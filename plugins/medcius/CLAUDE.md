# medcius plugin — conventions (v0.6.0-pilot)

- **Product boundary**: Medcius is an **Agent plugin for frontline clinicians**. It extends a host Agent with bounded clinical workflow skills, read-only data tools, provenance, PHI protection, and audit contracts. It is not a standalone clinical platform and not an autonomous clinical Agent. The inpatient pre-round patient-evolution summary (`patient-evolution-engine.mjs` + `fhir` + `clinical-note-extract`) is the first reference workflow, not the whole product boundary. Medcius does **not** make diagnostic decisions, formulate treatment plans, or autonomously write back to the EHR.

- **No bundled hosted MCP**: `mcp.json` / `.mcp.json` ship only 4 core stdio servers (`FHIR`, `Clinical Documents`, `PHI 卫士`, `本地审计链`). Do not call `hcls.mcp.claude.com`, `pubmed.mcp.claude.com`, or any unapproved hosted healthcare MCP. Local connectors do not by themselves prove that model context, logs, or telemetry remain inside the hospital; verify the host deployment and data-processing boundary.

- **Local data**: Bundled MCP servers store state in local app data directories. `audit/` is **append-only** and hash-chained with SHA-256 — never delete or reset it; `phiguard` is stateless.

- **Privacy & Audit (P0 defaults)**: Free text containing patient info must pass PHI Guard (`scan` → `redact`/`pseudonymize`) before logs, audit records, or external display. Audit events record structured evidence references and physician digital signatures.

- **Workflow packs**: New clinical workflows must be separately bounded skill packs with an explicit user, trigger, permissions, output contract, failure behavior, prohibited actions, evidence plan, and rollback path. Multi-agent supervisors, management cockpits, CME simulators, and legacy tools remain isolated in `experimental/` and excluded from production default startup.
