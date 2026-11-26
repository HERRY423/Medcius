// Bounded, ephemeral compute batching. Each logical caller owns its own timer,
// abort state and reply. There is no result cache or patient/session dictionary.
// Active expired callers retain accounting until the actual native reply.
export function createRequestBatcher({dispatch,onFailure,concurrency,maxPending=32,timeoutMs=30000,
  maxRequestsPerBatch=8,maxOutstandingRequests=128,maxOutstandingUtf16=1_000_000,
  maxOutstandingTexts=8192,maxBatchTexts=128,maxBatchUtf16=32000,waitMs=0,maxTokens=256,overlap=32}={}) {
  const integer=(x,a,b)=>Number.isInteger(x)&&x>=a&&x<=b;
  if(typeof dispatch!=='function'||!integer(concurrency,1,4)||!integer(maxPending,1,256)||!integer(timeoutMs,1,60000)
    ||!integer(maxRequestsPerBatch,2,8)||!integer(maxOutstandingRequests,1,256)||!integer(maxOutstandingUtf16,1,2_000_000)
    ||!integer(maxOutstandingTexts,1,16384)||!integer(maxBatchTexts,2,128)||!integer(maxBatchUtf16,1,32000)
    ||!integer(waitMs,0,10)||!integer(maxTokens,16,512)||!integer(overlap,8,maxTokens-3)) throw new Error('LOCAL_NER_BATCH_LIMIT_INVALID');
  const waiting=[],jobs=new Set(),drainers=[];
  let active=0,activeRequests=0,retainedUtf16=0,retainedTexts=0,closed=false,failed=false,flushTimer=null;
  const bounds=[1,5,10,25,50,100,250,500,1000,2000,5000,10000,30000,60000,Infinity];
  const hist=()=>({count:0,total_ms:0,max_ms:0,buckets:bounds.map(()=>0)}),queueWait=hist(),service=hist();
  const observe=(h,ms)=>{h.count++;h.total_ms+=ms;h.max_ms=Math.max(h.max_ms,ms);h.buckets[bounds.findIndex(b=>ms<=b)]++;};
  const counts={submitted:0,admitted:0,started:0,settled:0,expired:0,aborted:0,rejected_full:0,rejected_memory:0,
    peak_active:0,peak_pending:0,peak_waiting_batches:0,peak_outstanding:0,peak_retained_utf16:0,peak_retained_texts:0,completed_batches:0};
  const batchSizes=Array.from({length:maxRequestsPerBatch},()=>0);
  const clearFlush=()=>{if(flushTimer!==true) clearTimeout(flushTimer);flushTimer=null;};
  const cost=texts=>({texts:texts.length,units:texts.reduce((n,t)=>n+t.length,0),
    // This pinned tokenizer emits at most one token per input UTF-16 unit.
    // A conservative bound prevents grouped calls exceeding 512 windows.
    windows:texts.reduce((n,t)=>n+(t.length?1+Math.max(0,Math.ceil((t.length-(maxTokens-2))/(maxTokens-2-overlap))):0),0)});
  const take=(list,at,limit=maxRequestsPerBatch)=>{
    const selected=[list[at]],sum={...list[at].cost};let next=at+1;
    // A single oversized request keeps its original single/bulk semantics.
    while(next<list.length && selected.length<limit) {
      const c=list[next].cost;
      if(sum.texts+c.texts>maxBatchTexts||sum.units+c.units>maxBatchUtf16||sum.windows+c.windows>512) break;
      selected.push(list[next++]);sum.texts+=c.texts;sum.units+=c.units;sum.windows+=c.windows;
    }
    return {selected,next};
  };
  const queuedBatches=list=>{let n=0;for(let i=0;i<list.length;){i=take(list,i).next;n++;}return n;};
  const release=job=>{
    if(!jobs.delete(job)) return;
    retainedUtf16-=job.cost.units;retainedTexts-=job.cost.texts;job.cleanup();job.texts=null;
  };
  const cancel=(job,code)=>{
    if(job.cancelled) return;job.cancelled=true;
    if(code==='LOCAL_NER_INFERENCE_FAILED') counts.expired++;
    if(code==='LOCAL_NER_ABORTED') counts.aborted++;
    const i=waiting.indexOf(job);
    if(i>=0){waiting.splice(i,1);release(job);}else job.cleanup();
    job.reject(new Error(code));
  };
  const stop=()=>{
    closed=true;clearFlush();
    for(const job of [...jobs]) cancel(job,'LOCAL_NER_NOT_AVAILABLE');
  };
  const pump=()=>{
    clearFlush();
    for(const job of [...waiting]) if(performance.now()>=job.deadline) cancel(job,'LOCAL_NER_INFERENCE_FAILED');
    while(!closed && active<concurrency && waiting.length) {
      // Small bursts should use all free processes, not fill one large packet
      // while leaving another native lane idle. Large bursts retain size eight.
      const fairSize=Math.min(maxRequestsPerBatch,Math.ceil(waiting.length/(concurrency-active)));
      const batch=take(waiting,0,fairSize).selected;waiting.splice(0,batch.length);
      active++;activeRequests+=batch.length;counts.peak_active=Math.max(counts.peak_active,active);counts.started+=batch.length;
      const start=performance.now();for(const j of batch) observe(queueWait,start-j.arrived);
      Promise.resolve().then(()=>dispatch(batch.map(j=>j.texts))).then(results=>{
        if(!Array.isArray(results)||results.length!==batch.length) throw new Error('LOCAL_NER_OUTPUT_INVALID');
        if(results.some((r,i)=>!Array.isArray(r)||r.length!==batch[i].cost.texts)) throw new Error('LOCAL_NER_OUTPUT_INVALID');
        const copies=results.map(r=>structuredClone(r));
        counts.completed_batches++;batchSizes[batch.length-1]++;
        for(let i=0;i<batch.length;i++) {
          if(!batch[i].cancelled && performance.now()>=batch[i].deadline) cancel(batch[i],'LOCAL_NER_INFERENCE_FAILED');
          if(!batch[i].cancelled && !closed) batch[i].resolve(copies[i]);
        }
      }).catch(()=>{
        if(!closed&&!failed){failed=true;stop();onFailure?.();}
      }).finally(()=>{
        for(const job of batch) {counts.settled++;observe(service,performance.now()-start);release(job);}
        active--;activeRequests-=batch.length;pump();
        if(!active) for(const resolve of drainers.splice(0)) resolve();
      });
    }
  };
  const describe=h=>({count:h.count,total_ms:h.total_ms,max_ms:h.max_ms,
    histogram:bounds.map((b,i)=>({upper_ms:Number.isFinite(b)?b:null,count:h.buckets[i]}))});
  return Object.freeze({
    run(texts,{signal}={}) {
      counts.submitted++;
      if(closed) return Promise.reject(new Error('LOCAL_NER_NOT_AVAILABLE'));
      if(signal?.aborted) return Promise.reject(new Error('LOCAL_NER_ABORTED'));
      if(signal!==undefined && (typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function')) return Promise.reject(new Error('LOCAL_NER_SIGNAL_INVALID'));
      if(!Array.isArray(texts)||texts.length>512||texts.some(t=>typeof t!=='string'||!t.isWellFormed()||t.length>100000))
        return Promise.reject(new Error('LOCAL_NER_TEXT_INVALID'));
      texts=[...texts];const size=cost(texts);
      if(size.units>100000) return Promise.reject(new Error('LOCAL_NER_TEXT_INVALID'));
      if(jobs.size>=maxOutstandingRequests||queuedBatches([...waiting,{cost:size}])>maxPending+(concurrency-active)) {
        counts.rejected_full++;return Promise.reject(new Error('LOCAL_NER_QUEUE_FULL'));
      }
      if(retainedUtf16+size.units>maxOutstandingUtf16||retainedTexts+size.texts>maxOutstandingTexts) {
        counts.rejected_memory++;return Promise.reject(new Error('LOCAL_NER_QUEUE_BYTES_FULL'));
      }
      counts.admitted++;retainedUtf16+=size.units;retainedTexts+=size.texts;
      return new Promise((resolve,reject)=>{
        let timer;const abort=()=>cancel(job,'LOCAL_NER_ABORTED');
        const arrived=performance.now();
        const job={texts,cost:size,resolve,reject,arrived,deadline:arrived+timeoutMs,cancelled:false,cleanup(){clearTimeout(timer);signal?.removeEventListener('abort',abort);}};
        jobs.add(job);waiting.push(job);signal?.addEventListener('abort',abort,{once:true});
        timer=setTimeout(()=>cancel(job,'LOCAL_NER_INFERENCE_FAILED'),timeoutMs);
        counts.peak_pending=Math.max(counts.peak_pending,waiting.length);counts.peak_outstanding=Math.max(counts.peak_outstanding,jobs.size);
        counts.peak_waiting_batches=Math.max(counts.peak_waiting_batches,queuedBatches(waiting));
        counts.peak_retained_utf16=Math.max(counts.peak_retained_utf16,retainedUtf16);counts.peak_retained_texts=Math.max(counts.peak_retained_texts,retainedTexts);
        if(flushTimer===null && active<concurrency) {
          if(waitMs===0) {flushTimer=true;queueMicrotask(()=>{if(flushTimer===true) pump();});}
          else flushTimer=setTimeout(pump,waitMs);
        }
      });
    },
    diagnostics(){return {mode:'bounded_microbatch',queue_unit:'independent_native_batch',pending_unit:'logical_request',state:failed?'FAILED':closed?'CLOSED':'READY',
      concurrency,max_pending:maxPending,timeout_ms:timeoutMs,active,pending:waiting.length,active_requests:activeRequests,
      waiting_batches:queuedBatches(waiting),
      outstanding_requests:jobs.size,retained_utf16:retainedUtf16,retained_texts:retainedTexts,max_requests_per_batch:maxRequestsPerBatch,
      max_outstanding_requests:maxOutstandingRequests,max_outstanding_utf16:maxOutstandingUtf16,max_outstanding_texts:maxOutstandingTexts,
      max_batch_texts:maxBatchTexts,max_batch_utf16:maxBatchUtf16,collection_wait_ms:waitMs,...counts,
      batch_size_histogram:batchSizes.map((count,i)=>({requests:i+1,count})),queue_wait:describe(queueWait),service:describe(service)};},
    async close(){stop();if(active) await new Promise(resolve=>drainers.push(resolve));},
  });
}
