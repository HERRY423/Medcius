import { readFileSync } from "node:fs";
import { validateContract } from "./lib/schema-contract.mjs";
import { validateSpecialtyRulePack } from "../plugins/medcius/lib/specialty-rule-pack.mjs";

const files = [
  "plugins/medcius/rule-packs/calculation-reference.v1.json",
  "plugins/medcius/evals/shadow-mode/engine-challenge.cases.json",
  "plugins/medcius/evals/shadow-mode/engine-challenge.expected.json",
  "plugins/medcius/evals/clinical-benefit/observation-template.json",
  ".mcp.json",
  ".trae/mcp.json",
  "plugins/medcius/plugin.json",
  "plugins/medcius/mcp.json",
  "plugins/medcius/.claude-plugin/plugin.json",
  "plugins/medcius/.codex-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "plugins/medcius/rule-packs/schema/medcius-specialty-rule-pack.v1.schema.json",
  "plugins/medcius/rule-packs/specialties/cardiology-inpatient-sandbox.json",
  "plugins/medcius/contracts/patient-financial-access-record.v1.schema.json",
  "plugins/medcius/contracts/causal-evolution-report.v1.schema.json",
  "plugins/medcius/contracts/china-record-quality-report.v1.schema.json",
  "plugins/medcius/contracts/drg-dip-reconciliation.v1.schema.json",
  "plugins/medcius/packs/official-sources.json",
];

let ok = true;
for (const f of files) {
  try {
    const value=JSON.parse(readFileSync(f, "utf8"));
    if(f.includes("/specialties/")) {
      validateContract(JSON.parse(readFileSync("plugins/medcius/rule-packs/schema/medcius-specialty-rule-pack.v1.schema.json","utf8")),value);
      const check=validateSpecialtyRulePack(value); if(!check.ok) throw new Error(check.errors.join(","));
      console.log(`✓ CONTRACT ${f}`);
    } else if(f.endsWith("mcp.json")) {
      const server = { type:"object", required:["command","args"], properties:{
        command:{type:"string",minLength:1}, args:{type:"array",items:{type:"string"}}
      }};
      validateContract({type:"object",required:["mcpServers"],properties:{
        mcpServers:{type:"object",additionalProperties:server}
      }},value);
      if(!Object.keys(value.mcpServers).length) throw new Error("MCP_SERVERS_REQUIRED");
      console.log(`✓ MCP_CONTRACT ${f}`);
    } else if(f.endsWith("plugin.json")) {
      validateContract({type:"object",required:["name","version"],properties:{name:{type:"string",minLength:1},version:{type:"string",pattern:"^\\d+\\.\\d+\\.\\d+(?:-[a-zA-Z0-9.-]+)?$"}}},value);
      console.log(`✓ MANIFEST ${f}`);
    } else { console.log(`✓ SYNTAX_ONLY ${f}`); }
  } catch (e) {
    ok = false;
    console.error(`✗ ${f}: ${e.message}`);
  }
}
console.log(ok ? "ALL JSON CONTRACTS VALID (unmapped files explicitly syntax-only)" : "JSON ERRORS FOUND");
process.exit(ok ? 0 : 1);
