# Step 1 — Define the extraction schema

Goal: turn the user's request into a precise schema object that Step 2 can execute against. The schema is small by design — most fields need only a description.

## Schema shape

One entry per variable:

| key | required? | what it does |
|---|---|---|
| `desc` | yes | one line — what counts as this variable, in the note's own terms. The worker reads this. |
| `finding` | no | `true` if assertion context matters (symptom, condition, exposure). Tells the worker to classify `presence`/`temporality`/`experiencer` per `references/assertion-classes.md`. |
| `check` | no | how the orchestrator validates the extracted value afterward. Open-ended — see below. The worker sees it but does not run it. |

That's the whole contract. No `type` enum — the description says what to look for; the value comes back as whatever primitive the note stated (string, number, or null).

## `check` — validation kinds

`check` is `{kind, ...params}`. The orchestrator's validation pass dispatches on `kind`. Kinds today:

| kind | params | what step 3 does |
|---|---|---|
| `terminology` | `via` — whatever identifier your connector answers to | look up `value` against that connector; attach `{code, code_status, display}` |
| `range` | `min`, `max`, `unit?` | flag `value` outside `[min, max]`; flag unit mismatch |
| `date` | — | confirm `value` parses as a date at the precision the note gave |
| `pattern` | `regex` | flag `value` that doesn't match |
| `enum` | `values` | flag `value` not in the list (don't put candidate answers here if the worker shouldn't see them) |

Adding a kind means adding a branch to the validation pass — nothing in `rules.md` or the worker's contract changes.

## Guidance

- Write `desc` in the note's language, not the schema's. "Primary diagnosis as the clinician stated it" extracts better than "ICD-10-CM code for primary dx."
- One field = one value. For "all medications" or similar, extract the list as free text first, then re-run with a per-item schema built from that list.
- Dates: capture at the precision the note gives. "June 2020" stays `"2020-06"`; never invent a day.
- Numbers: the worker captures the unit as written. Put expected unit in `check.unit` if you want mismatches flagged.
- Don't put the answer in `check`. The worker reads the whole schema; an enum of candidate codes in `check.values` is a leak.

## Example — Chinese inpatient (default)

Ship-ready schema: `assets/sample-schemas/china-inpatient.json` (admission / discharge / procedures / allergy / physical exam). It does **not** request codes. After extraction, hand terms to `nhsa-coding` if the user wants settlement codes.

English PFT/ADE examples remain under `assets/sample-schemas/{pft,ade}.json`.

Echo the schema back as a table and confirm before proceeding to Step 2. Do not add fields that infer a diagnosis from labs or imaging.
