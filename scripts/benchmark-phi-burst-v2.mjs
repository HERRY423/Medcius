#!/usr/bin/env node
// Synthetic admission bursts, not hospital traffic or the 80-ms pre-round gate.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {cpus,availableParallelism,platform,release,totalmem} from 'node:os';
import {createHash} from 'node:crypto';
import {createLocalChineseNerPool,getLocalNerDiagnostics} from '../plugins/medcius/runtimes/cn-phi-ner/detector.mjs';
import {createPatientSourceSnapshotAsync,getPatientSnapshotPhiSession} from '../plugins/medcius/lib/patient-source-snapshot.mjs';
const output=process.argv[2];if(!output||process.argv.length!==3) throw new Error('USAGE: benchmark-phi-burst-v2.mjs OUTPUT_JSON');
const modelDirectory=process.env.MEDCIUS_CN_NER_MODEL_DIR;if(!modelDirectory) throw new Error('LOCAL_MODEL_REQUIRED');
process.env.MEDCIUS_PROFILE='production';
const hash=x=>createHash('sha256').update(x).digest('hex');
const sourcePaths=['scripts/benchmark-phi-burst-v2.mjs','plugins/medcius/lib/phi-oov-subjects.mjs','plugins/medcius/runtimes/cn-phi-ner/request-batcher.mjs','plugins/medcius/runtimes/cn-phi-ner/detector.mjs',
  'plugins/medcius/runtimes/cn-phi-ner/process-pool.mjs','plugins/medcius/runtimes/cn-phi-ner/process-worker.mjs',
  'plugins/medcius/runtimes/cn-phi-ner/inference-queue.mjs','plugins/medcius/runtimes/cn-phi-ner/batch-pool.mjs',
  'plugins/medcius/runtimes/cn-phi-ner/batch-worker.mjs','plugins/medcius/runtimes/cn-phi-ner/independent-batch-graph.mjs',
  'plugins/medcius/runtimes/cn-phi-ner/bert-tokenizer.mjs','plugins/medcius/lib/phi-entity-session.mjs',
  'plugins/medcius/lib/phi-inference-scope.mjs','plugins/medcius/lib/phi-runtime.mjs','plugins/medcius/lib/local-phi-egress.mjs',
  'plugins/medcius/lib/phi-clinical-literals.mjs','plugins/medcius/lib/patient-source-phi.mjs','plugins/medcius/lib/patient-source-snapshot.mjs',
  'plugins/medcius/servers/phiguard/src/lib.mjs'];
const sources={};for(const path of sourcePaths) sources[path]=hash(await readFile(path));
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
const profiles=[];
for(const profile of [
  {name:'fifo_pending32',options:{maxPending:32}},
  {name:'fifo_pending96',options:{maxPending:96}},
  {name:'microbatch8_pending32',options:{maxPending:32,microBatchMaxRequests:8,microBatchWaitMs:0,
    maxOutstandingRequests:128,maxOutstandingUtf16:1000000,maxOutstandingTexts:8192}},
]) {
  const start=performance.now(),detector=await createLocalChineseNerPool({modelDirectory,processes:2,threads:2,batchWorkers:2,cpuBudget:8,...profile.options});
  const startup_ms=performance.now()-start,rows=[];
  const request=async i=>{
    const source=input(i),snapshot=await createPatientSourceSnapshotAsync(source,{detector});
    try {
      const encoded=JSON.stringify(snapshot);
      if(/郄芃|林志明|赵星竹|欧阳星澜|郄主任|芃院/.test(encoded)) throw new Error('BENCHMARK_PHI_RESIDUAL');
      for(const literal of ['诉胸闷','无发热、咳嗽','偶有咳痰','胸痛缓解','血钾3.9mmol/L'])
        if(!encoded.includes(literal)) throw new Error('BENCHMARK_CLINICAL_LOSS');
      if(snapshot.context.patient_id!==source.context.patient_id) throw new Error('BENCHMARK_CONTEXT_MISMATCH');
    }
    finally {getPatientSnapshotPhiSession(snapshot,source.context)?.dispose();}
  };
  try {
    for(let i=0;i<3;i++) await request(i);
    for(const burst of [1,8,32,64]) {
      const runs=[];
      for(let round=0;round<3;round++) {
        const began=performance.now();
        const results=await Promise.all(Array.from({length:burst},async(_,i)=>{
          const at=performance.now();
          try {await request(i);return {status:'COMPLETED',elapsed_ms:performance.now()-at};}
          catch(e) {if(e.message.startsWith('BENCHMARK_')) throw e;return {status:'REJECTED',elapsed_ms:performance.now()-at,code:/^[A-Z_]+(?:: [A-Z_]+)?$/.test(e.message)?e.message:'GUARD_REJECTED'};}
        }));
        const duration_ms=performance.now()-began;
        const completed=results.filter(r=>r.status==='COMPLETED'), rejected=results.filter(r=>r.status==='REJECTED');
        runs.push({round:round+1,duration_ms,completed:completed.length,rejected:rejected.length,
          completed_latency:statistics(completed.map(r=>r.elapsed_ms)),rejection_latency:statistics(rejected.map(r=>r.elapsed_ms)),
          rejection_codes:rejected.reduce((r,e)=>(r[e.code]=(r[e.code]??0)+1,r),{}),
          throughput_per_second:completed.length/(duration_ms/1000)});
      }
      rows.push({simultaneous_requests:burst,runs});
    }
    profiles.push({profile:profile.name,options:{processes:2,threads:2,batchWorkers:2,cpuBudget:8,...profile.options},startup_ms,warmup_snapshots:3,rows,diagnostics:getLocalNerDiagnostics(detector)});
    console.log(JSON.stringify({profile:profile.name,scenarios:rows.map(r=>({burst:r.simultaneous_requests,
      completed:r.runs.reduce((s,x)=>s+x.completed,0),rejected:r.runs.reduce((s,x)=>s+x.rejected,0),
      mean_p95_ms:r.runs.reduce((s,x)=>s+(x.completed_latency?.p95_ms??0),0)/r.runs.length}))}));
  } finally {await detector.close();}
}
for(const path of sourcePaths) if(sources[path]!==hash(await readFile(path))) throw new Error('BENCHMARK_SOURCE_CHANGED');
const report={schema_version:'medcius.phi-burst.v2',created_at:new Date().toISOString(),scope:'SYNTHETIC_LOCAL_PHI_INGRESS_BURSTS',
  host:{platform:platform(),release:release(),node:process.version,available_parallelism:availableParallelism(),cpu:cpus()[0]?.model,total_memory_bytes:totalmem()},
  workload:{distinct_sources:64,rounds:3,burst_sizes:[1,8,32,64],sources_sha256:hash(JSON.stringify(Array.from({length:64},(_,i)=>input(i))))},
  limitations:['Authored synthetic development traffic; repeated requests are not independent clinical samples.',
    'Profiles run sequentially on this host with the same two processes and eight-native-thread budget; no randomized order or population inference.',
    'Latency statistics exclude rejected requests; rejections and their latency are reported separately.',
    'This is PHI ingress, not the full pre-round workflow or its fixed 80-ms gate.'],
  checks_per_completed_request:{full_phi_residual_check:true,clinical_literals:5,patient_context:true},clinical_evidence:'NOT_ESTABLISHED',reference_performance_gate:'NOT_EVALUATED',sources,profiles};
await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
