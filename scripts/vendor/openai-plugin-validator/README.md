# Pinned OpenAI plugin validator

Unmodified upstream files from `openai/codex` commit
`985cf47a4eb6084b2ff6b30ebdb1216acda85bb4`. The upstream removed this bundled
sample in commit `9db8162d658100bbf0a5a151996f9c3396ff1791`; pinning it here
keeps the existing Medcius check reproducible without depending on host caches.
This validates the pinned contract, not future host acceptance.

`provenance.json` records source URLs, byte lengths and SHA-256 values; the
wrapper checks them before execution. Upstream logic is unchanged.

Runtime: Python 3.10+ with `PyYAML==6.0.3` (see `requirements.txt`). Run from
the repository root: `node scripts/validate-plugin.mjs`. Set `MEDCIUS_PYTHON`
only to select the installed interpreter. Missing Python, PyYAML, source files,
integrity failure or validation errors fail the check.

License: Apache-2.0, included in `LICENSE`.
