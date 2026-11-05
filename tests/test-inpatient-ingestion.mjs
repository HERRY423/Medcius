// Synthetic engineering contracts only; no hospital or clinical acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCdaDocumentConnector, flattenDocumentToText } from '../plugins/medcius/lib/connectors/cda-document-connector.mjs';
import { HospitalDataAdapter } from '../plugins/medcius/lib/hospital-data-adapter.mjs';
import { parseCnCdaR2, WST500_DOCUMENT_KINDS } from '../plugins/medcius/lib/connectors/cn-cda-r2.mjs';
import { parseBoundedXml } from '../plugins/medcius/lib/connectors/bounded-xml.mjs';
import { normalizeOrderExecution, transitionOrderState } from '../plugins/medcius/lib/order-execution.mjs';
import { splitImagingReport, createPacsViewerLink } from '../plugins/medcius/lib/imaging-report.mjs';
import { createMappedViewConnectors, validateSiteViewMapping } from '../plugins/medcius/lib/connectors/site-view-mapping.mjs';
import { createViewDbConnector } from '../plugins/medcius/lib/connectors/viewdb-connector.mjs';
import { createViewLibraryConnectors } from '../plugins/medcius/lib/connectors/view-library-connector.mjs';
import { PatientEvolutionEngine } from '../plugins/medcius/lib/patient-evolution-engine.mjs';
import { HospitalAgentAdapter, getPreRoundResearchSnapshot, replayPreRoundResearchSnapshot } from '../plugins/medcius/lib/hospital-agent-adapter.mjs';
import { resolveRecordVersions } from '../plugins/medcius/lib/record-lifecycle.mjs';
import { readFileSync } from 'node:fs';
import { createSiteBridge } from '../plugins/medcius/lib/connectors/site-connector-factory.mjs';

const context = { tenant_id: 'synthetic-site', patient_id: 'synthetic-patient', encounter_id: 'synthetic-encounter', doctor_id: 'synthetic-clinician' };
const now = '2026-11-02T09:00:00Z', cutoffTime = '2026-11-01T09:00:00Z';
function cda(patient = context.patient_id) {
  return `<ClinicalDocument xmlns="urn:hl7-org:v3"><id root="1.2.3" extension="doc-1"/><code code="LOCAL-ADMISSION" codeSystem="1.2.4"/><recordTarget><patientRole><id root="1.2.5" extension="${patient}"/></patientRole></recordTarget><componentOf><encompassingEncounter><id root="1.2.6" extension="${context.encounter_id}"/></encompassingEncounter></componentOf><component><structuredBody><component><section><title>现病史</title><text><paragraph>胸闷，无发热。</paragraph></text></section></component></structuredBody></component></ClinicalDocument>`;
}

test('CDA source patient mismatch is rejected even when the catalog claims the requested patient', async () => {
  const connector = createCdaDocumentConnector({ fixedTenantId: context.tenant_id,
    listDocuments: async () => [{ id: 'doc-1', patient_id: context.patient_id, encounter_id: context.encounter_id }],
    loadDocument: async () => cda('another-patient') });
  await assert.rejects(connector.readPatient(context), /PATIENT_MISMATCH/);
});

test('CDA entity declarations and external markup are rejected rather than flattened', () => {
  assert.throws(() => flattenDocumentToText('<!DOCTYPE ClinicalDocument [<!ENTITY x SYSTEM "file:///private">]><ClinicalDocument><text>&x;</text></ClinicalDocument>'), /XML|CDA/);
});

test('PACS findings never become a diagnostic impression through fallback', () => {
  const r = HospitalDataAdapter.normalizePacsFeed([{ id: 'pacs-1', status: 'final', study_time: now, findings: '右肺见片状影。' }], { now, cutoffTime });
  assert.equal(r.diagnostic_reports[0].impression, null);
  assert.equal(r.diagnostic_reports[0].findings, '右肺见片状影。');
  assert.equal(r.imaging_impressions.length, 0);
});

test('planned infusion and an unverified execution record cannot contribute to actual fluid intake', () => {
  const r = HospitalDataAdapter.normalizeNisFeed([
    { id: 'planned', timestamp: now, record_kind: 'order', execution_status: 'ordered', iv_intake_ml: 500 },
    { id: 'pending', timestamp: now, record_kind: 'administration', execution_status: 'nurse_unverified', iv_intake_ml: 300 },
    { id: 'measured', timestamp: now, record_kind: 'nursing_measurement', iv_intake_ml: 100 }
  ], { now, cutoffTime });
  assert.equal(r.fluid_balance.intake_total_ml, 100);
});

test('a nurse-unverified or pharmacy-returned order cannot trigger an elapsed active-order alert', () => {
  const rulePack = { clinical_rules: { restricted_antibiotics: [{ name: '合成抗菌药', review_after_days: 1, level: '合成' }] } };
  const orders = ['nurse_unverified', 'pharmacy_returned'].map((execution_status,i) => ({
    id: `order-${i}`, drug_name: '合成抗菌药', status: 'active', execution_status, authored_on: '2026-10-20T00:00:00Z' }));
  assert.equal(HospitalDataAdapter.normalizeHisOrders(orders, { now, rulePack }).antibiotic_alerts.length, 0);
});

test('CDA namespace prefixes, section order and original XML locations survive structural extraction', () => {
  const xml = cda().replace(' xmlns="urn:hl7-org:v3"', ' xmlns:c="urn:hl7-org:v3"').replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)/g, '<$1c:$2');
  const p = parseCnCdaR2(xml);
  assert.equal(p.patient_id, context.patient_id); assert.equal(p.encounter_id, context.encounter_id);
  assert.match(p.text, /^现病史：\n胸闷，无发热。$/);
  assert.equal(xml.slice(p.sections[0].xml_start, p.sections[0].xml_end), '<c:text><c:paragraph>胸闷，无发热。</c:paragraph></c:text>');
  assert.equal(p.conformance_status, 'NOT_XSD_OR_SCHEMATRON_VALIDATED');
});

test('a local C-code does not acquire a national document type by looking like a standard part number', () => {
  const xml = cda().replace('LOCAL-ADMISSION', 'C0037');
  assert.equal(parseCnCdaR2(xml).document_kind, 'unknown');
  const p = parseCnCdaR2(xml, { profiles: [{ code: 'C0037', code_system: '1.2.4', wst_part: 38, mapping_ref: 'synthetic-map-v1' }] });
  assert.equal(p.document_kind, 'daily_progress'); assert.equal(p.wst_part, 38);
  assert.equal(WST500_DOCUMENT_KINDS[37], 'first_progress');
  assert.equal(WST500_DOCUMENT_KINDS[41], 'handover'); assert.equal(WST500_DOCUMENT_KINDS[53], 'discharge_summary');
  assert.equal(parseCnCdaR2(xml.replace('codeSystem="1.2.4"','codeSystem="9.9"'), { profiles: [{ code:'C0037', code_system:'1.2.4', wst_part:38, mapping_ref:'map' }] }).document_kind,'unknown');
});

test('CDA absent/ambiguous identity, wrong structure and section subject overrides fail closed', () => {
  const invalid = [cda().replace('<id root="1.2.5" extension="synthetic-patient"/>',''),
    cda().replace('<patientRole>', '<patientRole><id root="9.8" extension="other"/>'),
    cda().replace('</recordTarget>', '</recordTarget><recordTarget><patientRole/></recordTarget>'),
    cda().replace('<section>','<section><subject/>'), cda().replace('urn:hl7-org:v3','urn:wrong'),
    cda().replace('</section></component>', '</section>')];
  for (const xml of invalid) assert.throws(() => parseCnCdaR2(xml), /CONNECTOR_(CDA|XML)_/);
  assert.equal(parseCnCdaR2(invalid[1], { patientIdRoot: '1.2.5' }).patient_id, context.patient_id);
});

test('CDA XML rejects entities, processing instructions, XInclude and bounded-input violations', () => {
  for (const xml of ['<text>&notDeclared;</text>', '<text>&#0;</text>', '<text><x:a/></text>',
    '<text a="1" a="2"/>', '<text><constructor:a/></text>', '<text><?fetch remote?></text>',
    '<text xmlns:x="http://www.w3.org/2001/XInclude"><x:include/></text>', '<text><script>unsafe</script></text>']) {
    assert.throws(() => flattenDocumentToText(xml), /CONNECTOR_XML_/);
  }
  assert.throws(() => parseBoundedXml('<a><b><c/></b></a>', { maxDepth:2 }), /LIMIT/);
  assert.throws(() => parseBoundedXml('<a>超长</a>', { maxBytes:3 }), /SIZE_LIMIT/);
  assert.throws(() => flattenDocumentToText('<text>abcdef</text>', { maxChars:2 }), /NARRATIVE_LIMIT/);
  assert.equal(flattenDocumentToText('<text>A &amp; B <content>保持</content>顺序</text>'),'A & B 保持顺序');
});

test('CDA timestamps need source precision and timezone, never fetch-time substitution', () => {
  const xml = time => cda().replace('<code ', `<effectiveTime value="${time}"/><code `);
  assert.equal(parseCnCdaR2(xml('20261102')).effective_time,null);
  assert.equal(parseCnCdaR2(xml('20261102120000')).effective_time,null);
  assert.equal(parseCnCdaR2(xml('20261102120000'), { timezoneOffset:'+08:00' }).effective_time,'2026-11-02T12:00:00+08:00');
  assert.equal(parseCnCdaR2(xml('20260230120000+0800')).effective_time,null);
});

test('CDA catalog completeness, ID/version conflicts and duplicate pages are explicit', async () => {
  const make = (catalog, xml = cda()) => createCdaDocumentConnector({ fixedTenantId:context.tenant_id,
    listDocuments:async()=>catalog,loadDocument:async()=>xml });
  assert.equal((await make([{id:'doc-1'}]).readPatient(context)).complete,false);
  assert.equal((await make({documents:[{id:'doc-1'}],complete:true}).readPatient(context)).complete,true);
  await assert.rejects(make([{id:'wrong'}]).readPatient(context), /DOCUMENT_ID_MISMATCH/);
  await assert.rejects(make([{id:'doc-1',version_id:'2'}],cda().replace('<code ','<versionNumber value="3"/><code ')).readPatient(context), /VERSION_MISMATCH/);
  await assert.rejects(make([{id:'doc-1'},{id:'doc-1'}]).readPatient(context), /DOCUMENT_DUPLICATE/);
  await assert.rejects(make([]).readPatient({...context,tenant_id:'other'}), /TENANT_MISMATCH/);
});

test('timed-out CDA reads retain backpressure, abort sources and never load subsequent documents', async () => {
  let release, loads=0, signal;
  const c = createCdaDocumentConnector({fixedTenantId:context.tenant_id,timeoutMs:8,maxConcurrency:1,
    listDocuments:async(_c,io)=>{signal=io.signal; await new Promise(r=>release=r);return [{id:'doc-1'}];},
    loadDocument:async()=>{loads++;return cda();}});
  await assert.rejects(c.readPatient(context), /TIMEOUT/);
  assert.equal(signal.aborted,true); await assert.rejects(c.readPatient(context), /CONCURRENCY_LIMIT/);
  release(); await new Promise(r=>setTimeout(r,2)); assert.equal(loads,0);
});

test('CDA callback errors cannot leak source response bodies', async () => {
  const c=createCdaDocumentConnector({fixedTenantId:context.tenant_id,listDocuments:async()=>{throw new Error('private payload');},loadDocument:async()=>''});
  await assert.rejects(c.readPatient(context),e=>e.message==='CONNECTOR_CDA_CATALOG_READ_FAILED');
});

const order = { id:'order-1', ...context, order_kind:'long_term', execution_status:'stopped', drug_name:'合成药', status:'stopped' };
const admin = (id,performed_at,extra={}) => ({ id,order_id:order.id,execution_status:'administered',status:'final',performed_at,...extra });
test('only dated administration events count observed days; stopping an order preserves executed history', () => {
  const a=admin('a','2026-11-01T16:30:00Z'), b=admin('b','2026-11-02T03:00:00Z');
  const result=normalizeOrderExecution({...order,administrations:[a,a,b,admin('pending',now,{execution_status:'dispensed'}),admin('future','2026-11-03T01:00:00Z')]},{now,timezoneOffset:'+08:00'});
  assert.equal(result.administrations.length,2); assert.equal(result.observed_administration_days,1);
  assert.deepEqual(result.administration_dates,['2026-11-02']); assert.equal(result.treatment_duration_days,null);
  assert.equal(result.administration_coverage,'unknown'); assert.equal(result.eligible_for_order_age_review,false);
  assert.equal(normalizeOrderExecution({...order,administrations:[a]},{now}).observed_administration_days,null);
});

test('cancelled or conflicting execution versions cannot inflate administered days', () => {
  const original=admin('a','2026-11-01T03:00:00Z',{version_id:'1',updated_at:'2026-11-01T04:00:00Z',administered_volume_ml:100});
  const cancelled={...original,version_id:'2',updated_at:now,status:'entered-in-error'};
  assert.equal(normalizeOrderExecution({...order,administrations:[original,cancelled]},{now}).administrations.length,0);
  const conflict={...original,administered_volume_ml:300};
  const r=normalizeOrderExecution({...order,administrations:[original,conflict]},{now});
  assert.equal(r.administrations.length,0); assert.ok(r.gaps.includes('ADMINISTRATION_VERSION_CONFLICT'));
});

test('execution references reject cross-patient data and do not attach another order or undated event', () => {
  assert.throws(()=>normalizeOrderExecution({...order,administrations:[admin('a',now,{patient_id:'other'})]},{now}),/IDENTITY_MISMATCH/);
  const r=normalizeOrderExecution({...order,administrations:[admin('a',now,{order_id:'other'}),admin('b','2026-11-02')]},{now});
  assert.equal(r.administrations.length,0); assert.equal(r.gaps.length,2);
});

test('order kinds, source transitions and unknown numeric workflow codes never imply administration', () => {
  assert.equal(normalizeOrderExecution({...order,order_kind:'temporary'},{now}).order_kind,'temporary');
  assert.equal(normalizeOrderExecution({...order,order_kind:'1',execution_status:'7'},{now}).execution_status,'unknown');
  assert.equal(transitionOrderState('nurse_verified','pharmacy_returned'),'pharmacy_returned');
  assert.equal(transitionOrderState('stopped','administered'),'unknown');
  const r=normalizeOrderExecution({...order,previous_execution_status:'stopped',execution_status:'dispensed'},{now});
  assert.equal(r.eligible_for_order_age_review,false); assert.equal(r.execution_status,'unknown');
});

test('flat read-only MAR rows attach to the exact order while orphan events stay separate', () => {
  const r=HospitalDataAdapter.normalizeHisOrders([order,{...admin('a',now),record_kind:'administration'},
    {...admin('b',now,{order_id:'unavailable-order'}),record_kind:'administration'}],{now,timezoneOffset:'+08:00'});
  assert.equal(r.medications.length,1); assert.equal(r.orders.length,0);
  assert.equal(r.medications[0].administrations.length,1); assert.equal(r.orphan_administration_count,1);
});

test('planned-only fluids stay unknown, zero measured fluids stay zero and negative volumes are excluded', () => {
  const data=[{id:'p',timestamp:now,record_kind:'planned_infusion',iv_intake_ml:500}];
  assert.equal(HospitalDataAdapter.normalizeNisFeed(data,{now,cutoffTime}).fluid_balance,null);
  const r=HospitalDataAdapter.normalizeNisFeed([...data,{id:'z',timestamp:now,iv_intake_ml:0,urine_output_ml:-3}],{now,cutoffTime});
  assert.equal(r.fluid_balance.intake_total_ml,0); assert.equal(r.fluid_balance.output_total_ml,null);
  assert.equal(r.excluded_unexecuted_count,1);
});

test('a dated and order-bound nursing execution counts once, while missing time and missing linkage stay excluded', () => {
  const executed={id:'executed',order_id:'order-1',record_kind:'administration',execution_status:'administered',
    performed_at:now,iv_intake_ml:120};
  const r=HospitalDataAdapter.normalizeNisFeed([executed,executed,
    {...executed,id:'undated',performed_at:null},{...executed,id:'unlinked',order_id:null}],{now,cutoffTime});
  assert.equal(r.fluid_balance.intake_total_ml,120);
  assert.equal(r.excluded_unexecuted_count,1);assert.equal(r.discarded_outside_window_count,1);
});

test('imaging section parsing preserves negative findings, subjective impression and unclassified text', () => {
  const r=splitImagingReport({report_text:'检查方法：合成\n影像所见：右肺见片影，未见胸水。\n影像诊断：请结合临床。'});
  assert.equal(r.findings,'右肺见片影，未见胸水。'); assert.equal(r.impression,'请结合临床。');
  assert.equal(r.unclassified_text,'检查方法：合成');
  assert.equal(splitImagingReport({report_text:'肺部感染可能。'}).impression,null);
  assert.equal(splitImagingReport({impression:'字段结论',report_text:'结论：不同原文'}).unclassified_text,'结论：不同原文');
});

const profile={tenant_id:context.tenant_id,mapping_ref:'synthetic-viewer-v1',origin:'https://pacs.example.invalid',path:'/viewer',study_parameter:'studyUID'};
const imaging={id:'image-1',...context,study_uid:'1.2.840.10008.123',status:'final',study_time:now,name:'合成检查',modality:'CT',findings:'未见胸水。'};
test('PACS links require site/study identity and a trusted HTTPS profile; source URLs are ignored', () => {
  const r=createPacsViewerLink({...imaging,viewer_url:'javascript:unsafe'},context,profile);
  assert.equal(r.available,true); assert.equal(new URL(r.href).origin,profile.origin);
  assert.equal(new URL(r.href).searchParams.get('mode'),'readonly'); assert.doesNotMatch(r.href,/synthetic-patient|token|unsafe/);
  for (const patch of [{origin:'http://pacs.local'},{origin:'https://user:secret@pacs.local'},{path:'//evil.example'},{study_parameter:'token&x'},{tenant_id:'other'}])
    assert.equal(createPacsViewerLink(imaging,context,{...profile,...patch}).available,false);
  assert.equal(createPacsViewerLink({...imaging,patient_id:'other'},context,profile).available,false);
  assert.equal(createPacsViewerLink({...imaging,study_uid:'1.2&token=x'},context,profile).available,false);
});

test('findings-only reports reach the patient card with their own evidence, never an invented impression', () => {
  const r=PatientEvolutionEngine.analyzePatientEvolution({patient:{id:context.patient_id},context,pacsFeed:[imaging],pacsViewerProfile:profile,now});
  const changes=r.blocks.what_changed;
  assert.equal(changes.imaging_impressions.length,0); assert.equal(changes.imaging_changes.length,1);
  assert.equal(changes.imaging_changes[0].impression,null); assert.equal(changes.imaging_changes[0].viewer.available,true);
  assert.ok(r.blocks.evidence.some(e=>e.item_id===changes.imaging_changes[0].id));
});

test('PACS findings revisions and unknown combined text cannot collapse into identical versions', () => {
  const changed={...imaging,findings:'可见少量胸水。'};
  assert.equal(resolveRecordVersions([imaging,changed],{sourceType:'diagnostic_report',now}).current_records.length,0);
  const raw={...imaging,findings:null,report_text:'所见：未见胸水。\n印象：请结合临床。'};
  const normalized=HospitalDataAdapter.normalizePacsFeed([raw],{now,cutoffTime}).diagnostic_reports[0];
  assert.equal(resolveRecordVersions([raw,normalized],{sourceType:'diagnostic_report',now}).current_records.length,1);
});

test('guarded host snapshots replay the exact imaging card and deployment viewer configuration', () => {
  const r=HospitalAgentAdapter.executePreRoundWorkflow({host:'his_embed',context:{...context,as_of:now},
    dataFeeds:{patient:{id:context.patient_id},pacs:[imaging]},pacsViewerProfile:profile});
  const snapshot=getPreRoundResearchSnapshot(r);
  assert.deepEqual(replayPreRoundResearchSnapshot(snapshot.replayInput),r.summary);
});

const mappingFixture=JSON.parse(readFileSync(new URL('../plugins/medcius/config/site-mappings/synthetic-cn-views.v1.json',import.meta.url),'utf8'));
function onlyMapping(id='cn_orders') { const m=structuredClone(mappingFixture);m.views=m.views.filter(v=>v.id===id);return m; }
const mappedRow={RECORD_ID:'row-1',PATIENT_ID:context.patient_id,VISIT_ID:context.encounter_id,SITE_ID:context.tenant_id,
  ROW_KIND:'ORDER',DRUG_NAME:'合成药',ORDER_STATUS:'ACTIVE',ORDER_KIND:'LONG',EXEC_STATE:'UNVERIFIED',ORDER_TIME:'2026-11-02 10:00:00',DOSE_TEXT:'计划500ml'};
test('site mapping compiles parameterized views, state semantics, explicit timezone and column provenance', async () => {
  let sql,params;
  const [c]=createMappedViewConnectors({mapping:onlyMapping(),fixedTenantId:context.tenant_id,dialect:'sqlserver',
    query:async(s,p)=>{sql=s;params=p;return [{...mappedRow,PRIVATE_UNMAPPED:'do not release'}];}});
  const r=await c.readPatient(context), record=r.records[0];
  assert.match(sql,/SELECT TOP/); assert.ok(params.includes(context.patient_id)); assert.doesNotMatch(sql,/synthetic-patient|PRIVATE_UNMAPPED/);
  assert.equal(record.order_kind,'long_term'); assert.equal(record.execution_status,'nurse_unverified');
  assert.equal(record.authored_on,'2026-11-02T10:00:00+08:00'); assert.equal(record.mapping_provenance.fields.find(f=>f.field==='authored_on').column,'ORDER_TIME');
  assert.doesNotMatch(JSON.stringify(record),/do not release/); assert.equal(r.complete,true);
});

test('unmapped state and invalid timestamps degrade completeness rather than becoming active execution', async () => {
  const [c]=createMappedViewConnectors({mapping:onlyMapping(),fixedTenantId:context.tenant_id,
    query:async()=>[{...mappedRow,EXEC_STATE:'999',ORDER_TIME:'2026-02-30 12:00:00'}]});
  const r=await c.readPatient(context);
  assert.equal(r.complete,false); assert.equal(r.records[0].execution_status,'unknown');
  assert.equal(r.records[0].authored_on,null); assert.equal(r.parse_warnings.length,2);
  assert.equal(normalizeOrderExecution(r.records[0],{now}).eligible_for_order_age_review,false);
});

test('mapping rejects expressions, unsafe identifiers, unsupported YAML, implicit timezones and wrong source identity', async () => {
  for (const mutate of [m=>m.views[0].table='v; DROP TABLE x',m=>m.views[0].fields.id.expression='unsafe()',
    m=>delete m.timezone_offset,m=>m.views[0].scope='patient',m=>m.views[0].fields.execution_status.type='string']) {
    const m=onlyMapping(); mutate(m); assert.throws(()=>validateSiteViewMapping(m),/MAPPING_/);
  }
  assert.throws(()=>validateSiteViewMapping('key: !!js/function unsafe'),/JSON_YAML_SUBSET_REQUIRED/);
  const [c]=createMappedViewConnectors({mapping:onlyMapping(),fixedTenantId:context.tenant_id,query:async()=>[{...mappedRow,PATIENT_ID:'other'}]});
  await assert.rejects(c.readPatient(context),/PATIENT_MISMATCH/);
});

test('live mapping activation needs a deployment verifier bound to the complete mapping digest', () => {
  const m=onlyMapping(); const opts={mapping:m,query:async()=>[],fixedTenantId:context.tenant_id,live:true};
  assert.throws(()=>createMappedViewConnectors(opts),/SITE_APPROVAL_REQUIRED/);
  m.data_class='site';m.review_ref='site-review-v1';
  assert.throws(()=>createMappedViewConnectors(opts),/SITE_APPROVAL_REQUIRED/);
  let digest;
  createMappedViewConnectors({...opts,mappingApprovalVerifier:input=>{digest=input.sha256;return true;}});
  assert.match(digest,/^[a-f0-9]{64}$/);
  m.views[0].fields.execution_status.values.UNVERIFIED='administered';
  assert.throws(()=>createMappedViewConnectors({...opts,mappingApprovalVerifier:input=>input.sha256===digest}),/SITE_APPROVAL_REQUIRED/);
});

test('Dameng and both explicit OceanBase modes build bounded SELECTs without claiming driver acceptance', async () => {
  for (const dialect of ['dameng','oceanbase-mysql','oceanbase-oracle']) {
    let captured;
    const c=createViewDbConnector({id:'dialect',kind:'nis',table:'V_NIS',columns:['id'],dialect,
      query:async(sql,params,options)=>{captured={sql,params,options};return [];}});
    await c.readPatient(context);
    assert.match(captured.sql,dialect==='oceanbase-mysql'?/LIMIT \?/:/FETCH FIRST/);
    assert.equal(captured.options.readOnly,true); assert.ok(captured.params.includes(context.patient_id));
  }
});

test('hybrid site joins guarded CDA and mapped views without requiring an intermediate FHIR service', async () => {
  const activation={hospital_id:'synthetic-hospital',tenant_id:context.tenant_id,ward_id:'synthetic-ward',irb_protocol_id:'synthetic-only',
    data_agreement_sha256:'a'.repeat(64),clinical_surface:'his_embed',governance_stage:'silent_pilot',
    readonly_account:{username:'synthetic-reader',capabilities:['read'],system:'hybrid'}};
  const query=async sql=>{
    if(sql.includes('FROM V_PATIENT ')) return [{...mappedRow,RECORD_ID:context.patient_id,PATIENT_NAME:'合成患者',SEX:'U'}];
    if(sql.includes('FROM V_INPATIENT_VISIT ')) return [{...mappedRow,RECORD_ID:context.encounter_id,VISIT_STATUS:'IN',ADMITTED_AT:'2026-11-01 00:00:00'}];
    if(sql.includes('FROM V_HIS_INPATIENT_ORDER ')) return [mappedRow];
    return [];
  };
  const deps={channel:'hybrid',salt:'synthetic-test-guard-salt',sources:[{channel:'viewdb',bindings:{mapping:mappingFixture,query}},
    {channel:'cda',bindings:{listDocuments:async()=>({documents:[{id:'doc-1'}],complete:true}),loadDocument:async()=>cda()}}]};
  const {bridge,connectors}=createSiteBridge(activation,deps);
  const snapshot=await bridge.readPatientSnapshot(context);
  assert.equal(snapshot.dataFeeds.notes.length,1);assert.equal(snapshot.dataFeeds.his_orders[0].execution_status,'nurse_unverified');
  assert.equal(snapshot.dataFeeds.notes[0].ownership_status,'verified');
  assert.equal((await connectors[0].readPatient(context)).phi_exit_guard.applied,true);
  assert.throws(()=>createSiteBridge(activation,{...deps,sources:[deps.sources[1]]}),/REQUIRED_KIND_UNCOVERED/);
  assert.throws(()=>createSiteBridge(activation,{...deps,sources:[...deps.sources,deps.sources[1]]}),/DUPLICATE_CONNECTOR/);
});

test('current order cards explicitly expose temporary and unverified order state without claiming dosing', () => {
  const r=PatientEvolutionEngine.analyzePatientEvolution({patient:{id:context.patient_id},context,now,
    medications:[{...order,status:'active',authored_on:now,execution_status:'nurse_unverified',order_kind:'temporary'}]});
  const item=r.blocks.what_changed.medication_diff.added[0];
  assert.equal(item.change_type,'新增医嘱');assert.match(item.summary,/临时医嘱；护士未核对/);
  assert.equal(item.administration_records.length,0);
});
