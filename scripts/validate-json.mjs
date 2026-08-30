import { readFileSync } from "node:fs";

const files = [
  ".mcp.json",
  ".trae/mcp.json",
  "plugins/medcius/plugin.json",
  "plugins/medcius/mcp.json",
  "plugins/medcius/.claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "plugins/medcius/rule-packs/schema/medcius-specialty-rule-pack.v1.schema.json",
  "plugins/medcius/rule-packs/specialties/cardiology-inpatient-sandbox.json",
  "plugins/medcius/contracts/patient-financial-access-record.v1.schema.json",
  "plugins/medcius/contracts/causal-evolution-report.v1.schema.json",
  "plugins/medcius/contracts/china-record-quality-report.v1.schema.json",
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
