import assert from 'node:assert/strict';
import test from 'node:test';
import { PatientEvolutionEngine as Evolution } from '../plugins/medcius/lib/patient-evolution-engine.mjs';
import { HospitalAgentAdapter as Host } from '../plugins/medcius/lib/hospital-agent-adapter.mjs';
import { ConsultPreparationEngine as Consult } from '../plugins/medcius/lib/consult-preparation-engine.mjs';
import { ShiftHandoverEngine as Handover } from '../plugins/medcius/lib/shift-handover-engine.mjs';
import { DischargeReadinessEngine as Discharge } from '../plugins/medcius/lib/discharge-readiness-engine.mjs';
import { StagedDraftService as Views } from '../plugins/medcius/lib/staged-draft-service.mjs';
import { assertEvolutionConsistency, assertConsultConsistency, assertDischargeConsistency, assertHandoverConsistency } from '../plugins/medcius/lib/output-consistency.mjs';
import { dischargeFixture } from './fixtures/discharge-documentation.mjs';

const now = '2026-10-06T12:00:00Z';
const context = { tenant_id:'synthetic-t', doctor_id:'synthetic-d', patient_id:'synthetic-p', encounter_id:'synthetic-e', as_of:now };
const patient = { id:context.patient_id };
const base = { id:'synthetic-lab', code:'k', name:'血钾', status:'final', value:2, unit:'mmol/L', is_critical:true,
  version_id:'v1', effective_time:'2026-10-06T08:00:00Z', issued:'2026-10-06T09:00:00Z', _source:{system:'synthetic-lis'} };
const revised = {...base,version_id:'v2',value:3,updated_at:'2026-10-06T10:00:00Z'};
const source = {context,patient,encounter:{id:context.encounter_id,class:'IMP',status:'in-progress'},asOf:now,observations:[base,revised]};
const snapshot = Consult.createSnapshot(source);
const consult = () => Consult.prepareConsultDossier({snapshot,consultRequest:{department:'肾内科',purpose:'血钾'}});
const evolution = () => Evolution.analyzePatientEvolution({patient,now,observations:[base,revised]});
const handover = () => Handover.analyzePatientHandover({snapshot,windowStart:'2026-10-06T00:00:00Z'});

test('resolved revision agrees across records, labs, critical panel, glance, consultation, handover and discharge', () => {
  const d=evolution(), lab=d.blocks.what_changed.abnormal_labs[0], critical=d.critical_values[0];
  for (const row of [lab,critical,d.blocks.record_changes.items.find(r=>r.selection_status==='current')]) {
    assert.equal(row.result_status,'revised'); assert.equal(row.version_id,'v2'); assert.equal(row.change_type,'revision');
  }
  assert.equal(critical.value,lab.current_value);
  const v=Views.generateProgressiveViewsFromSummary(d);
  assert.match(v.glance.headline,/修订结果/);
  assert.deepEqual(v.digest.blocks.what_changed.critical_values,d.critical_values);
  const c=consult(); assert.equal(c.targeted_labs_timeline[0].result_status,'revised'); assert.match(Consult.generateConsultBriefText({consultDossier:c}),/已更正/);
  const h=handover(); assert.equal(h.sbar.assessment.source_observations[0].lifecycle.result_status,'revised');
  assert.equal(h.record_changes[0].lifecycle.result_status,'revised');
  assert.equal(h.high_risk_followup.items[0].record_states[0].result_status,'revised');
  const discharge=Discharge.evaluateDischargeReadiness({snapshot});
  assert.equal(discharge.domains.results.items[0].result_status,'revised');
});

test('source interpretation flag has identical critical meaning in all views, without inferred thresholds',()=>{
  const record={...base,is_critical:false,interpretation:'critical'};
  const d=Evolution.analyzePatientEvolution({patient,now,observations:[record]});
  assert.equal(d.critical_values.length,1); assert.equal(d.blocks.what_changed.abnormal_labs[0].is_critical,true);
  assert.match(d.critical_values[0].reason,/来源/); assert.doesNotMatch(d.critical_values[0].reason,/数值触发/);
  const c=Consult.prepareConsultDossier({...source,observations:[record],consultRequest:{department:'肾内科',purpose:'血钾'}});
  assert.equal(c.targeted_labs_timeline[0].source_critical,true);
});

test('host source gaps are selectable, counted and evidenced; no post-generation orphan rows',()=>{
  const d=Host.executePreRoundWorkflow({context,dataFeeds:{patient,encounter:source.encounter,nis:[{id:'undated-nis',temperature:37}],lis:[],pacs:[],his_orders:[],notes:[]}}).summary;
  assertEvolutionConsistency(d);
  for(const gap of d.blocks.data_gaps){
    assert.ok(d.selectable_items.some(r=>r.id===gap.id)); assert.ok(d.blocks.evidence.some(r=>r.item_id===gap.id));
  }
  assert.equal(d.total_items_count,d.selectable_items.length);
  assert.equal(new Set(d.selectable_items.map(r=>r.id)).size,d.total_items_count);
});

test('same counts and time cannot hide changed source values in host provenance',()=>{
  const make=value=>Host.executePreRoundWorkflow({context,dataFeeds:{patient,encounter:source.encounter,nis:[],lis:[{...base,value}],pacs:[],his_orders:[],notes:[]}});
  const a=make(2), b=make(2.1);
  assert.equal(a.summary.total_items_count,b.summary.total_items_count);
  assert.notEqual(a.provenance.envelope_sha256,b.provenance.envelope_sha256);
});

test('all current panels reject a cancelled replacement; permutations preserve selected state',()=>{
  const cancelled={...revised,status:'cancelled',cancelled_at:'2026-10-06T11:00:00Z'};
  for(const records of [[base,cancelled],[cancelled,base],[base,cancelled,base]]){
    const d=Evolution.analyzePatientEvolution({patient,now,observations:records});
    assert.equal(d.critical_values.length,0); assert.equal(d.blocks.what_changed.abnormal_labs.length,0); assertEvolutionConsistency(d);
    const c=Consult.prepareConsultDossier({...source,observations:records,consultRequest:{department:'肾内科',purpose:'血钾'}});
    assert.equal(c.targeted_labs_timeline.length,0); assert.equal(c.record_status_changes[0].result_status,'cancelled'); assertConsultConsistency(c);
  }
});

test('generated output cannot drift through aliases or later caller changes',()=>{
  const d=evolution(), c=consult(), h=handover(), f=dischargeFixture(), discharge=Discharge.evaluateDischargeReadiness(f.args);
  assert.throws(()=>{d.blocks.what_changed.abnormal_labs[0].current_value=999;},TypeError);
  assert.throws(()=>{c.views.digest.targeted_labs_timeline.items.pop();},TypeError);
  assert.throws(()=>{h.sbar.assessment.source_observations[0].record.value=999;},TypeError);
  assert.throws(()=>{discharge.domains.follow_up.items[0].record.purpose='changed';},TypeError);
  const previous=discharge.domains.follow_up.items[0].record.purpose;
  f.args.followUpPlans[0].purpose='caller changed';
  assert.equal(discharge.domains.follow_up.items[0].record.purpose,previous);
  assertHandoverConsistency(h); assertDischargeConsistency(discharge);
});

test('consistency guards reject contradictory counts, evidence, projections, responsibility and discharge conclusions',()=>{
  for(const mutate of [d=>d.total_items_count++,d=>d.blocks.data_gaps.pop(),d=>d.blocks.evidence.pop(),d=>{d.blocks.evidence[0].source_id='wrong';},d=>{d.blocks.what_changed.critical_values=[];}]){
    const d=structuredClone(evolution()); mutate(d); assert.throws(()=>assertEvolutionConsistency(d),/CONSISTENCY_FAILED/);
  }
  const c=structuredClone(consult()); c.views.glance.counts.targeted_labs_timeline++;
  assert.throws(()=>Consult.generateConsultBriefText({consultDossier:c}),/CONSISTENCY_FAILED/);
  const h=structuredClone(handover()); h.responsibility.current_responsible_doctor_id='forged-owner';
  assert.throws(()=>Handover.generateHandoverText({handoverData:h}),/CONSISTENCY_FAILED/);
  const d=structuredClone(Discharge.evaluateDischargeReadiness(dischargeFixture().args)); d.readiness_verdict.is_ready=true;
  assert.throws(()=>Discharge.generateDischargeChecklistText({readinessResult:d}),/CONSISTENCY_FAILED/);
});

test('progressive views cannot relabel one patient or time window as another',()=>{
  const d=evolution();
  assert.throws(()=>Views.generateProgressiveViewsFromSummary(d,{patient:{id:'different'}}),/PATIENT_MISMATCH/);
  assert.throws(()=>Views.generateProgressiveViewsFromSummary(d,{timeWindow:'72h'}),/TIME_WINDOW_MISMATCH/);
});
