import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { sha256Hex, canonicalJson } from "../plugins/medcius/servers/shared/crypto.mjs";
import { HospitalDataAdapter } from "../plugins/medcius/lib/hospital-data-adapter.mjs";
import { analyzeTemporalEvolution } from "../plugins/medcius/lib/temporal-evolution.mjs";
import { PatientEvolutionEngine } from "../plugins/medcius/lib/patient-evolution-engine.mjs";
import { ReadOnlyHospitalDataBridge } from "../plugins/medcius/lib/read-only-hospital-data-bridge.mjs";
import { createFhirR4Connectors } from "../plugins/medcius/lib/connectors/fhir-r4-connector.mjs";
import { ShiftHandoverEngine } from "../plugins/medcius/lib/shift-handover-engine.mjs";
import { readWardRoster } from "../plugins/medcius/lib/ward-roster.mjs";
import { validateLlmConfig, createLlmInferenceClient } from "../plugins/medcius/lib/llm-inference-config.mjs";
import { HANDLERS } from "../plugins/medcius/servers/fhir/src/tools.mjs";
import { TOOLS } from "../plugins/medcius/servers/fhir/src/schemas.mjs";
import * as fhir from "../plugins/medcius/servers/fhir/src/fhir-client.mjs";
import { scoreAssertionCohort } from "../scripts/score-cn-assertions.mjs";
import { syntheticWardView } from "../plugins/medcius/servers/api/src/ward-demo.mjs";

const identity={tenant_id:"synthetic-tenant",patient_id:"p-fixture",encounter_id:"e-fixture"};
const cut="2026-11-22T02:00:00Z", early="2026-11-21T15:00:00Z", late="2026-11-21T17:00:00Z";
const code="XJ01DDT001A001ABCD01001";
const pack={data_class:"official",status:"approved",clinical_rules:{restricted_antibiotics:[
  {nhsa_code:code,name:"合成药品",class:"合成类",level:"复核",review_after_days:2}]}};
const order=(id, extras={})=>({...identity,id,drug_name:"同名显示",drug_code:code,drug_code_system:"NHSA",
  is_medication:true,status:"active",authored_on:"2026-11-15T10:00:00Z",...extras});
const dose=(id,order_id,t,extra={})=>({...identity,id,order_id,performed_at:t,record_kind:"administration",
  execution_status:"administered",status:"completed",version_id:"1",...extra});

test("coded product days count distinct local eMAR dates across orders and abstain on missing or conflicting evidence",()=>{
  const a=order("order-a"),b=order("order-b");
  const run=(rows,zone="Asia/Shanghai")=>HospitalDataAdapter.normalizeHisOrders(rows,{rulePack:pack,now:cut,timeZone:zone});
  const doses=[dose("d1",a.id,early),dose("d2",b.id,late),dose("d3",b.id,late)];
  const result=run([a,b,...doses,order("wrong",{drug_code:null,drug_name:"合成药品"})]);
  assert.equal(result.observed_antibiotic_days.length,1);
  assert.equal(result.observed_antibiotic_days[0].duration_days,2);
  const stopped=run([{...a,status:"stopped",stopped_at:late},doses[0]]);
  assert.equal(stopped.antibiotic_alerts.length,0);
  assert.equal(stopped.observed_antibiotic_days[0].duration_days,1);
  assert.equal(run([{...a,authored_on:null},doses[0]]).observed_antibiotic_days[0].duration_days,1);
  assert.equal(result.antibiotic_alerts.length,2);
  for(const alert of result.antibiotic_alerts) {
    assert.deepEqual(alert.administration_dates,["2026-11-21","2026-11-22"]);
    assert.equal(alert.duration_days,2);assert.equal(alert.is_overdue,true);
    assert.deepEqual(alert.administration_evidence.map(e=>e.source_id).sort(),["d1","d2","d3"]);
  }
  assert.ok(result.time_gaps.some(g=>g.gap_type==="NHSA_DRUG_CODE_UNVERIFIED"));
  assert.equal(run([{...a,tenant_id:undefined,administrations:[{...doses[0],tenant_id:undefined}]}]).antibiotic_alerts[0].duration_days,null);
  assert.equal(run([a,dose("other-product",a.id,early,{drug_code:code.slice(0,-1)+"2",drug_code_system:"NHSA"})]).antibiotic_alerts[0].duration_days,null);
  assert.equal(run([a]).antibiotic_alerts[0].duration_days,null);
  assert.equal(run([a,doses[0]],"Invalid/Zone").antibiotic_alerts[0].duration_days,null);
  assert.equal(run([a,doses[0],{...doses[0],actual_dose:0}]).antibiotic_alerts[0].duration_days,null);
  assert.equal(run([a,dose("held",a.id,late,{status:"not-done"})]).antibiotic_alerts[0].duration_days,null);
  assert.equal(run([a,doses[0]]).antibiotic_alerts[0].is_overdue,null);
});

test("the FHIR HIS connector binds actual administrations to the encounter, request and site-coded product",async()=>{
  const system="urn:fixture:nhsa", requests=[];
  const base={subject:{reference:"Patient/"+identity.patient_id},meta:{versionId:"1"}};
  const concept=c=>({coding:[{system,code:c}]});
  const orderResource={...base,resourceType:"MedicationRequest",id:"order-a",status:"active",intent:"order",
    encounter:{reference:"Encounter/"+identity.encounter_id},authoredOn:early,medicationCodeableConcept:concept(code)};
  const administered={...base,resourceType:"MedicationAdministration",id:"dose-a",status:"completed",
    context:orderResource.encounter,request:{reference:"MedicationRequest/order-a"},effectiveDateTime:late,
    medicationCodeableConcept:concept(code),dosage:{dose:{value:1,unit:"g"}}};
  let event=administered;
  const endpoint=createFhirR4Connectors({baseUrl:"https://fixture.local/fhir",nhsaSystem:system,includeAdministrations:true,
    fetchImpl:async(url,init)=>{
      const target=new URL(url); requests.push([target,init.method]);
      const resources=target.pathname.endsWith("/MedicationRequest")?[orderResource]:[event];
      return Response.json({resourceType:"Bundle",type:"searchset",total:resources.length,entry:resources.map(resource=>({resource}))});
    }}).find(c=>c.kind==="his");
  const bridge = new ReadOnlyHospitalDataBridge({connectors:[endpoint],requiredKinds:["his"]});
  const calculate=async()=>HospitalDataAdapter.normalizeHisOrders((await bridge.readPatientSnapshot({...identity,doctor_id:"fixture-doctor"})).dataFeeds.his_orders,{rulePack:pack,now:cut,timeZone:"Asia/Shanghai"}).antibiotic_alerts[0];
  assert.equal((await calculate()).duration_days,1);
  assert.ok(requests.every(([url,method])=>method==="GET" && url.searchParams.get("patient")===identity.patient_id));
  assert.equal(requests[1][0].searchParams.get("context"),identity.encounter_id);
  event={...administered,medicationCodeableConcept:concept(code.slice(0,-1)+"2")};
  assert.equal((await calculate()).duration_days,null);
  event={...administered,effectiveDateTime:undefined,effectivePeriod:{start:early,end:late}};
  assert.equal((await calculate()).duration_days,null);
  event={...administered,context:{reference:"Encounter/foreign"}};
  await assert.rejects(calculate,/ENCOUNTER_MISMATCH/);
});

test("electrolytes compare consecutive time-stamped, final, comparable specimens",()=>{
  const sample=(metric,id,t,value)=>({...identity,id,source_system:"fixture-lab",version_id:"1",code:metric,effective_time:t,issued:t,
    status:"final",specimen_type:"serum",method_code:"method-a",value,unit:"mmol/L",ref_low:1,ref_high:9});
  const calc=observations=>analyzeTemporalEvolution({context:identity,observations,now:cut,cutoffTime:early}).electrolyte_trends;
  for (const metric of ["k","na","cl","ca","mg"]) {
    const a=sample(metric,"a",early,3),b=sample(metric,"b",late,5);
    const [r]=calc([b,a]);assert.deepEqual([r.direction,r.delta,r.elapsed_hours,r.slope_per_hour],["rising",2,2,1]);
    assert.deepEqual(r.source_references.map(s=>s.source_id),["a","b"]);
    for(const bad of [{method_code:"another"},{unit:"mg/L"},{ref_high:null},{ref_unit:"mg/L"},{comparator:"<"},{specimen_type:"urine"},{effective_time:early}]) {
      assert.equal(calc([a,{...b,...bad}])[0].status,"not_evaluable");
    }
    if (metric === "k") {
      const summarize = (after,temporalAnalysis) => PatientEvolutionEngine.analyzePatientEvolution({
        context:{...identity,doctor_id:"fixture-doctor"},patient:{id:identity.patient_id},now:cut,observations:[a,after],temporalAnalysis
      }).blocks.what_changed.abnormal_labs.find(l => l.source_id === after.id);
      for (const enabled of [true,false]) {
        const verified=summarize(b,enabled);
        assert.equal(verified.trend_direction,"↑");
        assert.deepEqual(verified.source_references.map(r=>r.source_id),["a","b"]);
        assert.equal(summarize({...b,method_code:"other"},enabled).trend_direction,null);
      }
    }
    assert.equal(calc([a,{...b,value:3}])[0].direction,"unchanged");
  }
});

test("open tasks preserve source assignment, deadlines and unverified carryovers until current evidence arrives",()=>{
  const args={context:identity,patient:{id:identity.patient_id},encounter:{id:identity.encounter_id},asOf:late,windowStart:early,
    observations:[{...identity,id:"lab-a",code:"K",source_system:"LIS",version_id:"v1",is_critical:true,
      status:"final",effective_time:early,issued:early,value:2,assigned_to_id:"fixture-owner",followup_due_at:late}],
    orders:[{...identity,id:"order-a",source_system:"HIS",version_id:"v1",title:"复核",status:"pending_execution",authored_on:early}]};
  const first=ShiftHandoverEngine.analyzePatientHandover(args);
  const task=first.high_risk_followup.items[0];
  assert.deepEqual([task.owner_id,task.due_at,task.closure_status],["fixture-owner",late,"open"]);
  const next={...args,windowStart:late,asOf:cut,observations:[],orders:[],previousHandover:first,
    verifyPreviousHandover:hash=>hash===first.packet_digest};
  const carried=ShiftHandoverEngine.analyzePatientHandover(next).carryover;
  assert.equal(carried.length,2);
  assert.ok(carried.every(t=>t.closure_status==="unknown" && t.owner_id===null));
  assert.equal(carried.find(t=>t.tracking_id===task.tracking_id).last_known_owner_id,"fixture-owner");
  const closed=ShiftHandoverEngine.analyzePatientHandover({...next,observations:[{...args.observations[0],acknowledged_at:late,acknowledged_version_id:"v1"}],
    orders:[{...args.orders[0],status:"completed"}]});
  assert.equal(closed.carryover.length,0);
  assert.throws(()=>ShiftHandoverEngine.analyzePatientHandover({...next,verifyPreviousHandover:()=>false}),/UNVERIFIED/);
});

test("roster beds are canonical, uniqueness checked, and absence is preserved",()=>{
  const scope={tenant_id:identity.tenant_id,ward_id:"w",as_of:cut};
  const row={...identity,ward_id:"w"};
  const roster={...scope,synchronized_through:cut,fetched_at:cut,read_only_enforced:true,status:"complete",source_id:"roster",source_version:"v1",members:[{...row,bed_number:"12床"}]};
  assert.equal(readWardRoster(roster,scope)[0].bed_number,"12");
  const other={...row,patient_id:"p-other",encounter_id:"e-other"};
  assert.throws(()=>readWardRoster({...roster,members:[...roster.members,{...other,bed_number:"12"}]},scope),/BED_UNVERIFIED/);
  assert.equal(readWardRoster({...roster,members:[other]},scope)[0].bed_number,undefined);
  assert.equal(readWardRoster({...roster,members:[{...row,bed_number:7}]},scope)[0].bed_number,"7");
  assert.throws(()=>readWardRoster({...roster,members:[{...row,bed_number:"０７床"},{...other,bed_number:7}]},scope),/BED_UNVERIFIED/);
});

test("no FHIR mutation surface and no managed model route to remote hosts",async()=>{
  for(const key of ["create_resource","update_resource"]) {
    assert.equal(Object.hasOwn(HANDLERS,key),false);assert.ok(!TOOLS.some(tool=>tool.name===key));
  }
  assert.equal(fhir.fhirWrite,undefined);
  const config={model_id:"qwen-fixture",model_version:"local-v1",prompt_pack_version:"v1",endpoint:"http://127.0.0.1/v1"};
  for(const endpoint of ["https://public.example/v1","https://10.0.0.2.example.org/v1","https://localhost@public.example/v1"]) assert.equal(validateLlmConfig({...config,endpoint}).ok,false);
  assert.equal(validateLlmConfig({...config,topology:"B",desensitization_attestation:true}).ok,false);
  const original=globalThis.fetch;let sent;
  try{
    globalThis.fetch=async (url,opts)=>{sent={url:url.href,opts};return Response.json({choices:[{message:{content:"合成"}}]});};
    assert.equal((await createLlmInferenceClient({config}).extract({text:"合成输入"})).text,"合成");
    assert.equal(sent.url,"http://127.0.0.1/v1/chat/completions");assert.equal(sent.opts.redirect,"error");
  } finally{globalThis.fetch=original;}
});

test("local adjudicated-span scorer has five denominators, and exports only counts",async()=>{
  const expected=[["患者胸痛","positive"],["否认胸痛","negative"],["胸痛待查","uncertain"],["胸痛尚待评估","not_evaluated"],["病历中未描述胸痛","not_mentioned"]];
  const cohort={data_class:"synthetic",tenant_id:identity.tenant_id,notes:expected.map(([text,presence],i)=>({
    context:{...identity,as_of:cut},source_id:"note-"+i,text,labels:[{start:text.indexOf("胸痛"),end:text.indexOf("胸痛")+2,exact:"胸痛",presence}]}))};
  const scored=await scoreAssertionCohort(cohort);
  assert.equal(scored.evaluated,5);assert.equal(scored.correct,5);assert.equal(scored.clinical_evidence_pass,false);
  assert.ok(Object.values(scored.per_class).every(c=>c.support===1));assert.doesNotMatch(JSON.stringify(scored),/胸痛|fixture/);
  await assert.rejects(scoreAssertionCohort({...cohort,data_class:"site_deidentified"}),/AUTHORIZED_ADJUDICATION_REQUIRED/);
});

test("the research sidebar matches host bed labels to the frozen chart and cutoff without transmitting the census",async()=>{
  const html=readFileSync(new URL("../plugins/medcius/servers/api/src/ui/preround-sidebar.html",import.meta.url),"utf8");
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace("__WARD_MODE__","research").replace("__WARD_ORIGINS__","[]");
  const window={addEventListener(){}};window.parent=window;
  const sandbox=vm.createContext({window,document:{getElementById:()=>({})},location:{origin:"https://research.test"},
    TextEncoder,crypto:webcrypto,fetch(){throw new Error("UNEXPECTED_CENSUS_TRANSFER");}});
  vm.runInContext(script,sandbox);
  const binding=sha256Hex(canonicalJson(["medcius.ward-bed.v1",identity.tenant_id,identity.patient_id,identity.encounter_id,cut,"07"]));
  sandbox.view={as_of:cut,entries:[{position:3,bed_binding_sha256:binding}]};
  const matched=async(row,tenant_id=identity.tenant_id)=>{
    sandbox.launchCtx={tenant_id,roster:[row]};return await vm.runInContext("verifiedBeds(view,launchCtx)",sandbox);
  };
  assert.equal((await matched({...identity,bed_number:"０７床"})).get(3),"07");
  for(const change of [{bed_number:"09"},{encounter_id:"another"},{patient_id:"another"}])
    assert.equal((await matched({...identity,bed_number:"07",...change})).size,0);
  assert.equal((await matched({...identity,bed_number:"07"},"another-tenant")).size,0);
  sandbox.view.as_of=late;assert.equal((await matched({...identity,bed_number:"07"})).size,0);
});

test("sidebar opens the cached roster, drills into source evidence and cancels stale patient contexts",async()=>{
  class Element {
    constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.textContent="";}
    appendChild(el){this.children.push(el);return el;}append(...els){this.children.push(...els);}
    replaceChildren(){this.children=[];this.textContent="";}setAttribute(k,v){this.attrs[k]=v;}
  }
  const els=new Map(), sent=[], calls=[], listeners={};
  const document={getElementById(id){if(!els.has(id))els.set(id,new Element("div"));return els.get(id);},
    createElement:t=>new Element(t),createTextNode:t=>Object.assign(new Element("text"),{textContent:t})};
  const parent={postMessage:(payload,target)=>sent.push({payload,target})};
  const window={parent,addEventListener:(type,fn)=>listeners[type]=fn};
  let delayed, stall=false, copied;
  const fetch=async(path,opts)=>{
    calls.push(path);let model;
    if(path.endsWith("/patient")) model=syntheticWardView(null,JSON.parse(opts.body));
    else {const pos=new URL(path,"https://mock.test").searchParams.get("position");model=syntheticWardView(pos==null?null:Number(pos));}
    if (model && path.endsWith("/ward-preround")) model = { ...model, audit_recorded_before_deadline: false };
    if(stall)await new Promise(resolve=>{delayed=resolve;});
    return {ok:!!model,status:model?200:404,json:async()=>model};
  };
  const html=readFileSync(new URL("../plugins/medcius/servers/api/src/ui/preround-sidebar.html",import.meta.url),"utf8");
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace("__WARD_MODE__","synthetic").replace("__WARD_ORIGINS__",'["https://emr.test"]');
  vm.runInNewContext(script,{window,location:{origin:"https://sidebar.test"},document,fetch,navigator:{clipboard:{writeText:async text=>{copied=text;}}}});
  const flush=()=>new Promise(r=>setImmediate(r));await flush();
  const flat=el=>[el,...el.children.flatMap(flat)];
  assert.equal(els.get("beds").children.length,syntheticWardView().entries.length);
  assert.match(els.get("status").textContent, /审计索引未在 07:00 前写入/);
  assert.ok(flat(els.get("row")).some(e=>e.tag==="details"));assert.ok(calls.every(p=>!p.includes("evolution-summary")));
  const context=syntheticWardView(1).entries[0].context;
  function emit(type,payload,origin="https://emr.test"){listeners.message({source:parent,origin,data:{type,payload}});}
  emit("his:patient-context",{...context,supports_source_task_review:true,template_fields:{changes:{id:"progress.changes",label:"本院病情变化"}}});await flush();
  const button=t=>flat(els.get("row")).find(e=>e.tag==="button" && e.textContent===t);
  await button("复制核实段落").onclick();assert.match(copied,/本院病情变化/);
  button("交给宿主预览草稿").onclick();
  assert.equal(sent.at(-1).target,"https://emr.test");assert.equal(sent.at(-1).payload.fields[0].field_id,"progress.changes");
  button("在院内任务中核对").onclick();
  assert.equal(sent.at(-1).payload.type,"medcius:open-source-task");
  assert.equal(sent.at(-1).payload.encounter_id,context.encounter_id);
  await els.get("beds").children[1].onclick();
  assert.equal(button("复制核实段落"),undefined);
  assert.equal(button("在院内任务中核对"),undefined);
  emit("his:patient-context",context);await flush();
  const count=calls.length;emit("his:context-cleared",{},"https://untrusted.test");assert.equal(calls.length,count);assert.ok(button("复制核实段落"));
  stall=true;const old=els.get("beds").children[0].onclick();emit("his:context-cleared",{});delayed();await old;
  assert.equal(els.get("row").children.length,0);assert.ok(!sent.some(x=>x.target==="*"));
});
