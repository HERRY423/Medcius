// Local IPC only. No text logs, remote endpoints, result cache or worker retry.
import {fork} from 'node:child_process';
import {availableParallelism} from 'node:os';
import {isAbsolute} from 'node:path';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createInferenceQueue} from './inference-queue.mjs';
import {createRequestBatcher} from './request-batcher.mjs';
import {validateOovSubjectSpans,validateContextSubjectSpans} from '../../lib/phi-oov-subjects.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
const labels=new Set(['PERSON','ADDRESS','IDENTIFIER','CONTACT','ORGANIZATION']);

export async function createNerProcessPool({modelDirectory,processes=2,threads=1,batchWorkers=1,
  cpuBudget=availableParallelism(),maxPending=32,timeoutMs=30000,maxTokens=256,overlap=32,
  maxTextLength=100000,startupTimeoutMs=60000,microBatchMaxRequests=1,microBatchWaitMs=0,
  maxOutstandingRequests=128,maxOutstandingUtf16=1_000_000,maxOutstandingTexts=8192}={}, {onFailure}={}) {
  if(typeof modelDirectory!=='string'||!isAbsolute(modelDirectory)||/^(?:https?:|\\\\|\/\/)/i.test(modelDirectory)) throw new Error('LOCAL_NER_DIRECTORY_REQUIRED');
  const integer=(x,a,b)=>Number.isInteger(x)&&x>=a&&x<=b;
  if(!integer(processes,1,4)||!integer(threads,1,8)||!integer(batchWorkers,1,4)
    ||!integer(cpuBudget,1,availableParallelism())||processes*threads*batchWorkers>cpuBudget
    ||!integer(startupTimeoutMs,100,120000)||!integer(maxTextLength,1,100000)
    ||!integer(maxTokens,16,512)||!integer(overlap,8,maxTokens-3)||!integer(microBatchMaxRequests,1,8)||!integer(microBatchWaitMs,0,10)
    ||!integer(maxOutstandingRequests,1,256)||!integer(maxOutstandingUtf16,1,2_000_000)||!integer(maxOutstandingTexts,1,16384)) throw new Error('LOCAL_NER_POOL_LIMIT_INVALID');
  const queue=microBatchMaxRequests===1?createInferenceQueue({maxPending,timeoutMs,concurrency:processes}):createRequestBatcher({
    concurrency:processes,maxPending,timeoutMs,maxRequestsPerBatch:microBatchMaxRequests,waitMs:microBatchWaitMs,
    maxOutstandingRequests,maxOutstandingUtf16,maxOutstandingTexts,maxTokens,overlap,dispatch:dispatchGroups,onFailure:fail});
  const manifest=JSON.parse(await readFile(new URL('./model-manifest.json',import.meta.url),'utf8'));
  const slots=[];let failed=false,closing=false,closePromise,sequence=0,completed=0,completedPackets=0;
  function fail(){
    if(failed||closing) return;
    failed=true;onFailure?.();void queue.close();
    // Process isolation permits terminating a broken native runtime safely.
    // Quarantine the whole pool; no respawn, heuristic or cached-success fallback.
    for(const slot of slots) if(!slot.exited) slot.child.kill();
  }
  async function dispatchGroups(groups) {
    if(failed||closing) throw new Error('LOCAL_NER_NOT_AVAILABLE');
    const slot=slots.find(s=>s.ready&&!s.exited&&!s.job);
    if(!slot) {fail();throw new Error('LOCAL_NER_INFERENCE_FAILED');}
    const id=++sequence,texts=groups.flat(),partitions=groups.flatMap((g,i)=>g.map(()=>i));
    const timer=setTimeout(fail,65000);
    try {
      const flat=await new Promise((resolve,reject)=>{
        slot.job={id,texts,groups,resolve,reject};
        slot.child.send({id,texts,partitions},error=>{if(error) fail();});
      });
      if(failed||closing) throw new Error('LOCAL_NER_NOT_AVAILABLE');
      let offset=0;return groups.map(group=>{const out=flat.slice(offset,offset+group.length);offset+=group.length;return out;});
    } finally {clearTimeout(timer);}
  }
  const started=performance.now();
  try {
    await Promise.all(Array.from({length:processes},async()=>{
      const child=fork(new URL('./process-worker.mjs',import.meta.url),[],{
        stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',execArgv:[],windowsHide:true,
      });
      const slot={child,job:null,ready:false,exited:false,rss:0};slots.push(slot);
      slot.exit=new Promise(resolve=>{const exited=()=>{
        if(slot.exited) return;
        slot.exited=true;slot.job?.reject(new Error('LOCAL_NER_INFERENCE_FAILED'));slot.job=null;
        slot.rejectReady?.(new Error('LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE'));fail();resolve();
      };child.once('exit',exited);child.once('close',exited);});
      child.on('error',()=>{slot.rejectReady?.(new Error('LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE'));fail();});
      child.on('disconnect',()=>{if(!closing) fail();});
      const ready=new Promise((resolve,reject)=>{slot.resolveReady=resolve;slot.rejectReady=reject;});
      child.on('message',message=>{
        if(!slot.ready) {
          if(message?.ready!==true||message.protocol!=='medcius.ner-process.v5'||message.model_id!==manifest.model_id||message.revision!==manifest.revision
            ||message.warmup!=='SINGLE_AND_BATCH_EXECUTED'||message.context_warmup!=='SOURCE_CROP_EXECUTED') {slot.rejectReady?.(new Error('LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE'));fail();return;}
          slot.ready=true;slot.rss=message.rss;slot.resolveReady?.();return;
        }
        const job=slot.job;
        if(!job || message?.id!==job.id || message.error || !Array.isArray(message.results)
          ||message.results.length!==job.texts.length) {fail();return;}
        for(const [i,r] of message.results.entries()) {
          const text=job.texts[i];
          if(r?.complete!==true||r.text_sha256!==hash(text)||!Array.isArray(r.spans)||r.subject_screening===undefined||r.context_subject_screening===undefined
            ||r.spans.some(s=>!integer(s?.start,0,text.length)||!integer(s?.end,s.start+1,text.length)
              ||!text.slice(s.start,s.end).isWellFormed()||!labels.has(s.label))) {fail();return;}
          try {validateOovSubjectSpans(text,r.subject_screening);validateContextSubjectSpans(text,r.context_subject_screening);} catch {fail();return;}
        }
        slot.job=null;slot.rss=message.rss;completed+=job.groups.length;completedPackets++;job.resolve(message.results);
      });
      child.send({init:{modelDirectory,threads,batchWorkers,maxTokens,overlap,maxTextLength,
        // Parent owns admission/deadlines. Child is a single native lane.
        timeoutMs:60000,maxPending:1}},error=>{if(error) {slot.rejectReady?.(new Error('LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE'));fail();}});
      const timer=setTimeout(()=>{slot.rejectReady?.(new Error('LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE'));fail();},startupTimeoutMs);
      try {await ready;} finally {clearTimeout(timer);slot.resolveReady=null;slot.rejectReady=null;}
    }));
    if(failed) throw new Error('unavailable');
  } catch {
    fail();for(const slot of slots) if(!slot.exited) slot.child.kill();
    await Promise.allSettled(slots.map(s=>s.exit));throw new Error('LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE');
  }
  const startupMs=performance.now()-started;
  return Object.freeze({
    id:manifest.model_id,version:manifest.revision,
    async detect(texts,{signal}={}) {
      if(failed||closing) throw new Error('LOCAL_NER_NOT_AVAILABLE');
      if(!Array.isArray(texts)||texts.length>512||texts.some(t=>typeof t!=='string'||!t.isWellFormed()||t.length>maxTextLength)
        ||texts.reduce((n,t)=>n+t.length,0)>100000) throw new Error('LOCAL_NER_TEXT_INVALID');
      texts=[...texts];
      if(microBatchMaxRequests>1) return queue.run(texts,{signal});
      return queue.run(async cancelled=>{
        if(cancelled()) throw new Error('LOCAL_NER_ABORTED');
        const results=(await dispatchGroups([texts]))[0];
        if(cancelled()) throw new Error('LOCAL_NER_ABORTED');
        return results;
      },{signal});
    },
    diagnostics(){return {mode:'process_pool',state:failed?'FAILED':closing?'CLOSED':'READY',processes,
      threads_per_session:threads,batch_workers_per_process:batchWorkers,cpu_budget:cpuBudget,
      maximum_active_native_threads:processes*threads*batchWorkers,startup_ms:startupMs,
      warmup:'SINGLE_AND_BATCH_EXECUTED',context_warmup:'SOURCE_CROP_EXECUTED',completed_operations:completed,completed_native_batches:completedPackets,microbatch_max_requests:microBatchMaxRequests,
      worker_pids:slots.filter(s=>!s.exited).map(s=>s.child.pid),worker_rss_bytes:slots.map(s=>s.rss),queue:queue.diagnostics()};},
    async close(){
      if(!closePromise) {
        closing=true;
        closePromise=(async()=>{
          // A separate OS process can be forcibly reclaimed on shutdown even
          // if native work is stuck; wait for exit before reporting closure.
          const timer=setTimeout(()=>{for(const s of slots) if(!s.exited) s.child.kill();},5000);
          try {
            await queue.close();
            for(const s of slots) if(!s.exited&&s.child.connected) s.child.send({close:true},()=>{});
            await Promise.allSettled(slots.map(s=>s.exit));
          } finally {clearTimeout(timer);}
        })();
      }
      await closePromise;
    },
  });
}
