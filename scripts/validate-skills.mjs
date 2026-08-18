import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const skillsDir = "plugins/medcius/skills";
const newSkills = [
  "nhsa-coding",
  "nhsa-policy",
  "nmpa-drugs",
  "china-clinical-trials",
  "hospital-info-systems",
  "prescription-review",
];

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PLUGIN_ALLOWED_KEYS = new Set([
  "$schema", "name", "version", "description", "author", "homepage",
  "repository", "license", "keywords", "extensions",
]);

let ok = true;

// 1. Check all skills have valid Agent Skills frontmatter
const all = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

console.log(`=== All ${all.length} skills ===`);
for (const d of all.sort()) {
  const p = join(skillsDir, d, "SKILL.md");
  if (!existsSync(p)) {
    console.log(`MISSING-SKILL.md ${d}`);
    ok = false;
    continue;
  }
  const text = readFileSync(p, "utf8");
  const lines = text.split(/\r?\n/);
  const hasFrontmatter = lines[0]?.trim() === "---";
  const hasName = lines.some((l) => l.startsWith("name:"));
  const hasDesc = lines.some((l) => l.startsWith("description:"));
  const status = hasFrontmatter && hasName && hasDesc ? "OK " : "BAD ";
  if (status === "BAD ") ok = false;
  const tag = newSkills.includes(d) ? " [NEW-CN]" : "";
  console.log(`${status}${d}${tag}`);
}

// 2. Check Agent Plugins portable layout (inside the plugin package)
console.log("\n=== Agent Plugins portable layout (plugins/medcius) ===");
const portableFiles = ["plugin.json", "mcp.json"];
for (const f of portableFiles) {
  const p = join("plugins/medcius", f);
  if (existsSync(p)) {
    console.log(`OK plugins/medcius/${f}`);
  } else {
    console.log(`BAD plugins/medcius/${f}`);
    ok = false;
  }
}

// 3. Check Claude Code plugin layout
console.log("\n=== Claude Code plugin layout ===");
const claudePluginFiles = [
  "plugins/medcius/.claude-plugin/plugin.json",
  "plugins/medcius/.mcp.json",
  "plugins/medcius/CLAUDE.md",
  ".claude-plugin/marketplace.json",
];
for (const p of claudePluginFiles) {
  if (existsSync(p)) {
    console.log(`OK ${p}`);
  } else {
    console.log(`BAD ${p}`);
    ok = false;
  }
}

// 4. Check Agent Plugins portable manifest schema conformance (offline structural check)
console.log("\n=== Agent Plugins 1.0.0 manifest conformance ===");

function checkPortablePlugin() {
  const p = "plugins/medcius/plugin.json";
  const doc = JSON.parse(readFileSync(p, "utf8"));
  const keys = Object.keys(doc);
  const bad = keys.filter((k) => !PLUGIN_ALLOWED_KEYS.has(k));
  if (bad.length) {
    console.log(`BAD ${p} — non-schema keys (additionalProperties:false): ${bad.join(", ")}`);
    ok = false;
  } else {
    console.log(`OK ${p} — keys all schema-valid`);
  }
  if (doc.$schema !== PLUGIN_SCHEMA) {
    console.log(`BAD ${p} — $schema must be ${PLUGIN_SCHEMA}`);
    ok = false;
  }
  if (typeof doc.name !== "string" || !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(doc.name)) {
    console.log(`BAD ${p} — name "${doc.name}" violates schema pattern`);
    ok = false;
  } else {
    console.log(`OK ${p} — name "${doc.name}"`);
  }
  if (doc.license !== "MIT") {
    console.log(`WARN ${p} — license "${doc.license}" differs from root LICENSE (MIT)`);
  }
}

function checkPortableMcp() {
  const p = "plugins/medcius/mcp.json";
  const doc = JSON.parse(readFileSync(p, "utf8"));
  if (doc.$schema !== MCP_SCHEMA) {
    console.log(`BAD ${p} — $schema must be ${MCP_SCHEMA}`);
    ok = false;
  }
  const servers = doc.mcpServers ?? {};
  const names = Object.keys(servers);
  console.log(`OK ${p} — ${names.length} servers: ${names.join(", ")}`);
  for (const [name, cfg] of Object.entries(servers)) {
    const t = cfg.type;
    if (t === "stdio") {
      if (typeof cfg.command !== "string") {
        console.log(`BAD ${p} — "${name}": stdio server needs a command`);
        ok = false;
      }
    } else if (t === "streamable-http" || t === "sse") {
      if (typeof cfg.url !== "string") {
        console.log(`BAD ${p} — "${name}": ${t} server needs a url`);
        ok = false;
      }
    } else {
      console.log(`BAD ${p} — "${name}": type "${t}" not in {stdio, streamable-http, sse}`);
      ok = false;
    }
  }
}

try {
  checkPortablePlugin();
} catch (e) {
  console.log(`BAD plugins/medcius/plugin.json — ${e.message}`);
  ok = false;
}
try {
  checkPortableMcp();
} catch (e) {
  console.log(`BAD plugins/medcius/mcp.json — ${e.message}`);
  ok = false;
}

console.log(ok ? "\nALL CHECKS PASSED" : "\nCHECKS FAILED");
process.exit(ok ? 0 : 1);
