#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const MCP_FILES = [".mcp.json", ".trae/mcp.json"];
const COMPONENTS = ["fhir", "documents", "phiguard", "audit"];
const WRAPPER = "plugins/medcius/scripts/codex-mcp-server.mjs";
const REQUIRED_SKILLS = [
  ".trae/skills/medcius-fhir/SKILL.md",
  ".trae/skills/medcius-clinical-note-extract/SKILL.md",
  ".codebuddy/skills/medcius/SKILL.md",
];
const REQUIRED_RULES = [".trae/rules/project_rules.md", ".rules/medcius.md"];

let ok = true;

function fail(message) {
  ok = false;
  console.log(`BAD ${message}`);
}

function loadJson(path) {
  if (!existsSync(path)) {
    fail(`${path} is missing`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path} is invalid JSON: ${error.message}`);
    return null;
  }
}

function checkMcp(path) {
  const doc = loadJson(path);
  if (!doc) return;
  const servers = doc.mcpServers;
  if (!servers || typeof servers !== "object") {
    fail(`${path} must contain mcpServers`);
    return;
  }

  const entries = Object.entries(servers);
  for (const component of COMPONENTS) {
    const entry = entries.find(([, config]) => config?.args?.at(-1) === component);
    if (!entry) {
      fail(`${path} is missing ${component} host entry`);
      continue;
    }
    const [name, config] = entry;
    if (config.command !== "node") fail(`${path} ${name} must use node`);
    if (!Array.isArray(config.args) || !String(config.args[0]).includes(WRAPPER)) {
      fail(`${path} ${name} must use the shared host wrapper`);
    }
    if (config.cwd !== "${workspaceFolder}") {
      fail(`${path} ${name} must use cwd \\"${workspaceFolder}\\"`);
    }
  }

  const serialized = JSON.stringify(doc);
  if (serialized.includes("create_resource") || serialized.includes("update_resource")) {
    fail(`${path} must not expose FHIR write tool names`);
  }
  console.log(`OK ${path} — ${entries.length} shared host MCP servers`);
}

for (const path of MCP_FILES) checkMcp(path);

for (const path of REQUIRED_SKILLS) {
  if (!existsSync(path)) {
    fail(`${path} is missing`);
  } else {
    const text = readFileSync(path, "utf8");
    if (!text.startsWith("---") || !/^name:\s*\S+/m.test(text) || !/^description:\s*\S+/m.test(text)) {
      fail(`${path} needs Agent Skill frontmatter`);
    } else {
      console.log(`OK ${path}`);
    }
  }
}

for (const path of REQUIRED_RULES) {
  if (!existsSync(path) || readFileSync(path, "utf8").trim().length === 0) {
    fail(`${path} is missing or empty`);
  } else {
    console.log(`OK ${path}`);
  }
}

console.log(ok ? "HOST ADAPTERS VALID" : "HOST ADAPTER ERRORS FOUND");
process.exit(ok ? 0 : 1);
