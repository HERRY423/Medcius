#!/usr/bin/env node

// Host adapter for Codex, Trae, WorkBuddy, and CodeBuddy. Keep the existing
// Claude/portable MCP manifests unchanged while giving compatible hosts a
// host-neutral entry point, a user data directory, and a hard read-only
// boundary for the FHIR server.

import { homedir } from "node:os";
import { join } from "node:path";

const component = process.argv[2];
const targets = {
  fhir: "../servers/fhir/src/index.mjs",
  documents: "../servers/documents/src/index.mjs",
  phiguard: "../servers/phiguard/src/index.mjs",
  audit: "../servers/audit/src/index.mjs",
};

const target = targets[component];
if (!target) {
  process.stderr.write(
    `usage: node codex-mcp-server.mjs <${Object.keys(targets).join("|")}>\n`,
  );
  process.exit(2);
}

const dataRoot =
  process.env.MEDCIUS_DATA ??
  process.env.CLAUDE_MEDCIUS_DATA ??
  (process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Medcius", "data")
    : join(homedir(), ".medcius", "data"));
process.env.CLAUDE_MEDCIUS_DATA = dataRoot;

if (process.env.MEDCIUS_PHI_SALT && !process.env.CLAUDE_MEDCIUS_PHI_SALT) {
  process.env.CLAUDE_MEDCIUS_PHI_SALT = process.env.MEDCIUS_PHI_SALT;
}

if (component === "fhir") {
  // The Codex package must never expose the FHIR write tools. A user can
  // still use the existing Claude package's explicit write path separately.
  process.env.MEDCIUS_FHIR_READ_ONLY = "true";
}

// The documents server also supports a one-shot CLI mode and inspects
// process.argv. Hide the host selector before importing any child server so
// every host receives its MCP stdio mode consistently.
process.argv = process.argv.slice(0, 2);

await import(new URL(target, import.meta.url));
