# clinical-note-extract

Structured extraction from clinical notes with span-level provenance and null-safety.

## What it does

Given one or more clinical notes and a schema of variables to extract, returns one record per note: each field carries its value, the verbatim source span, and (for findings) assertion on three independent axes — `presence` (present/absent/possible), `temporality` (current/historical/hypothetical), `experiencer` (patient/family_member/other) — following the ConText/ShARe model. Absent values are explicit nulls with a reason — never guesses.

Medcius uses this as the input to `nhsa-coding` (terms → 医保编码) and as a chart-abstraction primitive. It does **not** diagnose.

## Architecture

One path for any number of notes:

```
schema  →  extract-batch.js  →  records[]  →  validation pass  →  report
           (one no-tools                       (span check +
            worker per note)                    per-system code lookup)
```

Workers run as the `note-extract-worker` subagent (`tools: []`) following `references/rules.md`, so untrusted note text structurally cannot reach write/network tools. Each worker sees exactly one note in a clean context — no in-context batching, no recall collapse. Workers return only what they read (`value`, `span`, the three assertion axes, `unit`, `null_reason`); the validation pass in the calling session runs each field's `check` (terminology lookup, range, date, pattern, …) and attaches the results.

## Files

```
SKILL.md                          orchestrator (define → extract → validate → report)
workflows/extract-batch.js        one worker per note, schema-enforced output
references/
  rules.md                        the 7 hard rules workers follow
  01-define-schema.md             turn user intent into a precise schema
  02-extract.md                   numeric defaults + extraction detail
  03-review.md                    evidence-linked review output
  failure-modes.md                why each rule exists
  assertion-classes.md            present/absent/hypothetical/... taxonomy
assets/
  sample-note.md                  synthetic English pulmonology note
  sample-schemas/china-inpatient.json   入院/出院诊断、手术、过敏、体征
  sample-schemas/{pft,ade}.json
  china-notes/                    10 份合成中文出院记录（对抗陷阱）
```

The plugin also ships `agents/note-extract-worker.md` (no-tools subagent definition).

## Prerequisites

Default Chinese schema: `assets/sample-schemas/china-inpatient.json` (admission / discharge / procedures / allergy / exam). Ten synthetic adversarial notes: `assets/china-notes/`. This skill does **not** diagnose and does **not** emit codes.

Connectors for `check.via` must be local (`china-codes` for `nhsa`). Missing connectors don't block extraction. Hosted Claude MCP is not used.

## Try it

```
用 china-inpatient schema 抽取 assets/china-notes/01-allergy-negation.md
```

## Eval

> China inpatient traps (10 notes) live in `assets/china-notes/` with cases in `plugins/medcius/evals/china-skills/cases/clinical-note-extract.json`. Run `node scripts/run-evals.mjs`. The upstream English 9-case set is not vendored.

| trap | without rules | with rules | what the rules change |
|---|---|---|---|
| negation | 1/3 | 3/3 | sets `presence: absent` |
| family_history | 0/1 | 1/1 | sets `experiencer: family_member` |
| multi_axis | 0/2 | 2/2 | "no family history of X" = `absent` + `family_member` (flat enum can't represent this) |
| indication_vs_finding | 0/1 | 1/1 | "for DVT prophylaxis" → `temporality: hypothetical` |
| parametric_leak | 2/3 | 3/3 | won't emit drug class the note doesn't state |
| batched_refusal | 0/1 | 1/1 | refuses concatenated notes |
| causal_inversion | 1/1 | 1/1 | — already handled |
| hypothetical | 2/2 | 2/2 | — already handled |
| historical | 1/1 | 1/1 | — already handled |
| uncitable | 1/1 | 1/1 | — already handled |
| required_fabrication | 2/2 | 2/2 | — already handled |
| identifier_fabrication | 2/2 | 2/2 | — already handled |
| partial_date | 1/1 | 1/1 | — already handled |
| unit_confusion | 1/1 | 1/1 | — already handled |
| redaction | 1/1 | 1/1 | — already handled |

Single run, N=1 per trap for most rows — expect ±1 variance across runs. The stable pattern: the rules' value is **assertion-axis normalization** (the ConText three-axis model is what cTAKES/MedSpaCy/Comprehend Medical/Google Healthcare NLP all emit, so output joins with theirs) and **procedural enforcement** (one-note refusal, span citations, parametric-leak suppression). The bare model already won't fabricate identifiers, dates, or required fields.

## Scaling

Note text rides inline in the workflow's `args`, so the workflow path tops out at a few dozen notes per call — bounded by how much text the orchestrator can emit. For larger corpora use the runner:

```
# Prefer the host workflow (extract-batch.js). Optional CLI:
MEDCIUS_EXTRACT_CLI=<local-agent-cli> bun <skill-dir>/scripts/batch.ts <notes-dir> <schema.json> [out.jsonl]
```

The runner reads files in trusted code (not model-steered) and spawns one tool-disabled process per note — same security posture as the no-tools worker, no orchestrator-context ceiling. Validation cost is one connector call per *distinct* code, not per occurrence.

## Output handling

`records.json` carries whatever PHI was in the source notes. Treat the run directory under `~/.claude/data/medcius/clinical-note-extract/` as local working state: don't copy it to shared storage without explicit instruction, and delete it when the run is done.
