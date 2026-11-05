// Exact original-vs-optimized CPU inference, independent of the performance
// fixture. Synthetic only. Missing real assets are a failure, never a skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {syntheticNerTexts} from './fixtures/cn-ner-synthetic.mjs';
import {createBertTokenizer} from '../plugins/medcius/runtimes/cn-phi-ner/bert-tokenizer.mjs';
import {buildIndependentBatchGraph} from '../plugins/medcius/runtimes/cn-phi-ner/independent-batch-graph.mjs';
import {createLocalChineseNer,detectManyLocalChineseNer,getLocalNerDiagnostics,isVerifiedLocalChineseNer} from '../plugins/medcius/runtimes/cn-phi-ner/detector.mjs';
import {withPhiInferenceScope,primePhiInferenceScope,detectWithinPhiScope} from '../plugins/medcius/lib/phi-inference-scope.mjs';
const requireRuntime=createRequire(new URL('../plugins/medcius/runtimes/cn-phi-ner/package.json',import.meta.url));
const ort=requireRuntime('onnxruntime-node');
const directory=process.env.MEDCIUS_CN_NER_MODEL_DIR;
const hash=text=>createHash('sha256').update(text).digest('hex');
const feeds=rows=>{
  const length=Math.max(...rows.map(r=>r.length)), dims=[rows.length,length];
  const ids=new BigInt64Array(rows.length*length),mask=new BigInt64Array(ids.length);
  rows.forEach((r,i)=>r.forEach((n,j)=>{ids[i*length+j]=BigInt(n);mask[i*length+j]=1n;}));
  return {input_ids:new ort.Tensor('int64',ids,dims),attention_mask:new ort.Tensor('int64',mask,dims),
    token_type_ids:new ort.Tensor('int64',new BigInt64Array(ids.length),dims)};
};

test('independent quantization preserves every original CPU logit across batch layouts',async()=>{
  assert.ok(directory,'pinned local CPU model is required');
  const bytes=await readFile(join(directory,'model_quantized.onnx'));
  const tokenizer=createBertTokenizer(JSON.parse(await readFile(join(directory,'tokenizer.json'),'utf8')));
  const texts=syntheticNerTexts(),rows=[];
  for(const text of texts) {
    const tokens=tokenizer.encode(text);
    for(let start=0;start<tokens.length;start+=222) {
      rows.push([tokenizer.cls,...tokens.slice(start,start+254).map(t=>t.id),tokenizer.sep]);
      if(start+254>=tokens.length) break;
    }
  }
  const options={executionProviders:['cpu'],intraOpNumThreads:2,interOpNumThreads:1,graphOptimizationLevel:'all',logSeverityLevel:4};
  const reference=await ort.InferenceSession.create(bytes,options);
  const optimized=await ort.InferenceSession.create(buildIndependentBatchGraph(bytes),{
    ...options,extra:{session:{intra_op:{allow_spinning:'0'},inter_op:{allow_spinning:'0'}}},
  });
  try {
    const logits=[];
    for(const row of rows) logits.push((await reference.run(feeds([row]))).logits);
    let checked=0;
    for(const reversed of [false,true]) {
      const groups=new Map();
      for(const i of rows.keys()) { const b=Math.ceil(rows[i].length/8);if(!groups.has(b))groups.set(b,[]);groups.get(b).push(i); }
      for(const group of groups.values()) {
        if(reversed) group.reverse();const size=reversed?7:12;
        for(let at=0;at<group.length;at+=size) {
          const indices=group.slice(at,at+size), out=(await optimized.run(feeds(indices.map(i=>rows[i])))).logits;
          for(let j=0;j<indices.length;j++) {
            const i=indices[j],classes=logits[i].dims[2],offset=j*out.dims[1]*classes;
            const actual=out.data.subarray(offset,offset+rows[i].length*classes),expected=logits[i].data;
            assert.ok(Buffer.from(actual.buffer,actual.byteOffset,actual.byteLength).equals(Buffer.from(expected.buffer,expected.byteOffset,expected.byteLength)),
              `logit mismatch: synthetic window ${i}, layout ${Number(reversed)}`);
            checked++;
          }
        }
      }
    }
    // Negative control: ordinary batching changes activation ranges. It must
    // not be substituted for this per-example graph, even with the same model.
    const ordinary=(await reference.run(feeds([rows[0],rows[3]]))).logits;
    assert.notDeepEqual(Array.from(ordinary.data.slice(0,logits[0].data.length)),Array.from(logits[0].data));
    assert.throws(()=>buildIndependentBatchGraph(Buffer.from('corrupt synthetic model')),/GRAPH_UNSUPPORTED/);
    console.log('SYNTHETIC_NER_EQUIVALENCE '+JSON.stringify({texts:texts.length,windows:rows.length,layouts:2,exact_comparisons:checked,maximum_logit_difference:0}));
  } finally {await reference.release();await optimized.release();}
});

test('batched runtime keeps spans, request isolation, cancellation and native-failure blocking',async t=>{
  assert.ok(directory,'pinned local CPU model is required');
  const detector=await createLocalChineseNer({modelDirectory:directory,maxTokens:64,overlap:16});
  try {
    await t.test('Unicode offsets, overlapping windows and identical UNK tokens remain text-bound',async()=>{
      const texts=[...syntheticNerTexts().slice(0,12),...syntheticNerTexts().slice(251), 'A'.repeat(110),'B'.repeat(120)];
      const expected=[];for(const text of texts) expected.push(await detector.detect(text));
      const actual=await detectManyLocalChineseNer(detector,texts);
      assert.deepEqual(actual,expected);
      const mutable=['王建国因胸痛入院。','林志明居住于和平路28号。'];
      const pending=detectManyLocalChineseNer(detector,mutable);mutable.reverse();
      assert.deepEqual((await pending).map(r=>r.text_sha256),[hash(mutable[1]),hash(mutable[0])]);
    });
    await t.test('every operation performs fresh NER; patients and returned objects are isolated',async()=>{
      const context={tenant_id:'synthetic',patient_id:'p',encounter_id:'e'},texts=['王建国因胸痛入院。','无发热。'];
      for(let i=0;i<2;i++) {
        const before=getLocalNerDiagnostics(detector).completed_windows;
        await withPhiInferenceScope(context,detector,async()=>{
          await primePhiInferenceScope(detector,texts,{context});
          const first=await detectWithinPhiScope(detector,texts[0],{context});first.result.spans.length=0;
          assert.ok((await detectWithinPhiScope(detector,texts[0],{context})).result.spans.length>0);
        });
        assert.ok(getLocalNerDiagnostics(detector).completed_windows>before);
      }
      const results=await Promise.all(['p-a','p-b'].map(patient_id=>{
        const own={...context,patient_id};return withPhiInferenceScope(own,detector,async()=>{
          await primePhiInferenceScope(detector,texts,{context:own});return (await detectWithinPhiScope(detector,texts[0],{context:own})).result;
        });
      }));
      assert.deepEqual(results[0],results[1]);assert.notEqual(results[0],results[1]);
      await assert.rejects(detectManyLocalChineseNer(detector,texts,{signal:AbortSignal.abort()}),/ABORTED/);
    });
    await t.test('a real native worker error invalidates the detector and cannot return cached success',async()=>{
      const post=Worker.prototype.postMessage, context={tenant_id:'synthetic',patient_id:'p',encounter_id:'e'};
      let injected=false;
      try {
        await assert.rejects(withPhiInferenceScope(context,detector,async()=>{
          await detectWithinPhiScope(detector,'无发热。',{context});
          Worker.prototype.postMessage=function(message,...args){
            if(!injected && message.rows?.length) {injected=true;message=structuredClone(message);message.rows[0].ids[0]=9999999;}
            return post.call(this,message,...args);
          };
          await assert.rejects(primePhiInferenceScope(detector,['王建国入院。','林志明住院。'],{context}),/NER_|PHI_/);
          assert.equal(isVerifiedLocalChineseNer(detector),false);
          await assert.rejects(detectWithinPhiScope(detector,'无发热。',{context}),/SCOPE_FAILED/);
        }),/SCOPE_FAILED/);
        assert.equal(injected,true);
        await assert.rejects(detector.detect('无发热。'),/NOT_AVAILABLE/);
      } finally {Worker.prototype.postMessage=post;}
    });
  } finally {await detector.close();}
});
