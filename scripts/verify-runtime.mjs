#!/usr/bin/env node
// Offline release readiness probe. A successful import alone is insufficient.
import { resolvePhiDetector } from '../plugins/medcius/lib/phi-runtime.mjs';
import { detectManyLocalChineseNer } from '../plugins/medcius/runtimes/cn-phi-ner/detector.mjs';
let detector;
try {
  detector = await resolvePhiDetector();
  const result = await detector.detect('王建国因胸痛入院。');
  if (!result.complete || !result.spans.some(s => s.label === 'PERSON' && s.start === 0 && s.end >= 3))
    throw new Error('RUNTIME_NER_PROBE_FAILED');
  const batch=await detectManyLocalChineseNer(detector,['王建国因胸痛入院。','林志明居住于和平路28号。']);
  if(batch.length!==2 || batch.some(r=>!r.complete || !r.spans.some(s=>s.label==='PERSON'&&s.start===0&&s.end>=3)))
    throw new Error('RUNTIME_NER_BATCH_PROBE_FAILED');
  console.log('RUNTIME_READY: manifest-verified local CPU NER executed');
} catch {
  console.error('RUNTIME_NOT_READY: local model or native dependency verification failed');
  process.exitCode = 1;
} finally { await detector?.close(); }
