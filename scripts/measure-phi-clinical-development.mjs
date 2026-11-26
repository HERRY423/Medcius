// Local synthetic regression diagnostics. Raw narratives are never exported.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createLocalChineseNer} from '../plugins/medcius/lib/local-cn-ner.mjs';
import {createPhiEntitySession} from '../plugins/medcius/lib/phi-entity-session.mjs';
import {guardFreeTextEgress} from '../plugins/medcius/lib/local-phi-egress.mjs';
import {phiClinicalDevelopment,phiFixtureSource} from '../tests/fixtures/phi-clinical-development.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// Anchor unchanged text to the original. Captures represent removed intervals,
// so partial-name removal is never counted as complete entity protection.
export function redactionCoverage(original,sanitized) {
  const parts=sanitized.split(/(\[REDACTED:[A-Za-z0-9_]+\])/g);
  const expression=parts.map((p,i)=>i%2?'(.*?)':escape(p)).join('');
  const match=new RegExp(`^${expression}$`,'dsu').exec(original);
  if(!match) throw new Error('SYNTHETIC_ALIGNMENT_FAILED');
  const covered=new Uint8Array(original.length);
  for(const [a,b] of match.indices.slice(1)) covered.fill(1,a,b);
  return covered;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const out=process.argv[2]; if(!out) throw new Error('OUTPUT_REQUIRED');
  const detector=await createLocalChineseNer({modelDirectory:process.env.MEDCIUS_CN_NER_MODEL_DIR});
  const rows=[];
  try {
    for(const [i,f] of phiClinicalDevelopment.entries()) {
      const source=phiFixtureSource(f,i), session=createPhiEntitySession(source);
      try {
        const result=await guardFreeTextEgress(f.text,{detector,entitySession:session,context:source.context});
        const mask=redactionCoverage(f.text,result.text);
        const complete=f.phi.map(s=>mask.slice(s.start,s.end).every(Boolean));
        const kept=f.keep.map(s=>result.text.includes(s));
        rows.push({id:f.id,category:f.category,status:'RELEASED',entities:f.phi.length,completely_masked:complete.filter(Boolean).length,
          residual_entity_indices:complete.flatMap((ok,j)=>ok?[]:[j]),clinical_literals:f.keep.length,clinical_literals_retained:kept.filter(Boolean).length,
          clinical_loss_indices:kept.flatMap((ok,j)=>ok?[]:[j])});
      } catch(error) { rows.push({id:f.id,category:f.category,status:'BLOCKED',entities:f.phi.length,clinical_literals:f.keep.length,
        code:/^[A-Z_]+$/.test(error.message)?error.message:'EVALUATION_ERROR'}); }
      finally {session.dispose();}
    }
    const sum=k=>rows.reduce((n,r)=>n+(r[k]??0),0);
    const sources={};for(const f of ['tests/fixtures/phi-clinical-development.mjs','plugins/medcius/lib/phi-entity-session.mjs',
      'plugins/medcius/lib/local-phi-egress.mjs','plugins/medcius/runtimes/cn-phi-ner/detector.mjs']) sources[f]=hash(await readFile(f));
    const report={schema_version:'medcius.phi-development.v1',created_at:new Date().toISOString(),scope:'AUTHORED_SYNTHETIC_DEVELOPMENT_NOT_CLINICAL_VALIDATION',
      detector:{id:detector.id,version:detector.version},sources,summary:{cases:rows.length,blocked:rows.filter(r=>r.status==='BLOCKED').length,
        entities:sum('entities'),completely_masked:sum('completely_masked'),clinical_literals:sum('clinical_literals'),clinical_literals_retained:sum('clinical_literals_retained')},rows};
    await mkdir(dirname(resolve(out)),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.summary));
  } finally {await detector.close();}
}
