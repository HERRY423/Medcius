# Medcius Codex collaboration rules

Medcius is an Agent plugin for frontline clinicians. It extends a host Agent
with bounded clinical workflow skills, read-only data tools, provenance, PHI
protection, and audit contracts. It is not a standalone clinical platform and
not an autonomous clinical Agent. The inpatient pre-round patient-evolution
summary is the first reference workflow, not the whole product boundary.

In Codex, use Medcius for plugin engineering, synthetic-data replay,
integration testing, and evidence-governed review. The host Agent handles
conversation and orchestration; Medcius supplies constrained skills and tools;
the clinician reviews evidence and remains the final decision-maker. Do not
treat Agent output as a diagnosis, treatment recommendation, clinical
decision, or completed EHR write-back.

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

- Keep the production core host-neutral: skills, MCP tools, safety contracts,
  evidence schemas, and evals. A sidebar or API is a reference adapter, not the
  product center.
- Treat each clinical workflow as a separately bounded skill pack with an
  explicit user, trigger, permissions, output contract, failure behavior,
  prohibited actions, evidence plan, and rollback path.
- Use pre-round patient evolution as the first reference workflow. Do not infer
  that Medcius is limited to that workflow or that one validated workflow
  validates another.
- Keep prescribing, coding, prior authorization, clinical-trial search,
  autonomous multi-agent behavior, and online learning outside the production
  core unless each is approved as a separate intended use and evidence plan.
