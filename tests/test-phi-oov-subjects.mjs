import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {guardFreeTextEgress} from '../plugins/medcius/lib/local-phi-egress.mjs';
import {findOovSubjectSpans,validateOovSubjectSpans,OOV_SUBJECT_POLICY} from '../plugins/medcius/lib/phi-oov-subjects.mjs';
import {phiSubjectChallenge} from './fixtures/phi-subject-challenge.mjs';
const spec=JSON.parse(readFileSync(process.env.MEDCIUS_CN_NER_MODEL_DIR+'/tokenizer.json','utf8'));
const unknown=c=>/\p{Script=Han}/u.test(c)&&!Object.hasOwn(spec.model.vocab,c);
test('supplemental spans use the actual pinned vocabulary gap, exact Unicode spans and bounded clinical cues',()=>{
  let tested=0;
  for(const f of phiSubjectChallenge.filter(f=>f.phi.length)) {
    if(!Array.from(f.text.slice(f.phi[0].start,f.phi[0].end)).some(unknown)) continue;
    const spans=findOovSubjectSpans(f.text,unknown);
    assert.ok(spans.some(s=>s.start===f.phi[0].start&&s.end===f.phi[0].end),f.id);
    for(const s of spans) assert.ok(f.text.slice(s.start,s.end).isWellFormed());tested++;
  }
  assert.ok(tested>=20);
});
test('clinical negative subjects, rare clinical characters and protected markers are untouched',()=>{
  for(const f of phiSubjectChallenge.filter(f=>!f.phi.length)) assert.deepEqual(findOovSubjectSpans(f.text,unknown),[],f.id);
  for(const text of ['[REDACTED:LOCAL_ENTITY]无发热。','瘰疬无压痛。','腘窝无压痛。','薏苡无发热。','莪术无发热。'])
    assert.deepEqual(findOovSubjectSpans(text,unknown),[],text);
});
test('no global surname matching, name seeding, unsupported predicates or ordinary-word inference',()=>{
  for(const text of ['郄芃','记录包含郄芃。','𠮷玥恢复。','王伟无发热。','普通无发热。','合成术后无发热。'])
    assert.deepEqual(findOovSubjectSpans(text,unknown),[],text);
});
test('subject metadata validation rejects forged policy, invalid Unicode, span ranges and labels',()=>{
  const text='𠮷玥无发热。',spans=findOovSubjectSpans(text,unknown);
  assert.equal(validateOovSubjectSpans(text,{policy:OOV_SUBJECT_POLICY,spans}).length,1);
  for(const screening of [{policy:'other',spans}, {policy:OOV_SUBJECT_POLICY,spans:[{...spans[0],start:1}]},
    {policy:OOV_SUBJECT_POLICY,spans:[{...spans[0],end:99}]},{policy:OOV_SUBJECT_POLICY,spans:[{...spans[0],label:'ADDRESS'}]}])
    assert.throws(()=>validateOovSubjectSpans(text,screening),/RESULT_INVALID/);
});

test('supplemental spans cannot bypass incomplete, unbound, failed or malformed neural output',async()=>{
  const text='郄芃诉胸闷。',screening={policy:OOV_SUBJECT_POLICY,spans:findOovSubjectSpans(text,unknown)};
  const valid={complete:true,text_sha256:createHash('sha256').update(text).digest('hex'),spans:[],subject_screening:screening};
  for(const result of [{...valid,complete:false},{...valid,text_sha256:'unbound'},
    {...valid,subject_screening:{...screening,policy:'forged'}},
    {...valid,subject_screening:{...screening,spans:[{...screening.spans[0],end:999}]}}]) {
    const detector={id:'synthetic',version:'v1',execution:'local',async detect(){return result;}};
    await assert.rejects(guardFreeTextEgress(text,{detector}),/RESULT_UNBOUND|SUBJECT_RESULT_INVALID/);
  }
  const detector={id:'synthetic',version:'v1',execution:'local',async detect(){throw new Error('synthetic');}};
  await assert.rejects(guardFreeTextEgress(text,{detector}),/DETECTOR_FAILED/);
});
