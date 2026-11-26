// Old development strings only. The frozen v4 challenge is never imported here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {Worker} from 'node:worker_threads';
import {createBertTokenizer} from '../plugins/medcius/runtimes/cn-phi-ner/bert-tokenizer.mjs';
import {buildIndependentBatchGraph} from '../plugins/medcius/runtimes/cn-phi-ner/independent-batch-graph.mjs';
import {createBatchPool} from '../plugins/medcius/runtimes/cn-phi-ner/batch-pool.mjs';
const require=createRequire(new URL('../plugins/medcius/runtimes/cn-phi-ner/package.json',import.meta.url));
const ort=require('onnxruntime-node'),dir=process.env.MEDCIUS_CN_NER_MODEL_DIR;
const bytes=await readFile(dir+'/model_quantized.onnx'),config=JSON.parse(await readFile(dir+'/config.json','utf8'));
const classes=Object.keys(config.id2label).length,graph=buildIndependentBatchGraph(bytes);
const tokenizer=createBertTokenizer(JSON.parse(await readFile(dir+'/tokenizer.json','utf8')));
const words=['郤珺','欧阳星澜','邢珺','令狐珺','郤\u200b 珺','郄芃','𠮷玥','杜仲'];
const rows=Array.from({length:64},(_,index)=>({index,ids:[tokenizer.cls,...tokenizer.encode(words[index%words.length]).map(t=>t.id),tokenizer.sep]}));
const feeds=ids=>({input_ids:new ort.Tensor('int64',BigInt64Array.from(ids,BigInt),[1,ids.length]),attention_mask:new ort.Tensor('int64',BigInt64Array.from(ids,()=>1n),[1,ids.length]),token_type_ids:new ort.Tensor('int64',new BigInt64Array(ids.length),[1,ids.length])});

test('balanced crop waves preserve every original CPU logit across odd sizes and worker budgets',async()=>{
  const single=await ort.InferenceSession.create(bytes,{executionProviders:['cpu'],intraOpNumThreads:1,interOpNumThreads:1,graphOptimizationLevel:'all',logSeverityLevel:4,extra:{session:{intra_op:{allow_spinning:'0'},inter_op:{allow_spinning:'0'}}}});
  try {
    const reference=[];for(const row of rows.slice(0,words.length)) reference.push((await single.run(feeds(row.ids))).logits.data.slice());
    const shortNotes = Array.from({ length: 27 }, (_, index) => {
      const text = ['胸闷', '咳嗽伴呼吸急促', '检验结果待临床团队核对'][index % 3];
      return { index, ids: [tokenizer.cls, ...tokenizer.encode(text).map(token => token.id), tokenizer.sep] };
    });
    const noteLogits = await Promise.all(shortNotes.slice(0, 3).map(async row => (await single.run(feeds(row.ids))).logits.data.slice()));
    let comparisons=0;
    for(const workerCount of [1,2,4]) {
      const pool=await createBatchPool(graph,{threads:1,classes,workerCount});
      try {
        for(const n of [1,2,3,4,5,8,12,13,24,25,31,64]) {
          const results=await pool.run(rows.slice(0,n),()=>false,{compactShortRows:true});
          assert.equal(results.length,n);assert.equal(new Set(results.map(r=>r.index)).size,n);
          for(const result of results) {assert.deepEqual(result.data,reference[result.index%words.length]);comparisons++;}
        }
        await assert.rejects(pool.run([{index:0,ids:Array(7).fill(101)}],()=>false,{compactShortRows:true}),/LIMIT_INVALID/);
        assert.equal((await pool.run(rows.slice(0,1),()=>false,{compactShortRows:true})).length,1);
        const mixedLengths = await pool.run(shortNotes);
        assert.equal(new Set(mixedLengths.map(result => result.index)).size, shortNotes.length);
        for (const result of mixedLengths) assert.deepEqual(result.data, noteLogits[result.index % 3]);
      } finally {await pool.close();}
    }
    console.log(`CROP_LOGIT_COMPARISONS=${comparisons}`);
  } finally {await single.release();}
});

test('cancellation drains all dispatched crop workers before releasing the operation',async()=>{
  const pool=await createBatchPool(graph,{threads:1,classes,workerCount:2});
  const post=Worker.prototype.postMessage;let cancelled=false,dispatched=0,replied=0;
  try {
    Worker.prototype.postMessage=function(message,...args){
      if(message.rows) {dispatched++;this.once('message',()=>replied++);if(dispatched===2)queueMicrotask(()=>{cancelled=true;});}
      return post.call(this,message,...args);
    };
    await assert.rejects(pool.run(rows.slice(0,8),()=>cancelled,{compactShortRows:true}),/ABORTED/);
    assert.equal(dispatched,2);assert.equal(replied,2);
    Worker.prototype.postMessage=post;
    assert.equal((await pool.run(rows.slice(0,2),()=>false,{compactShortRows:true})).length,2);
  } finally {Worker.prototype.postMessage=post;await pool.close();}
});

test('a native crop failure quarantines the pool and drains sibling work without a partial success',async()=>{
  let failures=0;const pool=await createBatchPool(graph,{threads:1,classes,workerCount:2,onFailure(){failures++;}});
  const post=Worker.prototype.postMessage;let dispatched=0,replied=0;
  try {
    Worker.prototype.postMessage=function(message,...args){
      if(message.rows) {dispatched++;this.once('message',()=>replied++);if(dispatched===1) {message=structuredClone(message);message.rows[0].ids[0]=9999999;}}
      return post.call(this,message,...args);
    };
    await assert.rejects(pool.run(rows.slice(0,8),()=>false,{compactShortRows:true}),/INFERENCE_FAILED/);
    assert.equal(dispatched,2);assert.equal(replied,2);assert.equal(failures,1);
    await assert.rejects(pool.run(rows.slice(0,1)),/NOT_AVAILABLE/);
  } finally {Worker.prototype.postMessage=post;await pool.close();}
});
