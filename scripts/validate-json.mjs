import { readFileSync } from "node:fs";

const files = [
  "plugins/medcius/plugin.json",
  "plugins/medcius/mcp.json",
  "plugins/medcius/.claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];

let ok = true;
for (const f of files) {
  try {
    JSON.parse(readFileSync(f, "utf8"));
    console.log(`✓ ${f}`);
  } catch (e) {
    ok = false;
    console.error(`✗ ${f}: ${e.message}`);
  }
}
console.log(ok ? "ALL JSON VALID" : "JSON ERRORS FOUND");
process.exit(ok ? 0 : 1);