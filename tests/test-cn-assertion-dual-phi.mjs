// Synthetic engineering regressions only. No clinical recall claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractConTextAssertion, extractConTextAssertions, parseCnNote } from '../plugins/medcius/lib/parse-cn-note.mjs';
import { createPhiEntitySession, guardSessionValue } from '../plugins/medcius/lib/phi-entity-session.mjs';
import { EnhancedPhiGuard } from '../plugins/medcius/lib/enhanced-phi-guard.mjs';
import { createPatientSourceSnapshot, createPatientSourceSnapshotAsync, getPatientSnapshotPhiSession } from '../plugins/medcius/lib/patient-source-snapshot.mjs';
import { HospitalAgentAdapter, getPreRoundResearchSnapshot, replayPreRoundResearchSnapshot } from '../plugins/medcius/lib/hospital-agent-adapter.mjs';
import { inspectEvidenceAnchor } from '../plugins/medcius/lib/evidence-anchors.mjs';
import { sha256Hex } from '../plugins/medcius/servers/shared/crypto.mjs';
import { scanText } from '../plugins/medcius/servers/phiguard/src/lib.mjs';
import { decodeNerLogits } from '../plugins/medcius/runtimes/cn-phi-ner/detector.mjs';
import { createLlmInferenceClient } from '../plugins/medcius/lib/llm-inference-config.mjs';

const context = { tenant_id:'synthetic-site', patient_id:'patient-a', encounter_id:'encounter-a', phi_session_id:'session-a', doctor_id:'staff-a' };
const asOf = '2026-11-02T12:00:00Z';
const input = () => ({ context, asOf,
  patient: { id:context.patient_id, name:[{ family:'王', given:['伟'] }], name_variants:['王韦'],
    contact:[{name:{text:'李芳'}}], address:[{line:['合成市合成区青禾路28号3栋602室']}] },
  encounter: { id:context.encounter_id, participant:[{individual:{display:'陈明'}}], supervising_doctor:'赵宁', consulting_doctor:'周平' },
  notes: [{ id:'note-a', patient_id:context.patient_id, encounter_id:context.encounter_id, timestamp:asOf,
    text:'病程记录：王伟诉胸闷，王玮偶有咳嗽。李芳陪同，陈明查房。赵宁与周平讨论。住青禾路31号2栋101室。' }] });
const mentions = text => extractConTextAssertions(text).flatMap(x => x.mentions);
const emptyDetector = { execution:'local', id:'synthetic-empty-detector', version:'test-v1',
  async detect(text) { return { complete:true, text_sha256:sha256Hex(text), spans:[] }; } };

test('enumerated negation has explicit long-range cue links and stops at a new positive predicate', () => {
  for (const text of ['无发热、咳嗽、胸闷，偶有咳痰', '无发热、咳嗽、胸闷偶有咳痰']) {
    const m = mentions(text);
    assert.deepEqual(m.map(x=>x.presence), ['negative','negative','negative','positive']);
    for (const x of m) { assert.equal(text.slice(x.start,x.end), x.span); if (x.cue) assert.equal(text.slice(x.cue.start,x.cue.end),x.cue.text); }
    assert.equal(m[2].dependency,'coordinated_complement');
  }
  const m = mentions('否认' + '反复'.repeat(30) + '发热、盗汗、胸部压迫感，偶有咳痰');
  assert.deepEqual(m.map(x=>x.presence),['negative','negative','negative','positive']);
  assert.equal(m[2].cue.start,0);
});

test('question marks, R/O and postposed uncertainty do not turn a separate diagnosis into a suspect', () => {
  for (const text of ['肺炎？','？肺炎','肺炎?','R/O肺炎','r/o 肺炎','R / O 肺炎','肺炎待排','考虑肺炎可能']) assert.equal(extractConTextAssertion(text).presence,'uncertain',text);
  assert.deepEqual(mentions('肺炎？、高血压').map(m=>m.presence),['uncertain','positive']);
  assert.deepEqual(mentions('肺炎待排、糖尿病').map(m=>m.presence),['uncertain','positive']);
  assert.deepEqual(mentions('考虑肺炎、肺水肿').map(m=>m.presence),['uncertain','uncertain']);
  const p = parseCnNote('出院诊断：1. 肺炎？；2. 高血压');
  assert.equal(p.discharge_diagnosis_primary.value,null); assert.equal(p.discharge_diagnosis_other.value,'高血压');
});

test('historical surgery and recovery stay historical events, not current or negated disease', () => {
  const c = extractConTextAssertions('10年前行阑尾切除术，术后恢复可');
  assert.deepEqual(c.map(x=>x.temporality),['historical','historical']);
  assert.equal(c[0].presence,'positive'); assert.equal(c[1].clinical_status,'recovered');
  assert.equal(extractConTextAssertion('既往肺炎，已治愈').temporality,'historical');
  assert.equal(extractConTextAssertion('肺炎未完全治愈').clinical_status,'unknown');
  assert.equal(parseCnNote('出院诊断：既往肺炎已愈').discharge_diagnosis_primary.value,null);
  assert.equal(parseCnNote('手术名称：10年前行阑尾切除术').procedures.temporality,'historical');
});

test('section defaults and UTF16 anchors retain exact CRLF, astral and repeated content', () => {
  const text = '😀\r\n既往史：肺炎已愈\r\n家族史：母亲有高血压\r\n病程记录：无发热、咳嗽，偶有胸闷';
  const c = parseCnNote(text).assertion_clauses;
  assert.equal(c[0].temporality,'historical'); assert.equal(c[1].experiencer,'family_member');
  assert.equal(c[2].experiencer,'patient');
  for (const clause of c) {
    assert.equal(text.slice(clause.start,clause.end),clause.text);
    for (const m of clause.mentions) { assert.equal(text.slice(m.start,m.end),m.text); if(m.cue) assert.equal(text.slice(m.cue.start,m.cue.end),m.cue.text); }
  }
});

test('pseudo-negation, unevaluated findings, contrast and family subject remain separated', () => {
  for(const text of ['胸痛无缓解','无明显诱因出现胸痛','无创检查','四肢无力']) assert.equal(extractConTextAssertion(text).presence,'positive',text);
  assert.equal(extractConTextAssertion('未行胸部CT').presence,'not_evaluated');
  assert.deepEqual(mentions('母亲否认发热，患者偶有胸痛').map(x=>x.experiencer),['family_member','patient']);
  assert.deepEqual(extractConTextAssertions('未见啰音但偶有胸闷').map(x=>x.presence),['negative','positive']);
  assert.equal(extractConTextAssertion('不伴发热').presence,'negative');
});

test('session extraction covers FHIR names, variants, homophones, contacts, clinicians and street numbers', () => {
  const source = input(), s = createPhiEntitySession(source);
  const text = source.notes[0].text + '王韦来诊，😀王\u200b伟来诊。';
  const r = EnhancedPhiGuard.sanitize(text,{entitySession:s,context,mode:'REDACT'});
  assert.doesNotMatch(r.sanitized,/王伟|王玮|王韦|李芳|陈明|赵宁|周平|青禾路|31号|101室/);
  assert.match(r.sanitized,/胸闷/); assert.match(r.sanitized,/咳嗽/);
  assert.equal(EnhancedPhiGuard.sanitize(r.sanitized,{entitySession:s,context,mode:'REDACT'}).sanitized,r.sanitized);
  assert.doesNotMatch(JSON.stringify(s),/王|青禾路|wang|wei/);
  assert.doesNotMatch(JSON.stringify(r.detected_entities),/王|李|陈/);
});

test('sessions reject other tenants, patients, encounters, sessions and disposed handles without echoing PHI', () => {
  const s = createPhiEntitySession(input());
  for (const key of ['tenant_id','patient_id','encounter_id','phi_session_id']) assert.throws(()=>s.scan('王伟',{...context,[key]:'different'}),/PHI_SESSION_CONTEXT_MISMATCH/);
  assert.throws(()=>EnhancedPhiGuard.sanitize('王伟',{entitySession:s}),/CONTEXT/);
  s.dispose(); assert.throws(()=>s.scan('王伟',context),/DISPOSED/);
  const b = createPhiEntitySession({ context:{...context,patient_id:'patient-b'},patient:{id:'patient-b',name:'刘洋'},encounter:{id:context.encounter_id} });
  assert.equal(b.scan('王伟',{...context,patient_id:'patient-b'}).length,0);
});

test('later snapshots inject new clinician names into the same context-bound session', () => {
  const source=input(), s=createPhiEntitySession(source);
  const newer={...source,encounter:{...source.encounter,consulting_doctor:'刘洋'},notes:[{...source.notes[0],text:'刘阳查房，无发热。'}]};
  const snap=createPatientSourceSnapshot(newer,{entitySession:s});
  assert.doesNotMatch(JSON.stringify(snap),/刘洋|刘阳/);
  assert.ok(s.scan('王玮与刘阳',context).length >= 2);
  assert.throws(()=>s.inject({...newer,context:{...context,encounter_id:'another'}}),/CONTEXT_MISMATCH/);
  assert.throws(()=>HospitalAgentAdapter.executePreRoundWorkflow({host:'codex',context:{...context,as_of:asOf},dataFeeds:{...input(),encounter:{id:'wrong'}}}),/CONTEXT_MISMATCH/);
});

test('hosted extraction carries the private session into both prompt and response guards', async () => {
  const s=createPhiEntitySession(input()); let sent;
  const c=createLlmInferenceClient({config:{topology:'B',model_id:'synthetic',model_version:'v1',prompt_pack_version:'v1',endpoint:'https://example.invalid',
    desensitization_attestation:true,phi_exit_guard_version:'v1',egress_human_sampling_attested:true,bare_name_limitation_acknowledged:true},
    localPhiDetector:emptyDetector,transport:async r=>{sent=r.prompt;return {text:'王玮自述胸闷'};}});
  const result=await c.extract({text:'王玮自述胸闷',entitySession:s,context});
  assert.doesNotMatch(sent,/王玮/); assert.doesNotMatch(result.text,/王玮/);
  assert.equal(result.egress_receipt.assurance,'dual_track_executed');
});

test('structured dictionary is applied before source hashes and anchors, never returned inside snapshot', () => {
  const source = input(); source.notes[0].text = '病程记录：王玮诉胸闷，李芳陪同。';
  const snapshot = createPatientSourceSnapshot(source);
  assert.doesNotMatch(JSON.stringify(snapshot),/王玮|王伟|李芳|陈明|青禾路/);
  const entry = snapshot.records.notes[0];
  assert.equal(inspectEvidenceAnchor({ source_id:entry.record.id,span:entry.record.text,text_anchor:entry.evidence.text_anchor },[entry.record]).anchor_status,'verbatim_verified');
  assert.equal(snapshot.phi_guard.ner_status,'NOT_RUN');
  const session = getPatientSnapshotPhiSession(snapshot,context);
  assert.equal(session.scan('王玮',context).length > 0,true);
  assert.throws(()=>createPatientSourceSnapshot(source,{phiPolicy:'dual_track_required'}),/ASYNC_DUAL_TRACK/);
});

test('dynamic redaction preserves metadata and resolves overlaps without corrupting pseudonyms', () => {
  const s = createPhiEntitySession(input());
  const r = guardSessionValue({ text:'王伟及王玮', integrity:{ algorithm:'SHA-256', content_sha256:'a'.repeat(64) } },{session:s,context});
  assert.doesNotMatch(JSON.stringify(r),/王伟|王玮/);
  assert.equal(r.integrity.content_sha256,'a'.repeat(64));
  assert.equal(scanText('青禾路31号2栋101室').total,1);
  assert.equal(scanText('气道通畅，无尿路感染').total,0);
});

test('dual guard fails closed for missing, incomplete, unbound, aborted and throwing detectors', async () => {
  const s = createPhiEntitySession(input());
  await assert.rejects(EnhancedPhiGuard.sanitizeDual('王伟',{entitySession:s,context}),/DETECTOR_REQUIRED/);
  for (const detect of [async()=>({complete:false,spans:[]}),async()=>({complete:true,text_sha256:'wrong',spans:[]}),async()=>{throw new Error('王伟');}]) {
    await assert.rejects(EnhancedPhiGuard.sanitizeDual('王伟',{entitySession:s,context,detector:{...emptyDetector,detect}}),e=>/LOCAL_PHI/.test(e.message)&&!e.message.includes('王伟'));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(EnhancedPhiGuard.sanitizeDual('王伟',{entitySession:s,context,detector:emptyDetector,signal:controller.signal}),/ABORTED/);
});

test('async snapshot scans narrative before anchoring, preserves clinical names and fails on detector failure', async () => {
  const source=input(); source.medications=[{id:'med-a',name:'合成药物甲',timestamp:asOf,patient_id:context.patient_id,encounter_id:context.encounter_id}];
  const snapshot = await createPatientSourceSnapshotAsync(source,{detector:emptyDetector});
  assert.doesNotMatch(JSON.stringify(snapshot),/王伟|王玮|李芳|青禾路/);
  assert.equal(snapshot.phi_guard.assurance,'dual_track_executed');
  assert.equal(snapshot.records.medications[0].record.drug_name,'合成药物甲');
  await assert.rejects(createPatientSourceSnapshotAsync(source,{detector:{...emptyDetector,detect:async()=>{throw new Error('patient content');}}}),/PHI_SOURCE_GUARD_FAILED/);
});

test('async ingress cannot be rebound by caller mutation while awaiting a detector', async () => {
  const source = input(); let release;
  const gate = new Promise(r=>release=r);
  const pending = createPatientSourceSnapshotAsync(source,{detector:{...emptyDetector,async detect(text){await gate; return emptyDetector.detect(text);}}});
  source.notes[0].text='modified'; source.context={...context,patient_id:'different'}; release();
  const snapshot=await pending;
  assert.equal(snapshot.context.patient_id,context.patient_id);
  assert.doesNotMatch(JSON.stringify(snapshot),/modified/);
});

test('host async entry uses guarded notes for both clinical summary and reproducible source replay', async () => {
  const source=input();
  const result=await HospitalAgentAdapter.executePreRoundWorkflowAsync({host:'codex',context:{...context,as_of:asOf},dataFeeds:source,localPhiDetector:emptyDetector});
  assert.doesNotMatch(JSON.stringify(result),/王伟|王玮|李芳|陈明|青禾路/);
  assert.equal(result.phi_guard.assurance,'dual_track_executed');
  const snap=getPreRoundResearchSnapshot(result);
  assert.deepEqual(replayPreRoundResearchSnapshot(snap.replayInput),snap.engineOutput);
});

test('BIOES decoding handles orphan fragments conservatively and rejects malformed or nonfinite output', () => {
  const labels={0:'O',1:'B-PERSON',2:'I-PERSON',3:'E-PERSON',4:'S-LOC'};
  const tokens=[{start:2,end:3},{start:3,end:4},{start:4,end:5},{start:6,end:7}];
  const data=new Float32Array(6*5); [1,2,3,4].forEach((label,i)=>data[(i+1)*5+label]=10);
  assert.deepEqual(decodeNerLogits({dims:[1,6,5],data},tokens,labels),[{start:2,end:5,label:'PERSON'},{start:6,end:7,label:'ADDRESS'}]);
  data[8]=NaN; assert.throws(()=>decodeNerLogits({dims:[1,6,5],data},tokens,labels),/OUTPUT_INVALID/);
  assert.throws(()=>decodeNerLogits({dims:[1,2,5],data},tokens,labels),/OUTPUT_INVALID/);
});
