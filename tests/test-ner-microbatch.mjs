// Actual pinned CPU inference. Synthetic identities only; no remote calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createLocalChineseNer,createLocalChineseNerPool,detectManyLocalChineseNer,getLocalNerDiagnostics,isVerifiedLocalChineseNer} from '../plugins/medcius/runtimes/cn-phi-ner/detector.mjs';
import {createPatientSourceSnapshotAsync,getPatientSnapshotPhiSession} from '../plugins/medcius/lib/patient-source-snapshot.mjs';
import {guardFreeTextEgress} from '../plugins/medcius/lib/local-phi-egress.mjs';
import {createPhiEntitySession} from '../plugins/medcius/lib/phi-entity-session.mjs';
import {withPhiInferenceScope,detectWithinPhiScope} from '../plugins/medcius/lib/phi-inference-scope.mjs';
import {phiRuntimeOptions} from '../plugins/medcius/lib/phi-runtime.mjs';
const modelDirectory=process.env.MEDCIUS_CN_NER_MODEL_DIR;
const context=i=>({profile:'production',tenant_id:`synthetic-tenant-${i%2}`,ward_id:`w-${i%4}`,
  patient_id:`p-${i}`,encounter_id:`e-${i}`,phi_session_id:`s-${i}`});
const source=i=>({context:context(i),asOf:'2026-11-15T00:00:00Z',patient:{id:`p-${i}`,name:i%2?'郄芃':'𠮷玥'},encounter:{id:`e-${i}`},
  notes:[{id:`n-${i}`,timestamp:'2026-11-14T23:00:00Z',text:'郄芃诉胸闷，𠮷玥无发热。瘰疬无压痛，血钾3.9mmol/L。'}]});

test('microbatch options require a pool and reject invalid or oversubscribed limits',async()=>{
  const env={MEDCIUS_CN_NER_PROCESSES:'2',MEDCIUS_CN_NER_MICROBATCH_REQUESTS:'8',MEDCIUS_CN_NER_MAX_OUTSTANDING_UTF16:'1000000'};
  assert.deepEqual(phiRuntimeOptions(env),{processes:2,microBatchMaxRequests:8,maxOutstandingUtf16:1000000});
  assert.equal(phiRuntimeOptions({...env,MEDCIUS_CN_NER_MICROBATCH_WAIT_MS:'0'}).microBatchWaitMs,0);
  for(const key of ['MEDCIUS_CN_NER_MICROBATCH_REQUESTS','MEDCIUS_CN_NER_MAX_OUTSTANDING_REQUESTS','MEDCIUS_CN_NER_MAX_OUTSTANDING_TEXTS'])
    assert.throws(()=>phiRuntimeOptions({[key]:'2'}),/CONFIGURATION/);
  assert.throws(()=>phiRuntimeOptions({MEDCIUS_CN_NER_PROCESSES:'2',MEDCIUS_CN_NER_MAX_OUTSTANDING_REQUESTS:'128'}),/CONFIGURATION/);
  for(const options of [{microBatchMaxRequests:9},{microBatchWaitMs:11},{maxOutstandingRequests:257},{maxOutstandingUtf16:2000001},{maxOutstandingTexts:16385}])
    await assert.rejects(createLocalChineseNerPool({modelDirectory,...options}),/LIMIT_INVALID/);
});

test('real microbatches preserve exact output, clinical text, patient isolation and fail-closed semantics',async t=>{
  const pool=await createLocalChineseNerPool({modelDirectory,processes:2,threads:2,batchWorkers:2,cpuBudget:8,microBatchMaxRequests:8});
  const reference=await createLocalChineseNer({modelDirectory,threads:1,batchWorkers:1});
  try {
    await t.test('mixed Unicode, unknown tokens, window lengths and duplicate text match single inference',async()=>{
      const texts=['','郄芃诉胸闷。','𠮷玥无发热。','瘰疬无压痛。','😀王建国因胸痛入院。','无发热。'.repeat(75)+'林志明胸闷。','A'.repeat(110),'B'.repeat(120)];
      const expected=[];for(const text of texts) expected.push(await reference.detect(text));
      assert.deepEqual(await Promise.all(texts.map(text=>pool.detect(text))),expected);
      const repeated=await Promise.all([pool.detect(texts[1]),pool.detect(texts[1])]);
      repeated[0].subject_screening.spans.length=0;assert.equal(repeated[1].subject_screening.spans.length,1);
      let before=getLocalNerDiagnostics(reference).completed_windows;
      await detectManyLocalChineseNer(reference,[texts[1],texts[1]],{partitions:[0,1]});
      assert.equal(getLocalNerDiagnostics(reference).completed_windows-before,2);
      before=getLocalNerDiagnostics(reference).completed_windows;
      await detectManyLocalChineseNer(reference,[texts[1],texts[1]],{partitions:[0,0]});
      assert.equal(getLocalNerDiagnostics(reference).completed_windows-before,1);
      await assert.rejects(detectManyLocalChineseNer(reference,texts,{partitions:[0]}),/LIMIT/);
    });
    await t.test('64 concurrent snapshots keep contexts/dictionaries separate and redact both rare names',async()=>{
      const results=await Promise.all(Array.from({length:64},async(_,i)=>({i,snapshot:await createPatientSourceSnapshotAsync(source(i),{detector:pool})})));
      for(const {i,snapshot} of results) {
        const serialized=JSON.stringify(snapshot),session=getPatientSnapshotPhiSession(snapshot,context(i));
        try {
          assert.doesNotMatch(serialized,/郄芃|𠮷玥/);assert.match(serialized,/瘰疬无压痛/);assert.match(serialized,/血钾3.9mmol\/L/);
          assert.equal(snapshot.context.patient_id,`p-${i}`);assert.equal(snapshot.phi_guard.ner_status,'EXECUTED');
          for(const key of ['tenant_id','ward_id','patient_id','encounter_id','phi_session_id'])
            assert.throws(()=>session.scan('郄芃',{...context(i),[key]:'wrong'}),/CONTEXT_MISMATCH/);
          // A supplemental guess must never become an identity dictionary entry.
          assert.equal(session.scan(i%2?'𠮷玥':'郄芃',context(i)).length,0);
        } finally {session.dispose();}
      }
      const q=getLocalNerDiagnostics(pool).queue;assert.equal(q.rejected_full,0);assert.equal(q.rejected_memory,0);
      assert.ok(q.peak_outstanding<=128);assert.ok(q.peak_retained_utf16<=1000000);assert.ok(q.peak_retained_texts<=8192);
      assert.ok(q.batch_size_histogram.some(b=>b.requests>1&&b.count>0));
    });
    await t.test('supplemental results stay source-bound and do not seed another note or replace NER',async()=>{
      const empty={...source(99),patient:{id:'p-99'},notes:[]},session=createPhiEntitySession(empty);
      try {
        for(const text of ['郄芃诉胸闷。','𠮷玥无发热。']) {
          const out=await guardFreeTextEgress(text,{detector:pool,context:empty.context,entitySession:session});
          assert.doesNotMatch(out.text,/郄芃|𠮷玥/);assert.equal(out.receipt.supplemental_subject_policy,'cn-oov-clinical-subject-v1');
          assert.ok(out.receipt.supplemental_subject_span_count>=1);assert.equal(out.receipt.complete_deidentification,'NOT_ESTABLISHED');
          assert.equal(session.scan(text,empty.context).length,0);
        }
        await assert.rejects(guardFreeTextEgress('郄芃诉胸闷。',{detector:{...pool},context:empty.context,entitySession:session}),/VERIFIED_NER_REQUIRED/);
      } finally {session.dispose();}
    });
    await t.test('cancelling an active caller leaves its batch sibling and native accounting intact',async()=>{
      const abort=new AbortController(),text='王建国无发热。'.repeat(200);
      const cancelled=pool.detect(text,{signal:abort.signal}),sibling=pool.detect('郄芃诉胸闷。'),otherLane=pool.detect('无发热。');
      for(let i=0;i<100&&!getLocalNerDiagnostics(pool).queue.active;i++) await delay(1);
      abort.abort();await assert.rejects(cancelled,/ABORTED/);
      assert.ok(getLocalNerDiagnostics(pool).queue.outstanding_requests>=1);
      assert.equal((await sibling).subject_screening.spans.length,1);
      await otherLane;
    });
    await t.test('actual process death rejects the whole batch and invalidates prior scope success',async()=>{
      const ctx=context(100);
      await assert.rejects(withPhiInferenceScope(ctx,pool,async()=>{
        await detectWithinPhiScope(pool,'无发热。',{context:ctx});
        const pending=Array.from({length:8},()=>pool.detect('王建国无发热。'.repeat(200))).map(p=>assert.rejects(p,/NOT_AVAILABLE|INFERENCE_FAILED/));
        for(let i=0;i<100&&!getLocalNerDiagnostics(pool).queue.active;i++) await delay(1);
        process.kill(getLocalNerDiagnostics(pool).worker_pids[0]);await Promise.all(pending);
        assert.equal(isVerifiedLocalChineseNer(pool),false);
        await assert.rejects(detectWithinPhiScope(pool,'无发热。',{context:ctx}),/NOT_AVAILABLE/);
      }),/SCOPE_FAILED/);
    });
  } finally {await pool.close();await reference.close();}
  assert.equal(getLocalNerDiagnostics(pool).worker_pids.length,0);
});

test('actual microbatch deadline rejects all expired callers and close reaps native work',async()=>{
  const pool=await createLocalChineseNerPool({modelDirectory,processes:1,microBatchMaxRequests:8,timeoutMs:10});
  try {
    await Promise.all(Array.from({length:8},()=>assert.rejects(pool.detect('王建国胸痛。'.repeat(100)),/INFERENCE_FAILED/)));
    assert.equal(getLocalNerDiagnostics(pool).queue.expired,8);
    assert.ok(getLocalNerDiagnostics(pool).queue.active>0);
  } finally {await pool.close();}
  assert.equal(getLocalNerDiagnostics(pool).worker_pids.length,0);
});
