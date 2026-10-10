import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PatientEvolutionEngine} from '../plugins/medcius/lib/patient-evolution-engine.mjs';
const html=readFileSync(new URL('../plugins/medcius/servers/api/src/ui/workstation.html',import.meta.url),'utf8');
const code=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const summary=PatientEvolutionEngine.analyzePatientEvolution({patient:{id:'synthetic-p'},now:'2026-10-06T10:00:00Z'});
const result={ok:true,data:{workflow:'evolution',payload:summary,payload_digest:'synthetic-digest',patient_context:{patient_id:'synthetic-p',encounter_id:'synthetic-e'},signable:true}};
function environment(){
  const elements=new Map();
  const el=id=>{if(!elements.has(id)){const classes=new Set(id==='report-card'?['hidden']:[]);elements.set(id,{value:'',textContent:'',innerHTML:'',disabled:false,dataset:{},listeners:{},attributes:{},classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle(c,v){const on=v??!classes.has(c);on?classes.add(c):classes.delete(c);}},addEventListener(type,fn){this.listeners[type]=fn;},setAttribute(k,v){this.attributes[k]=v;}});}return elements.get(id);};
  for(const id of [...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]))el(id);
  const tabs=['evolution','shift-handover','consult-preparation','discharge-readiness'].map(k=>{const b=el('tab-'+k);b.dataset.tab=k;return b;});
  const buttons=[el('run')]; const pending=[];
  const context=vm.createContext({crypto:{randomUUID},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},AbortController,document:{getElementById:el,addEventListener(){},querySelectorAll:s=>s==='[data-tab]'?tabs:s==='.run-button'?buttons:[]},fetch:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))});
  vm.runInContext(code,context); context.initUi();el('ctx-demo').value='demo';el('ctx-bed').value='01床';el('evo-window').value='24h';
  const deliver=r=>pending.shift().resolve({ok:r.ok,status:r.ok?200:400,json:async()=>r.data});
  return {context,el,pending,deliver};
}
test('primary shell has four tasks, labelled controls and secondary engineering tools',()=>{
  assert.equal([...html.matchAll(/data-tab=/g)].length,4);
  assert.match(html,/<details class="tech-tools"/); assert.doesNotMatch(html,/去签核 →|NULL \/ 未提及|JSON 数组，可选/);
  for(const [,id]of html.matchAll(/<(?:input|textarea|select) id="([^"]+)"/g))assert.ok(html.includes(`for="${id}"`),id);
});
test('a successful read binds patient, cutoff and report and never enables signing without session permission',async()=>{
  const e=environment(),run=e.context.runWorkflow('evolution',{time_window:'24h'});assert.equal(e.el('run').disabled,true);
  e.deliver(result);await run;assert.equal(e.el('report-card').classList.contains('hidden'),false);assert.match(e.el('patient-identity').textContent,/synthetic-p.*synthetic-e/);
  assert.equal(e.el('signoff-button').disabled,true);assert.ok(e.el('report-cutoff').textContent.includes('资料截至'));
});
test('patient change clears old report and rejects a late response even when fetch ignores abort',async()=>{
  const e=environment(),run=e.context.runWorkflow('evolution',{});e.el('ctx-bed').value='02床';e.el('ctx-bed').listeners.input();e.deliver(result);await run;
  assert.equal(e.el('report-card').classList.contains('hidden'),true);assert.equal(e.el('report-body').innerHTML,'');assert.equal(e.el('signoff-button').disabled,true);assert.equal(e.el('run').disabled,false);
});
test('task switch invalidates report and pending request; old workflow cannot render into new task',async()=>{
  const e=environment(),run=e.context.runWorkflow('evolution',{});e.context.switchWorkflow('consult-preparation');e.deliver(result);await run;
  assert.equal(e.el('panel-consult-preparation').classList.contains('hidden'),false);assert.equal(e.el('report-body').innerHTML,'');
});
test('failed refresh removes previous results and returns a readable error',async()=>{
  const e=environment();let run=e.context.runWorkflow('evolution',{});e.deliver(result);await run;
  run=e.context.runWorkflow('evolution',{});e.pending.shift().reject(Error('network failed'));await run;
  assert.equal(e.el('report-body').innerHTML,'');assert.match(e.el('report-error').innerHTML,/未能完成/);assert.equal(e.el('run').disabled,false);
});
test('malformed sources, conflicting patient identity and empty consultation purpose are rejected',async()=>{
  const e=environment();e.el('ctx-demo').value='';e.el('ctx-feeds').value='{';await e.context.runWorkflow('evolution',{});assert.equal(e.pending.length,0);assert.match(e.el('report-error').innerHTML,/格式/);
  e.el('ctx-demo').value='demo';e.context.switchWorkflow('consult-preparation');await e.context.runWorkflow('consult-preparation',{consult_request:{department:'肾内科',purpose:' '}});assert.equal(e.pending.length,0);
  assert.throws(()=>e.context.renderReport({...result,data:{...result.data,patient_context:{patient_id:'other',encounter_id:'e'}}},'evolution'),/MISMATCH/);
});
test('source disclosure escapes keys and text while preserving unknown and empty semantics',()=>{
  const e=environment();const rendered=e.context.renderTree({text:'<img onerror=alert(1)>','<script>':'<svg>',status:null});assert.ok(!rendered.includes('<img')&&!rendered.includes('<script>')&&!rendered.includes('<svg>'));assert.match(rendered,/未提供/);assert.match(e.context.renderTree([]),/不等于不存在/);
});

test('zero critical flags always display a coverage warning; delayed sync remains visible',()=>{
  const e=environment();
  const sources=[{kind:'lis',status:'available_empty',fetched_at:'2026-10-07T08:00:00Z',synchronized_through:'2026-10-07T07:40:00Z',query_read_complete:true}];
  const d=PatientEvolutionEngine.analyzePatientEvolution({patient:{id:'synthetic-p'},now:'2026-10-07T08:00:00Z',sourceAvailability:sources});
  const rendered=e.context.renderEvolution(d);
  assert.match(rendered,/不能用于排除危急值/);
  assert.match(rendered,/不能据此认定无危急值/);
  assert.match(rendered,/同步或完整性仍有缺口/);
  assert.match(rendered,/固定快照，不是实时监测/);
  assert.match(e.context.visibilityNotice(null),/来源同步完整性未确认/);
});
test('reading panel ignores late saves after patient change and retains unsaved questions',async()=>{
  const e=environment(),s={session_id:'draft-one',snapshot_hash:'hash-one',revision:0,mode:'active',items:[],selected_ids:[],note:'saved'};
  e.context.renderReport({...result,data:{...result.data,review_session:s}},'evolution');
  e.el('review-note').value='unsaved question';e.context.renderReview();assert.equal(e.el('review-note').value,'unsaved question');
  const save=e.context.reviewAct('note',{note:'unsaved question'});
  e.context.invalidateReport();e.deliver({ok:true,data:{review_session:{...s,revision:1,note:'unsaved question'}}});await save;
  assert.equal(e.el('review-panel').classList.contains('hidden'),true);assert.equal(e.el('review-note').value,'');assert.equal(e.el('review-status').textContent,'');
});
