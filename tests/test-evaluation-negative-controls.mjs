// Controls exercise the actual scorers. Detection is a metric change or rejection,
// never merely an already-false aggregate verdict. Synthetic engineering only.
import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdirSync,readdirSync,mkdtempSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {evaluateShadowStudy,generateSampleShadowCases} from "../plugins/medcius/evals/shadow-mode/shadow-study.mjs";
import {evaluatePhysicianAnnotation} from "../plugins/medcius/evals/physician-annotation/physician-annotation-engine.mjs";
import {TimeMotionAnalyzer,sampleObservationSessions} from "../plugins/medcius/evals/time-motion/time-motion-analyzer.mjs";
import {gradeNoteText,gradeRecord,gradeFieldSpec} from "../plugins/medcius/evals/real-world-noise/grader.mjs";
import {pairValidationRows,confusion,readJsonl} from "../plugins/medcius/evals/clinical-validation/run.mjs";
import {loadPack,reviewCase} from "../plugins/medcius/evals/public-reference-validation/reference-reviewer.mjs";
import {scoreReferenceResults} from "../plugins/medcius/evals/public-reference-validation/scorer.mjs";
import {sha256Hex,canonicalJson} from "../plugins/medcius/servers/shared/crypto.mjs";

const root=fileURLToPath(new URL("../",import.meta.url));
const read=p=>JSON.parse(readFileSync(join(root,p),"utf8"));
const jsonl=p=>readFileSync(join(root,p),"utf8").trim().split(/\r?\n/).filter(s=>s.trim()).map(JSON.parse);
const copy=structuredClone, digest=v=>sha256Hex(canonicalJson(v));
const path=join(root,"out/evaluation-negative-controls.json");mkdirSync(join(root,"out"),{recursive:true});
writeFileSync(path,JSON.stringify({execution_status:"INCOMPLETE",clinical_evidence_pass:false}));
const suites=[];
function suite(id,input,baseline) {const result={evaluation_id:id,input_sha256:digest(input),baseline,controls:[]};suites.push(result);return result;}
function check(s,id,exercise) {const observation=exercise();s.controls.push({id,detected:true,observation});}
function rejects(s,id,fn,pattern) {check(s,id,()=>{assert.throws(fn,pattern);return {rejected:true,reason:pattern.source};});}

const shadow=generateSampleShadowCases(), sb=evaluateShadowStudy(shadow);
const sh=suite("label-statistics-fixture-v1",shadow,{n:sb.total_cases,tp:sb.overall.tp,tn:sb.overall.tn,independence:sb.independence_status});
for(const [name,mutator,metric] of [
  ["always_clear",()=>"clear","fn"], ["always_flag",()=>"flag","fp"],
  ["inverted",r=>r.predicted==="flag"?"clear":"flag","fn"], ["all_abstain",()=>null,"abstentions"]]) {
  check(sh,name,()=>{const r=evaluateShadowStudy(shadow.map(row=>({...row,predicted:mutator(row)})));assert.ok(r.overall[metric]>sb.overall[metric]);assert.equal(r.total_cases,shadow.length);return {[metric]:r.overall[metric],n:r.total_cases};});
}
check(sh,"unadjudicated",()=>{const r=evaluateShadowStudy(shadow.map(row=>({...row,adjudicator:null})));assert.ok(r.unadjudicated_cases_count>0);assert.equal(r.endpoints.all_disagreements_adjudicated,false);return {pending:r.unadjudicated_cases_count};});
rejects(sh,"duplicate_row",()=>evaluateShadowStudy([...shadow,shadow[0]]),/DUPLICATE_SHADOW_KEY/);
check(sh,"caller_claimed_independence",()=>{const r=evaluateShadowStudy(shadow,{isDemo:false,metadata:{independent:true}});assert.equal(r.endpoints.prediction_independence_established,false);assert.equal(r.passClassification.clinical_evidence_pass,false);return {independence:r.independence_status};});

const annotation=read("plugins/medcius/evals/physician-annotation/ward-annotation-cases.json"), ab=evaluatePhysicianAnnotation(annotation);
const an=suite("physician-annotation-fixture-v1",annotation,{n:ab.total_cases,tp:ab.overall.tp,tn:ab.overall.tn});
for(const [name,change,metric] of [
  ["always_clear",r=>({...r,ai_extracted:"clear"}),"fn"],
  ["wrong_positive_category",r=>({...r,ai_extracted:"invented_category"}),"misclassifications"],
  ["all_abstain",r=>({...r,ai_extracted:null}),"abstentions"],
  ["missing_spans",r=>({...r,span:null}),"missing_evidence_anchors"],
  ["declared_nonverbatim",r=>({...r,is_verbatim_span:false}),"fake_spans"],
  ["missing_rater",r=>({...r,physician_b:null}),"unadjudicated"]]) {
  check(an,name,()=>{const r=evaluatePhysicianAnnotation(annotation.map(change));assert.ok(r.overall[metric]>ab.overall[metric]);assert.equal(r.total_cases,annotation.length);return {[metric]:r.overall[metric],n:r.total_cases};});
}
rejects(an,"duplicate_row",()=>evaluatePhysicianAnnotation([...annotation,annotation[0]]),/DUPLICATE_ANNOTATION_KEY/);

const sessions=copy(sampleObservationSessions), tb=TimeMotionAnalyzer.analyzeCohort(sessions);
const tm=suite("time-motion-four-row-simulation-v1",sessions,{n:tb.sample_size,saved:tb.time_metrics.time_saved_seconds});
check(tm,"reversed_arms",()=>{const r=TimeMotionAnalyzer.analyzeCohort(sessions.map(s=>({...s,manual:s.medcius,medcius:s.manual})));assert.equal(r.time_metrics.time_saved_seconds,-tb.time_metrics.time_saved_seconds);return r.time_metrics;});
check(tm,"identical_arms",()=>{const r=TimeMotionAnalyzer.analyzeCohort(sessions.map(s=>({...s,medcius:s.manual})));assert.equal(r.time_metrics.time_saved_seconds,0);return r.time_metrics;});
check(tm,"missing_duration",()=>{const x=copy(sessions);x[0].medcius.duration_seconds=null;const r=TimeMotionAnalyzer.analyzeCohort(x);assert.equal(r.time_metrics.time_saved_seconds,null);assert.equal(r.evidence.engineering_pass,false);return {saved:r.time_metrics.time_saved_seconds,missing:r.missing_measurements};});
check(tm,"worse_safety",()=>{const r=TimeMotionAnalyzer.analyzeCohort(sessions.map(s=>({...s,medcius:{...s.medcius,critical_omissions:99}})));assert.equal(r.safety_non_inferiority.descriptive_omission_comparison_pass,false);assert.equal(r.safety_non_inferiority.is_non_inferior,null);return r.safety_non_inferiority;});
rejects(tm,"negative_time",()=>TimeMotionAnalyzer.analyzeCohort([{manual:{duration_seconds:-1},medcius:{}}]),/MEASUREMENT_INVALID/);
rejects(tm,"empty",()=>TimeMotionAnalyzer.analyzeCohort([]),/No session/);

const notesDir=join(root,"plugins/medcius/skills/clinical-note-extract/assets/china-notes");
const gold=JSON.parse(readFileSync(join(notesDir,"expected.json"),"utf8"));
const notes=readdirSync(notesDir).filter(f=>/^\d\d-.*\.md$/.test(f)&&gold[f.slice(0,-3)]).sort().map(f=>({id:f,text:readFileSync(join(notesDir,f),"utf8"),gold:gold[f.slice(0,-3)]}));
const parsed=notes.map(n=>gradeNoteText(n.text,n.gold));assert.ok(parsed.every(r=>r.exact));
const ns=suite("noise-fixture-v1",notes,{n:notes.length,clean_exact:parsed.length});
for(const [name,mutator] of [["empty_record",()=>({})],["corrupt_values",r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,{...v,value:"CORRUPTED",presence:"unknown",temporality:"unknown"}]))]]) {
  check(ns,name,()=>{const failed=notes.filter((n,i)=>!gradeRecord(mutator(copy(parsed[i].record)),n.gold).exact).length;assert.equal(failed,notes.length);return {failed,n:notes.length};});
}
check(ns,"value_cannot_replace_span",()=>{const failures=gradeFieldSpec("allergy_history",{span_contains:["否认过敏"]},{value:"否认过敏",span:null});assert.ok(failures.length>0);return {failures};});
check(ns,"negative_not_unknown",()=>{const failures=gradeFieldSpec("allergy_history",{presence:"absent"},{value:null,presence:"unknown"});assert.ok(failures.length>0);return {failures};});

const gp=join(root,"plugins/medcius/evals/clinical-validation/gold/batch01.jsonl"),pp=join(root,"plugins/medcius/evals/clinical-validation/pred/batch01.jsonl");
const cg=readJsonl(gp),cp=readJsonl(pp,"prediction"), cb=confusion(pairValidationRows(cg,cp));
const cs=suite("clinical-validation-batch01-fixture",{gold:cg,pred:cp},{n:cg.length,...cb});
for(const [name,predict,metric] of [["always_clear",()=>"clear","fn"],["always_flag",()=>"flag","fp"],["inverted",r=>r.predicted==="flag"?"clear":"flag","fn"]]) {
  check(cs,name,()=>{const r=confusion(pairValidationRows(cg,cp.map(row=>({...row,predicted:predict(row)}))));assert.ok(r[metric]>cb[metric]);assert.equal(r.tp+r.fp+r.fn+r.tn,cg.length);return r;});
}
rejects(cs,"missing_prediction",()=>pairValidationRows(cg,cp.slice(1)),/UNPAIRED/);
rejects(cs,"duplicate_prediction",()=>pairValidationRows(cg,[...cp,cp[0]]),/DUPLICATE/);
rejects(cs,"invalid_label",()=>pairValidationRows(cg,cp.map(r=>({...r,predicted:null}))),/LABEL_INVALID/);

const cases=jsonl("plugins/medcius/evals/public-reference-validation/cases/public-gold.jsonl"), pack=loadPack(join(root,"plugins/medcius/evals/public-reference-validation/public-reference-pack.json"));
const predictions=cases.map(c=>{const review=reviewCase(c.input,pack);return {case_id:c.case_id,predicted:review.overall,review};});
const rb=scoreReferenceResults(cases,predictions);assert.equal(rb.pass,true);
const ps=suite("public-reference-fixture-v1",{cases,pack},{n:cases.length,failures:rb.failures});
for(const [name,change] of [
  ["always_clear",r=>({...r,predicted:"clear"})],["always_flag",r=>({...r,predicted:"flag"})],
  ["inverted",r=>({...r,predicted:r.predicted==="flag"?"clear":"flag"})],
  ["all_abstain",r=>({...r,predicted:"insufficient_data"})],
  ["missing_facts",r=>({...r,review:{dimensions:{}}})]]) {
  check(ps,name,()=>{const r=scoreReferenceResults(cases,predictions.map(change));assert.equal(r.pass,false);assert.ok(r.failures>0);assert.equal(r.n,cases.length);return {failures:r.failures,unexpected_abstentions:r.unexpected_abstentions,n:r.n};});
}
rejects(ps,"missing_prediction",()=>scoreReferenceResults(cases,predictions.slice(1)),/PAIRING_INVALID/);
rejects(ps,"duplicate_prediction",()=>scoreReferenceResults(cases,predictions.map((r,i)=>i? r:predictions[1])),/PAIRING_INVALID/);
check(ps,"cli_abstention_and_stale_success",()=>{
  const dir=mkdtempSync(join(tmpdir(),"medcius-reference-negative-")),input=join(dir,"cases.jsonl"),output=join(dir,"report.md");
  const c={...copy(cases.find(c=>c.expected==="flag")),input:copy(cases.find(c=>c.expected==="insufficient_data").input)};
  writeFileSync(input,JSON.stringify(c)+"\n");
  const run=()=>spawnSync(process.execPath,["plugins/medcius/evals/public-reference-validation/run.mjs","--cases",input,"--out",output],{cwd:root,encoding:"utf8",timeout:10000});
  const bad=run();assert.equal(bad.status,1);assert.match(bad.stderr,/LABEL_MISMATCH/);assert.doesNotMatch(readFileSync(output,"utf8"),/ALL CONSISTENT/);
  writeFileSync(output,"OLD SUCCESS: ALL CONSISTENT");writeFileSync(input,"");
  assert.notEqual(run().status,0);assert.match(readFileSync(output,"utf8"),/INCOMPLETE/);assert.doesNotMatch(readFileSync(output,"utf8"),/ALL CONSISTENT/);
  return {unexpected_abstention_exit:bad.status,stale_success_invalidated:true};
});

const report={evaluation_id:"cross-evaluation-negative-controls-v1",execution_status:"COMPLETED",evidence_class:"synthetic_scorer_sensitivity",independent_validation:false,clinical_evidence_pass:false,
  limitation:"Mutant detection validates the measuring code; it does not establish independent gold, clinical validity, or real benefit. Annotation verbatim flags remain supplied declarations.",
  suites,summary:{evaluations:suites.length,controls:suites.reduce((n,s)=>n+s.controls.length,0),undetected:0}};
writeFileSync(path,JSON.stringify(report,null,2)+"\n");
console.log(`ALL CROSS-EVALUATION NEGATIVE CONTROLS PASSED: ${report.summary.evaluations} evaluations, ${report.summary.controls} controls; synthetic only`);
