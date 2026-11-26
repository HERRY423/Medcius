import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequestBatcher} from '../plugins/medcius/runtimes/cn-phi-ner/request-batcher.mjs';
const deferred=()=>{let resolve,reject;return {promise:new Promise((a,b)=>{resolve=a;reject=b;}),resolve,reject};};
const reply=groups=>groups.map(g=>g.map(text=>({text,spans:[]})));
test('64 logical requests share bounded compute batches; replies/order/objects stay independent',async()=>{
  const sent=[],q=createRequestBatcher({concurrency:2,dispatch:async groups=>{sent.push(groups);await delay(1);return reply(groups);}});
  const inputs=Array.from({length:64},(_,i)=>[`synthetic-${i}`,i%2?'same':'different']);
  const outputs=await Promise.all(inputs.map(t=>q.run(t)));
  assert.deepEqual(outputs.map(g=>g.map(r=>r.text)),inputs);assert.ok(sent.length<64);
  assert.ok(sent.every(g=>g.length<=8));assert.equal(q.diagnostics().peak_active,2);
  assert.equal(q.diagnostics().pending_unit,'logical_request');assert.ok(q.diagnostics().peak_waiting_batches<=34);
  outputs[1][1].spans.push('private');assert.deepEqual(outputs[3][1].spans,[]);
  await q.close();assert.equal(q.diagnostics().outstanding_requests,0);assert.equal(q.diagnostics().retained_utf16,0);
});

test('small bursts distribute across free lanes without an artificial collection timer',async()=>{
  const sent=[],gate=deferred(),q=createRequestBatcher({concurrency:2,dispatch:async g=>{sent.push(g);await gate.promise;return reply(g);}});
  const pending=Array.from({length:8},(_,i)=>q.run([String(i)]));
  await delay(1);assert.deepEqual(sent.map(g=>g.length),[4,4]);
  gate.resolve();await Promise.all(pending);await q.close();assert.equal(q.diagnostics().collection_wait_ms,0);
});
test('request counts, native-batch queue slots, text volume and empty-text counts all impose hard bounds',async()=>{
  for(const [options,first,next,code] of [
    [{maxOutstandingRequests:1},['a'],['b'],'QUEUE_FULL'],
    [{maxOutstandingUtf16:3},['abc'],['x'],'QUEUE_BYTES_FULL'],
    [{maxOutstandingTexts:2},['',''],[''],'QUEUE_BYTES_FULL'],
    [{maxPending:1,maxBatchUtf16:1},['a'],['c'],'QUEUE_FULL'],
  ]) {
    const gate=deferred();
    const q=createRequestBatcher({concurrency:1,dispatch:async groups=>{await gate.promise;return reply(groups);},...options});
    const a=q.run(first);
    let b;if(options.maxPending) b=q.run(['b']);
    await assert.rejects(q.run(next),new RegExp(code));
    const aborted=[a,...(b?[b]:[])].map(p=>assert.rejects(p,/NOT_AVAILABLE/));
    const closing=q.close();gate.resolve();await closing;await Promise.all(aborted);
  }
});
test('one cancelled caller cannot cancel a batch sibling or release native memory/slots early',async()=>{
  const gate=deferred(),sent=deferred(),a=new AbortController();
  const q=createRequestBatcher({concurrency:1,maxOutstandingRequests:2,dispatch:async g=>{sent.resolve();await gate.promise;return reply(g);}});
  const first=q.run(['patient-a'],{signal:a.signal}),second=q.run(['patient-b']);
  await sent.promise;a.abort();await assert.rejects(first,/ABORTED/);
  assert.equal(q.diagnostics().outstanding_requests,2);assert.equal(q.diagnostics().active,1);
  await assert.rejects(q.run(['overflow']),/QUEUE_FULL/);gate.resolve();
  assert.equal((await second)[0].text,'patient-b');await q.close();assert.equal(q.diagnostics().retained_utf16,0);
});
test('queued abort removes only that caller and freezes input before collection',async()=>{
  const q=createRequestBatcher({concurrency:1,waitMs:5,dispatch:async g=>reply(g)}),controller=new AbortController(),texts=['original'];
  const first=q.run(texts),cancelled=q.run(['other'],{signal:controller.signal});texts[0]='mutated';controller.abort();
  await assert.rejects(cancelled,/ABORTED/);assert.equal((await first)[0].text,'original');await q.close();
});
test('late native replies and event-loop stalls cannot win an expired deadline',async()=>{
  const gate=deferred(),started=deferred();
  const q=createRequestBatcher({concurrency:1,timeoutMs:20,dispatch:async g=>{started.resolve();await gate.promise;return reply(g);}});
  const first=q.run(['text']);await started.promise;await assert.rejects(first,/INFERENCE_FAILED/);
  assert.equal(q.diagnostics().active,1);assert.equal(q.diagnostics().outstanding_requests,1);
  let closed=false;const closing=q.close().then(()=>closed=true);await delay(1);assert.equal(closed,false);gate.resolve();await closing;
  const stalled=createRequestBatcher({concurrency:1,timeoutMs:20,dispatch:async g=>{const until=performance.now()+30;while(performance.now()<until){}return reply(g);}});
  await assert.rejects(stalled.run(['never release late']),/INFERENCE_FAILED/);await stalled.close();
});
test('failed or malformed native batch poisons queued work and drains without partial success',async()=>{
  for(const dispatch of [async()=>{throw new Error('raw secret');},async()=>[],async()=>[[]]]) {
    let failures=0;const q=createRequestBatcher({concurrency:1,dispatch,onFailure(){failures++;}});
    await assert.rejects(q.run(['clinical text']),/NOT_AVAILABLE/);
    await assert.rejects(q.run(['retry']),/NOT_AVAILABLE/);assert.equal(failures,1);await q.close();
  }
});
test('oversized requests run alone and estimated window counts keep groups under native limits',async()=>{
  const sent=[],q=createRequestBatcher({concurrency:1,maxTokens:16,overlap:8,dispatch:async g=>{sent.push(g);return reply(g);}});
  await Promise.all([['a'.repeat(8000)],['b'.repeat(2000)],['c'.repeat(2000)]].map(x=>q.run(x)));
  assert.equal(sent.length,3);assert.ok(sent.every(g=>g.length===1));await q.close();
});
