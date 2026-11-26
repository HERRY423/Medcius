import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createPhiEntitySession} from '../plugins/medcius/lib/phi-entity-session.mjs';
import {createWardPhiSessionCache} from '../plugins/medcius/lib/phi-ward-cache.mjs';
import {guardFreeTextEgress} from '../plugins/medcius/lib/local-phi-egress.mjs';
import {scanText} from '../plugins/medcius/servers/phiguard/src/lib.mjs';
import {phiClinicalDevelopment,phiFixtureSource} from './fixtures/phi-clinical-development.mjs';
import {redactionCoverage} from '../scripts/measure-phi-clinical-development.mjs';
const hash=t=>createHash('sha256').update(t).digest('hex');
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};

test('source metadata covers rare names, Unicode, clinician aliases, institutions and locations',()=>{
  for(const [i,f] of phiClinicalDevelopment.entries()) {
    if(['unseeded_name','clinical_preservation'].includes(f.category)) continue;
    const source=phiFixtureSource(f,i),session=createPhiEntitySession(source),spans=session.scan(f.text,source.context);
    try {for(const gold of f.phi) assert.ok(spans.some(s=>s.start<=gold.start&&s.end>=gold.end),f.id);}
    finally {session.dispose();}
  }
});
test('titles and clinical words are not turned into patient or clinician names',()=>{
  for(const f of phiClinicalDevelopment.filter(f=>f.category==='clinical_preservation')) {
    const source=phiFixtureSource(f),session=createPhiEntitySession(source);
    try {assert.equal(session.scan(f.text,source.context).length,0,f.id);assert.equal(scanText(f.text).total,0,f.id);}
    finally {session.dispose();}
  }
  // No surname-only or globally inferred familiar-name aliases.
  const source=phiFixtureSource(phiClinicalDevelopment[6]),s=createPhiEntitySession(source);
  assert.equal(s.scan('老郄、郄与胸闷',source.context).length,0);s.dispose();
});
test('entity ownership includes nested clinicians/organizations and ward binding',()=>{
  const source=phiFixtureSource(phiClinicalDevelopment[11]);
  for(const bad of [{organizations:[{tenant_id:'wrong',name:'芃院'}]},
    {encounter:{...source.encounter,serviceProvider:{tenant_id:'wrong',display:'芃院'}}}]) {
    assert.throws(()=>createPhiEntitySession({...source,...bad}),/SOURCE_MISMATCH/);
  }
  const s=createPhiEntitySession(source);
  assert.throws(()=>s.scan('芃院',{...source.context,ward_id:'different'}),/CONTEXT_MISMATCH/);s.dispose();
});
test('injecting institutional aliases invalidates cached misses',()=>{
  const source=phiFixtureSource(phiClinicalDevelopment[11]);
  const s=createPhiEntitySession({...source,organizations:[]});
  assert.equal(s.scan('芃院',source.context).length,0);s.inject(source);
  assert.equal(s.scan('芃院',source.context).length,1);s.dispose();
});
test('coverage scoring rejects partial masking and counts preserved clinical text separately',()=>{
  assert.deepEqual([...redactionCoverage('郄芃胸痛','[REDACTED:LOCAL_ENTITY]芃胸痛')],[1,0,0,0]);
  assert.deepEqual([...redactionCoverage('郄芃胸痛','[REDACTED:LOCAL_ENTITY]胸痛')],[1,1,0,0]);
  assert.throws(()=>redactionCoverage('郄芃胸痛','虚构内容'),/ALIGNMENT/);
});
test('dictionary warmup never attests neural clearance or retains a prior guarded result',async()=>{
  const source=phiFixtureSource(phiClinicalDevelopment[6]),cache=createWardPhiSessionCache();let calls=0;
  const detector={id:'synthetic',version:'v1',execution:'local',async detect(text){calls++;return {complete:true,text_sha256:hash(text),spans:[]};}};
  assert.equal(cache.prewarm([{source,sourceVersion:'v1'}]).neural_clearance,'NOT_RUN');
  for(let i=0;i<2;i++) await cache.withSession(source,{sourceVersion:'v1'},async session=>{
    const before=calls;const result=await guardFreeTextEgress('郄主任查房，无发热。',{detector,context:source.context,entitySession:session});
    assert.ok(calls>before);assert.doesNotMatch(result.text,/郄主任/);assert.match(result.text,/无发热/);
    assert.equal(result.receipt.complete_deidentification,'NOT_ESTABLISHED');
  });
  assert.equal(cache.diagnostics().reused,2);assert.doesNotMatch(JSON.stringify(cache.diagnostics()),/synthetic-site|郄|v1|digest/);cache.close();
});
test('warm dictionary cache has fixed TTL, source version binding, LRU bounds and disposal',async()=>{
  let time=0;const cache=createWardPhiSessionCache({maxSessions:1,ttlMs:50,now:()=>time});
  const source=phiFixtureSource(phiClinicalDevelopment[6]);let first;
  await cache.withSession(source,{sourceVersion:'v1'},s=>{first=s;});
  await assert.rejects(cache.withSession({...source,practitioners:[{name:'赵星竹'}]},{sourceVersion:'v1'},()=>{}),/VERSION_REUSED/);
  await cache.withSession(source,{sourceVersion:'v2'},s=>assert.notEqual(s,first));
  assert.throws(()=>first.scan('郄主任',source.context),/DISPOSED/);
  let second;await cache.withSession(source,{sourceVersion:'v2'},s=>{second=s;});
  time=50;assert.equal(cache.diagnostics().sessions,0);assert.throws(()=>second.scan('郄主任',source.context),/DISPOSED/);
  await cache.withSession(source,{sourceVersion:'v2'},()=>{});
  const other=phiFixtureSource(phiClinicalDevelopment[0],1);await cache.withSession(other,{sourceVersion:'v1'},()=>{});
  assert.equal(cache.diagnostics().sessions,1);assert.equal(cache.diagnostics().evicted,1);cache.close();
  await assert.rejects(cache.withSession(source,{sourceVersion:'v2'},()=>{}),/CLOSED/);
});
test('active dictionary leases cannot be evicted or reused across ward/tenant/session',async()=>{
  const source=phiFixtureSource(phiClinicalDevelopment[6]),cache=createWardPhiSessionCache({maxSessions:1}),gate=deferred();let session;
  const work=cache.withSession(source,{sourceVersion:'v1'},async s=>{session=s;await gate.promise;assert.ok(s.scan('郄主任',source.context).length);});
  for(const key of ['ward_id','tenant_id','phi_session_id']) await assert.rejects(cache.withSession({...source,context:{...source.context,[key]:'other'}},{sourceVersion:'v1'},()=>{}),/CACHE_FULL/);
  cache.invalidate(source.context);gate.resolve();await work;
  assert.throws(()=>session.scan('郄主任',source.context),/DISPOSED/);assert.equal(cache.diagnostics().sessions,0);cache.close();
});
test('dictionary cache rejects missing context/version and closes leases after work failure',async()=>{
  const source=phiFixtureSource(phiClinicalDevelopment[6]),cache=createWardPhiSessionCache();
  await assert.rejects(cache.withSession({...source,context:{...source.context,ward_id:null}},{sourceVersion:'v1'},()=>{}),/CONTEXT/);
  await assert.rejects(cache.withSession(source,{},()=>{}),/VERSION/);
  await assert.rejects(cache.withSession(source,{sourceVersion:'v1'},()=>{throw new Error('synthetic');}),/synthetic/);
  assert.equal(cache.diagnostics().leased,0);cache.close();assert.equal(cache.diagnostics().sessions,0);
});
test('idle dictionaries expire without another request; note metadata coverage survives prewarming',async()=>{
  const source=phiFixtureSource(phiClinicalDevelopment[6]);
  source.practitioners=[];source.notes=[{supervising_doctor:'郄芃',text:'正文不能留在缓存键或会话里'}];
  const cache=createWardPhiSessionCache({ttlMs:20});let session;
  await cache.withSession(source,{sourceVersion:'v1'},s=>{session=s;assert.ok(s.scan('郄主任',source.context).length);});
  await delay(60);
  assert.throws(()=>session.scan('郄主任',source.context),/DISPOSED/);cache.close();
});
