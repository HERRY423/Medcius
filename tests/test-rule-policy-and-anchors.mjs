import assert from "node:assert/strict";
import { test } from "node:test";
import { HospitalDataAdapter, calculateEgfrCkdEpi, calculateNews2, normalizeLabUnit } from "../plugins/medcius/lib/hospital-data-adapter.mjs";
import { PatientEvolutionEngine } from "../plugins/medcius/lib/patient-evolution-engine.mjs";
import { loadSpecialtyRulePack, validateSpecialtyRulePack, rulePackDigest } from "../plugins/medcius/lib/specialty-rule-pack.mjs";
import { inspectEvidenceAnchor } from "../plugins/medcius/lib/evidence-anchors.mjs";
import { trackHighRiskFollowup } from "../plugins/medcius/lib/high-risk-followup-tracker.mjs";
const pack = loadSpecialtyRulePack("cardiology-inpatient-sandbox");
const clone = () => structuredClone(pack);
const now = new Date("2026-10-06T08:00:00Z");

test("electrolyte inclusive threshold matrix, units and changed policy affect real normalizer", () => {
  for (const [code, low, high] of [["k",2.8,6.2],["na",120,160]]) {
    for (const [value, count] of [[low-0.01,1],[low,1],[low+0.01,0],[high-0.01,0],[high,1],[high+0.01,1]]) {
      const lab = [{ id: "lab", code, value, unit: "mmol/L", sample_time: now.toISOString(), status: "final" }];
      assert.equal(HospitalDataAdapter.normalizeLisFeed(lab, { rulePack: pack }).critical_values.length, count, `${code} ${value}`);
      assert.equal(HospitalDataAdapter.normalizeLisFeed(lab).critical_values.length, 0);
    }
  }
  const modified = clone(); modified.clinical_rules.critical_values.k.high = 7;
  const lab = [{id:"k",code:"k",value:6.3,unit:"mmol/L",status:"final",sample_time:now.toISOString()}];
  assert.equal(HospitalDataAdapter.normalizeLisFeed(lab,{rulePack:pack}).critical_values.length,1);
  assert.equal(HospitalDataAdapter.normalizeLisFeed(lab,{rulePack:modified}).critical_values.length,0);
  assert.equal(HospitalDataAdapter.normalizeLisFeed([{...lab[0],unit:"mg/dL"}],{rulePack:pack}).critical_values.length,0);
  for (const invalid of [null, "", true, NaN]) assert.equal(HospitalDataAdapter.normalizeLisFeed([{...lab[0],value:invalid}],{rulePack:pack}).critical_values.length,0);
  assert.equal(normalizeLabUnit(1, "mg/dL", "umol/L", "scr").comparableValue,88.4);
  assert.equal(normalizeLabUnit(90.09, "mg/dL", "mmol/L", "glu").comparableValue,5);
});

test("renal calculation guard responds to pack policy and carries content digest", () => {
  const input = { patient:{id:"p",age:50,gender:"male"}, now, notes:[], observations:[
    {id:"b",code:"scr",value:100,unit:"umol/L",status:"final",effective_time:"2026-10-05T12:00:00Z"},
    {id:"n",code:"scr",value:130,unit:"umol/L",status:"final",effective_time:"2026-10-06T07:00:00Z"},
  ] };
  const conservative = PatientEvolutionEngine.analyzePatientEvolution(input);
  assert.equal(conservative.patient.egfr,null);
  const changed = clone(); changed.clinical_rules.renal_stability={absolute_rise_umol_l:40,relative_rise:0.8};
  const result = PatientEvolutionEngine.analyzePatientEvolution({...input,rulePack:changed});
  assert.ok(result.patient.egfr > 0);
  assert.equal(result.rule_provenance.sha256,rulePackDigest(changed));
  assert.notEqual(result.rule_provenance.sha256,pack.sha256);
  assert.ok(result.calculation_provenance.sha256);
  for (const age of [0,12,17]) assert.equal(calculateEgfrCkdEpi(88.4,age,"male"),null);
  assert.equal(calculateEgfrCkdEpi(88.4,50,"unknown"),null);
  // Independent hand-calculated examples, not values obtained from the function.
  assert.ok(Math.abs(calculateEgfrCkdEpi(88.4,50,"male")-91.7)<0.2);
  assert.ok(Math.abs(calculateEgfrCkdEpi(88.4,50,"female")-68.6)<0.2);
});

test("NEWS2 boundaries and aggregate risk priority", () => {
  const normal={respiration_rate:16,spo2:98,supplemental_oxygen:false,systolic_bp:120,heart_rate:70,consciousness:"A",temperature:37};
  const cases={respiration_rate:[[8,3],[9,1],[11,1],[12,0],[20,0],[21,2],[24,2],[25,3]],spo2:[[91,3],[92,2],[93,2],[94,1],[95,1],[96,0]],systolic_bp:[[90,3],[91,2],[100,2],[101,1],[110,1],[111,0],[219,0],[220,3]],heart_rate:[[40,3],[41,1],[50,1],[51,0],[90,0],[91,1],[110,1],[111,2],[130,2],[131,3]],temperature:[[35,3],[35.1,1],[36,1],[36.1,0],[38,0],[38.1,1],[39,1],[39.1,2]]};
  for(const [field,rows] of Object.entries(cases)) for(const [v,s] of rows) assert.equal(calculateNews2({...normal,[field]:v}).subscores[field],s,`${field}=${v}`);
  assert.equal(calculateNews2({...normal,respiration_rate:25,supplemental_oxygen:true}).risk_code,"MEDIUM");
  assert.equal(calculateNews2({...normal,spo2:null}).score,null);
});

test("follow-up has no deadline without a pack and changes with the approved policy input", () => {
  const obs=[{id:"o",code:"k",is_critical:true,status:"final",resulted_at:"2026-10-06T07:00:00Z"}];
  assert.equal(trackHighRiskFollowup({observations:obs,now}).items[0].due_minutes,null);
  assert.equal(trackHighRiskFollowup({observations:obs,now,rulePack:pack}).items[0].overdue,true);
  const changed=clone(); changed.clinical_rules.followup[0].due_minutes.resulted=90;
  assert.equal(trackHighRiskFollowup({observations:obs,now,rulePack:changed}).items[0].overdue,false);
});

test("pack rejects expired, cross-site, missing approval and invalid numeric policy", () => {
  assert.throws(()=>{pack.clinical_rules.critical_values.k.high=100;},TypeError);
  const p=clone(); p.data_class="official"; p.status="approved"; p.authority={...p.authority,approved_by:"fixture-only",hospital_scope:"site",approval_document:"synthetic-approval",approval_sha256:"a".repeat(64)};
  assert.equal(validateSpecialtyRulePack(p,{production:true,hospitalScope:"site",now}).ok,true); // Metadata contract, not actual approval.
  assert.equal(validateSpecialtyRulePack(p,{production:true,hospitalScope:"other",now}).ok,false);
  p.authority.review_due="2026-01-01";
  assert.equal(validateSpecialtyRulePack(p,{production:true,now}).ok,false);
  const malformed=clone(); malformed.clinical_rules.followup[0].due_minutes.resulted=-1;
  assert.equal(validateSpecialtyRulePack(malformed).ok,false);
});

test("verbatim offsets require exact unique source; structured references and gaps stay distinct", () => {
  const note={id:"n",text:"前文：否认胸痛。"};
  assert.equal(inspectEvidenceAnchor({source_id:"n",span:"否认胸痛"},[note]).highlight.start,3);
  assert.equal(inspectEvidenceAnchor({source_id:"n",span:"存在胸痛"},[note]).anchor_status,"unverified");
  assert.equal(inspectEvidenceAnchor({source_id:"wrong",span:"否认胸痛"},[note]).anchor_status,"unverified");
  assert.equal(inspectEvidenceAnchor({source_id:"n",span:"否认胸痛"},[note,note]).anchor_status,"ambiguous");
  assert.equal(inspectEvidenceAnchor({source_id:"o"},[{id:"o",value:1}]).anchor_status,"resource_linked");
  assert.equal(inspectEvidenceAnchor({category:"DATA_GAP"},[]).anchor_status,"not_applicable");
  const derived={source_type:"MultiSourceCrossAlignment",source_references:[{source_id:"o"}]};
  assert.equal(inspectEvidenceAnchor(derived,[{id:"o"}]).anchor_status,"sources_linked");
  assert.equal(inspectEvidenceAnchor(derived,[]).anchor_status,"unverified");
  assert.equal(inspectEvidenceAnchor({...derived,source_references:[{source_id:null}]},[{id:"o"}]).anchor_status,"unverified");
});
