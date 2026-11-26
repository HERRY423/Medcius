# mcp-server-fhir

Local stdio MCP server for clinical data access against any SMART-on-FHIR R4 endpoint — Epic, Oracle Health (Cerner), MEDITECH, athenahealth, OpenEMR, HAPI, and other conformant servers. Uses the SMART client_id your organization has registered with its EHR.

Runs as a subprocess on the user's machine: the FHIR API leg is direct between this process and the EHR. Tool results returned to the calling agent become part of that agent's conversation with its LLM provider — handle that leg under the appropriate agreement for your deployment. This README is not compliance advice.

**Status: experimental, pre-release.** For evaluation against test/sandbox FHIR servers. Clinical validation is pending.

## Install

Ships inside the `medcius` plugin and is wired via `${CLAUDE_PLUGIN_ROOT}` in the plugin's `.mcp.json` — installing the plugin is the install step. There is no build step and nothing to install: node runs `src/index.mjs` straight from source, and the runtime has zero dependencies (node builtins only). To point it at your EHR, add `env` to that entry:

```jsonc
"fhir": {
  "command": "node",
  "args": ["${CLAUDE_PLUGIN_ROOT}/servers/fhir/src/index.mjs"],
  "env": {
    "FHIR_BASE_URL": "https://<your-fhir-r4-base>",
    "FHIR_CLIENT_ID": "<your-org's-SMART-client-id>"
  }
}
```

## Tools

**Auth/session** (always prompt): `connect({base_url?, client_id?, bearer_token?, scope?})` · `connect_complete({callback_url})` · `disconnect()`

**Read** (annotated `readOnlyHint`): `status()` · `capability()` · `search_patients` · `get_patient` · `search_conditions` · `search_observations` · `search_medication_requests` · `search_allergies` · `search_document_references` · `get_document_content` · `search_resource(type, params)` · `read_resource(type, id)`

The client supports resource reads and form-encoded FHIR searches. Binary attachment export is blocked by PHI Guard. Text attachments resolve against the connected FHIR origin.

## Auth

`connect()` with no args reads `FHIR_BASE_URL` + `FHIR_CLIENT_ID` from env and runs SMART standalone PKCE: on a desktop, opens the browser and listens on `localhost:53682/53683`; in a headless/VM environment (`FHIR_AUTH_MODE=manual`), returns the sign-in URL and you finish via `connect_complete` with the pasted callback URL. Default scope is `user/*.rs` (one login, whole panel, read+search only). Scope syntax negotiates v2→v1 against servers that don't advertise `permission-v2`.

The connection (base URL + access token, ≤1h TTL) is cached to `os.tmpdir()` (mode 0600, ownership-checked) so it survives the host respawning the stdio subprocess. The refresh token is held in memory only.

## Limitations

- **RTF decode is minimal, not a full parser.** Group-aware strip with cp1252/`\uN`/`\bin` handling — fine for EHR note bodies; exotic RTF (nested tables, fields) degrades to plain text.
- **PDFs/images need the extraction hop** — `get_document_content` returns `binary_not_extracted`; binary export is blocked in this package.
- **No bulk export** (`$export`). Per-resource reads scoped by the clinician's auth only.
- **SSRF guard is hostname-pattern, not socket-level.** Literal private/link-local IPs and known metadata hostnames are rejected; a hostname that DNS-resolves to a private IP is not (TOCTOU). Mitigated by the user's-own-machine threat model; full socket-level filtering is a follow-up.
- **Re-auth per session.** The refresh token is not persisted (no OS keyring); a fresh SMART login is needed once per session/host where the access token has expired.
- **`launch.smarthealthit.org`** works no-auth with the bare `/v/r4/fhir` URL; SMART login against it needs a sim-encoded `iss` from its launcher UI.

## Dev

The server itself needs no install — `bun install` only fetches the typecheck and test
devDependencies (`@medplum/*` stands up a fake FHIR server for the HTTP tests).

```sh
bun run dev      # node stdio, straight from src/ — no build

bun install      # devDeps, for the two below
bun test         # unit + security tests
bun run check    # tsc --noEmit typecheck (JSDoc types over .mjs)
```
