// Real packaged stdio and direct storage boundaries; synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { guardToolOutput, guardToolOutputAsync } from '../plugins/medcius/servers/shared/phi-output.mjs';
import { runOnce } from '../plugins/medcius/servers/shared/rpc.mjs';
import { createPhiRequestSession } from '../plugins/medcius/lib/phi-entity-session.mjs';

const model = process.env.MEDCIUS_CN_NER_MODEL_DIR;
const data = mkdtempSync(join(tmpdir(),'medcius-mcp-dual-'));
mkdirSync(join(data,'tmp'));
const baseEnv = {...process.env, NODE_ENV:'production', MEDCIUS_PROFILE:'production', NODE_NO_WARNINGS:'1',
  CLAUDE_MEDCIUS_DATA:data, MEDCIUS_DATA:data, TMP:join(data,'tmp'), TEMP:join(data,'tmp')};
function rpc(component, extra = {}) {
  const child = spawn(process.execPath, ['plugins/medcius/scripts/codex-mcp-server.mjs',component],
    { cwd:resolve('.'), env:{...baseEnv,...extra}, stdio:['pipe','pipe','pipe'] });
  let seq = 0; const pending = new Map();
  child.stderr.resume();
  const exit = new Promise(r => child.once('exit',r));
  createInterface({input:child.stdout}).on('line',line => {
    const msg=JSON.parse(line), p=pending.get(msg.id);
    if(p){clearTimeout(p.timer);pending.delete(msg.id);p.resolve(msg);}
  });
  child.on('exit', () => { for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('MCP_EXIT'));}pending.clear(); });
  return {
    request(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP_TIMEOUT'));},30000);
      pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});},
    call(name,args={}){return this.request('tools/call',{name,arguments:args});},
    async close(){child.stdin.end();await exit;},
  };
}
const payload = {actor:'synthetic-review',action:'probe',subject_ref:'synthetic-only',tenant_id:'synthetic-tenant',payload:{note:'王建国因胸痛入院。林志明陪同。'}};

test('all four distributed MCP entries block missing/corrupt NER before side effects or source reads', async () => {
  const corrupt=mkdtempSync(join(data,'invalid-'));writeFileSync(join(corrupt,'config.json'),'{}');
  for(const modelDir of ['',corrupt]) for(const [server,name,args] of [
    ['phiguard','redact',{text:payload.payload.note,mode:'mask',keep_last:4}],
    ['audit','record_event',payload],
    ['fhir','connect',{base_url:'http://127.0.0.1:1/fhir'}],
    ['documents','log_observation',{entry:payload.payload.note}],
  ]) {
    const client=rpc(server,{MEDCIUS_CN_NER_MODEL_DIR:modelDir});
    try { const r=await client.call(name,args); assert.equal(r.result.isError,true,JSON.stringify(r));assert.doesNotMatch(JSON.stringify(r),/王建国|林志明/);
      const invalid=await client.request('王建国');assert.equal(invalid.error.message,'METHOD_NOT_FOUND');assert.doesNotMatch(JSON.stringify(invalid),/王建国/); }
    finally {await client.close();}
  }
  assert.equal(existsSync(join(data,'documents/observations.md')),false);
});

test('verified model: PHI output removes bare names; audit refuses raw input and preserves clean signed bytes', async () => {
  assert.ok(model,'real CPU model required');
  const phi=rpc('phiguard'), audit=rpc('audit'), docs=rpc('documents');
  try {
    for(const name of ['redact','pseudonymize','scan']) {
      const r=await phi.call(name,{text:payload.payload.note});
      assert.notEqual(r.result.isError,true,JSON.stringify(r));assert.doesNotMatch(JSON.stringify(r),/王建国|林志明/);
    }
    const bad=await audit.call('record_event',payload);assert.equal(bad.result.isError,true);
    const denied=await docs.call('log_observation',{entry:payload.payload.note});assert.equal(denied.result.isError,true);
    assert.equal(existsSync(join(data,'documents/observations.md')),false);
    const good=await audit.call('record_event',{...payload,payload:{note:'患者无发热、咳嗽。'}});
    assert.notEqual(good.result.isError,true,JSON.stringify(good));
    const event=JSON.parse(good.result.content[0].text);
    const read=await audit.call('get_event',{event_id:event.event_id});assert.notEqual(read.result.isError,true,JSON.stringify(read));
    const stored=JSON.parse(read.result.content[0].text);assert.equal(stored.event_digest,event.event_digest);
    assert.equal(stored.payload_json,'{"note":"患者无发热、咳嗽。"}');
    const chain=JSON.parse((await audit.call('verify_chain')).result.content[0].text);assert.equal(chain.ok,true);assert.equal(chain.checked,1);
    const exp=await audit.call('export_batch',{});assert.notEqual(exp.result.isError,true,JSON.stringify(exp));
  } finally {await phi.close();await audit.close();await docs.close();}
});

test('actual FHIR response: nested JSON session entities are injected before sealing identifiers', async () => {
  assert.ok(model);
  let reads=0;
  const http=createServer((req,res)=>{reads++;res.setHeader('Content-Type','application/fhir+json');
    res.end(JSON.stringify(req.url.includes('metadata')?{resourceType:'CapabilityStatement',status:'active',fhirVersion:'4.0.1',format:['json'],rest:[]}:
      {resourceType:'DiagnosticReport',id:'synthetic-report',status:'final',patient:{name:'索乌'},
        conclusion:'索乌自述胸闷。王建国因胸痛入院。林志明陪同，住和平路28号3栋602室。'}));});
  await new Promise((r,j)=>{http.once('error',j);http.listen(0,'127.0.0.1',r);});
  const client=rpc('fhir');
  try {
    const connected=await client.call('connect',{base_url:`http://127.0.0.1:${http.address().port}/fhir`});
    assert.notEqual(connected.result.isError,true,JSON.stringify(connected));
    const result=await client.call('read_resource',{resource_type:'DiagnosticReport',id:'synthetic-report'});
    assert.notEqual(result.result.isError,true,JSON.stringify(result));
    assert.doesNotMatch(JSON.stringify(result),/王建国|林志明|索乌|和平路|602室/);assert.ok(reads>0);
  } finally {await client.close();await new Promise(r=>http.close(r));}
});

test('production document ingestion rejects raw text before storage and accepts clean text',async()=>{
  const corpus=join(data,'corpus');mkdirSync(corpus);
  writeFileSync(join(corpus,'note.txt'),'王建国因胸痛入院。');
  const client=rpc('documents');
  try {
    const registered=await client.call('corpus_register',{name:'fixture',dir:corpus});
    assert.notEqual(registered.result.isError,true,JSON.stringify(registered));
    const bad=await client.call('ingest',{corpus:'fixture'});assert.equal(bad.result.isError,true);
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(join(data,'documents/data.sqlite'),{readOnly:true});
    try {assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get().n,0);} finally {db.close();}
    writeFileSync(join(corpus,'note.txt'),'患者无发热、咳嗽，偶有咳痰。');
    const clean=await client.call('ingest',{corpus:'fixture'});assert.notEqual(clean.result.isError,true,JSON.stringify(clean));
    const log=await client.call('log_observation',{entry:'患者无发热。'});assert.notEqual(log.result.isError,true,JSON.stringify(log));
    assert.match(readFileSync(join(data,'documents/observations.md'),'utf8'),/患者无发热/);
  }finally{await client.close();}
});

test('direct transport/audit entry, legacy rows, key spoofing and context switching fail closed',async()=>{
  const previous={profile:process.env.MEDCIUS_PROFILE,node:process.env.NODE_ENV,model:process.env.MEDCIUS_CN_NER_MODEL_DIR,data:process.env.CLAUDE_MEDCIUS_DATA};
  process.env.CLAUDE_MEDCIUS_DATA=join(data,'direct');
  process.env.MEDCIUS_PROFILE='demo';process.env.NODE_ENV='test';
  const {HANDLERS:A}=await import('../plugins/medcius/servers/audit/src/tools.mjs');
  const old=A.record_event(payload);
  process.env.MEDCIUS_PROFILE='production';
  try {
    assert.throws(()=>guardToolOutput('王建国入院'),/ASYNC_REQUIRED/);
    await assert.rejects(A.get_event({event_id:old.event_id}),/PHI_RAW_VALUE_BLOCKED/);
    await assert.rejects(A.export_batch({}),/PHI_RAW_VALUE_BLOCKED/);
    await assert.rejects(A.record_event({...payload,payload:{record_sha256:'王建国因胸痛入院。'}}),/PHI_(RAW_VALUE|VALUE_FIELD_CONTEXT)_BLOCKED/);
    const before=await A.verify_chain({});assert.equal(before.ok,true);assert.equal(before.checked,1);
    const safe=await guardToolOutputAsync({content:[{type:'text',text:JSON.stringify({patient:{name:'索乌'},note:'索乌自述胸闷。'})}]});
    assert.doesNotMatch(JSON.stringify(safe),/索乌/);
    const escaped=await guardToolOutputAsync({patient:{name:'索乌'},note:'索\n乌自述胸闷。', '王建国': '病程'});
    assert.doesNotMatch(JSON.stringify(escaped),/索|乌|王建国/);
    const {generateKeyPair,buildSignoffEnvelope,signSignoffEnvelope}=await import('../plugins/medcius/servers/shared/digital-signature.mjs');
    const pair=generateKeyPair('synthetic-signer');
    const clean=await A.record_event({...payload,payload:{note:'患者无发热。'}});
    const {envelope}=buildSignoffEnvelope({eventId:clean.event_id,eventDigest:clean.event_digest,tenantId:payload.tenant_id,
      signer:'synthetic-signer',role:'physician',decision:'agree',reason:'Reviewed synthetic case',signedAt:new Date().toISOString(),replayId:'synthetic-replay'});
    const signature=signSignoffEnvelope({envelope,privateKeyPem:pair.privateKey,keyId:pair.keyId,signer:'synthetic-signer',role:'physician'});
    const signed=await A.signoff({event_id:clean.event_id,tenant_id:payload.tenant_id,signer:'synthetic-signer',role:'physician',decision:'agree',
      reason:'Reviewed synthetic case',signature:signature.signature,key_id:pair.keyId,envelope});
    assert.equal(signed.signature_verified,true);
    const read=await A.get_event({event_id:clean.event_id});assert.equal(read.signoffs[0].signature,signature.signature);
    assert.equal((await A.verify_chain({})).ok,true);
    const request=createPhiRequestSession([{name:'索乌'}]);
    assert.throws(()=>request.session.scan('索乌',{phi_request_id:'another'}),/CONTEXT_MISMATCH/);request.session.dispose();
    delete process.env.MEDCIUS_CN_NER_MODEL_DIR;
    await assert.rejects(A.record_event({...payload,payload:{note:'已脱敏'}}),/MODEL_REQUIRED/);
    let called=false;
    await assert.rejects(runOnce({phiGuard:false,tools:[{name:'test',inputSchema:{type:'object'}}],handlers:{test(){called=true;return 'raw';}}},'test',{}),/TOOL_FAILED_OR_PHI_OUTPUT_BLOCKED/);
    await assert.rejects(runOnce({tools:[],handlers:{}},'王建国',{}),{message:'TOOL_FAILED_OR_PHI_OUTPUT_BLOCKED'});
    assert.equal(called,false);
  } finally {
    for(const [k,v] of Object.entries({MEDCIUS_PROFILE:previous.profile,NODE_ENV:previous.node,MEDCIUS_CN_NER_MODEL_DIR:previous.model,CLAUDE_MEDCIUS_DATA:previous.data}))
      if(v===undefined) delete process.env[k];else process.env[k]=v;
  }
});
