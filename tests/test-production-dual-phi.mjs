// Synthetic end-to-end production boundary tests. No HIS or model API is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HospitalAgentAdapter, getPreRoundResearchSnapshot } from '../plugins/medcius/lib/hospital-agent-adapter.mjs';
import { PatientEvolutionEngine } from '../plugins/medcius/lib/patient-evolution-engine.mjs';
import { createPatientSourceSnapshot, createPatientSourceSnapshotAsync, assertPatientSourceSnapshot } from '../plugins/medcius/lib/patient-source-snapshot.mjs';
import { EnhancedPhiGuard } from '../plugins/medcius/lib/enhanced-phi-guard.mjs';
import { createPhiEntitySession } from '../plugins/medcius/lib/phi-entity-session.mjs';
import { createLlmInferenceClient } from '../plugins/medcius/lib/llm-inference-config.mjs';
import { resolvePhiDetector } from '../plugins/medcius/lib/phi-runtime.mjs';
import { ReadOnlyHospitalDataBridge } from '../plugins/medcius/lib/read-only-hospital-data-bridge.mjs';
import { withPhiExitGuard } from '../plugins/medcius/lib/connectors/phi-exit-guard.mjs';
import { saveFrozenResearchRecord, saveFrozenResearchRecordAsync, readFrozenResearchRecordAsync, replayFrozenResearchRecordAsync } from '../plugins/medcius/lib/silent-research-archive.mjs';
import { sha256Hex } from '../plugins/medcius/servers/shared/crypto.mjs';
import { guardPhiValue } from '../plugins/medcius/lib/phi-value-guard.mjs';
import { toModelSafe, containsRawStructuredPhi, mayContainStructuredJson } from '../plugins/medcius/lib/clinical-boundary.mjs';

const context = { tenant_id:'synthetic-site', doctor_id:'synthetic-doctor', patient_id:'synthetic-patient', encounter_id:'synthetic-encounter', as_of:'2026-11-02T12:00:00Z' };
const source = () => ({context:{...context}, patient:{id:context.patient_id,name:'赵宁',contact:[{name:'李芳'}]}, encounter:{id:context.encounter_id},
  asOf:context.as_of, notes:[{id:'synthetic-note',patient_id:context.patient_id,encounter_id:context.encounter_id,
    timestamp:'2026-11-02T11:00:00Z',text:'王建国因胸痛入院。赵宁自述胸闷，李芳陪同。'}], nis:[],lis:[],pacs:[],his_orders:[]});
const fake = Object.freeze({execution:'local',device:'cpu',id:'claimed-onnx',version:'v1',
  async detect(text){return {complete:true,text_sha256:sha256Hex(text),spans:[]};}});
const config = topology => ({topology,model_id:'synthetic',model_version:'v1',prompt_pack_version:'v1',endpoint:'https://example.invalid',
  desensitization_attestation:true,phi_exit_guard_version:'v1',egress_human_sampling_attested:true,bare_name_limitation_acknowledged:true});

test('production dual-track: no sync, callback, cached-model or topology bypass', async t => {
  const modelDirectory = process.env.MEDCIUS_CN_NER_MODEL_DIR;
  assert.ok(modelDirectory, 'MEDCIUS_CN_NER_MODEL_DIR is REQUIRED for the complete production regression');
  const previous = {profile:process.env.MEDCIUS_PROFILE,node:process.env.NODE_ENV,data:process.env.CLAUDE_MEDCIUS_DATA};
  process.env.CLAUDE_MEDCIUS_DATA = mkdtempSync(join(tmpdir(),'medcius-production-phi-'));
  process.env.MEDCIUS_PROFILE='demo'; process.env.NODE_ENV='test';
  const legacy = createPatientSourceSnapshot(source());
  const clientMadeInDemo = createLlmInferenceClient({config:config('A'),localPhiDetector:fake,transport:async()=>{throw new Error('must not send');}});
  process.env.MEDCIUS_PROFILE='production';
  const session = createPhiEntitySession(source());
  let detector;
  try {
    await t.test('all legacy entry points and pre-production snapshots are blocked', () => {
      for(const fn of [()=>createPatientSourceSnapshot(source(),{phiPolicy:'dictionary'}),
        ()=>EnhancedPhiGuard.sanitize('正文',{context:{...context,profile:'demo'}}),
        ()=>HospitalAgentAdapter.executePreRoundWorkflow({context:{...context,profile:'demo'},dataFeeds:source()}),
        ()=>HospitalAgentAdapter.routeAndExecuteWorkflow({context,skillId:'patient-evolution-summary',dataFeeds:source()}),
        ()=>PatientEvolutionEngine.analyzePatientEvolution({context,patient:source().patient}),
        ()=>saveFrozenResearchRecord({}),()=>assertPatientSourceSnapshot(legacy)]) assert.throws(fn,/PHI_PRODUCTION/);
    });
    await t.test('empty detectors and cloned metadata cannot impersonate a loaded model', async () => {
      await assert.rejects(createPatientSourceSnapshotAsync(source(),{detector:fake}),/VERIFIED_NER_REQUIRED/);
      await assert.rejects(clientMadeInDemo.extract({text:'王建国入院',context,entitySession:session}),/VERIFIED_NER_REQUIRED/);
      for(const topology of ['A','B']) assert.throws(()=>createLlmInferenceClient({config:config(topology),localPhiDetector:fake,transport:async()=>({text:''})}),/VERIFIED_NER_REQUIRED/);
    });
    await t.test('missing model blocks before source read and model transport', async () => {
      delete process.env.MEDCIUS_CN_NER_MODEL_DIR;
      let reads=0, sends=0;
      await assert.rejects(HospitalAgentAdapter.executePreRoundFromBridge({context,bridge:{async readPatientSnapshot(){reads++;}}}),/MODEL_REQUIRED/);
      const bridge=new ReadOnlyHospitalDataBridge({connectors:[{id:'synthetic',kind:'patient',capabilities:['read'],async readPatient(){reads++;}}]});
      await assert.rejects(bridge.readPatientSnapshot({...context,profile:'demo'}),/MODEL_REQUIRED/);
      for(const topology of ['A','B']) {
        const c=createLlmInferenceClient({config:config(topology),transport:async()=>{sends++;return {text:'unsafe'};}});
        await assert.rejects(c.extract({text:'王建国入院',context,entitySession:session}),/MODEL_REQUIRED/);
      }
      assert.equal(reads,0);assert.equal(sends,0);
      process.env.MEDCIUS_CN_NER_MODEL_DIR=modelDirectory;
    });
    detector=await resolvePhiDetector();
    await t.test('corrupt/replaced assets never reuse the previous cached model', async () => {
      const invalid=mkdtempSync(join(tmpdir(),'medcius-invalid-ner-'));writeFileSync(join(invalid,'config.json'),'{}');
      process.env.MEDCIUS_CN_NER_MODEL_DIR=invalid;
      await assert.rejects(resolvePhiDetector(),/LOAD_FAILED/);
      delete process.env.MEDCIUS_CN_NER_MODEL_DIR;
      await assert.rejects(resolvePhiDetector(),/MODEL_REQUIRED/);
      process.env.MEDCIUS_CN_NER_MODEL_DIR=modelDirectory;
      await assert.rejects(resolvePhiDetector({detector:{...detector}}),/VERIFIED_NER_REQUIRED/);
    });
    await t.test('A and B scan prompt and generated response; patient/session mismatch is blocked', async () => {
      for(const topology of ['A','B']) {
        let sent;
        const c=createLlmInferenceClient({config:config(topology),localPhiDetector:detector,
          transport:async req=>{sent=req.prompt;return {text:'林志明主诉咳嗽，居住于和平路28号3栋602室。赵宁。'};}});
        await assert.rejects(c.extract({text:'王建国入院',context}),/SESSION/);
        await assert.rejects(c.extract({text:'王建国入院',context:{...context,patient_id:'other'},entitySession:session}),/SESSION/);
        const result=await c.extract({text:source().notes[0].text,context,entitySession:session});
        assert.doesNotMatch(sent,/王建国|赵宁|李芳/);
        assert.doesNotMatch(result.text,/林志明|和平路|28号|602室|赵宁/);
        assert.equal(result.egress_receipt.assurance,'dual_track_executed');
      }
    });
    await t.test('clinical literals remain readable; dynamic patient names override the fixed lexicon', async () => {
      const text='替格瑞洛片：来源状态未知或未识别，无法确认结果与闭环阶段。王建国因胸痛入院。';
      const guarded=await EnhancedPhiGuard.sanitizeDual(text,{detector,entitySession:session,context});
      assert.match(guarded.sanitized,/替格瑞洛片/);assert.doesNotMatch(guarded.sanitized,/王建国/);
      const named=createPhiEntitySession({...source(),patient:{id:context.patient_id,name:'格瑞洛'}});
      try { assert.doesNotMatch((await EnhancedPhiGuard.sanitizeDual(text,{detector,entitySession:named,context})).sanitized,/格瑞洛/); }
      finally { named.dispose(); }
      const data=source(); data.notes[0].result_status='unknown'; data.notes[0].free_text='王建国因胸痛入院。';
      data.notes[0].metadata_id='林志明主诉咳嗽。';
      const snap=await createPatientSourceSnapshotAsync(data,{detector});
      assert.equal(snap.records.notes[0].record.result_status,'unknown');
      assert.doesNotMatch(JSON.stringify(snap),/王建国|林志明/);
      // Marker prefixes are impossible JSON, not evidence that text is safe.
      // All trailing free text must still undergo deterministic AND actual NER.
      for (const marker of ['[ID:name:REDACTED]','[PSN:1234abcd]','[REDACTED:PERSON]']) {
        const raw=` \t${marker} 王建国因胸痛入院。联系电话13900001111。`;
        assert.equal(mayContainStructuredJson(raw),false);
        assert.equal(containsRawStructuredPhi(raw).hit,true);
        assert.doesNotMatch(toModelSafe(raw),/13900001111/);
        assert.doesNotMatch(await guardPhiValue(raw,{detector}),/王建国|13900001111/);
        const nested=JSON.stringify([{name:'赵宁',note:raw,inner:JSON.stringify({name:'李芳'})}]);
        assert.equal(mayContainStructuredJson(nested),true);
        assert.equal(containsRawStructuredPhi(nested).hit,true);
        assert.doesNotMatch(await guardPhiValue(nested,{detector}),/王建国|13900001111|赵宁|李芳/);
      }
      for(const value of [[],{},[true,false,null,1,-2,[],{}],['[ID:name:REDACTED]'],{'[PSN:1234abcd]':'value'}])
        assert.equal(mayContainStructuredJson(` \r\n${JSON.stringify(value)}`),true);
    });
    await t.test('connector exit seeds the dictionary before sealing identity; optional PHI failure is fatal', async () => {
      const connector=(kind,records)=>({id:`synthetic-${kind}`,kind,capabilities:['read'],async readPatient(){return {...context,records,fetched_at:context.as_of};}});
      const connectors=[connector('patient',[source().patient]),connector('encounter',[source().encounter]),connector('notes',source().notes)]
        .map(c=>withPhiExitGuard(c,{salt:'synthetic-only-salt'}));
      const bridge=new ReadOnlyHospitalDataBridge({connectors,localPhiDetector:detector});
      const snap=await bridge.readPatientSnapshot(context);
      assert.doesNotMatch(JSON.stringify(snap),/王建国|赵宁|李芳/);
      assert.equal(snap.phi_guard.ner_status,'EXECUTED');assert.equal(snap.security_contract.model_safe,true);
      const bad={id:'synthetic-optional',kind:'notes',capabilities:['read'],async readPatient(){throw new Error('LOCAL_NER_INFERENCE_FAILED');}};
      await assert.rejects(new ReadOnlyHospitalDataBridge({connectors:[...connectors,bad],localPhiDetector:detector}).readPatientSnapshot(context),/PHI_BRIDGE_GUARD_FAILED/);
      const coded={...bad,async readPatient(){throw Object.assign(new Error('detector unavailable'),{code:'LOCAL_NER_INFERENCE_FAILED'});}};
      await assert.rejects(new ReadOnlyHospitalDataBridge({connectors:[...connectors,coded],localPhiDetector:detector}).readPatientSnapshot(context),/PHI_BRIDGE_GUARD_FAILED/);
      await assert.rejects(withPhiExitGuard(connector('notes',source().notes),{salt:'synthetic-only-salt',mode:'assert'})
        .readPatient(context,{localPhiDetector:detector}),/PHI_EXIT_GUARD_RAW_PHI_BLOCKED/);
    });
    await t.test('async snapshots, pre-round and immutable archive replay share guarded evidence', async () => {
      const snap=await createPatientSourceSnapshotAsync(source(),{detector});assertPatientSourceSnapshot(snap);
      assert.doesNotMatch(JSON.stringify(snap),/王建国|赵宁|李芳/);
      const result=await HospitalAgentAdapter.executePreRoundWorkflowAsync({host:'his_embed',context,dataFeeds:source(),localPhiDetector:detector});
      const research=getPreRoundResearchSnapshot(result);
      assert.doesNotMatch(JSON.stringify(research),/王建国|赵宁|李芳/);
      const args={tenantId:context.tenant_id,patientId:context.patient_id,encounterId:context.encounter_id,asOf:context.as_of,
        governanceStage:'silent_pilot',sourceMode:'authorized_bridge',...research};
      const saved=await saveFrozenResearchRecordAsync(args,{localPhiDetector:detector});
      const replay=await replayFrozenResearchRecordAsync(saved.case_id,{tenantId:context.tenant_id,localPhiDetector:detector});assert.equal(replay.match,true);
      const record=await readFrozenResearchRecordAsync(saved.case_id,{tenantId:context.tenant_id,localPhiDetector:detector});
      assert.doesNotMatch(JSON.stringify(record),/王建国|赵宁|李芳/);
      const before=readdirSync(process.env.CLAUDE_MEDCIUS_DATA,{recursive:true});
      const aborted=new AbortController();aborted.abort();
      await assert.rejects(saveFrozenResearchRecordAsync(args,{localPhiDetector:detector,signal:aborted.signal}),/PHI_SOURCE_GUARD_FAILED/);
      assert.deepEqual(readdirSync(process.env.CLAUDE_MEDCIUS_DATA,{recursive:true}),before);
    });
    await t.test('real inference timeout and disposed model cannot fall back to regex', async () => {
      const {createLocalChineseNer}=await import('../plugins/medcius/lib/local-cn-ner.mjs');
      const slow=await createLocalChineseNer({modelDirectory,timeoutMs:1,maxTokens:64});let sends=0;
      const c=createLlmInferenceClient({config:config('A'),localPhiDetector:slow,transport:async()=>{sends++;return {text:'bad'};}});
      await assert.rejects(c.extract({text:'王建国主诉胸痛。'.repeat(300),context,entitySession:session}),/LOCAL_PHI_DETECTOR_FAILED/);
      assert.equal(sends,0);
      // A native run may still be stopping after its deadline. No retry/send.
      for(let i=0;i<50;i++){try{await slow.close();break;}catch{await new Promise(r=>setTimeout(r,10));}}
      await detector.close();
      await assert.rejects(createPatientSourceSnapshotAsync(source(),{detector}),/VERIFIED_NER_REQUIRED/);
    });
  } finally {
    session.dispose();process.env.MEDCIUS_CN_NER_MODEL_DIR=modelDirectory;
    for(const [key,value] of Object.entries({MEDCIUS_PROFILE:previous.profile,NODE_ENV:previous.node,CLAUDE_MEDCIUS_DATA:previous.data})) {
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
});
