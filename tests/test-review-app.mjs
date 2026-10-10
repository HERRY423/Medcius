import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createReviewAppConfig } from '../plugins/medcius/servers/review-app/src/config.mjs';
import { runOnce } from '../plugins/medcius/servers/shared/rpc.mjs';
const html=readFileSync(new URL('../plugins/medcius/servers/review-app/src/review.html',import.meta.url),'utf8');
const code=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(){
  const elements=new Map(),sent=[],timers=new Map();let serial=0,listener;
  const el=id=>{if(!elements.has(id))elements.set(id,{value:id==='filter'?'all':'',innerHTML:'',textContent:'',disabled:false,listeners:{},addEventListener(k,fn){this.listeners[k]=fn;}});return elements.get(id);};
  const parent={postMessage:m=>sent.push(m)};
  const context=vm.createContext({document:{getElementById:el,documentElement:{style:{}}},window:{parent,addEventListener:(name,fn)=>listener=fn},crypto:{randomUUID},setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(code,context);
  const receive=(data,source=parent)=>listener({data:{jsonrpc:'2.0',...data},source});
  const reply=(msg,result)=>receive({id:msg.id,result});
  const request=method=>sent.findLast(m=>m.method===method&&m.id!=null);
  const click=id=>el(id).listeners.click();
  return {context,el,sent,timers,receive,reply,request,click};
}
async function load(e,caps={message:{text:{}},updateModelContext:{text:{}},experimental:{'openai/message':{}}}){
  e.reply(e.request('ui/initialize'),{hostCapabilities:caps,hostContext:{}});await tick();
  const cfg=createReviewAppConfig(),r=await runOnce(cfg,'medcius_review_workspace',{});
  e.receive({method:'ui/notifications/tool-result',params:r});return {cfg,state:r._meta.review_session};
}
async function fulfillTool(e,cfg){await tick();const m=e.request('tools/call');assert.ok(m);e.reply(m,await runOnce(cfg,m.params.name,m.params.arguments));await tick();}
async function prepare(e,cfg,state){
  let p=e.context.act('focus',{selected_ids:[state.items[0].id]});await fulfillTool(e,cfg);await p;
  p=e.click('prepare');await fulfillTool(e,cfg);await fulfillTool(e,cfg);await p;
}
test('extension contract: static resources, global/thread entrypoints and empty invocation',()=>{
  const c=createReviewAppConfig(),tool=c.tools[0];assert.deepEqual(tool.inputSchema.properties,{});
  assert.deepEqual(tool._meta['openai/ui'].entrypoints,[{type:'global'},{type:'thread'}]);
  assert.equal(c.resources[0].mimeType,'text/html;profile=mcp-app');assert.equal(tool._meta.ui.resourceUri,c.resources[0].uri);
  assert.ok(c.tools.slice(1).every(t=>t._meta.ui.visibility.length===1&&t._meta.ui.visibility[0]==='app'));
});
test('first result renders without duplicate tool call; spoofed frames and unsupported capabilities stay closed',async()=>{
  const e=harness();e.receive({id:e.request('ui/initialize').id,result:{hostCapabilities:{message:{text:{}}}}},{});
  assert.equal(e.el('send').disabled,true);await load(e,{});
  assert.equal(e.sent.filter(m=>m.method==='tools/call').length,0);assert.match(e.el('items').innerHTML,/血钾/);
  assert.equal(e.el('send').disabled,true);assert.equal(e.el('attach').disabled,true);
});
test('selected context, explicit send and uncertain receipt never become completed review',async()=>{
  const e=harness(),{cfg,state}=await load(e);await prepare(e,cfg,state);
  assert.equal(e.el('send').disabled,false);assert.match(e.el('preview').textContent,/1\. 血钾/);assert.doesNotMatch(e.el('preview').textContent,/2\. 血钾/);
  assert.equal(e.sent.filter(m=>m.method==='ui/message').length,0);
  const p=e.click('send');await tick();const message=e.request('ui/message');assert.ok(message);
  assert.equal(message.params._meta['openai/message'].target,'active');assert.match(message.params.content[0].text,/仅核对/);
  // Delivery timeout may follow a committed send: do not automatically retry.
  for(const fn of [...e.timers.values()])fn();await p;
  assert.match(e.el('status').textContent,/结果未知/);assert.equal(e.el('send').disabled,true);
  await e.click('send');assert.equal(e.sent.filter(m=>m.method==='ui/message').length,1);
});
test('context removal and draft edit invalidate attachments and prepared requests',async()=>{
  const e=harness(),{cfg,state}=await load(e);await prepare(e,cfg,state);
  let p=e.click('attach');await tick();e.reply(e.request('ui/update-model-context'),{});await p;
  assert.match(e.el('attachment').textContent,/已附加/);
  e.el('note').value='新增核对问题';e.el('note').listeners.input();await tick();
  assert.equal(e.el('send').disabled,true);assert.equal(e.el('attach').disabled,true);
  assert.deepEqual(JSON.parse(JSON.stringify(e.request('ui/update-model-context').params)),{content:[]});e.reply(e.request('ui/update-model-context'),{});await tick();
  e.receive({method:'ui/notifications/host-context-changed',params:{'openai/modelContext':null}});
  assert.match(e.el('attachment').textContent,/宿主移除/);
});
test('host isError receipt is not reported as successful submission',async()=>{
  const e=harness(),{cfg,state}=await load(e);await prepare(e,cfg,state);
  const p=e.click('send');await tick();e.reply(e.request('ui/message'),{isError:true});await p;
  assert.match(e.el('status').textContent,/结果未知/);assert.equal(e.el('send').disabled,true);
});
test('stdio advertises and serves only packaged UI; actions work over real JSON-RPC',async()=>{
  const proc=spawn(process.execPath,['plugins/medcius/servers/review-app/src/index.mjs'],{stdio:['pipe','pipe','pipe'],env:{...process.env,NODE_ENV:'test',MEDCIUS_PROFILE:'test',MEDCIUS_CLINICAL_LANDING:'false'}});
  const waiters=new Map();let seq=0;const lines=createInterface({input:proc.stdout});
  lines.on('line',line=>{const r=JSON.parse(line);waiters.get(r.id)?.(r);waiters.delete(r.id);});proc.stderr.resume();
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error('stdio timeout')),5000);waiters.set(id,r=>{clearTimeout(timer);resolve(r);});proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  try{
    const init=await call('initialize',{protocolVersion:'2025-06-18'});assert.ok(init.result.capabilities.resources);
    const list=await call('resources/list');const resource=await call('resources/read',{uri:list.result.resources[0].uri});assert.match(resource.result.contents[0].text,/我的核对范围/);
    const denied=await call('resources/read',{uri:'file:///C:/private.txt'});assert.equal(denied.error.code,-32602);
    const r=await call('tools/call',{name:'medcius_review_workspace',arguments:{}}),s=r.result._meta.review_session;
    const action=await call('tools/call',{name:'medcius_review_action',arguments:{session_id:s.session_id,snapshot_hash:s.snapshot_hash,expected_revision:0,request_id:'stdio-request-one',action:'pause'}});
    assert.equal(action.result._meta.review_session.mode,'paused');
  }finally{proc.kill();lines.close();}
});
