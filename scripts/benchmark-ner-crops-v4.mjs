// Component timing uses prior development names, never the unseen challenge.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createBertTokenizer} from '../plugins/medcius/runtimes/cn-phi-ner/bert-tokenizer.mjs';
import {buildIndependentBatchGraph} from '../plugins/medcius/runtimes/cn-phi-ner/independent-batch-graph.mjs';
const [baselineRoot,out]=process.argv.slice(2);if(!baselineRoot||!out||process.argv.length!==4)throw new Error('ARGUMENTS');
const hash=b=>createHash('sha256').update(b).digest('hex'),dir=process.env.MEDCIUS_CN_NER_MODEL_DIR;
const bytes=await readFile(dir+'/model_quantized.onnx'),spec=JSON.parse(await readFile(dir+'/tokenizer.json','utf8')),config=JSON.parse(await readFile(dir+'/config.json','utf8'));
const tokenizer=createBertTokenizer(spec),graph=buildIndependentBatchGraph(bytes),arms=[],runs=[],sources={};
for(const p of ['scripts/benchmark-ner-crops-v4.mjs','plugins/medcius/runtimes/cn-phi-ner/batch-pool.mjs','plugins/medcius/runtimes/cn-phi-ner/batch-worker.mjs','plugins/medcius/runtimes/cn-phi-ner/independent-batch-graph.mjs'])sources[p]=hash(await readFile(p));
const names=['郤珺','欧阳星澜','邢珺','令狐珺'],rows=Array.from({length:64},(_,index)=>({index,ids:[tokenizer.cls,...tokenizer.encode(names[index%4]).map(t=>t.id),tokenizer.sep]}));
try {
 for(const [name,root] of [['before',baselineRoot],['after','.']]) {
  const module=await import(pathToFileURL(resolve(root,'plugins/medcius/runtimes/cn-phi-ner/batch-pool.mjs')));
  arms.push({name,pool:await module.createBatchPool(graph,{threads:2,workerCount:2,classes:Object.keys(config.id2label).length})});
 }
 for(const count of [1,2,4,8,13,24,25,64]) {
  for(const arm of arms)await arm.pool.run(rows.slice(0,count),()=>false,{compactShortRows:true});
  for(let round=0;round<12;round++)for(const arm of round%2?[...arms].reverse():arms) {
   const prior=arm.pool.diagnostics(),start=performance.now(),output=await arm.pool.run(rows.slice(0,count),()=>false,{compactShortRows:true}),ms=performance.now()-start;
   if(output.length!==count)throw new Error('OUTPUT_INCOMPLETE');
   runs.push({count,round:round+1,arm:arm.name,ms,native_batches:arm.pool.diagnostics().completed_batches-prior.completed_batches});
  }
 }
 for(const [p,h] of Object.entries(sources))if(hash(await readFile(p))!==h)throw new Error('SOURCE_CHANGED');
 await writeFile(out,JSON.stringify({created_at:new Date().toISOString(),scope:'PAIRED_LOCAL_CROP_COMPONENT_ONLY',sources,baseline_pool_sha256:hash(await readFile(resolve(baselineRoot,'plugins/medcius/runtimes/cn-phi-ner/batch-pool.mjs'))),model_sha256:hash(bytes),options:{threads:2,batchWorkers:2,rounds:12},runs},null,2)+'\n');
 for(const count of [1,2,4,8,13,24,25,64]) console.log(JSON.stringify({count,...Object.fromEntries(arms.map(a=>{const r=runs.filter(r=>r.count===count&&r.arm===a.name);return [a.name,r.reduce((s,r)=>s+r.ms,0)/r.length];}))}));
}finally{for(const arm of arms)await arm.pool.close();}
