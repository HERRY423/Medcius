// Real pinned CPU runtime in local processes; no remote calls or real patients.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {availableParallelism} from 'node:os';
import {createInferenceQueue} from '../plugins/medcius/runtimes/cn-phi-ner/inference-queue.mjs';
import {createLocalChineseNer,createLocalChineseNerPool,detectManyLocalChineseNer,getLocalNerDiagnostics,isVerifiedLocalChineseNer} from '../plugins/medcius/runtimes/cn-phi-ner/detector.mjs';
import {phiRuntimeOptions} from '../plugins/medcius/lib/phi-runtime.mjs';
import {withPhiInferenceScope,detectWithinPhiScope} from '../plugins/medcius/lib/phi-inference-scope.mjs';
import {createPatientSourceSnapshotAsync} from '../plugins/medcius/lib/patient-source-snapshot.mjs';
const directory=process.env.MEDCIUS_CN_NER_MODEL_DIR;
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};

test('multi-slot admission is globally bounded; timeouts retain every active slot',async()=>{
  const q=createInferenceQueue({concurrency:2,maxPending:1,timeoutMs:20}),a=deferred(),b=deferred();
  const first=q.run(()=>a.promise),second=q.run(()=>b.promise),queued=q.run(()=>assert.fail('expired queued work ran'));
  await assert.rejects(q.run(()=>{}),/QUEUE_FULL/);
  await Promise.all([first,second,queued].map(p=>assert.rejects(p,/INFERENCE_FAILED/)));
  assert.equal(q.diagnostics().active,2);assert.equal(q.diagnostics().pending,0);assert.equal(q.diagnostics().expired,3);
  let closed=false;const drain=q.close().then(()=>closed=true);await delay(1);assert.equal(closed,false);
  a.resolve();await delay(1);assert.equal(closed,false);b.resolve();await drain;
  assert.equal(q.diagnostics().settled,2);assert.equal(q.diagnostics().peak_active,2);
});
test('process/CPU budgets and environment configuration reject ambiguous or oversubscribed values',async()=>{
  for(const options of [{processes:0},{processes:5},{processes:2,threads:2,batchWorkers:2,cpuBudget:2},{cpuBudget:availableParallelism()+1}])
    await assert.rejects(createLocalChineseNerPool({modelDirectory:directory,...options}),/LIMIT/);
  assert.deepEqual(phiRuntimeOptions({MEDCIUS_CN_NER_PROCESSES:'2',MEDCIUS_CN_NER_THREADS:'1'}),{processes:2,threads:1});
  for(const env of [{MEDCIUS_CN_NER_PROCESSES:'2x'},{MEDCIUS_CN_NER_THREADS:'0'},{MEDCIUS_CN_NER_CPU_BUDGET:'4'}])
    assert.throws(()=>phiRuntimeOptions(env),/CONFIGURATION/);
});
test('missing assets fail startup without exposing a detector',async()=>{
  await assert.rejects(createLocalChineseNerPool({modelDirectory:directory+'/synthetic-missing',processes:1}),/ASSETS_OR_RUNTIME/);
});
test('prewarmed process pool preserves real spans, production isolation and whole-pool failure',async t=>{
  assert.ok(directory,'actual pinned model required');
  const pool=await createLocalChineseNerPool({modelDirectory:directory,processes:2,threads:1,batchWorkers:1});
  const reference=await createLocalChineseNer({modelDirectory:directory,batchWorkers:1,threads:1});
  try {
    await t.test('registered only after single/batch inference; immutable and not forgeable',()=>{
      const d=getLocalNerDiagnostics(pool);assert.equal(d.warmup,'SINGLE_AND_BATCH_EXECUTED');assert.equal(d.worker_pids.length,2);
      assert.equal(d.maximum_active_native_threads,2);assert.equal(isVerifiedLocalChineseNer(pool),true);
      assert.equal(isVerifiedLocalChineseNer({...pool}),false);assert.ok(Object.isFrozen(pool));
    });
    await t.test('single, bulk, Unicode and sliding windows exactly match the original detector',async()=>{
      const texts=['','王建国因胸痛入院。','😀𠮷玥，林志明居住于和平路28号。','无发热。'.repeat(75)+'王建国复查。'];
      const expected=[];for(const text of texts) expected.push(await reference.detect(text));
      assert.deepEqual(await detectManyLocalChineseNer(pool,texts),expected);
      assert.deepEqual(await Promise.all(texts.map(text=>pool.detect(text))),expected);
      const mutable=[...texts],pending=detectManyLocalChineseNer(pool,mutable);mutable.reverse();assert.deepEqual(await pending,expected);
      await assert.rejects(pool.detect('test',{signal:AbortSignal.abort()}),/ABORTED/);
    });
    await t.test('concurrent patient snapshots and every fresh request execute real NER',async()=>{
      const before=getLocalNerDiagnostics(pool).completed_operations;
      const results=await Promise.all([0,1,2,3].map(i=>{
        const context={tenant_id:'synthetic',patient_id:`p-${i}`,encounter_id:`e-${i}`,profile:'production'};
        return createPatientSourceSnapshotAsync({context,asOf:'2026-11-15T00:00:00Z',patient:{id:context.patient_id,name:'郄芃'},
          encounter:{id:context.encounter_id},notes:[{id:`n-${i}`,timestamp:'2026-11-14T23:00:00Z',text:'郄芃诉胸闷，王建国陪同。'}]}, {detector:pool});
      }));
      for(const r of results) {assert.doesNotMatch(JSON.stringify(r),/郄芃|王建国/);assert.equal(r.phi_guard.ner_status,'EXECUTED');}
      assert.ok(getLocalNerDiagnostics(pool).completed_operations>=before+4);
      assert.equal(getLocalNerDiagnostics(pool).queue.peak_active,2);
    });
    await t.test('changing ward prevents nested request-local neural cache reuse',async()=>{
      const context={tenant_id:'synthetic',ward_id:'ward-a',patient_id:'p',encounter_id:'e'};
      await withPhiInferenceScope(context,pool,async()=>{
        await detectWithinPhiScope(pool,'无发热。',{context});
        const other={...context,ward_id:'ward-b'};
        await withPhiInferenceScope(other,pool,async()=>{
          assert.equal((await detectWithinPhiScope(pool,'无发热。',{context:other})).reused,false);
        });
      });
    });
    await t.test('an actual child exit invalidates the entire pool and cached scope',async()=>{
      const context={tenant_id:'synthetic',patient_id:'p',encounter_id:'e'};
      await assert.rejects(withPhiInferenceScope(context,pool,async()=>{
        await detectWithinPhiScope(pool,'无发热。',{context});
        process.kill(getLocalNerDiagnostics(pool).worker_pids[0]);
        for(let i=0;i<100&&isVerifiedLocalChineseNer(pool);i++) await delay(10);
        assert.equal(isVerifiedLocalChineseNer(pool),false);
        await assert.rejects(detectWithinPhiScope(pool,'无发热。',{context}),/NOT_AVAILABLE/);
      }),/SCOPE_FAILED/);
      await assert.rejects(pool.detect('无发热。'),/NOT_AVAILABLE/);
    });
  } finally {await pool.close();await reference.close();}
  assert.equal(getLocalNerDiagnostics(pool).worker_pids.length,0);
});

test('actual process deadline rejects callers while native work retains capacity; close reaps the process',async()=>{
  const pool=await createLocalChineseNerPool({modelDirectory:directory,processes:1,timeoutMs:5,maxPending:1});
  try {
    const long=pool.detect('王建国无发热、咳嗽。'.repeat(200));
    const queued=pool.detect('林志明胸闷。');
    await assert.rejects(pool.detect('王建国胸痛。'),/QUEUE_FULL/);
    await Promise.all([long,queued].map(p=>assert.rejects(p,/INFERENCE_FAILED/)));
    assert.equal(getLocalNerDiagnostics(pool).queue.active,1);
    assert.equal(getLocalNerDiagnostics(pool).queue.pending,0);
    assert.equal(getLocalNerDiagnostics(pool).queue.expired,2);
  } finally {await pool.close();}
  assert.equal(getLocalNerDiagnostics(pool).worker_pids.length,0);assert.equal(isVerifiedLocalChineseNer(pool),false);
});
