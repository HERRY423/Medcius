# Third-Party Notices & Provenance

Medcius (this repository, `HERRY423/Medcius`) is a **rebranded and extended fork** of the
[`anthropics/healthcare`](https://github.com/anthropics/healthcare) plugin. This notice records the
provenance of the code and the licensing posture, so redistribution terms are explicit and honest.

## 1. Upstream status

| Field | Value |
|---|---|
| Upstream repo | `https://github.com/anthropics/healthcare` |
| LICENSE file upstream | **None** |
| SPDX license reported by GitHub | **None** (`license: null`) |
| License statement upstream | README: *"Provided under Anthropic's terms of service."* |
| Bundled package manifests | `plugins/healthcare/servers/{documents,fhir}/package.json` declare `"license": "MIT"`, `"author": "Anthropic"` — but there is **no repository-level open-source grant** upstream |

**Conclusion:** the upstream grant is ambiguous and not a standard open-source license. Redistribution
and modification of upstream-derived files rest on whatever Anthropic's terms of service permit, and
Medcius's MIT license does **not** extend to them.

## 2. Provenance classification

Tree diff of `upstream-healthcare/main` vs the working tree (rename-aware), dir moved
`plugins/healthcare/` → `plugins/medcius/`:

| Class | Count | Meaning |
|---|---|---|
| **Unmodified upstream** | 159 | Moved verbatim, byte-identical (100% similarity). Redistributed as-is. |
| **Modified from upstream** | ~40 | Upstream files changed by Medcius: env/data-dir renames (`paths.js`, `screen.js`, …), `.mcp.json` (added China servers), READMEs, skill docs. |
| **Medcius-original (written fresh)** | ~35 | Not present upstream, or **rewritten from upstream-derived copies**: 6 China skills, `.cursor/rules/*.mdc` (6), portable `plugin.json` + `mcp.json`, validate/smoke scripts, `LICENSE`, `.gitignore`, and the **rewritten MCP server code** — `servers/shared/{rpc,validate}.mjs`, `servers/fhir/src/*` (smart auth, session store, fhir-client, documents, tools, index), `servers/documents/src/*` (db, engine, citations, ingest, extract, index). |
| **Rewritten from upstream** | 5 | `.claude-plugin/plugin.json`, `CLAUDE.md`, `README.md`, the plugin manifests (rewritten beyond rename-pairing). |

## 3. Licensing posture

1. **`LICENSE` (MIT, Copyright © 2026 HERRY423) covers the Medcius-original files only.**
2. **Unmodified and modified upstream files** retain their upstream status; Medcius makes no MIT claim
   over them. Their use is subject to Anthropic's terms for `anthropics/healthcare`.
3. **Before public redistribution or commercial use**, confirm what Anthropic's terms of service permit
   for the upstream-derived code, or replace/rewrite the high-value upstream components (the FHIR
   connector and the documents/contracts engine) so Medcius is genuinely independent.
4. Package identity: bundled npm packages were renamed `@anthropic-ai/*` → `@medcius/*` to mark Medcius
   maintenance; their Anthropic origin is recorded here rather than erased.

## 4. Keep / rewrite / split recommendation (summary)

| Component | Provenance | Recommendation |
|---|---|---|
| 6 China skills | Original | **Keep** — this is Medcius's differentiator |
| Portable manifests, validate scripts | Original | **Keep** |
| Upstream payer/provider skills (`prior-auth`, `icd10-cm`, `procedure-coding`, `fraud-detection`, `clinical-trial-protocol`, …) | Unmodified upstream | **Keep as-is** under upstream terms (NOTICE covers it); consider splitting US-only skills into a separate package if the China focus is primary |
| Bundled servers (`documents`/contracts engine, `fhir`) + shared transport | **Medcius-original (rewritten 2026-08)** | **Kept, now Medcius-owned** — original implementations preserving the MCP tool contract, SQLite schema, and data-dir convention; internal simplifications applied; not live-tested against a real FHIR endpoint/corpus |
| US-only MCP endpoints (CMS Coverage, ICD-10, NPI, US Clinical Trials) | Upstream config | **Split** if China-primary: keep China + PubMed endpoints; move US endpoints to a separate US flavor |
