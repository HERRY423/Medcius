// Actual pinned CPU model, synthetic input only. No external model API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createLocalChineseNer } from '../plugins/medcius/lib/local-cn-ner.mjs';
import { withPhiInferenceScope, detectWithinPhiScope } from '../plugins/medcius/lib/phi-inference-scope.mjs';
import { guardFreeTextEgress } from '../plugins/medcius/lib/local-phi-egress.mjs';
import { createPhiEntitySession } from '../plugins/medcius/lib/phi-entity-session.mjs';

const requireRuntime = createRequire(new URL('../plugins/medcius/runtimes/cn-phi-ner/package.json', import.meta.url));
const ort = requireRuntime('onnxruntime-node');
const context = {tenant_id:'synthetic-site',patient_id:'synthetic-p',encounter_id:'synthetic-e'};
const clean = '患者无发热、咳嗽、胸闷，偶有咳痰。';

test('request-local neural reuse preserves mandatory inference and failure isolation', async t => {
  assert.ok(process.env.MEDCIUS_CN_NER_MODEL_DIR, 'actual pinned model is required');
  const detector = await createLocalChineseNer({modelDirectory:process.env.MEDCIUS_CN_NER_MODEL_DIR});
  const session = createPhiEntitySession({context,patient:{id:context.patient_id},encounter:{id:context.encounter_id}});
  const nativeRun = ort.InferenceSession.prototype.run;
  let calls=0, fail=false;
  ort.InferenceSession.prototype.run = async function (...args) {
    calls++;
    if (fail) throw new Error('synthetic native inference failure');
    return nativeRun.apply(this,args);
  };
  try {
    await t.test('identical clean text reuses within an operation; every new operation runs the CPU model', async () => {
      const before=calls;
      for(let i=0;i<2;i++) {
        const result=await guardFreeTextEgress(clean,{context,detector,entitySession:session});
        assert.equal(result.text,clean);
        assert.equal(result.receipt.inference_calls,1);
        assert.equal(result.receipt.inference_reuses,1);
        assert.equal(result.receipt.passes_completed,2);
      }
      assert.equal(calls-before,2);
    });
    await t.test('scoped output equals uncached detector output, including bare names and changed residual text', async () => {
      const text='王建国因胸痛入院，林志明居住于和平路28号3栋602室。';
      const reference=await detector.detect(text);
      await withPhiInferenceScope(context,detector,async()=>{
        const first=await detectWithinPhiScope(detector,text,{context});
        const next=await detectWithinPhiScope(detector,text,{context});
        assert.deepEqual(first.result,reference);assert.deepEqual(next.result,reference);
        assert.equal(first.reused,false);assert.equal(next.reused,true);
        next.result.spans.length=0;
        assert.deepEqual((await detectWithinPhiScope(detector,text,{context})).result,reference);
        const result=await guardFreeTextEgress(text,{context,detector,entitySession:session});
        assert.doesNotMatch(result.text,/王建国|林志明|和平路|28号|602室/);
        assert.ok(result.receipt.inference_calls>0,'changed residual text must run NER');
      });
    });
    await t.test('concurrent same-patient operations and nested different-patient operations cannot share results', async () => {
      const before=calls;
      await Promise.all([0,1].map(()=>withPhiInferenceScope(context,detector,async()=>{
        assert.equal((await detectWithinPhiScope(detector,clean,{context})).reused,false);
        assert.equal((await detectWithinPhiScope(detector,clean,{context})).reused,true);
      })));
      assert.equal(calls-before,2);
      await withPhiInferenceScope(context,detector,async()=>{
        await detectWithinPhiScope(detector,clean,{context});
        const other={...context,patient_id:'synthetic-other'};
        await withPhiInferenceScope(other,detector,async()=>{
          assert.equal((await detectWithinPhiScope(detector,clean,{context:other})).reused,false);
        });
      });
    });
    await t.test('a newly injected dictionary is applied even when the raw neural result is reused', async () => {
      await withPhiInferenceScope(context,detector,async()=>{
        await guardFreeTextEgress('合成词',{context,detector,entitySession:session});
        session.inject({context,patient:{id:context.patient_id,name:'合成词'},encounter:{id:context.encounter_id}});
        const result=await guardFreeTextEgress('合成词',{context,detector,entitySession:session});
        assert.doesNotMatch(result.text,/合成词/);
      });
    });
    await t.test('native failure and cancellation poison the current scope; no previous result fallback', async () => {
      await assert.rejects(withPhiInferenceScope(context,detector,async()=>{
        await detectWithinPhiScope(detector,clean,{context});
        fail=true;
        await assert.rejects(detectWithinPhiScope(detector,'新的合成文本',{context}),/INFERENCE_FAILED/);
        fail=false;
        await assert.rejects(detectWithinPhiScope(detector,clean,{context}),/SCOPE_FAILED/);
        return {success:true}; // Catching a failed inner call must not release a successful operation.
      }),/SCOPE_FAILED/);
      await assert.rejects(withPhiInferenceScope(context,detector,async()=>{
        await detectWithinPhiScope(detector,clean,{context});
        await assert.rejects(detectWithinPhiScope(detector,clean,{context,signal:AbortSignal.abort()}),/ABORTED/);
        await assert.rejects(detectWithinPhiScope(detector,clean,{context}),/SCOPE_FAILED/);
      }),/SCOPE_FAILED/);
      assert.equal((await detectWithinPhiScope(detector,clean,{context})).reused,false);
    });
    await t.test('closing a detector invalidates its cached result immediately', async () => {
      await assert.rejects(withPhiInferenceScope(context,detector,async()=>{
        await detectWithinPhiScope(detector,clean,{context});
        await detector.close();
        await assert.rejects(detectWithinPhiScope(detector,clean,{context}),/NOT_AVAILABLE/);
      }),/SCOPE_FAILED/);
    });
  } finally {
    ort.InferenceSession.prototype.run=nativeRun;
    session.dispose();await detector.close();
  }
});
