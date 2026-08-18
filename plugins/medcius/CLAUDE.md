# medcius plugin — conventions

- **Local data**: skills and bundled MCP servers write to `~/.claude/data/medcius/<component-name>/`, where the component is the *server's* name, not the skill's (the contracts skill's server writes to `documents/`). Override the parent dir with `$CLAUDE_MEDCIUS_DATA`; each component appends its own name. The user adds `~/.claude/data/medcius` to `sandbox.filesystem.allowWrite` in `~/.claude/settings.json` once; subagents and Workflow workers inherit it. Never write under the plugin install path (versioned cache, wiped on upgrade).

- **Cross-agent notes (portable `mcp.json`)**:
  - The two local stdio servers (`Contracts Analyzer`, `FHIR`) reference their entrypoints via `${PLUGIN_ROOT}` — the Agent Plugins plugin-root variable. A client that does not substitute it will skip these two servers; the HTTP servers are unaffected.
  - All HTTP servers are hosted at Anthropic's `hcls.mcp.claude.com` / `pubmed.mcp.claude.com`. Whether a non-Claude client can reach them depends on network egress to those hosts; when unreachable, skills with a connector fall back to web/official sources or explicitly stop (per each SKILL.md).
