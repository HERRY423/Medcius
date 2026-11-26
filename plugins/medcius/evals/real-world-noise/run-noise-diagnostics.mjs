#!/usr/bin/env node
// v1's literal score is retained. v2 adds a separate lexical-alias diagnostic;
// it never changes parser output or treats seeds as independent patients.
import { readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCnNote } from '../../lib/parse-cn-note.mjs';
import { extractCnTerms,CN_TERM_VERSION } from '../../lib/cn-note-terms.mjs';
import { gradeRecord } from './grader.mjs';
import { applyNoise,NOISE_MODELS } from './noise-models.mjs';
import { sha256Hex,canonicalJson } from '../../servers/shared/crypto.mjs';
const dir=dirname(fileURLToPath(import.meta.url));
const notesDir=join(dir,'../../skills/clinical-note-extract/assets/china-notes');
const gold=JSON.parse(readFileSync(join(notesDir,'expected.json'),'utf8'));
const seeds=[1,2,3];
const cases=readdirSync(notesDir).filter(f=>/^\d\d-.*\.md$/.test(f) && gold[f.slice(0,-3)]).sort()
  .map(f=>({id:f.slice(0,-3),text:readFileSync(join(notesDir,f),'utf8'),gold:gold[f.slice(0,-3)]}));

export function normalizeDiagnosticAliases(value) {
  if(typeof value!=='string') return value;
  let result=value;
  for(const m of extractCnTerms(value).filter(m=>m.canonical).toReversed()) result=result.slice(0,m.start)+m.canonical+result.slice(m.end);
  return result;
}
export function gradeAliases(record,goldEntry) {
  const projected=structuredClone(record),spec=structuredClone(goldEntry);
  // Compare both sides using the same lexical mapping. Do not normalize spans,
  // presence, time, subject or null expectations; never guess OCR characters.
  for(const [key,field] of Object.entries(projected)) if(field && typeof field==='object' && Object.hasOwn(field,'value')) field.value=normalizeDiagnosticAliases(field.value);
  for(const rule of Object.values(spec)) if(rule && !Array.isArray(rule) && typeof rule==='object') {
    for(const key of ['value_contains','must_not_contain','allowed_contains']) if(Array.isArray(rule[key])) rule[key]=rule[key].map(normalizeDiagnosticAliases);
  }
  const result=gradeRecord(projected,spec);
  // These two gold predicates were not implemented by the legacy field grader.
  const extra=[];
  for(const [key,rule] of Object.entries(spec)) {
    const field=projected[key];
    if(rule?.null_or_not_diabetes && /糖尿病|diabetes/i.test(field?.value??'')) extra.push(key+': family diagnosis leakage');
    if(rule?.must_not_be_confirmed_pe && /肺.*栓塞/.test(field?.value??'') && field?.presence==='present') extra.push(key+': uncertainty upgraded');
  }
  return {...result,exact:result.exact && extra.length===0,failures:[...result.failures,...extra]};
}

export function noiseDiagnostics() {
  const models={};
  for(const model of ['clean',...Object.keys(NOISE_MODELS)]) {
    let literal=0,aliases=0,rawFields=0,fields=0;const failures=[];const byNote={};
    for(const c of cases) for(const seed of seeds) {
      const text=model==='clean'?c.text:applyNoise(c.text,model,seed),record=parseCnNote(text);
      const raw=gradeRecord(record,c.gold),normalized=gradeAliases(record,c.gold);
      literal+=Number(raw.exact);aliases+=Number(normalized.exact);rawFields+=raw.fields_passed;fields+=raw.fields_total;
      (byNote[c.id]??=[]).push({seed,literal_exact:raw.exact,alias_exact:normalized.exact,input_sha256:sha256Hex(text)});
      if(!raw.exact) failures.push({note_id:c.id,seed,literal_failures:raw.failures,alias_failures:normalized.failures,
        status:normalized.exact?'lexical_alias_mismatch_only':'remaining_failure'});
    }
    models[model]={runs:cases.length*seeds.length,literal_exact:literal,alias_exact:aliases,
      literal_field_passed:rawFields,field_total:fields,
      notes_all_seeds_alias_exact:Object.values(byNote).filter(rows=>rows.every(r=>r.alias_exact)).length,
      failures,by_note:byNote};
  }
  return {identity:'noise-diagnostics-v2',status:'SYNTHETIC_DEVELOPMENT_ONLY',case_count:cases.length,seeds,
    input_sha256:sha256Hex(canonicalJson(cases)),lexicon_version:CN_TERM_VERSION,
    code_sha256:Object.fromEntries(['../../lib/parse-cn-note.mjs','../../lib/cn-assertions.mjs','../../lib/cn-assertion-rules.mjs',
      '../../lib/cn-measurements.mjs','../../lib/cn-note-terms.mjs','noise-models.mjs','grader.mjs','run-noise-diagnostics.mjs']
      .map(p=>[p,sha256Hex(readFileSync(join(dir,p),'utf8'))])),
    uncertainty:'No patient-population CI: three variants of each of ten notes are dependent development fixtures.',
    scoring_scope:'Legacy structured-field predicates plus two explicit safety predicates; narrative must_not prose is not scored.',
    original_v1_report:'reports/noise-robustness-baseline.json (historical, unchanged)',
    model_inference:'NOT_RUN',clinical_recall:'NOT_EVALUATED',models};
}

if(process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  const r=noiseDiagnostics();
  const markdown=['# 噪声字段匹配诊断 v2','',
    '固定合成开发样例；旧 v1 原文字符串指标单独保留。别名等价指标仅用于解释失败来源，不是临床召回率。',
    '10 份病历各 3 个变体，不作为 30 个独立患者；不报告患者总体置信区间。',
    '','|噪声|原文字段全命中 / 30|别名等价全命中 / 30|三个变体均等价命中的病历 / 10|','|---|---:|---:|---:|',
    ...Object.entries(r.models).map(([k,m])=>`|${k}|${m.literal_exact}|${m.alias_exact}|${m.notes_all_seeds_alias_exact}|`),
    '', '评分范围：结构化字段预期和两项显式安全断言；自然语言 must_not 条目未纳入本指标。',
    '真实模型效果 NOT_RUN；真实病历召回率 NOT_EVALUATED。原文值、span、缺失值与断言均未因评分而改写。',''].join('\n');
  if(process.argv.includes('--out')) {
    writeFileSync(join(dir,'reports/noise-diagnostics-v2.json'),JSON.stringify(r,null,2)+'\n');
    writeFileSync(join(dir,'reports/noise-diagnostics-v2.md'),markdown);
  }
  console.log(markdown);
  if(r.models.clean.literal_exact!==30 || r.models.combined.literal_exact<20) process.exitCode=1;
}
