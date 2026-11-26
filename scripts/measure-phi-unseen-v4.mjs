// Once-only, same-author synthetic holdout. No model/rule tuning after opening.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {redactionCoverage} from './measure-phi-clinical-development.mjs';
const [baselineRoot,evidenceDirectory]=process.argv.slice(2);
if(!baselineRoot||!evidenceDirectory||process.argv.length!==4)throw new Error('USAGE: measure-phi-unseen-v4.mjs BASELINE_ROOT EVIDENCE_DIRECTORY');
const hash=x=>createHash('sha256').update(x).digest('hex');
const read=async p=>JSON.parse(await readFile(p,'utf8')),dir=resolve(evidenceDirectory);
const freeze=await read(dir+'/freeze.json'),lock=await read(dir+'/implementation-freeze.json');
const bytes=await readFile(dir+'/challenge.json');if(hash(bytes)!==freeze.challenge_sha256||lock.challenge_sha256!==freeze.challenge_sha256)throw new Error('CHALLENGE_CHANGED');
const challenge=JSON.parse(bytes);
for(const row of challenge.rows) {
  if(typeof row.text!=='string'||!row.text.isWellFormed())throw new Error('GOLD_TEXT_INVALID');
  for(const s of [...row.phi,...row.keep])if(!Number.isInteger(s.start)||!Number.isInteger(s.end)||s.start<0||s.end<=s.start||s.end>row.text.length)throw new Error('GOLD_SPAN_INVALID');
  if(row.phi.some(p=>row.keep.some(k=>p.start<k.end&&p.end>k.start)))throw new Error('GOLD_OVERLAP');
}
async function verifySources(){for(const [path,digest] of Object.entries(lock.sources))if(hash(await readFile(path))!==digest)throw new Error('IMPLEMENTATION_CHANGED');
 for(const [path,digest] of Object.entries(lock.baseline_sources))if(hash(await readFile(resolve(baselineRoot,path)))!==digest)throw new Error('BASELINE_CHANGED');}
await verifySources();
await writeFile(dir+'/evaluation-started.json',JSON.stringify({started_at:new Date().toISOString(),implementation_freeze_sha256:hash(await readFile(dir+'/implementation-freeze.json')),challenge_sha256:hash(bytes)})+'\n',{flag:'wx'});
process.env.MEDCIUS_PROFILE='production';
const report={schema_version:'medcius.phi-unseen-paired.v4',scope:'SAME_AUTHOR_SYNTHETIC_HOLDOUT_NOT_BLINDED_OR_CLINICAL',challenge_sha256:hash(bytes),implementation_freeze_sha256:hash(await readFile(dir+'/implementation-freeze.json')),arms:{},clinical_evidence:'NOT_ESTABLISHED'};
const load=(root,path)=>import(pathToFileURL(resolve(root,path)));
for(const [name,root] of [['before',baselineRoot],['after','.']]) {
 const runtime=await load(root,'plugins/medcius/runtimes/cn-phi-ner/detector.mjs');
 const egress=await load(root,'plugins/medcius/lib/local-phi-egress.mjs'),entities=await load(root,'plugins/medcius/lib/phi-entity-session.mjs');
 const detector=await runtime.createLocalChineseNerPool({modelDirectory:process.env.MEDCIUS_CN_NER_MODEL_DIR,processes:2,batchWorkers:2,threads:2,cpuBudget:8,microBatchMaxRequests:8});
 const rows=[];
 try {
  for(let start=0;start<challenge.rows.length;start+=8) {
   rows.push(...await Promise.all(challenge.rows.slice(start,start+8).map(async(f,j)=>{
    const i=start+j,context={tenant_id:`heldout-site-${i%2}`,ward_id:`w-${i%4}`,patient_id:`p-${i}`,encounter_id:`e-${i}`,phi_session_id:`s-${i}`};
    const session=entities.createPhiEntitySession({context,patient:{id:context.patient_id},encounter:{id:context.encounter_id}});
    const row={id:f.id,category:f.category,entities:f.phi.length,clinical_segments:f.keep.length};
    try {
     const r=await egress.guardFreeTextEgress(f.text,{detector,entitySession:session,context}),mask=redactionCoverage(f.text,r.text);
     const covered=f.phi.map(p=>mask.slice(p.start,p.end).every(Boolean)),kept=f.keep.map(p=>mask.slice(p.start,p.end).every(n=>n===0));
     return {...row,status:'RELEASED',completely_masked:covered.filter(Boolean).length,residual_entity_indices:covered.flatMap((ok,n)=>ok?[]:[n]),
      clinical_segments_retained:kept.filter(Boolean).length,clinical_loss_indices:kept.flatMap((ok,n)=>ok?[]:[n]),output_sha256:hash(r.text),crop_probes:r.receipt.context_subject_probe_count};
    }catch(e){return {...row,status:'BLOCKED',code:/^[A-Z_]+$/.test(e.message)?e.message:'EVALUATION_ERROR'};}
    finally{session.dispose();}
   })));
   await writeFile(dir+`/evaluation-${name}-checkpoint.json`,JSON.stringify({rows},null,2)+'\n');
  }
  const sum=k=>rows.reduce((s,r)=>s+(r[k]??0),0);
  report.arms[name]={model:{id:detector.id,version:detector.version},summary:{cases:rows.length,entities:sum('entities'),completely_masked:sum('completely_masked'),clinical_segments:sum('clinical_segments'),clinical_segments_retained:sum('clinical_segments_retained'),blocked:rows.filter(r=>r.status==='BLOCKED').length,released_with_residual:rows.filter(r=>r.residual_entity_indices?.length).length,released_with_clinical_loss:rows.filter(r=>r.clinical_loss_indices?.length).length},rows};
 }finally{await detector.close();}
}
await verifySources();report.completed_at=new Date().toISOString();
report.changed_case_ids=report.arms.after.rows.filter((r,i)=>r.status!==report.arms.before.rows[i].status||r.output_sha256!==report.arms.before.rows[i].output_sha256).map(r=>r.id);
await writeFile(dir+'/challenge-results.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({before:report.arms.before.summary,after:report.arms.after.summary,changed_case_ids:report.changed_case_ids}));
