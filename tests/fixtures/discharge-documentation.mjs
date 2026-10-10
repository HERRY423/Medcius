import { DischargeReadinessEngine as Engine } from "../../plugins/medcius/lib/discharge-readiness-engine.mjs";
import { canonicalJson, sha256Hex } from "../../plugins/medcius/servers/shared/crypto.mjs";

export const documentHash = record => sha256Hex(canonicalJson(record));
export function dischargeFixture() {
  const context = { tenant_id: "synthetic-hospital", patient_id: "synthetic-patient", encounter_id: "synthetic-encounter" };
  const asOf = "2026-10-06T10:00:00Z";
  const source = { context, asOf, patient: { id: context.patient_id }, encounter: { id: context.encounter_id, class: "IMP", status: "in-progress" },
    medications: [{ id: "inpatient-med", drug_name: "合成药物甲", medication_code: "fictional-a", code_system: "synthetic", dosage: "5 mg", route: "po", frequency: "qd", status: "active", authored_on: "2026-10-06T08:00:00Z" }],
    diagnosticReports: [{ id: "result-1", name: "合成检查报告", status: "final", version_id: "r1", study_time: "2026-10-06T08:00:00Z", issued: "2026-10-06T08:30:00Z", acknowledged: true,
      acknowledged_at: "2026-10-06T09:00:00Z", acknowledged_version_id: "r1", impression: "来源记录的合成描述" }],
    notes: [{ id: "note-1", timestamp: "2026-10-06T08:00:00Z", text: "尚未安排复诊。此合成病历用于验证否定语句不构成预约。" }],
    sourceAvailability: [{ kind: "pacs", status: "available" }, { kind: "his", status: "available" }] };
  const snapshot = Engine.createSnapshot(source);
  const doc = (id, fields = {}) => ({ id, ...context, recorded_at: "2026-10-06T09:30:00Z", author_id: "synthetic-doctor",
    source_reference: { source_system: "synthetic-discharge-service", resource_id: `Document/${id}` }, ...fields });
  const dm = doc("discharge-med", { drug_name: "合成药物甲", medication_code: "fictional-a", code_system: "synthetic", dosage: "5 mg", route: "po", frequency: "qd", duration_or_stop_rule: "按来源合成处方记录的期限核对", status: "draft" });
  const inpatient = snapshot.records.medications[0].evidence, result = snapshot.records.diagnosticReports[0].evidence;
  const ref = evidence => ({ source_id: evidence.source_id, content_sha256: evidence.content_sha256 });
  const args = { snapshot, dischargeMedications: [dm], medicationTransitions: [doc("transition-1", { action: "continue", inpatient_ref: ref(inpatient), discharge_ref: { source_id: dm.id, content_sha256: documentHash(dm) } })],
    followUpPlans: [doc("followup-1", { purpose: "核对来源检查资料", scheduled_at: "2026-10-13T09:00:00Z", destination: "合成专科门诊", responsible_party: "synthetic-followup-team",
      contact_route: "来源指定的院内联络渠道", arrangement_status: "booked", appointment_reference: "Appointment/synthetic-1", target_ref: ref(result) })],
    patientInstructions: [doc("instruction-1", { text: "请按原始说明核对就诊材料；有疑问通过来源列明渠道联系。", instruction_type: "source_patient_instructions" })] };
  return { context, asOf, source, snapshot, doc, args };
}
