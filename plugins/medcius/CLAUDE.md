# medcius plugin — conventions (v0.2.0-pilot)

- **Product boundary**: Medcius is exclusively an **Inpatient Pre-Round "Patient Evolution Summary" Sidebar Plugin** (`patient-evolution-engine.mjs` + `fhir` + `clinical-note-extract`). It extracts 24/72h clinical changes, dynamic LIS lab trends, medication regimen diffs, pending reports, and critical data gaps. It does **not** make diagnostic decisions, does **not** formulate treatment plans, and does **not** autonomously write back to the EHR.

- **No hosted Claude MCP**: `mcp.json` / `.mcp.json` ship only 4 core local stdio servers (`FHIR`, `Contracts Analyzer`, `PHI 卫士`, `本地审计链`). Do not call `hcls.mcp.claude.com`, `pubmed.mcp.claude.com`, or any hosted cloud healthcare MCP. All computation and PHI filtering are strictly local.

- **Local data**: Bundled MCP servers store state in local app data directories. `audit/` is **append-only** and hash-chained with SHA-256 — never delete or reset it; `phiguard` is stateless.

- **Privacy & Audit (P0 defaults)**: Free text containing patient info must pass PHI Guard (`scan` → `redact`/`pseudonymize`) before logs, audit records, or external display. Audit events record structured evidence references and physician digital signatures.

- **Experimental Modules**: Multi-agent supervisors, management cockpits, CME simulators, and legacy tools are isolated in `experimental/` and excluded from production default startup.
