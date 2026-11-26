// Offline CPU-only NER. No model hub, telemetry, network client, or text logging.
import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { availableParallelism } from 'node:os';
import { createBertTokenizer } from './bert-tokenizer.mjs';
import { createInferenceQueue } from './inference-queue.mjs';
import { createBatchPool } from './batch-pool.mjs';
import { loadClinicalPhiManifest, sha256 as hash, validateClinicalPhiLabels } from './clinical-model.mjs';
import {findOovSubjectSpans,OOV_SUBJECT_POLICY,findContextSubjectCandidates,CONTEXT_SUBJECT_POLICY,MAX_CONTEXT_SUBJECTS,MAX_CONTEXT_OCCURRENCES,hasSurnameGivenNameShape} from '../../lib/phi-oov-subjects.mjs';
const verifiedDetectors = new WeakSet();
const clinicalDetectors = new WeakMap();
const bulkDetectors = new WeakMap(), diagnostics = new WeakMap();
export function isVerifiedLocalChineseNer(detector) { return verifiedDetectors.has(detector); }
export function getClinicalPhiModelBinding(detector) {
  return verifiedDetectors.has(detector) ? clinicalDetectors.get(detector) : undefined;
}
export function detectManyLocalChineseNer(detector,texts,options) {
  if(!verifiedDetectors.has(detector)) throw new Error('LOCAL_NER_NOT_AVAILABLE');
  return bulkDetectors.get(detector)(texts,options);
}
export function getLocalNerDiagnostics(detector) { return diagnostics.get(detector)?.(); }
const LABELS = { PER: 'PERSON', PERSON: 'PERSON', LOC: 'ADDRESS', LOCATION: 'ADDRESS',
  ADDRESS: 'ADDRESS', GPE: 'ADDRESS', FAC: 'ADDRESS', ORG: 'ORGANIZATION',
  ORGANIZATION: 'ORGANIZATION', CONTACT: 'CONTACT', IDENTIFIER: 'IDENTIFIER' };

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
  threads = availableParallelism() <= 4 ? 1 : 2, timeoutMs = 30000, maxPending = 32,
  batchWorkers = Math.min(4, availableParallelism()), clinicalManifestSha256 } = {}) {
  if (typeof modelDirectory !== 'string' || !isAbsolute(modelDirectory) || /^(?:https?:|\\\\|\/\/)/i.test(modelDirectory)) throw new Error('LOCAL_NER_DIRECTORY_REQUIRED');
  if (!Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > 512 || !Number.isInteger(overlap)
    || overlap < 8 || overlap >= maxTokens - 2 || !Number.isInteger(maxTextLength) || maxTextLength < 1 || maxTextLength > 100000
    || !Number.isInteger(threads) || threads < 1 || threads > 8 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || !Number.isInteger(batchWorkers) || batchWorkers < 1 || batchWorkers > 4) throw new Error('LOCAL_NER_LIMIT_INVALID');
  const queue = createInferenceQueue({ maxPending, timeoutMs });
  const clinical = clinicalManifestSha256 !== undefined;
  let config, manifest, ort, session, pool, tokenizer, detector, graphVersion, closed=false, closing, nativeCalls=0;
  try {
    const baseline = JSON.parse(await readFile(new URL('./model-manifest.json', import.meta.url), 'utf8'));
    manifest = clinical ? await loadClinicalPhiManifest(modelDirectory, clinicalManifestSha256, baseline) : baseline;
    const assets = {};
    for (const [name, expected] of Object.entries(manifest.files)) {
      const content = await readFile(resolve(modelDirectory, name));
      if (content.length !== expected.bytes || hash(content) !== expected.sha256) throw new Error('integrity');
      assets[name] = content;
    }
    config = JSON.parse(assets['config.json']);
    const bytes = assets['model_quantized.onnx'];
    if (config.model_type !== 'bert' || !config.id2label || maxTokens > config.max_position_embeddings) throw new Error('configuration');
    if (clinical) {
      if (!Number.isSafeInteger(config.max_position_embeddings) || Array.isArray(config.id2label)) throw new Error('configuration');
      validateClinicalPhiLabels(config.id2label);
    }
    tokenizer = createBertTokenizer(JSON.parse(assets['tokenizer.json']));
    ort = await import('onnxruntime-node');
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['cpu'], intraOpNumThreads: threads,
      interOpNumThreads: 1, graphOptimizationLevel: 'all', logSeverityLevel: 4,
      extra:{session:{intra_op:{allow_spinning:'0'},inter_op:{allow_spinning:'0'}}} });
    let workerGraph = bytes;
    if (clinical) graphVersion = 'clinical-single-row';
    else {
      const { buildIndependentBatchGraph, BATCH_GRAPH_VERSION } = await import('./independent-batch-graph.mjs');
      workerGraph = buildIndependentBatchGraph(bytes);
      graphVersion = BATCH_GRAPH_VERSION;
    }
    pool=await createBatchPool(workerGraph,{threads,classes:Object.keys(config.id2label).length,workerCount:batchWorkers,singleRows:clinical,
      onFailure(){ closed=true; if(detector) verifiedDetectors.delete(detector); void queue.close(); }});
  } catch { await pool?.close(); await session?.release(); throw new Error('LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE'); }
  if (session.inputNames.some(n => !['input_ids','attention_mask','token_type_ids'].includes(n))
    || !session.inputNames.includes('input_ids') || !session.outputNames.includes('logits')) {
    await pool.close(); await session.release(); throw new Error('LOCAL_NER_GRAPH_UNSUPPORTED');
  }
  let contextProbeWindows=0;
  const finish=(text,spans)=>{
    for (const s of spans) if (s.label === 'ADDRESS') s.end += /^(?:\s*[0-9０-９一二三四五六七八九十百甲乙丙-]+(?:号|弄|栋|幢|单元|楼|层|室))+/.exec(text.slice(s.end))?.[0].length ?? 0;
    return {text_sha256:hash(text),complete:true,spans,
      subject_screening:{policy:OOV_SUBJECT_POLICY,spans:findOovSubjectSpans(text,tokenizer.isUnknownHan)},
      context_subject_screening:{policy:CONTEXT_SUBJECT_POLICY,complete:true,probe_count:0,candidate_count:0,reused_input_count:0,spans:[]}};
  };
  async function finishWithContext(texts,raw,cancelled,partitions) {
    const results=texts.map((text,i)=>finish(text,raw[i])),rows=[],unique=new Map(),counts=new Map(),occurrences=new Map();
    // An exact crop may already be one of this logical operation's original
    // inputs (for example a structured name). Those independently computed raw
    // logits are identical evidence; never look in another request's partition.
    const originals=new Map(texts.map((text,i)=>[(partitions?.[i]??0)+'\0'+text,raw[i]])),recognized=new Map();
    const targets=texts.map((text,i)=>{
      const candidates=findContextSubjectCandidates(text,tokenizer.isUnknownHan,raw[i]),partition=partitions?.[i]??0;
      occurrences.set(partition,(occurrences.get(partition)??0)+candidates.length);
      if(occurrences.get(partition)>MAX_CONTEXT_OCCURRENCES) throw new Error('LOCAL_NER_SUBJECT_LIMIT');
      results[i].context_subject_screening.candidate_count=candidates.length;
      const textCrops=new Set();
      return candidates.map(span=>{
        const crop=text.slice(span.start,span.end),key=partition+'\0'+crop;
        if(!unique.has(key)) {
          counts.set(partition,(counts.get(partition)??0)+1);
          if(counts.get(partition)>MAX_CONTEXT_SUBJECTS) throw new Error('LOCAL_NER_SUBJECT_LIMIT');
          if(originals.has(key)) {
            unique.set(key,{reused:true});
            recognized.set(key,originals.get(key).some(s=>s.label==='PERSON'&&s.start===0&&s.end===crop.length));
          } else {
            const tokens=tokenizer.encode(crop),index=rows.length;
            if(!tokens.length||tokens.length>4||index>=512) throw new Error('LOCAL_NER_SUBJECT_LIMIT');
            unique.set(key,{reused:false});rows.push({index,key,ids:[tokenizer.cls,...tokens.map(t=>t.id),tokenizer.sep],tokens,crop});
          }
        }
        if(!textCrops.has(crop)) {
          textCrops.add(crop);results[i].context_subject_screening.probe_count++;
          if(unique.get(key).reused)results[i].context_subject_screening.reused_input_count++;
        }
        return {span,key,crop};
      });
    });
    if(cancelled()) throw new Error('LOCAL_NER_ABORTED');
    const output=rows.length?await pool.run(rows.map(({index,ids})=>({index,ids})),cancelled,{compactShortRows:true}):[],seen=new Set();
    for(const r of output) {
      const row=rows[r.index];
      if(!Number.isInteger(r.index)||!row||seen.has(r.index)||!(r.data instanceof Float32Array)) throw new Error('LOCAL_NER_OUTPUT_INVALID');
      const spans=decodeNerLogits({dims:[1,row.ids.length,Object.keys(config.id2label).length],data:r.data},row.tokens,config.id2label);
      seen.add(r.index);recognized.set(row.key,spans.some(s=>s.label==='PERSON'&&s.start===0&&s.end===row.crop.length));
    }
    if(seen.size!==rows.length||recognized.size!==unique.size||cancelled()) throw new Error('LOCAL_NER_INFERENCE_FAILED');
    contextProbeWindows+=rows.length;
    for(const [i,items] of targets.entries()) for(const {span,key,crop} of items) {
      const neural=recognized.get(key);
      if(neural || hasSurnameGivenNameShape(crop)) {
        results[i].context_subject_screening.spans.push({...span,label:'PERSON',
          method:neural?'source_crop_ner':'surname_subject_rule',probe_text_sha256:hash(crop)});
      }
    }
    return results;
  }
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
        return (await finishWithContext([text],[spans],cancelled))[0];
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
  bulkDetectors.set(detector,async(texts,{signal,partitions}={})=>{
    if(!Array.isArray(texts)||texts.length>512||texts.reduce((n,t)=>n+(typeof t==='string'?t.length:100001),0)>100000) throw new Error('LOCAL_NER_LIMIT_INVALID');
    texts=[...texts]; // freeze caller-owned ordering before queue admission
    if(partitions!==undefined && (!Array.isArray(partitions)||partitions.length!==texts.length||partitions.some(n=>!Number.isSafeInteger(n)||n<0))) throw new Error('LOCAL_NER_LIMIT_INVALID');
    if(partitions) partitions=[...partitions];
    texts.forEach(validateText);
    if(texts.length===1) return [await detector.detect(texts[0],{signal})];
    return queue.run(async cancelled=>{
      const unique=new Map(), rows=[], windows=texts.map((text,textIndex)=>{
        const tokens=tokenizer.encode(text), parts=[], size=maxTokens-2;
        for(let start=0;start<tokens.length;start+=size-overlap) {
          const window=tokens.slice(start,start+size), ids=[tokenizer.cls,...window.map(t=>t.id),tokenizer.sep];
          // Cross-request batching shares compute only, not window caches.
          const key=(partitions ? partitions[textIndex]+':' : '')+ids.join(',');
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
      return finishWithContext(texts,windows.map(parts=>parts.flatMap(({index,window})=>decodeNerLogits({
        dims:[1,window.length+2,Object.keys(config.id2label).length],data:byIndex.get(index)},window,config.id2label))),cancelled,partitions);
    },{signal});
  });
  diagnostics.set(detector,()=>Object.freeze({mode:'in_process',single_native_calls:nativeCalls,context_probe_windows:contextProbeWindows,...pool.diagnostics(),batch_graph:graphVersion,queue:queue.diagnostics()}));
  if (clinical) {
    // Execute the alternate model before registering it as an available detector.
    try {
      await pool.run([{ index: 0, ids: [tokenizer.cls, tokenizer.encode('临床')[0].id, tokenizer.sep] }]);
    } catch {
      await detector.close();
      throw new Error('LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE');
    }
    clinicalDetectors.set(detector, Object.freeze({
      tenant_id: manifest.tenant_id, manifest_sha256: clinicalManifestSha256,
    }));
  }
  verifiedDetectors.add(detector);
  return detector;
}

// Registration remains private to this factory. Arbitrary local objects and
// forged IPC receipts cannot become production-approved detectors.
export async function createLocalChineseNerPool(options={}) {
  if (options.clinicalManifestSha256 !== undefined) throw new Error('PHI_CLINICAL_NER_PROCESS_POOL_UNSUPPORTED');
  const {createNerProcessPool}=await import('./process-pool.mjs');
  let detector;
  const pool=await createNerProcessPool(options,{onFailure(){if(detector) verifiedDetectors.delete(detector);}});
  detector=Object.freeze({id:pool.id,version:pool.version,execution:'local',device:'cpu',
    detect(text,options){return pool.detect([text],options).then(results=>results[0]);},
    async close(){verifiedDetectors.delete(detector);await pool.close();}});
  bulkDetectors.set(detector,(texts,options)=>pool.detect(texts,options));
  diagnostics.set(detector,()=>pool.diagnostics());verifiedDetectors.add(detector);return detector;
}
