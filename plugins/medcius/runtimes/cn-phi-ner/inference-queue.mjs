// Bounded FIFO. Caller deadlines never free a slot until underlying native work
// or an isolated process reply settles. Counters contain no text or identity.
export function createInferenceQueue({ maxPending = 32, timeoutMs = 30000, concurrency = 1 } = {}) {
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 256
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('LOCAL_NER_LIMIT_INVALID');
  const waiting = [], active = new Set(), idleWaiters = [];
  const bounds=[1,5,10,25,50,100,250,500,1000,2000,5000,10000,30000,60000,Infinity];
  const histogram=()=>({count:0,total_ms:0,max_ms:0,buckets:bounds.map(()=>0)});
  const queueWait=histogram(), service=histogram();
  const observe=(h,ms)=>{h.count++;h.total_ms+=ms;h.max_ms=Math.max(h.max_ms,ms);h.buckets[bounds.findIndex(b=>ms<=b)]++;};
  const counts={submitted:0,admitted:0,started:0,settled:0,expired:0,aborted:0,rejected_full:0,peak_active:0,peak_pending:0};
  let closed = false;
  const pump = () => {
    if (active.size >= concurrency || closed) return;
    const job = waiting.shift();
    if (!job) return;
    active.add(job); counts.started++; counts.peak_active=Math.max(counts.peak_active,active.size);
    const started=performance.now();observe(queueWait,started-job.enqueued);
    Promise.resolve().then(() => {
      if(performance.now()>=job.enqueued+timeoutMs) job.cancel('LOCAL_NER_INFERENCE_FAILED');
      if (job.cancelled) throw new Error('LOCAL_NER_ABORTED');
      return job.work(() => job.cancelled);
    }).then(result=>{
      if(performance.now()>=job.enqueued+timeoutMs) job.cancel('LOCAL_NER_INFERENCE_FAILED');
      else job.resolve(result);
    }, job.reject).finally(() => {
      counts.settled++;observe(service,performance.now()-started);
      job.cleanup(); active.delete(job); pump();
      if(!active.size) for(const resolve of idleWaiters.splice(0)) resolve();
    });
    pump();
  };
  const describe=h=>({count:h.count,total_ms:h.total_ms,max_ms:h.max_ms,
    histogram:bounds.map((b,i)=>({upper_ms:Number.isFinite(b)?b:null,count:h.buckets[i]}))});
  return Object.freeze({
    run(work, { signal } = {}) {
      counts.submitted++;
      if (closed) return Promise.reject(new Error('LOCAL_NER_NOT_AVAILABLE'));
      if (typeof work !== 'function') return Promise.reject(new Error('LOCAL_NER_LIMIT_INVALID'));
      if (signal?.aborted) return Promise.reject(new Error('LOCAL_NER_ABORTED'));
      if (active.size >= concurrency && waiting.length >= maxPending) {
        counts.rejected_full++; return Promise.reject(new Error('LOCAL_NER_QUEUE_FULL'));
      }
      counts.admitted++;
      return new Promise((resolve, reject) => {
        let timer;
        const job = { work, resolve, reject, cancelled: false, enqueued: performance.now(), cleanup() {
          clearTimeout(timer); signal?.removeEventListener('abort', abort);
        } };
        const cancel = code => {
          if(job.cancelled) return;
          job.cancelled = true;
          if(code==='LOCAL_NER_INFERENCE_FAILED') counts.expired++;
          if(code==='LOCAL_NER_ABORTED') counts.aborted++;
          const i = waiting.indexOf(job);
          if (i >= 0) waiting.splice(i, 1);
          job.cleanup(); reject(new Error(code));
        };
        const abort = () => cancel('LOCAL_NER_ABORTED');
        job.cancel = cancel;
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => cancel('LOCAL_NER_INFERENCE_FAILED'), timeoutMs);
        waiting.push(job); pump(); counts.peak_pending=Math.max(counts.peak_pending,waiting.length);
      });
    },
    diagnostics(){return {state:closed?'CLOSED':'READY',concurrency,max_pending:maxPending,timeout_ms:timeoutMs,
      active:active.size,pending:waiting.length,...counts,queue_wait:describe(queueWait),service:describe(service)};},
    async close() {
      closed = true;
      for (const job of [...waiting]) job.cancel('LOCAL_NER_NOT_AVAILABLE');
      for(const job of active) job.cancel('LOCAL_NER_NOT_AVAILABLE');
      if(active.size) await new Promise(resolve=>idleWaiters.push(resolve));
    },
  });
}
