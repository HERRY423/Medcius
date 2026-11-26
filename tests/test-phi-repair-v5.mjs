import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {createLocalChineseNer,createLocalChineseNerPool,isVerifiedLocalChineseNer} from '../plugins/medcius/runtimes/cn-phi-ner/detector.mjs';
import {guardFreeTextEgress} from '../plugins/medcius/lib/local-phi-egress.mjs';
import {createPhiEntitySession} from '../plugins/medcius/lib/phi-entity-session.mjs';
import {validateContextSubjectSpans,CONTEXT_SUBJECT_POLICY} from '../plugins/medcius/lib/phi-oov-subjects.mjs';
import {withinClinicalLiteral} from '../plugins/medcius/lib/phi-clinical-literals.mjs';
import {redactionCoverage} from '../scripts/measure-phi-clinical-development.mjs';

// These formerly withheld challenges are now permanent development regressions.
const rows=[];
for(const directory of ['2026-11-19-phi-v4','phi-v5','phi-v5/final-holdout']) {
  const path=new URL('../docs/engineering/verification/'+directory+'/challenge.json',import.meta.url);
  rows.push(...JSON.parse(await readFile(path,'utf8')).rows);
}
assert.equal(rows.length,292);
const modelDirectory=process.env.MEDCIUS_CN_NER_MODEL_DIR;
const hash=text=>createHash('sha256').update(text).digest('hex');

test('all prior challenge positions pass through the production guard with isolated sessions',async()=>{
  const detector=await createLocalChineseNerPool({modelDirectory,processes:2,batchWorkers:2,threads:2,cpuBudget:8,microBatchMaxRequests:8});
  try {
    for(let offset=0;offset<rows.length;offset+=64) {
      await Promise.all(rows.slice(offset,offset+64).map(async(f,index)=>{
        const i=offset+index,context={profile:'production',patient_id:'p'+i,encounter_id:'e'+i,tenant_id:'t'+i%2,ward_id:'w'+i%4,phi_session_id:'s'+i};
        const session=createPhiEntitySession({context,patient:{id:context.patient_id},encounter:{id:context.encounter_id}});
        try {
          const r=await guardFreeTextEgress(f.text,{detector,context,entitySession:session});
          const mask=redactionCoverage(f.text,r.text);
          for(const p of f.phi) assert.ok(mask.slice(p.start,p.end).every(Boolean),f.id);
          for(const p of f.keep) assert.ok(mask.slice(p.start,p.end).every(v=>v===0),f.id);
          if(r.receipt.surname_subject_rule_span_count) {
            assert.ok(r.receipt.context_subject_probe_count>0);
            assert.deepEqual(session.scan(f.text,context),[]);
            assert.throws(()=>session.scan(f.text,{...context,patient_id:'foreign'}),/CONTEXT_MISMATCH/);
          }
        } finally {session.dispose();}
      }));
    }
    const context={tenant_id:'t',patient_id:'p',encounter_id:'e'};
    for(const [word,text] of [['泽兰','加用泽兰后腹胀减轻。'],['牡丹皮','停用牡丹皮期间无头晕。'],['窦缓','窦缓无头晕。']]) {
      const session=createPhiEntitySession({context,patient:{id:'p',name:word},encounter:{id:'e'}});
      try {assert.ok(!(await guardFreeTextEgress(text,{context,entitySession:session,detector})).text.includes(word));}
      finally {session.dispose();}
    }
  } finally {await detector.close();}
});

test('clinical exceptions require the exact context and label; surname evidence requires a subject position',()=>{
  for(const [text,word,label] of [['加用泽兰后腹胀减轻。','泽兰','ADDRESS'],['加用泽兰后腹胀减轻。','泽兰','CONTACT'],['姓名：泽兰','泽兰','PERSON'],['姓名：牡丹皮','牡丹皮','ADDRESS'],['停用牡丹皮期间','牡丹','ADDRESS'],
    ['停用牡丹皮期间','牡丹皮','CONTACT'],['停用牡丹皮期间','牡丹皮','IDENTIFIER'],
    ['患者窦缓无头晕。','窦缓','PERSON'],['家属腓总神经','腓总','PERSON']]) {
    const start=text.indexOf(word);
    assert.equal(withinClinicalLiteral(text,{start,end:start+word.length,label}),false);
  }
  for(const word of ['仲孙砚','郜砚','郏辛冉']) {
    const text=word+'回忆夜里醒过两次。';
    const span={start:0,end:word.length,label:'PERSON',method:'surname_subject_rule',probe_text_sha256:hash(word)};
    assert.equal(validateContextSubjectSpans(text,{complete:true,policy:CONTEXT_SUBJECT_POLICY,candidate_count:1,probe_count:1,spans:[span]}).length,1);
  }
  for(const word of ['南宫市','东方人','薄膜','薄荷','濮阳县','郤珺科']) {
    const text=word+'表示不适。';
    const span={start:0,end:word.length,label:'PERSON',method:'surname_subject_rule',probe_text_sha256:hash(word)};
    assert.throws(()=>validateContextSubjectSpans(text,{complete:true,policy:CONTEXT_SUBJECT_POLICY,candidate_count:1,probe_count:1,spans:[span]}),/INVALID/);
  }
  for(const text of ['查祎记录。','查体出现心悸。','查血无发热。']) {
    const span={start:0,end:2,label:'PERSON',method:'surname_subject_rule',probe_text_sha256:hash(text.slice(0,2))};
    assert.throws(()=>validateContextSubjectSpans(text,{complete:true,policy:CONTEXT_SUBJECT_POLICY,candidate_count:1,probe_count:1,spans:[span]}),/INVALID/);

  }
  assert.throws(()=>validateContextSubjectSpans('记录无关文字。',{complete:true,policy:CONTEXT_SUBJECT_POLICY,candidate_count:1,probe_count:1,
      spans:[{label:'PERSON',start:0,end:2,method:'source_crop_ner',probe_text_sha256:hash('记录')}]}),/INVALID/);
});

test('surname rule cannot release a result when the actual crop worker fails',async()=>{
  for(const [text,cropTokenLength] of [['查祎出现心悸。',4],['闻人苒表示夜里难入睡。',5]]) {
    const detector=await createLocalChineseNer({modelDirectory,threads:1,batchWorkers:1});
    const post=Worker.prototype.postMessage;
    let injected=false;
    try {
      Worker.prototype.postMessage=function(message,...args) {
        if(message.rows?.some(r=>r.ids.length===cropTokenLength)) {
          injected=true;message=structuredClone(message);message.rows[0].ids[0]=9999999;
        }
        return post.call(this,message,...args);
      };
      await assert.rejects(guardFreeTextEgress(text,{detector}),/DETECTOR_FAILED/);
      assert.equal(injected,true);
      assert.equal(isVerifiedLocalChineseNer(detector),false);
    } finally {Worker.prototype.postMessage=post;await detector.close();}
  }
});
