// Replay previously scored synthetic rows through the current production guard.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createLocalChineseNerPool} from '../plugins/medcius/runtimes/cn-phi-ner/detector.mjs';
import {guardFreeTextEgress} from '../plugins/medcius/lib/local-phi-egress.mjs';
import {createPhiEntitySession} from '../plugins/medcius/lib/phi-entity-session.mjs';
import {redactionCoverage} from './measure-phi-clinical-development.mjs';

const [directory,output]=process.argv.slice(2);
if(!directory||!output) throw new Error('Provide the challenge directory and output file.');
const hash=value=>createHash('sha256').update(value).digest('hex');
const bytes=await readFile(directory+'/challenge.json');
const prior=JSON.parse(await readFile(directory+'/challenge-results.json','utf8'));
if(prior.challenge_sha256!==hash(bytes)) throw new Error('CHALLENGE_CHANGED');
const fixtures=JSON.parse(bytes).rows;
const detector=await createLocalChineseNerPool({modelDirectory:process.env.MEDCIUS_CN_NER_MODEL_DIR,
  processes:2,batchWorkers:2,threads:2,cpuBudget:8,microBatchMaxRequests:8});
const rows=[];
try {
  for(let i=0;i<fixtures.length;i++) {
    const f=fixtures[i],previous=prior.arms.after.rows[i];
    if(previous.id!==f.id) throw new Error('GOLD_ORDER_INVALID');
    const context={profile:'production',tenant_id:'replay',ward_id:'w'+i%4,patient_id:'p'+i,encounter_id:'e'+i,phi_session_id:'s'+i};
    const session=createPhiEntitySession({context,patient:{id:context.patient_id},encounter:{id:context.encounter_id}});
    try {
      const result=await guardFreeTextEgress(f.text,{detector,entitySession:session,context});
      const mask=redactionCoverage(f.text,result.text),digest=hash(result.text);
      rows.push({id:f.id,output_sha256:digest,prior_output_match:digest===previous.output_sha256,
        entities:f.phi.length,masked:f.phi.filter(s=>mask.slice(s.start,s.end).every(Boolean)).length,
        segments:f.keep.length,retained:f.keep.filter(s=>mask.slice(s.start,s.end).every(n=>n===0)).length});
    } finally {session.dispose();}
  }
} finally {await detector.close();}
const sum=key=>rows.reduce((n,r)=>n+r[key],0);
const summary={cases:rows.length,entities:sum('entities'),masked:sum('masked'),segments:sum('segments'),retained:sum('retained'),
  changed_ids:rows.filter(r=>!r.prior_output_match).map(r=>r.id)};
await writeFile(output,JSON.stringify({scope:'SYNTHETIC_REPLAY',challenge_sha256:hash(bytes),summary,rows},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(summary));
