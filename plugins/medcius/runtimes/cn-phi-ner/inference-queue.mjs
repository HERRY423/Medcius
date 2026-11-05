// One native session, bounded FIFO. A caller deadline never frees a native slot
// until the underlying operation has actually settled (ORT cannot be cancelled).
export function createInferenceQueue({ maxPending = 32, timeoutMs = 30000 } = {}) {
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 256
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('LOCAL_NER_LIMIT_INVALID');
  const waiting = [];
  let active = null, closed = false, drain;
  const pump = () => {
    if (active || closed) return;
    const job = waiting.shift();
    if (!job) return;
    active = job;
    drain = Promise.resolve().then(() => {
      if (job.cancelled) throw new Error('LOCAL_NER_ABORTED');
      return job.work(() => job.cancelled);
    }).then(job.resolve, job.reject).finally(() => {
      job.cleanup(); active = null; pump();
    });
  };
  return Object.freeze({
    run(work, { signal } = {}) {
      if (closed) return Promise.reject(new Error('LOCAL_NER_NOT_AVAILABLE'));
      if (signal?.aborted) return Promise.reject(new Error('LOCAL_NER_ABORTED'));
      if (active && waiting.length >= maxPending) return Promise.reject(new Error('LOCAL_NER_QUEUE_FULL'));
      return new Promise((resolve, reject) => {
        let timer;
        const job = { work, resolve, reject, cancelled: false, cleanup() {
          clearTimeout(timer); signal?.removeEventListener('abort', abort);
        } };
        const cancel = code => {
          job.cancelled = true;
          const i = waiting.indexOf(job);
          if (i >= 0) waiting.splice(i, 1);
          job.cleanup(); reject(new Error(code));
        };
        const abort = () => cancel('LOCAL_NER_ABORTED');
        job.cancel = cancel;
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => cancel('LOCAL_NER_INFERENCE_FAILED'), timeoutMs);
        waiting.push(job); pump();
      });
    },
    async close() {
      closed = true;
      for (const job of [...waiting]) job.cancel('LOCAL_NER_NOT_AVAILABLE');
      active?.cancel('LOCAL_NER_NOT_AVAILABLE');
      await drain;
    },
  });
}
