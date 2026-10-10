// Offline synthetic walkthrough using the actual workstation, without hospital credentials.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PatientEvolutionEngine as Evolution } from '../plugins/medcius/lib/patient-evolution-engine.mjs';
import { ConsultPreparationEngine as Consult } from '../plugins/medcius/lib/consult-preparation-engine.mjs';
import { ShiftHandoverEngine as Handover } from '../plugins/medcius/lib/shift-handover-engine.mjs';
import { DischargeReadinessEngine as Discharge } from '../plugins/medcius/lib/discharge-readiness-engine.mjs';
import { dischargeFixture, documentHash } from '../tests/fixtures/discharge-documentation.mjs';
const cases={};
for (const bed of ['01床','02床','03床']) {
  const f=dischargeFixture();
  const context={...f.context,patient_id:`synthetic-patient-${bed.slice(0,2)}`,encounter_id:`synthetic-encounter-${bed.slice(0,2)}`};
  const old={id:'synthetic-lab',name:'血钾',code:'k',unit:'mmol/L',value:2.5,is_critical:true,status:'final',version_id:'v1',effective_time:'2026-10-06T07:30:00Z',issued:'2026-10-06T08:00:00Z'};
  const current={...old,value:bed==='02床'?4.1:3,is_critical:bed!=='02床',status:'corrected',version_id:'v2',updated_at:'2026-10-06T09:00:00Z'};
  const source={...f.source,context,patient:{id:context.patient_id,bed_number:bed},encounter:{...f.source.encounter,id:context.encounter_id},observations:[old,current]};
  const snapshot=Consult.createSnapshot(source);
  const extra=Object.fromEntries(Object.entries(f.args).filter(([k])=>k!=='snapshot').map(([k,rows])=>[k,rows.map(r=>({...r,...context}))]));
  extra.medicationTransitions[0].discharge_ref.content_sha256=documentHash(extra.dischargeMedications[0]);
  const outputs={evolution:Evolution.analyzePatientEvolution({patient:source.patient,observations:source.observations,notes:source.notes,diagnosticReports:source.diagnosticReports,medications:source.medications,now:source.asOf,sourceAvailability:source.sourceAvailability}),
    'consult-preparation':Consult.prepareConsultDossier({snapshot,consultRequest:{department:'肾内科',purpose:'核对血钾变化与当前用药',focus_terms:['血钾']}}),
    'shift-handover':Handover.analyzePatientHandover({snapshot,windowStart:'2026-10-06T00:00:00Z'}),
    'discharge-readiness':Discharge.evaluateDischargeReadiness({...extra,snapshot})};
  cases[bed]=Object.fromEntries(Object.entries(outputs).map(([workflow,payload])=>[workflow,{ok:true,data:{workflow,payload,payload_digest:documentHash(payload),patient_context:{patient_id:context.patient_id,encounter_id:context.encounter_id},signable:false}}]));
}
const script=`const previewCases=${JSON.stringify(cases).replaceAll('<','\\u003c')};
window.MEDCIUS_PREVIEW=async(name,request)=>{
  if(!request.demo_ward) throw Error('来源尚未接入，请选择合成示例。');
  if(name==='consult-preparation' && (request.consult_request.department!=='肾内科' || request.consult_request.purpose!=='核对血钾变化与当前用药')) throw Error('来源格式：离线示例仅预置此会诊诉求，请恢复默认内容或在本地接口验证其他诉求。');
  if(name==='evolution' && request.time_window!=='24h') throw Error('来源格式：离线示例仅预置近24小时；其他时间窗需本地接口计算。');
  await new Promise(resolve=>setTimeout(resolve,180));return structuredClone(previewCases[request.bed][name]);
};
function startPreview(){token=null;canSign=false;$('view-login').classList.add('hidden');$('view-app').classList.remove('hidden');$('clinician-info').textContent='合成流程体验';$('ctx-demo').value='demo';$('cs-dept').value='肾内科';$('cs-purpose').value='核对血钾变化与当前用药';$('stage-badge').textContent='离线合成回放';showPatientContext();runWorkflow('evolution',{time_window:'24h'});}
`;
let html=readFileSync(new URL('../plugins/medcius/servers/api/src/ui/workstation.html',import.meta.url),'utf8');
html=html.replace('<script>','<script>\n'+script);
const out=new URL('../out/doctor-workstation/',import.meta.url);mkdirSync(out,{recursive:true});writeFileSync(new URL('synthetic-preview.html',out),html,'utf8');
writeFileSync(new URL('../out/doctor-ui-validation/preview-cases.json',import.meta.url),JSON.stringify(cases,null,2),'utf8');
console.log('Offline doctor workflow preview generated. Synthetic only.');
