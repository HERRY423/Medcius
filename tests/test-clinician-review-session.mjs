import test from 'node:test';
import assert from 'node:assert/strict';
import { ClinicianReviewSessions } from '../plugins/medcius/lib/clinician-review-session.mjs';
import { createReviewAppConfig } from '../plugins/medcius/servers/review-app/src/config.mjs';
import { runOnce } from '../plugins/medcius/servers/shared/rpc.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.CLAUDE_MEDCIUS_DATA = mkdtempSync(join(tmpdir(), 'medcius-reading-test-'));
process.env.CLAUDE_MEDCIUS_PHI_SALT = 'synthetic-reading-test-salt';
for (const key of ['NODE_ENV', 'MEDCIUS_PROFILE', 'MEDCIUS_CLINICAL_LANDING']) delete process.env[key];
const { createWorkstationHandler } = await import('../plugins/medcius/servers/api/src/workstation-routes.mjs');

const actor = { isAuthenticated: true, user: 'doctor-a', tenantId: 'hospital-a' };
const report = { workflow: 'evolution', patient_context: { patient_id: 'synthetic-p', encounter_id: 'synthetic-e' }, payload_digest: 'original-report',
  payload: { generated_at: '2026-10-06T10:00:00Z', selectable_items: [{ id: 'one', title: '更正结果', summary: '原结果已被更正，人工确认未知' }, { id: 'two', title: '资料缺失', summary: '未提供不等于正常' }],
    blocks: { evidence: [{ item_id: 'one', source_id: 'Observation/example', version_id: 'v2', span: null }] } } };
function setup(options) {
  const store = new ClinicianReviewSessions(options);let s = store.create(report, actor), seq = 0;
  const input = (action, extra={}) => ({ session_id:s.session_id,snapshot_hash:s.snapshot_hash,expected_revision:s.revision,request_id:`request-${++seq}`,action,...extra });
  const act = (action, extra={}) => s=store.act(input(action,extra),actor);
  return { store, input, act, state:()=>s };
}
test('reading marks never mutate report; drafts and ownership are isolated',()=>{
  const original=structuredClone(report), a=setup(),s=a.state();
  a.act('mark',{item_id:s.items[0].id,item_hash:s.items[0].item_hash,status:'read'});
  assert.deepEqual(report,original);assert.equal(a.state().items[0].status,'read');
  s.items[0].title='injected';assert.notEqual(a.store.read(s.session_id,actor).items[0].title,'injected');
  for(const other of [{...actor,user:'doctor-b'},{...actor,tenantId:'hospital-b'}])assert.throws(()=>a.store.read(s.session_id,other),/UNAVAILABLE/);
  assert.throws(()=>a.store.create(report,{user:'a'}),/IDENTITY/);
});
test('old report, stale revision, wrong item hash and duplicate-key conflicts fail closed',()=>{
  const a=setup(),i=a.input('focus',{selected_ids:['item-1']});const result=a.store.act(i,actor);
  assert.equal(a.store.act(i,actor).revision,result.revision);
  assert.throws(()=>a.store.act({...i,selected_ids:['item-2']},actor),/REUSED/);
  assert.throws(()=>a.store.act({...i,request_id:'request-new'},actor),/STALE/);
  assert.throws(()=>a.store.act({...i,request_id:'request-next',expected_revision:1,snapshot_hash:'other'},actor),/STALE/);
  assert.throws(()=>a.store.act({...i,request_id:'request-last',expected_revision:1,action:'mark',item_id:'item-1',item_hash:'wrong',status:'read'},actor),/MISMATCH/);
});
test('selection is bounded and only a prepared active revision can be shared',()=>{
  const a=setup(),id=a.state().session_id;
  assert.throws(()=>a.act('request'),/SELECTION_REQUIRED/);
  assert.throws(()=>a.act('focus',{selected_ids:['not-present']}),/SELECTION_INVALID/);
  assert.throws(()=>a.act('focus',{selected_ids:['item-1','item-1']}),/SELECTION_INVALID/);
  a.act('focus',{selected_ids:['item-1']});a.act('request');
  const c=a.store.modelContext(id,actor);assert.equal(c.items.length,1);assert.equal(c.items[0].evidence.version_id,'v2');assert.equal(c.items[0].evidence.span,null);assert.ok(!JSON.stringify(c).includes('synthetic-p'));
  c.items[0].evidence.version_id='mutated';assert.equal(a.store.read(id,actor).items[0].evidence.version_id,'v2');
  a.act('pause');assert.throws(()=>a.store.modelContext(id,actor),/NOT_PREPARED/);assert.throws(()=>a.act('note',{note:'question'}),/PAUSED/);
  a.act('resume');assert.throws(()=>a.store.modelContext(id,actor),/NOT_PREPARED/);
});
test('PHI is removed before note storage and context; bare-name assurance stays explicit',()=>{
  const a=setup();a.act('note',{note:'患者姓名：张三，电话：13800138000，请核对来源'});
  assert.doesNotMatch(JSON.stringify(a.state()),/张三|13800138000/);assert.equal(a.state().assurance,'heuristic_scan_only');
  assert.throws(()=>a.act('note',{note:'x'.repeat(1001)}),/NOTE_INVALID/);
  a.act('focus',{selected_ids:['item-1']});a.act('request');assert.doesNotMatch(JSON.stringify(a.store.modelContext(a.state().session_id,actor)),/13800138000/);
});
test('session expiry and capacity do not silently evict another active review',()=>{
  let now=0;const a=setup({now:()=>now,ttlMs:100,maxSessions:1});
  assert.throws(()=>a.store.create(report,actor),/CAPACITY/);now=100;
  assert.throws(()=>a.store.read(a.state().session_id,actor),/UNAVAILABLE/);assert.ok(a.store.create(report,actor));
});
test('MCP roundtrip survives PHI egress including binding tokens and all actions',async()=>{
  const cfg=createReviewAppConfig();let s=(await runOnce(cfg,'medcius_review_workspace',{}))._meta.review_session;
  assert.match(s.snapshot_hash,/^sha256-ap:[a-p]{64}$/);assert.ok(s.items.length);
  for(const [index,action] of ['focus','note','request'].entries()){
    const args={session_id:s.session_id,snapshot_hash:s.snapshot_hash,expected_revision:s.revision,request_id:`request-mcp-${index}`,action,
      ...(action==='focus'?{selected_ids:[s.items[0].id]}:action==='note'?{note:'检查来源版本'}:{})};
    s=(await runOnce(cfg,'medcius_review_action',args))._meta.review_session;assert.equal(s.revision,index+1);
  }
  const c=(await runOnce(cfg,'medcius_review_context',{session_id:s.session_id}))._meta.review_context;
  assert.equal(c.snapshot_hash,s.snapshot_hash);assert.equal(c.items.length,1);assert.match(c.items[0].item_hash,/^sha256-ap:[a-p]{64}$/);
  const saved=process.env.NODE_ENV;process.env.NODE_ENV='production';
  try{await assert.rejects(runOnce(cfg,'medcius_review_workspace',{}),/SYNTHETIC_ONLY/);}finally{saved===undefined?delete process.env.NODE_ENV:process.env.NODE_ENV=saved;}
});
test('REST reading drafts keep report RBAC and silent/production restrictions',async()=>{
  let stage='engineering';const handler=createWorkstationHandler({governance:{getCurrentStage:()=>({id:stage})}});
  const call=async(path,body,identity=actor,permission={allowed:true})=>{
    let out;await handler({headers:{}},{},{pathname:path,method:'POST',body,auth:identity,guardedAuthorize:()=>permission,sendJson:(status,data)=>out={status,data}});return out;
  };
  const response=await call('/workstation/evolution',{demo_ward:true,as_of:'2026-10-06T10:00:00Z'});
  assert.equal(response.status,200,JSON.stringify(response.data));const s=response.data.review_session;assert.ok(s);
  assert.equal((await call('/workstation/review/read',{session_id:s.session_id})).status,200);
  assert.equal((await call('/workstation/review/read',{session_id:s.session_id},{...actor,user:'other'})).status,400);
  assert.equal((await call('/workstation/review/read',{session_id:s.session_id},{isAuthenticated:false})).status,401);
  assert.equal((await call('/workstation/review/read',{session_id:s.session_id},actor,{allowed:false,status:403,error:'DENIED'})).status,403);
  stage='silent_pilot';assert.equal((await call('/workstation/review/read',{session_id:s.session_id})).status,403);
});
