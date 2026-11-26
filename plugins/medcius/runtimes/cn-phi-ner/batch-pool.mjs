import { Worker } from 'node:worker_threads';
import { channel } from 'node:diagnostics_channel';
const measurements=channel('medcius.ner.batch');
// Caller admission/deadlines belong to inference-queue. Within an admitted
// operation, at most four native batches execute and at most twelve independent
// windows share a batch. A native failure invalidates the pool, never falls back.
export async function createBatchPool(bytes,{threads,classes,onFailure,workerCount=4,singleRows=false}={}) {
  if(!Number.isInteger(workerCount)||workerCount<1||workerCount>4) throw new Error('LOCAL_NER_LIMIT_INVALID');
  const shared=new SharedArrayBuffer(bytes.length); new Uint8Array(shared).set(bytes);
  const workers=[], waiting=[]; let failed=false,closing=false,completedBatches=0,completedWindows=0;
  const fail=()=>{
    if(failed) return; failed=true; onFailure?.();
    const error=new Error('LOCAL_NER_INFERENCE_FAILED');
    for(const job of waiting.splice(0)) job.reject(error);
    // An ORT call cannot be interrupted safely by terminating its JS worker.
    // Quarantine the pool immediately, but retain active slots until native
    // replies/worker exits. Graceful release follows the outer queue's drain.
  };
  const pump=()=>{
    if(failed || closing) return;
    for(const slot of workers) if(!slot.job && waiting.length) {
      while(waiting[0]?.cancelled()) waiting.shift().reject(new Error('LOCAL_NER_ABORTED'));
      if(!waiting.length) return;
      slot.job=waiting.shift(); slot.worker.ref();
      slot.idle=new Promise(resolve=>{slot.resolveIdle=resolve;});
      slot.worker.postMessage({id:slot.job.id,rows:slot.job.rows});
    }
  };
  try {
    for(let i=0;i<workerCount;i++) {
      const worker=new Worker(new URL('./batch-worker.mjs',import.meta.url),{workerData:{bytes:shared,threads,classes},execArgv:[]});
      const slot={worker,job:null,exited:false}; workers.push(slot);
      slot.exit=new Promise(resolve=>worker.once('exit',()=>{
        slot.exited=true;slot.job?.reject(new Error('LOCAL_NER_INFERENCE_FAILED'));slot.job=null;slot.resolveIdle?.();
        if(!closing) fail();resolve();
      }));
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{reject(new Error('LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE'));},30000);
        const error=()=>{clearTimeout(timer);reject(new Error('LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE'));fail();};
        worker.once('error',error);worker.once('exit',()=>{if(!closing) {clearTimeout(timer);reject(new Error('LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE'));}});
        worker.once('message',message=>{clearTimeout(timer);if(message.ready!==true) return error();resolve();});
      });
      worker.on('error',fail);
      worker.on('message',message=>{
        const job=slot.job;
        const invalid=!job || message.id!==job.id || message.error || !Array.isArray(message.results)
          || message.results.length!==job.rows.length;
        slot.job=null;slot.resolveIdle?.();worker.unref();
        if(invalid || failed) {job?.reject(new Error('LOCAL_NER_INFERENCE_FAILED'));fail();return;}
        completedBatches++;completedWindows+=job.rows.length;
        job.resolve(message.results);pump();
      });
      worker.unref();
    }
  } catch {
    fail();closing=true;
    await Promise.allSettled(workers.map(async slot=>{
      if(!slot.exited) {slot.worker.ref();slot.worker.postMessage({close:true});} await slot.exit;
    }));
    throw new Error('LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE');
  }
  let sequence=0;
  return Object.freeze({
    async run(rows,cancelled=()=>false,{compactShortRows=false}={}) {
      const started=performance.now();
      if(failed || closing) throw new Error('LOCAL_NER_NOT_AVAILABLE');
      if(rows.length>512) throw new Error('LOCAL_NER_LIMIT_INVALID');
      if(compactShortRows&&rows.some(row=>row.ids.length>6)) throw new Error('LOCAL_NER_LIMIT_INVALID');
      const groups=new Map();
      for(const row of rows) {
        const bucket=Math.ceil(row.ids.length/8);
        if(!groups.has(bucket)) groups.set(bucket,[]);groups.get(bucket).push(row);
      }
      // Spread short crop work over the existing workers in at most one wave
      // when it fits. One large crop batch left sibling workers idle, while
      // one row per batch adds repeated dispatches. Keep independent examples
      // together within each balanced batch; the native budget is unchanged.
      const batchSize=rows.length<=4 ? 1 : 12;
      const batches=[...groups.values()].flatMap(group=>{
        if (singleRows) return group.map(row => [row]);
        const short = group.every(row => row.ids.length <= 32);
        const expand = compactShortRows || (short && groups.size === 1 && group.length > 4);
        const count = expand
          ? Math.min(group.length, workerCount * Math.ceil(group.length / (workerCount * 12)))
          : Math.ceil(group.length / batchSize);
        if (count === 1) return [group];
        if (!short) {
          return Array.from({ length: count }, (_, i) => group.slice(i * batchSize, (i + 1) * batchSize));
        }
        // Group similar lengths first to reduce padding, then spread short
        // rows evenly so a small remainder does not leave a worker idle.
        const sorted = group.toSorted((a, b) => a.ids.length - b.ids.length);
        return Array.from({ length: count }, (_, i) =>
          sorted.slice(Math.floor(i * sorted.length / count), Math.floor((i + 1) * sorted.length / count)));
      })
        .sort((a,b)=>b.length*Math.max(...b.map(r=>r.ids.length))-a.length*Math.max(...a.map(r=>r.ids.length)));
      const promises=batches.map(batch=>new Promise((resolve,reject)=>{
        waiting.push({id:++sequence,rows:batch,resolve,reject,cancelled});
      }));
      pump();
      // Never return on the first rejection while sibling native calls still
      // run. The outer FIFO slot stays occupied through native completion.
      const settled=await Promise.allSettled(promises);
      if(cancelled()) throw new Error('LOCAL_NER_ABORTED');
      const error=settled.find(r=>r.status==='rejected');if(error) throw error.reason;
      if(measurements.hasSubscribers) measurements.publish({windows:rows.length,batches:batches.length,elapsed_ms:performance.now()-started});
      return settled.flatMap(r=>r.value);
    },
    diagnostics(){return {batch_workers:workerCount,completed_batches:completedBatches,completed_windows:completedWindows};},
    async close(){
      closing=true;
      for(const job of waiting.splice(0)) job.reject(new Error('LOCAL_NER_NOT_AVAILABLE'));
      await Promise.allSettled(workers.map(async slot=>{
        // Called after the outer queue has drained all native work.
        await slot.idle;
        if(!slot.exited) {slot.worker.ref();slot.worker.postMessage({close:true});}await slot.exit;
      }));
    },
  });
}
