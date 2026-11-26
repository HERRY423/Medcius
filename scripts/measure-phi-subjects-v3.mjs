import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createLocalChineseNer} from '../plugins/medcius/lib/local-cn-ner.mjs';
import {createPhiEntitySession} from '../plugins/medcius/lib/phi-entity-session.mjs';
import {guardFreeTextEgress} from '../plugins/medcius/lib/local-phi-egress.mjs';
import {phiClinicalDevelopment,phiFixtureSource} from '../tests/fixtures/phi-clinical-development.mjs';
import {phiSubjectChallenge} from '../tests/fixtures/phi-subject-challenge.mjs';
import {phiContextSubjectsV3} from '../tests/fixtures/phi-context-subjects-v3.mjs';
import {redactionCoverage} from './measure-phi-clinical-development.mjs';
const out=process.argv[2];if(!out) throw new Error('OUTPUT_REQUIRED');
const hash=b=>createHash('sha256').update(b).digest('hex');
const paths=['scripts/measure-phi-subjects-v3.mjs','tests/fixtures/phi-context-subjects-v3.mjs','plugins/medcius/lib/phi-clinical-literals.mjs','tests/fixtures/phi-clinical-development.mjs','tests/fixtures/phi-subject-challenge.mjs',
  'plugins/medcius/lib/local-phi-egress.mjs','plugins/medcius/lib/phi-entity-session.mjs','plugins/medcius/lib/phi-oov-subjects.mjs',
  'plugins/medcius/runtimes/cn-phi-ner/bert-tokenizer.mjs','plugins/medcius/runtimes/cn-phi-ner/detector.mjs'];
const digest=async p=>{try{return hash(await readFile(p));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const sources={};for(const p of paths) sources[p]=await digest(p);
const detector=await createLocalChineseNer({modelDirectory:process.env.MEDCIUS_CN_NER_MODEL_DIR});
const cohorts={};
try {
  for(const [cohort,fixtures] of Object.entries({original:phiClinicalDevelopment,challenge:phiSubjectChallenge,context:phiContextSubjectsV3})) {
    const rows=[];
    for(const [i,f] of fixtures.entries()) {
      const source=phiFixtureSource({...f,metadata:f.metadata??{}},i),session=createPhiEntitySession(source);
      try {
        const result=await guardFreeTextEgress(f.text,{detector,entitySession:session,context:source.context});
        const mask=redactionCoverage(f.text,result.text);
        const covered=f.phi.map(s=>mask.slice(s.start,s.end).every(Boolean)),keep=f.keep.map(s=>{
          const at=f.text.indexOf(s);if(at<0)throw new Error('FIXTURE_LITERAL_MISSING');
          return mask.slice(at,at+s.length).every(n=>n===0);
        });
        rows.push({id:f.id,category:f.category,status:'RELEASED',entities:f.phi.length,completely_masked:covered.filter(Boolean).length,
          residual_entity_indices:covered.flatMap((v,j)=>v?[]:[j]),clinical_literals:f.keep.length,clinical_literals_retained:keep.filter(Boolean).length,
          clinical_loss_indices:keep.flatMap((v,j)=>v?[]:[j]),supplemental_spans:result.receipt.supplemental_subject_span_count??0,context_probes:result.receipt.context_subject_probe_count??0});
      } catch(e) {rows.push({id:f.id,category:f.category,status:'BLOCKED',entities:f.phi.length,clinical_literals:f.keep.length,
        code:/^[A-Z_]+$/.test(e.message)?e.message:'EVALUATION_ERROR'});}
      finally {session.dispose();}
    }
    const sum=k=>rows.reduce((n,r)=>n+(r[k]??0),0);
    cohorts[cohort]={summary:{cases:rows.length,entities:sum('entities'),completely_masked:sum('completely_masked'),
      clinical_literals:sum('clinical_literals'),clinical_literals_retained:sum('clinical_literals_retained'),blocked:rows.filter(r=>r.status==='BLOCKED').length},rows};
  }
  for(const p of paths) if(sources[p]!==await digest(p)) throw new Error('SOURCE_CHANGED');
  const report={schema_version:'medcius.phi-subject-development.v3',created_at:new Date().toISOString(),
    scope:'AUTHORED_SYNTHETIC_DEVELOPMENT_NOT_CLINICAL_VALIDATION',model:{id:detector.id,version:detector.version},sources,cohorts};
  await mkdir(dirname(resolve(out)),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(cohorts).map(([k,v])=>[k,v.summary]))));
} finally {await detector.close();}
