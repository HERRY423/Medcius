// Paired synthetic burst comparison of a frozen local baseline and this checkout.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {cpus,availableParallelism,platform,release} from 'node:os';
const [baselineRoot,baselineReport,output]=process.argv.slice(2);
if(!baselineRoot||!baselineReport||!output||process.argv.length!==5) throw new Error('USAGE: benchmark-phi-paired.mjs BASELINE_ROOT BASELINE_REPORT OUTPUT');
process.env.MEDCIUS_PROFILE='production';
const modelDirectory=process.env.MEDCIUS_CN_NER_MODEL_DIR;
const hash=x=>createHash('sha256').update(x).digest('hex');
const before=JSON.parse(await readFile(baselineReport,'utf8'));
const sources={},baselineSources={};
for(const [path,expected] of Object.entries(before.sources)) {
 const digest=hash(await readFile(resolve(baselineRoot,path)));
 if(digest!==expected) throw new Error('BASELINE_SOURCE_MISMATCH');
 baselineSources[path]=digest;sources[path]=hash(await readFile(resolve(path)));
}
sources['scripts/benchmark-phi-paired.mjs']=hash(await readFile('scripts/benchmark-phi-paired.mjs'));
const names=['郄芃','林志明','赵星竹','欧阳星澜'];
function input(i) {
  const context={tenant_id:'synthetic-site',ward_id:`synthetic-ward-${i%4}`,doctor_id:'synthetic-doctor',
    patient_id:`p-${i}`,encounter_id:`e-${i}`,phi_session_id:`s-${i}`};
  return {context,asOf:'2026-11-15T00:00:00Z',patient:{id:context.patient_id,name:names[i%4]},encounter:{id:context.encounter_id},
    practitioners:[{name:'郄芃'}],organizations:[{name:'合成芃禾医院',aliases:['芃院']}],
    notes:[{id:`n-${i}-a`,timestamp:'2026-11-14T23:00:00Z',text:`${names[i%4]}诉胸闷。`+'无发热、咳嗽，偶有咳痰。'.repeat(i%4===0?16:3)},
      {id:`n-${i}-b`,timestamp:'2026-11-14T22:00:00Z',text:'郄主任查房，胸痛缓解。转自芃院，血钾3.9mmol/L。'}]};
}
const statistics=values=>{
  if(!values.length) return null;
  const sorted=values.toSorted((a,b)=>a-b),q=p=>sorted[Math.max(0,Math.ceil(p*sorted.length)-1)];
  return {n:values.length,mean_ms:values.reduce((a,b)=>a+b,0)/values.length,p50_ms:q(.5),p95_ms:q(.95),p99_ms:q(.99),max_ms:sorted.at(-1)};
};

const options={processes:2,threads:2,batchWorkers:2,cpuBudget:8,maxPending:32,microBatchMaxRequests:8,microBatchWaitMs:0,
 maxOutstandingRequests:128,maxOutstandingUtf16:1000000,maxOutstandingTexts:8192};
const arms=[],runs=[];
try {
 for(const [name,root] of [['before',resolve(baselineRoot)],['after',resolve('.')]]) {
  const runtime=await import(pathToFileURL(resolve(root,'plugins/medcius/runtimes/cn-phi-ner/detector.mjs')));
  const snapshots=await import(pathToFileURL(resolve(root,'plugins/medcius/lib/patient-source-snapshot.mjs')));
  const started=performance.now(),detector=await runtime.createLocalChineseNerPool({modelDirectory,...options});
  const arm={name,root,runtime,snapshots,detector,startup_ms:performance.now()-started};arms.push(arm);
  arm.request=async i=>{
   const source=input(i),snapshot=await snapshots.createPatientSourceSnapshotAsync(source,{detector});
   try {
    const text=JSON.stringify(snapshot);
    if(/郄芃|林志明|赵星竹|欧阳星澜|郄主任|芃院/.test(text)) throw new Error('BENCHMARK_PHI_RESIDUAL');
    for(const literal of ['诉胸闷','无发热、咳嗽','偶有咳痰','胸痛缓解','血钾3.9mmol/L']) if(!text.includes(literal)) throw new Error('BENCHMARK_CLINICAL_LOSS');
    if(snapshot.context.patient_id!==source.context.patient_id) throw new Error('BENCHMARK_CONTEXT_MISMATCH');
   } finally {snapshots.getPatientSnapshotPhiSession(snapshot,source.context).dispose();}
  };
  for(let i=0;i<3;i++) await arm.request(i);
 }
 for(const burst of [1,8,32,64]) {
  for(let round=0;round<6;round++) for(const arm of round%2?[...arms].reverse():arms) {
   const started=performance.now();
   const rows=await Promise.all(Array.from({length:burst},async(_,i)=>{
    const at=performance.now();
    try {await arm.request(i);return {status:'COMPLETED',ms:performance.now()-at};}
    catch(e) {if(e.message.startsWith('BENCHMARK_')) throw e;return {status:'REJECTED',ms:performance.now()-at};}
   }));
   const duration_ms=performance.now()-started,completed=rows.filter(r=>r.status==='COMPLETED');
   runs.push({arm:arm.name,burst,round:round+1,order:round%2?'AFTER_BEFORE':'BEFORE_AFTER',duration_ms,
    completed:completed.length,rejected:rows.length-completed.length,completed_latency:statistics(completed.map(r=>r.ms)),
    throughput_per_second:completed.length/(duration_ms/1000)});
  }
  console.log(JSON.stringify({burst,arms:arms.map(a=>{const r=runs.filter(x=>x.arm===a.name&&x.burst===burst);return {name:a.name,completed:r.reduce((s,x)=>s+x.completed,0),rejected:r.reduce((s,x)=>s+x.rejected,0),mean_p95_ms:r.reduce((s,x)=>s+x.completed_latency.p95_ms,0)/r.length};})}));
 }
 for(const [path,digest] of Object.entries(sources)) if(hash(await readFile(path))!==digest) throw new Error('SOURCE_CHANGED');
 for(const [path,digest] of Object.entries(baselineSources)) if(hash(await readFile(resolve(baselineRoot,path)))!==digest) throw new Error('BASELINE_CHANGED');
 const workloadHash=hash(JSON.stringify(Array.from({length:64},(_,i)=>input(i))));
 if(workloadHash!==before.workload.sources_sha256) throw new Error('WORKLOAD_CHANGED');
 const report={schema_version:'medcius.phi-burst-paired.v1',created_at:new Date().toISOString(),scope:'SYNTHETIC_LOCAL_PHI_INGRESS_ONLY',
  host:{platform:platform(),release:release(),node:process.version,cpu:cpus()[0]?.model,available_parallelism:availableParallelism()},options,
  workload:{sources_sha256:workloadHash,bursts:[1,8,32,64],paired_rounds:6,warmup_per_arm:3},sources,baselineSources,runs,
  diagnostics:arms.map(a=>({arm:a.name,startup_ms:a.startup_ms,...a.runtime.getLocalNerDiagnostics(a.detector)})),
  limitations:['Deterministic alternating order, six paired bursts; not independent clinical samples or formal equivalence.',
   'Both model pools stay resident, but only one arm executes at a time; each arm has the same eight-thread native budget.',
   'The reference 80-ms full-workflow gate is not evaluated.'],clinical_evidence:'NOT_ESTABLISHED'};
 await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
} finally {for(const arm of arms) await arm.detector.close();}
