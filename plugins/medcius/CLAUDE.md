# medcius plugin — conventions

- **Product boundary**: Medcius does **coding** (`nhsa-coding`), **evidence-gated prescription review** (`prescription-review`), and **note extraction** (`clinical-note-extract`). It does **not** make diagnostic decisions, differentials, or treatment plans. Do not describe it as a clinician CDS.

- **No hosted Claude MCP**: `mcp.json` / `.mcp.json` ship only local stdio servers (`china-codes`, `drug-labels`, `china-trials`, `documents`, `fhir`). Do not call `hcls.mcp.claude.com`, `pubmed.mcp.claude.com`, or any Anthropic-hosted healthcare MCP. If a US skill (prior-auth, ICD-10-CM, CPT) lacks a user-provided connector, stop. `nmpa-drugs` has no registry connector — local labels only.

- **Local data**: skills and bundled MCP servers write to `~/.claude/data/medcius/<component-name>/`, where the component is the *server's* name, not the skill's (the contracts skill's server writes to `documents/`). Override the parent dir with `$CLAUDE_MEDCIUS_DATA`; each component appends its own name (`documents/`, `drug-labels/`, `china-codes/`, `china-trials/`, `audit/`). `audit/` is **append-only** — never delete or "reset" it; `phiguard` is stateless. Never write under the plugin install path (versioned cache, wiped on upgrade).

- **Privacy & audit (P0 defaults, not optional)**: free text containing patient info must pass PHI Guard (`scan` → `redact`/`pseudonymize`) BEFORE logs, audit records, exports, or model context — `subject_ref` uses pseudonyms, never raw MRN/name/ID. Review verdicts are recorded via Local Audit Chain `record_event` (payload carries each evidence item's `snapshot_hash`/`source_version`/`data_class`); FLAG / REQUIRES_PHARMACIST_REVIEW batches are complete only after pharmacist `signoff`. The audit server rejects raw CN ID/phone patterns by design; run `verify_chain` before trusting any export.

- **Cross-agent notes (portable `mcp.json`)**:
  - Local stdio servers (`Contracts Analyzer`, `FHIR`, `Local Drug Labels`, `Local China Codes`) reference entrypoints via `${PLUGIN_ROOT}` (Agent Plugins) or `${CLAUDE_PLUGIN_ROOT}` (Claude Code path substitution — filesystem only, not a hosted API). A client that does not substitute the variable skips those servers.
  - `Local China Codes` and `Local Drug Labels` run fully offline after `ingest --sample` (probe) or official pack import. When a local corpus reports `not_in_corpus` / `no_mention_in_corpus`, that is not "not found nationally" — skills must surface the coverage disclaimer and never assert absence.
  - Official government websites (NMPA, NHSA, chinadrugtrials.org.cn, provincial 医保局) are allowed as **cited** sources; they are not MCP servers.
