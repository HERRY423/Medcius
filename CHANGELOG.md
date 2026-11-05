# Changelog

## 1.0.0 — 2026-11-05

- Publish the integrated plugin as V1.0.0 without changing clinical permissions.
- Resolve npm CLI paths on Windows, Unix Node distributions and Debian;
  keep offline installation and real-inference readiness checks mandatory.
- Package only committed plugin files, verify tag/manifest versions and ZIP
  contents, and publish SHA-256 plus source-commit metadata.
- Require successful CI on the exact release commit before publication.

See [V1.0.0 release notes](docs/releases/V1.0.0.md). Prior results below retain
their original scope, including failed performance observations.

## 0.10.0-pilot — 2026-11-05

This engineering integration brings the accumulated local changes into one
versioned plugin package. It does not enable a new clinical intended use.

- Integrate Chinese assertion scopes, measurements, CDA identity, site view
  mappings, order execution and source-bound PACS links.
- Integrate asynchronous production PHI guards across HIS, MCP, documents,
  audit and model input/output, with request-bound dictionaries and pinned
  local CPU NER. Missing or failed execution continues to block output.
- Include bounded NER batching, numerical-equivalence and concurrency tests,
  clinical-reference helpers and versioned coding-store boundaries. Jiangsu
  grouper configuration remains `NOT_CONFIGURED`.
- Integrate offline dependency checks, actual inference readiness probes,
  deployment locking, backup/rollback and TLS-aware health checks.
- Install the selected snake-and-spear icon (512 px display / 128 px composer).
- Synchronize host manifests, runtime version metadata, image labels and
  18 draft controlled documents. Preserve `DRAFT_UNAPPROVED`; historical
  records retain their original versions and results in Git and dated reports.
- Prepare CI's locked Node/Python/NER dependencies and pinned model assets;
  retain execution artifacts even on failure. Publish the two named synthetic
  report summaries previously linked only from ignored local output.

See [integration verification](docs/engineering/INTEGRATION-2026-11-05.md)
for actual checks, failures and scope. Historical release commit/tag labels
did not consistently match the package's previous `0.8.0-pilot` manifests;
this entry records the synchronized package version without rewriting history.

Clinical validity and hospital acceptance remain unestablished. The workflow
limit remains an authorized silent pilot, and the Codex FHIR tools remain
read-only. Model weights, patient records, runtime databases and credentials
are not included in the source update.
