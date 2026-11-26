import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {availableParallelism} from 'node:os';
import {createLocalChineseNer,createLocalChineseNerPool,detectManyLocalChineseNer,getLocalNerDiagnostics,isVerifiedLocalChineseNer} from '../plugins/medcius/runtimes/cn-phi-ner/detector.mjs';
import {guardFreeTextEgress} from '../plugins/medcius/lib/local-phi-egress.mjs';
import {createPhiEntitySession} from '../plugins/medcius/lib/phi-entity-session.mjs';
import {withinClinicalLiteral} from '../plugins/medcius/lib/phi-clinical-literals.mjs';
import {validateContextSubjectSpans,CONTEXT_SUBJECT_POLICY,MAX_CONTEXT_SUBJECTS,MAX_CONTEXT_OCCURRENCES,findContextSubjectCandidates} from '../plugins/medcius/lib/phi-oov-subjects.mjs';
import {redactionCoverage} from '../scripts/measure-phi-clinical-development.mjs';
import {phiContextSubjectsV3} from './fixtures/phi-context-subjects-v3.mjs';
import {phiFixtureSource} from './fixtures/phi-clinical-development.mjs';
import {createPatientSourceSnapshotAsync,getPatientSnapshotPhiSession} from '../plugins/medcius/lib/patient-source-snapshot.mjs';
const modelDirectory=process.env.MEDCIUS_CN_NER_MODEL_DIR,hash=t=>createHash('sha256').update(t).digest('hex');

test('clinical protection requires exact medication grammar and cannot shield arbitrary identities or identifiers',()=>{
  for(const text of ['杜仲无发热。','患者杜仲无发热。','姓名：杜仲','杜仲10g。','中药处方：患者杜仲10g。','伪中药处方：杜仲10g。',
    '伪中药处方：'+' '.repeat(251)+'杜仲10g。','中药处方：杜仲10g患者入院。']) {
    const start=text.indexOf('杜仲');assert.equal(withinClinicalLiteral(text,{start,end:start+2,label:'PERSON'}),false,text);
  }
  for(const text of ['中药处方：杜仲10g。','服用刘寄奴后无发热。','口服徐长卿后无发热。']) {
    const word=text.includes('杜仲')?'杜仲':text.includes('刘寄奴')?'刘寄奴':'徐长卿',start=text.indexOf(word);
    assert.equal(withinClinicalLiteral(text,{start,end:start+word.length,label:'PERSON'}),true);
    for(const label of ['IDENTIFIER','CONTACT','ADDRESS','ORGANIZATION']) assert.equal(withinClinicalLiteral(text,{start,end:start+word.length,label}),false);
    assert.equal(withinClinicalLiteral(text,{start,end:text.length,label:'PERSON'}),false);
  }
  assert.equal(withinClinicalLiteral('中药处方：杜仲10g。',{start:0,end:2,label:'ADDRESS'}),true);
  assert.equal(withinClinicalLiteral('姓名：中药处方',{start:3,end:7,label:'PERSON'}),false);
});

test('context crop receipts reject incomplete, mismatched, oversized, duplicate and foreign-source evidence',async()=>{
  const text='郤珺无发热。',span={start:0,end:2,label:'PERSON',method:'source_crop_ner',probe_text_sha256:hash('郤珺')};
  const screening={policy:CONTEXT_SUBJECT_POLICY,complete:true,probe_count:1,candidate_count:1,spans:[span]};
  assert.equal(validateContextSubjectSpans(text,screening).length,1);
  for(const invalid of [{...screening,complete:false},{...screening,probe_count:0},{...screening,probe_count:65},
    {...screening,policy:'forged'},{...screening,spans:[{...span,probe_text_sha256:hash('王珺')}]},
    {...screening,spans:[{...span,end:999}]},{...screening,candidate_count:513},{...screening,candidate_count:2,spans:[span,span]}]) {
    assert.throws(()=>validateContextSubjectSpans(text,invalid),/RESULT_INVALID/);
    const detector={id:'synthetic',version:'v1',execution:'local',async detect(t){return {complete:true,text_sha256:hash(t),spans:[],context_subject_screening:invalid};}};
    await assert.rejects(guardFreeTextEgress(text,{detector}),/RESULT_INVALID/);
  }
});

test('repeated text cannot hide a clinical deletion at a different source position',()=>{
  const original='中药处方：杜仲10g。患者杜仲无发热。';
  const correct=redactionCoverage(original,'中药处方：杜仲10g。患者[REDACTED:LOCAL_ENTITY]无发热。');
  const wrong=redactionCoverage(original,'中药处方：[REDACTED:LOCAL_ENTITY]10g。患者杜仲无发热。');
  assert.ok(correct.slice(original.lastIndexOf('杜仲'),original.lastIndexOf('杜仲')+2).every(Boolean));
  assert.ok(correct.slice(0,11).every(x=>x===0));assert.ok(wrong.slice(0,11).some(Boolean));
});

test('actual CPU context review and clinical negative controls',async t=>{
  const detector=await createLocalChineseNer({modelDirectory,threads:1,batchWorkers:1});
  try {
    await t.test('two retained misses have full source-crop evidence while raw full-note NER still misses',async()=>{
      for(const text of ['郤珺诉胸闷。','郤珺无发热。']) {
        const result=await detector.detect(text);assert.equal(result.spans.length,0);
        assert.equal(result.context_subject_screening.probe_count,1);
        assert.deepEqual(validateContextSubjectSpans(text,result.context_subject_screening),[{start:0,end:2,label:'PERSON'}]);
      }
    });
    await t.test('all 125 fixed name/clinical controls preserve annotated positions without blocking',async()=>{
      for(const [i,f] of phiContextSubjectsV3.entries()) {
        const source=phiFixtureSource({...f,metadata:{}},i),session=createPhiEntitySession(source);
        try {
          const result=await guardFreeTextEgress(f.text,{detector,entitySession:session,context:source.context}),mask=redactionCoverage(f.text,result.text);
          for(const p of f.phi) assert.ok(mask.slice(p.start,p.end).every(Boolean),f.id);
          for(const literal of f.keep) {const at=f.text.indexOf(literal);assert.ok(mask.slice(at,at+literal.length).every(x=>x===0),f.id);}
        } finally {session.dispose();}
      }
      for(const text of ['患者黄疸无发热。','患者房颤无胸闷。','患者白细胞无明显异常。'])
        assert.equal((await guardFreeTextEgress(text,{detector})).text,text);
    });
    await t.test('crop review is fresh, partitioned by request and never adds patient identities',async()=>{
      const text='郤珺无发热。',before=getLocalNerDiagnostics(detector).context_probe_windows;
      const results=await detectManyLocalChineseNer(detector,[text,text],{partitions:[0,1]});
      assert.equal(getLocalNerDiagnostics(detector).context_probe_windows-before,2);
      results[0].context_subject_screening.spans.length=0;assert.equal(results[1].context_subject_screening.spans.length,1);
      const again=getLocalNerDiagnostics(detector).context_probe_windows;
      await detector.detect(text);assert.equal(getLocalNerDiagnostics(detector).context_probe_windows-again,1);
      const source=phiFixtureSource({metadata:{}},200),session=createPhiEntitySession(source);
      try {await guardFreeTextEgress(text,{detector,context:source.context,entitySession:session});assert.equal(session.scan(text,source.context).length,0);}
      finally {session.dispose();}
    });
    await t.test('exact crop inference already present in this request is reused, never a different patient input',async()=>{
      const text='郤珺无发热。',before=getLocalNerDiagnostics(detector).context_probe_windows;
      const a=await detectManyLocalChineseNer(detector,[text,'郤珺'],{partitions:[0,0]});
      assert.equal(getLocalNerDiagnostics(detector).context_probe_windows,before);
      assert.equal(a[0].context_subject_screening.reused_input_count,1);assert.equal(a[0].context_subject_screening.spans.length,1);
      const b=await detectManyLocalChineseNer(detector,[text,'郤珺'],{partitions:[0,1]});
      assert.equal(getLocalNerDiagnostics(detector).context_probe_windows-before,1);
      assert.equal(b[0].context_subject_screening.reused_input_count,0);assert.equal(b[0].context_subject_screening.spans.length,1);
    });
    await t.test('compact crop batches have the same source-bound predictions as single crops',async()=>{
      const texts=['郤珺无发热。','邢珺无发热。','令狐珺无发热。','郤\u200b 珺无发热。'];
      const reference=[];for(const text of texts) reference.push(await detector.detect(text));
      assert.deepEqual(await detectManyLocalChineseNer(detector,texts,{partitions:[0,1,2,3]}),reference);
    });
    await t.test('qualified herb protection cannot overrule supplied patient identity',async()=>{
      const text='中药处方：杜仲10g。患者杜仲无发热。';
      const a=phiFixtureSource({metadata:{patient:{name:'杜仲'}}},201),b=phiFixtureSource({metadata:{}},202);
      for(const [source,expected] of [[a,0],[b,1]]) {
        const session=createPhiEntitySession(source);
        try {const r=await guardFreeTextEgress(text,{detector,context:source.context,entitySession:session});assert.equal((r.text.match(/杜仲/g)??[]).length,expected);}
        finally {session.dispose();}
      }
    });
    await t.test('candidate budgets reject overflow rather than silently omitting privacy candidates',async()=>{
      assert.throws(()=>findContextSubjectCandidates('郤珺无发热。'.repeat(MAX_CONTEXT_OCCURRENCES+1),()=>false),/SUBJECT_LIMIT/);
      await assert.rejects(detectManyLocalChineseNer(detector,Array.from({length:MAX_CONTEXT_SUBJECTS+1},(_,i)=>'郤'+'\u200b'.repeat(i)+'珺无发热。')),/SUBJECT_LIMIT/);
      const repeated=await detector.detect('郤珺无发热。'.repeat(200));
      assert.ok(repeated.context_subject_screening.probe_count<=1);
      assert.equal(isVerifiedLocalChineseNer(detector),true); // invalid request, not a native failure
    });
    await t.test('failure during the crop-only native pass cannot return a raw-note clean fallback',async()=>{
      const post=Worker.prototype.postMessage;let injected=false;
      try {
        Worker.prototype.postMessage=function(m,...args){
          if(!injected&&m.rows?.some(r=>r.ids.length===4)) {injected=true;m=structuredClone(m);m.rows[0].ids[0]=9999999;}
          return post.call(this,m,...args);
        };
        await assert.rejects(guardFreeTextEgress('郤珺无发热。',{detector}),/DETECTOR_FAILED/);
        assert.equal(injected,true);assert.equal(isVerifiedLocalChineseNer(detector),false);
        await assert.rejects(detector.detect('无发热。'),/NOT_AVAILABLE/);
      } finally {Worker.prototype.postMessage=post;}
    });
  } finally {await detector.close();}
});

test('64 production requests with new context probes preserve patient binding and isolated dictionaries',async()=>{
  const detector=await createLocalChineseNerPool({modelDirectory,processes:2,batchWorkers:availableParallelism()>=4?2:1,microBatchMaxRequests:8});
  try {
    assert.equal(getLocalNerDiagnostics(detector).context_warmup,'SOURCE_CROP_EXECUTED');
    await Promise.all(Array.from({length:64},async(_,i)=>{
      const context={profile:'production',tenant_id:`t-${i%2}`,ward_id:`w-${i%4}`,patient_id:`p-${i}`,encounter_id:`e-${i}`,phi_session_id:`s-${i}`};
      const source={context,asOf:'2026-11-15T00:00:00Z',patient:{id:`p-${i}`},encounter:{id:`e-${i}`},
        notes:[{id:`n-${i}`,timestamp:'2026-11-14T23:00:00Z',text:'郤珺无发热。中药处方：杜仲10g。'}]};
      const snapshot=await createPatientSourceSnapshotAsync(source,{detector}),session=getPatientSnapshotPhiSession(snapshot,context);
      try {
        const encoded=JSON.stringify(snapshot);assert.doesNotMatch(encoded,/郤珺/);assert.match(encoded,/杜仲10g/);assert.match(encoded,/无发热/);
        assert.equal(snapshot.context.patient_id,context.patient_id);assert.equal(session.scan('郤珺',context).length,0);
        for(const key of ['tenant_id','ward_id','patient_id','encounter_id','phi_session_id'])
          assert.throws(()=>session.scan('郤珺',{...context,[key]:'other'}),/CONTEXT_MISMATCH/);
      } finally {session.dispose();}
    }));
    const q=getLocalNerDiagnostics(detector).queue;assert.equal(q.rejected_full+q.rejected_memory+q.expired,0);assert.ok(q.peak_outstanding<=128);
  } finally {await detector.close();}
  assert.equal(getLocalNerDiagnostics(detector).worker_pids.length,0);
});
