import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { PatientEvolutionEngine } from "../../lib/patient-evolution-engine.mjs";
import { loadSpecialtyRulePack } from "../../lib/specialty-rule-pack.mjs";
const read = name => readFileSync(new URL(name, import.meta.url));
const inputs = read("./engine-challenge.cases.json"), reference = read("./engine-challenge.expected.json");
const expected = JSON.parse(reference).expected;
const now = new Date("2026-10-06T08:00:00Z");
const rulePack = loadSpecialtyRulePack("cardiology-inpatient-sandbox");
// No expectation or label is passed into the production engine.
function predict(item) {
  const result = PatientEvolutionEngine.analyzePatientEvolution({patient:{id:"synthetic"},rulePack,now,lisFeed:[{...item,status:"final",sample_time:now.toISOString()}]});
  if (result.blocks.data_gaps.some(g=>g.summary?.includes("CRITICAL_VALUE_UNIT_INCOMPATIBLE"))) return "abstain";
  return result.critical_values.length ? "flag" : "clear";
}
const rows = JSON.parse(inputs).cases.map(item=>({id:item.id,predicted:predict(item),expected:expected[item.id]}));
const assess = rows => ({n:rows.length,mismatches:rows.filter(r=>r.predicted!==r.expected).length,tp:rows.filter(r=>r.predicted==="flag"&&r.expected==="flag").length,fp:rows.filter(r=>r.predicted==="flag"&&r.expected==="clear").length,fn:rows.filter(r=>r.predicted==="clear"&&r.expected==="flag").length,tn:rows.filter(r=>r.predicted==="clear"&&r.expected==="clear").length,expected_abstentions:rows.filter(r=>r.expected==="abstain").length});
const mutants = Object.fromEntries(Object.entries({always_clear:()=>"clear",always_flag:()=>"flag",inverted:r=>r.predicted==="flag"?"clear":r.predicted==="clear"?"flag":"abstain",unsafe_missing_as_clear:r=>r.predicted==="abstain"?"clear":r.predicted}).map(([name,fn])=>[name,assess(rows.map(r=>({...r,predicted:fn(r)})))]));
const summary=assess(rows);
const report={evaluation_id:"engine-policy-challenge-v1",execution_status:"COMPLETED",evidence_class:"synthetic_engineering_fixture",input_sha256:createHash("sha256").update(inputs).digest("hex"),reference_sha256:createHash("sha256").update(reference).digest("hex"),reference_kind:JSON.parse(reference).reference_kind,rule_pack_sha256:rulePack.sha256,summary,negative_controls:mutants,rows,engineering_pass:summary.mismatches===0&&Object.values(mutants).every(m=>m.mismatches>0),clinical_evidence_pass:false,independent_validation:false};
const dir=new URL("./reports/",import.meta.url); mkdirSync(dir,{recursive:true});
writeFileSync(new URL("engine-challenge-summary.json",dir),JSON.stringify(report,null,2)+"\n");
assert.equal(report.engineering_pass,true);
console.log("Engine challenge: 8 actual-engine cases, 4 defective-output controls detected; synthetic engineering only.");
