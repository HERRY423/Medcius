// Only token IDs from the bounded local queue cross this worker boundary.
// No network, logging, persisted text, or alternate model/provider.
import { parentPort, workerData } from 'node:worker_threads';
import * as ort from 'onnxruntime-node';
let session;
try {
  session=await ort.InferenceSession.create(new Uint8Array(workerData.bytes).slice(), {
    executionProviders:['cpu'], intraOpNumThreads:workerData.threads, interOpNumThreads:1,
    graphOptimizationLevel:'all', logSeverityLevel:4,
    // Block idle native threads instead of competing with sibling sessions or
    // the PHI traversal; no numerical/precision options are changed.
    extra:{session:{intra_op:{allow_spinning:'0'},inter_op:{allow_spinning:'0'}}},
  });
  if(session.inputNames.length!==3 || !['input_ids','attention_mask','token_type_ids'].every(k=>session.inputNames.includes(k))
    || !session.outputNames.includes('logits')) throw new Error('graph');
  parentPort.postMessage({ready:true});
} catch { parentPort.postMessage({error:'LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE'}); parentPort.close(); }
if(session) parentPort.on('message',async message=>{
  if(message.close) { await session.release(); parentPort.close(); return; }
  try {
    const {id,rows}=message;
    if(!Array.isArray(rows) || rows.length<1 || rows.length>12
      || rows.some(r=>!Array.isArray(r.ids)||r.ids.length<2||r.ids.length>512||r.ids.some(n=>!Number.isSafeInteger(n)||n<0))) throw new Error('input');
    const length=Math.max(...rows.map(r=>r.ids.length)), dims=[rows.length,length];
    const ids=new BigInt64Array(rows.length*length), mask=new BigInt64Array(ids.length);
    rows.forEach((row,i)=>row.ids.forEach((n,j)=>{ids[i*length+j]=BigInt(n);mask[i*length+j]=1n;}));
    const output=await session.run({input_ids:new ort.Tensor('int64',ids,dims),attention_mask:new ort.Tensor('int64',mask,dims),
      token_type_ids:new ort.Tensor('int64',new BigInt64Array(ids.length),dims)});
    const logits=output.logits, classes=workerData.classes;
    if(logits?.dims?.length!==3 || logits.dims[0]!==rows.length || logits.dims[1]!==length || logits.dims[2]!==classes
      || logits.data.length!==rows.length*length*classes || logits.data.some(v=>!Number.isFinite(v))) throw new Error('output');
    const results=rows.map((row,i)=>({index:row.index, data:logits.data.slice(i*length*classes,(i*length+row.ids.length)*classes)}));
    parentPort.postMessage({id,results},results.map(r=>r.data.buffer));
  } catch { parentPort.postMessage({id:message.id,error:'LOCAL_NER_INFERENCE_FAILED'}); }
});
