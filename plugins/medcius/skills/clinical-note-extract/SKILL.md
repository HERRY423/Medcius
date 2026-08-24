---
name: clinical-note-extract-skill
description: 从病历抽取结构化字段（原文 + span），中国住院默认用 china-inpatient schema（入院诊断、出院诊断、手术、过敏史、体格检查）。不做诊断决策、不输出编码。当用户说"抽取这份病历"、"入院诊断是什么"、"出院诊断/手术/过敏史/体格检查"、"extract from this note"时使用。
---

# Clinical Note Extraction

Structured extraction from clinical notes against a schema, with span citations for every value and explicit nulls for every absence. One note or many — the path is the same: an isolated no-tools worker extracts each note, then a deterministic validation pass verifies spans.

**Product boundary:** this skill extracts what the note says. It does not diagnose, does not upgrade 疑似/待查 to a confirmed disease, does not emit ICD/医保 codes (that is `nhsa-coding`), and does not judge prescription safety (that is `prescription-review`).

Chinese inpatient notes: unless the user supplies another schema, use `assets/sample-schemas/china-inpatient.json`. Templated 出院记录（带「入院诊断：」等标题）优先跑确定性解析：`node scripts/intake-discharge.mjs <file> [--code --out dir]`（`lib/parse-cn-note.mjs`）。无标题的自由文本再用 worker。Adversarial samples: `assets/china-notes/` (10 synthetic notes).

## Steps

```
1  Define schema   — references/01-define-schema.md
2  Extract         — workflows/extract-batch.js (one isolated worker per note)
3  Validate        — span check + run each field's `check`
4  Report          — references/03-review.md
```

### Step 1 — Define schema

Read `references/01-define-schema.md`. If the note is a Chinese admission/discharge/progress record and the user did not give a schema, load `assets/sample-schemas/china-inpatient.json` and confirm it. Otherwise turn the request into a schema: each field is `{desc, finding?, check?}`. `desc` says what to look for in the note's own terms; `finding: true` means classify assertion; `check` is how step 3 validates. Confirm with the user before extracting. Do not add diagnosis-inference fields.

### Step 2 — Extract

However the user supplied notes — pasted text, file paths, a directory, PDFs, a FHIR connector, a database query — resolve each to plain text using whatever tools you have, then call the saved workflow with one `{id, text}` per note. The workflow's input contract is the only strict piece; how you get there is yours to figure out. It runs one `note-extract-worker` agent per note (no tools — note text is untrusted), each following `references/rules.md`, and returns one schema-enforced record per note:

```
Workflow({
  scriptPath: "<this skill dir>/workflows/extract-batch.js",
  args: {
    notes:  [{id, text}, ...],     // one or many
    schema: <the schema from step 1>,
    rules:  <Read references/rules.md verbatim>
  }
})
```

Workers have no tools — they return only what they read (`value`, `span`, `presence`/`temporality`/`experiencer`, `null_reason`, `unit`). All checks happen in step 3. Because note text rides inline in `args`, the workflow path tops out at a few dozen notes per call. For larger corpora, prefer the same workflow in chunks; `scripts/batch.ts` only runs if `MEDCIUS_EXTRACT_CLI` points at a local agent CLI (does not call hosted APIs).

### Step 3 — Validate

Runs here in the calling session. Deterministic — no model judgment. For every record:

1. **Span check.** For every non-null field, confirm `span` appears verbatim in that note's source text. Attach `span_verified`.
2. **Run each field's `check`.** Dispatch on `check.kind`:
   - `terminology` — dedupe `(check.via, value)` across all records, look each up via a **local** connector (`via: "nhsa"` → 本地编码与目录库). No connector → `code_status: "unvalidated"`. Never call hosted Claude/Anthropic MCP. China default schema does not include terminology checks; coding is a separate skill.
   - `range` — `value` vs `[min, max]` and `unit` vs `check.unit`; attach `range_flag`.
   - `date` — confirm `value` parses as a date; attach `date_ok`.
   - `pattern` / `enum` — match; attach `check_ok`.
   - other / no `check` — nothing to attach.

A field is trustworthy when `span_verified` and its check (if any) passed. Adding a check kind = add a branch here; nothing upstream changes.

### Step 4 — Report

Read `references/03-review.md`. Produce one row per (note, field): `note_id | field | value | presence/temporality/experiencer | span | check`. Below it, the completion summary: fields requested / populated / null, and per `check.kind` what passed vs flagged (name any terminology `via` that lacked a connector). Never let a failed check or unverified span pass silently.

Offer to write records + report to `$CLAUDE_MEDCIUS_DATA/clinical-note-extract/<run-id>/` (default `~/.claude/data/medcius/clinical-note-extract/`). Local working state only — extracted records carry PHI from the source notes; do not upload them to hosted services.

## Output contract

Worker emits, per field: `{value, span, location, presence?, temporality?, experiencer?, null_reason?, unit?}` — only what it read. Step 3 attaches `span_verified` plus whatever the field's `check` produced (`code`/`code_status`/`display` for terminology, `range_flag` for range, etc.).

### Optional — export as FHIR

If the user wants FHIR resources instead of flat records, the assertion axes map directly:

| record | FHIR |
|---|---|
| `experiencer != patient` | `FamilyMemberHistory.condition` (not `Condition`) |
| `presence: absent` → `verificationStatus: refuted`; `possible` → `unconfirmed`; `present` → `confirmed` | `Condition.verificationStatus` |
| `temporality: historical` → `inactive`; `current` → `active` | `Condition.clinicalStatus` |
| `temporality: hypothetical` | no native field — omit, or use a `RiskAssessment` resource |
| `value` + terminology check result | `Condition.code` as a `CodeableConcept` (`{text: value, coding: [{system, code, display}]}`) |
| `span` + `location` | `Condition.note` or a provenance extension |

This is a deterministic transform over the validated records — no model call. Offer it when the user names FHIR as the target; otherwise the flat records are the default.

## Prerequisites

Connectors for whatever `check.via` values the schema names must be local (bundled `china-codes` or user-provided). Missing ones don't block extraction — those fields stay unvalidated. Hosted Claude MCP is not a connector.
