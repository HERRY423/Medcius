// Offline CPU-only NER. No model hub, telemetry, network client, or text logging.
import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { createBertTokenizer } from './bert-tokenizer.mjs';
import { createInferenceQueue } from './inference-queue.mjs';
import { createBatchPool } from './batch-pool.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const verifiedDetectors = new WeakSet();
const bulkDetectors = new WeakMap(), diagnostics = new WeakMap();
export function isVerifiedLocalChineseNer(detector) { return verifiedDetectors.has(detector); }
export function detectManyLocalChineseNer(detector,texts,options) {
  if(!verifiedDetectors.has(detector)) throw new Error('LOCAL_NER_NOT_AVAILABLE');
  return bulkDetectors.get(detector)(texts,options);
}
export function getLocalNerDiagnostics(detector) { return diagnostics.get(detector)?.(); }
const LABELS = { PER: 'PERSON', PERSON: 'PERSON', LOC: 'ADDRESS', LOCATION: 'ADDRESS',
  GPE: 'ADDRESS', FAC: 'ADDRESS', ORG: 'ORGANIZATION' };

export function decodeNerLogits(logits, tokens, id2label) {
  const count = Object.keys(id2label).length;
  if (logits?.dims?.length !== 3 || logits.dims[0] !== 1 || logits.dims[1] !== tokens.length + 2
    || logits.dims[2] !== count || logits.data?.length !== (tokens.length + 2) * count) throw new Error('LOCAL_NER_OUTPUT_INVALID');
  const spans = []; let current = null;
  const flush = () => { if (current) spans.push(current); current = null; };
  for (let i=0;i<tokens.length;i++) {
    let best = -Infinity, labelId = -1;
    for (let j=0;j<count;j++) {
      const v = logits.data[(i+1)*count+j];
      if (!Number.isFinite(v)) throw new Error('LOCAL_NER_OUTPUT_INVALID');
      if (v > best) { best = v; labelId = j; }
    }
    const tag = id2label[labelId];
    if (typeof tag !== 'string') throw new Error('LOCAL_NER_LABEL_INVALID');
    const m = /^([BIESUL])-(.+)$/.exec(tag), label = m && LABELS[m[2]];
    if (!label) { flush(); continue; }
    if (['B','S','U'].includes(m[1]) || current?.label !== label) flush();
    if (!current) current = { start: tokens[i].start, end: tokens[i].end, label };
    else current.end = tokens[i].end;
    if (['E','S','L','U'].includes(m[1])) flush();
  }
  flush(); return spans;
}

export async function createLocalChineseNer({ modelDirectory, maxTokens = 256, overlap = 32, maxTextLength = 100000,
  threads = 2, timeoutMs = 30000, maxPending = 32 } = {}) {
  if (typeof modelDirectory !== 'string' || !isAbsolute(modelDirectory) || /^(?:https?:|\\\\|\/\/)/i.test(modelDirectory)) throw new Error('LOCAL_NER_DIRECTORY_REQUIRED');
  if (!Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > 512 || !Number.isInteger(overlap)
    || overlap < 8 || overlap >= maxTokens - 2 || !Number.isInteger(maxTextLength) || maxTextLength < 1 || maxTextLength > 100000
    || !Number.isInteger(threads) || threads < 1 || threads > 8 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('LOCAL_NER_LIMIT_INVALID');
  const queue = createInferenceQueue({ maxPending, timeoutMs });
  let spec, config, bytes, manifest, ort, session, pool, detector, graphVersion, closed=false, closing, nativeCalls=0;
  try {
    manifest = JSON.parse(await readFile(new URL('./model-manifest.json', import.meta.url), 'utf8'));
    const assets = {};
    for (const [name, expected] of Object.entries(manifest.files)) {
      const content = await readFile(resolve(modelDirectory, name));
      if (content.length !== expected.bytes || hash(content) !== expected.sha256) throw new Error('integrity');
      assets[name] = content;
    }
    config = JSON.parse(assets['config.json']); spec = JSON.parse(assets['tokenizer.json']); bytes = assets['model_quantized.onnx'];
    if (config.model_type !== 'bert' || !config.id2label || maxTokens > config.max_position_embeddings) throw new Error('configuration');
    ort = await import('onnxruntime-node');
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['cpu'], intraOpNumThreads: threads,
      interOpNumThreads: 1, graphOptimizationLevel: 'all', logSeverityLevel: 4,
      extra:{session:{intra_op:{allow_spinning:'0'},inter_op:{allow_spinning:'0'}}} });
    const {buildIndependentBatchGraph,BATCH_GRAPH_VERSION}=await import('./independent-batch-graph.mjs');graphVersion=BATCH_GRAPH_VERSION;
    pool=await createBatchPool(buildIndependentBatchGraph(bytes),{threads,classes:Object.keys(config.id2label).length,
      onFailure(){ closed=true; if(detector) verifiedDetectors.delete(detector); void queue.close(); }});
  } catch { await pool?.close(); await session?.release(); throw new Error('LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE'); }
  const tokenizer = createBertTokenizer(spec);
  if (session.inputNames.some(n => !['input_ids','attention_mask','token_type_ids'].includes(n))
    || !session.inputNames.includes('input_ids') || !session.outputNames.includes('logits')) {
    await pool.close(); await session.release(); throw new Error('LOCAL_NER_GRAPH_UNSUPPORTED');
  }
  const finish=(text,spans)=>{
    for (const s of spans) if (s.label === 'ADDRESS') s.end += /^(?:\s*[0-9０-９一二三四五六七八九十百甲乙丙-]+(?:号|弄|栋|幢|单元|楼|层|室))+/.exec(text.slice(s.end))?.[0].length ?? 0;
    return {text_sha256:hash(text),complete:true,spans};
  };
  const validateText=text=>{
    if (closed) throw new Error('LOCAL_NER_NOT_AVAILABLE');
    if (typeof text !== 'string' || !text.isWellFormed() || text.length > maxTextLength) throw new Error('LOCAL_NER_TEXT_INVALID');
  };
  detector = Object.freeze({
    id: manifest.model_id, version: manifest.revision, execution: 'local', device: 'cpu',
    async detect(text, { signal } = {}) {
      validateText(text);
      if (signal?.aborted) throw new Error('LOCAL_NER_ABORTED');
      return queue.run(async cancelled => {
        const tokens = tokenizer.encode(text), spans = [];
        const size = maxTokens - 2;
        for (let start = 0; start < tokens.length; start += size - overlap) {
          if (cancelled()) throw new Error('LOCAL_NER_ABORTED');
          const window = tokens.slice(start, start + size);
          const ids = [tokenizer.cls, ...window.map(t => t.id), tokenizer.sep];
          const feeds = {};
          for (const key of session.inputNames) {
            const values = key === 'input_ids' ? ids : ids.map(() => key === 'attention_mask' ? 1 : 0);
            feeds[key] = new ort.Tensor('int64', BigInt64Array.from(values, BigInt), [1, ids.length]);
          }
          let output;
          try { nativeCalls++; output = await session.run(feeds); }
          catch { throw new Error('LOCAL_NER_INFERENCE_FAILED'); }
          if (cancelled()) throw new Error('LOCAL_NER_ABORTED');
          spans.push(...decodeNerLogits(output.logits, window, config.id2label));
          if (start + size >= tokens.length) break;
        }
        return finish(text,spans);
      }, { signal });
    },
    async close() {
      if (!closing) {
        closed = true; verifiedDetectors.delete(detector);
        closing = queue.close().then(async () => { await pool.close(); await session.release(); });
      }
      await closing;
    },
  });
  bulkDetectors.set(detector,async(texts,{signal}={})=>{
    if(!Array.isArray(texts)||texts.length>512||texts.reduce((n,t)=>n+(typeof t==='string'?t.length:100001),0)>100000) throw new Error('LOCAL_NER_LIMIT_INVALID');
    texts=[...texts]; // freeze caller-owned ordering before queue admission
    texts.forEach(validateText);
    if(texts.length===1) return [await detector.detect(texts[0],{signal})];
    return queue.run(async cancelled=>{
      const unique=new Map(), rows=[], windows=texts.map(text=>{
        const tokens=tokenizer.encode(text), parts=[], size=maxTokens-2;
        for(let start=0;start<tokens.length;start+=size-overlap) {
          const window=tokens.slice(start,start+size), ids=[tokenizer.cls,...window.map(t=>t.id),tokenizer.sep];
          const key=ids.join(',');
          if(!unique.has(key)) { unique.set(key,rows.length);rows.push({index:rows.length,ids}); }
          parts.push({index:unique.get(key),window});
          if(start+size>=tokens.length) break;
        }
        return parts;
      });
      const results=await pool.run(rows,cancelled), byIndex=new Map();
      for(const result of results) {
        if(!Number.isInteger(result.index)||!rows[result.index]||byIndex.has(result.index)
          || !(result.data instanceof Float32Array) || result.data.length!==rows[result.index].ids.length*Object.keys(config.id2label).length) throw new Error('LOCAL_NER_OUTPUT_INVALID');
        byIndex.set(result.index,result.data);
      }
      if(byIndex.size!==rows.length || cancelled()) throw new Error('LOCAL_NER_INFERENCE_FAILED');
      return texts.map((text,i)=>finish(text,windows[i].flatMap(({index,window})=>decodeNerLogits({
        dims:[1,window.length+2,Object.keys(config.id2label).length],data:byIndex.get(index)},window,config.id2label))));
    },{signal});
  });
  diagnostics.set(detector,()=>Object.freeze({single_native_calls:nativeCalls,...pool.diagnostics(),batch_graph:graphVersion}));
  verifiedDetectors.add(detector);
  return detector;
}
