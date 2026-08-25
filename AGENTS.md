# Medcius Codex collaboration rules

Medcius is an inpatient pre-round patient-evolution summary project. In Codex,
use it for engineering, synthetic-data replay, integration testing, and
evidence-governed review. Do not treat Codex output as a diagnosis, treatment
recommendation, clinical decision, or completed EHR write-back.

## Safety and evidence boundary

- Preserve fail-closed behavior when patient, encounter, tenant, time, source,
  or reference-range context is missing.
- Keep every extracted fact tied to an original note span or FHIR resource ID;
  use explicit `null`, `unknown`, or abstention rather than filling gaps.
- Keep negative results separate from “not mentioned” and “not evaluated”.
- Use synthetic fixtures or an approved local FHIR sandbox by default. Do not
  paste real patient data into a general Codex thread without an approved
  deployment and data-processing boundary.
- Run PHI Guard before free text enters logs, audit records, exports, or model
  context. Never weaken the append-only audit chain to make a test pass.
- The Codex Medcius MCP package is read-only for FHIR. Never add or enable
  `create_resource` or `update_resource` in the Codex manifest.

## Verification expectations

For implementation changes, run focused tests first, then the relevant full
checks. At minimum, preserve:

```powershell
node scripts/validate-json.mjs
node scripts/validate-skills.mjs
python C:\Users\13264\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py plugins\medcius
```

Report engineering checks, synthetic validation, and clinical evidence as
separate statuses. A green test run is not clinical evidence.

## Scope discipline

The flagship workflow is pre-round patient evolution only. Keep prescribing,
coding, prior authorization, clinical-trial search, autonomous multi-agent
behavior, and online learning outside the production Codex package unless a
separate intended use and evidence plan is approved.
