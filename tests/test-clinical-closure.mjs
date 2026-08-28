import assert from "node:assert/strict";
import { HospitalDataAdapter } from "../plugins/medcius/lib/hospital-data-adapter.mjs";
import { trackHighRiskFollowup } from "../plugins/medcius/lib/high-risk-followup-tracker.mjs";
import { loadSpecialtyRulePack, validateSpecialtyRulePack } from "../plugins/medcius/lib/specialty-rule-pack.mjs";
import { ReadOnlyHospitalDataBridge } from "../plugins/medcius/lib/read-only-hospital-data-bridge.mjs";
import { HospitalAgentAdapter } from "../plugins/medcius/lib/hospital-agent-adapter.mjs";

console.log("== Testing clinical follow-up closure, external rule packs, and read-only bridge ==");

const samplePack = loadSpecialtyRulePack("cardiology-inpatient-sandbox");
assert.equal(validateSpecialtyRulePack(samplePack).ok, true);
assert.equal(validateSpecialtyRulePack(samplePack, { production: true }).ok, false, "sample rule pack must fail production validation");
assert.throws(() => loadSpecialtyRulePack("../cardiology-inpatient-sandbox"), /RULE_PACK_INVALID_ID/);

const thresholdOnlyLab = [{ id: "lab-k", code: "k", value: 2.4, unit: "mmol/L", sample_time: "2026-08-25T06:00:00Z" }];
assert.equal(HospitalDataAdapter.normalizeLisFeed(thresholdOnlyLab).critical_values.length, 0, "no universal threshold without an explicit rule pack or LIS flag");
assert.equal(HospitalDataAdapter.normalizeLisFeed(thresholdOnlyLab, { rulePack: samplePack }).critical_values.length, 1);

const followup = trackHighRiskFollowup({
  orders: [
    { id: "ord-echo-1", code: "echo", title: "床旁超声心动图", priority: "urgent", status: "active", authored_on: "2026-08-25T04:00:00Z" },
    { id: "ord-k-1", code: "k", title: "复查血钾", priority: "stat", status: "active", authored_on: "2026-08-25T05:00:00Z" }
  ],
  observations: [
    { id: "obs-k-1", order_id: "ord-k-1", code: "k", name: "血钾", status: "final", is_critical: true, resulted_at: "2026-08-25T05:20:00Z" }
  ],
  diagnosticReports: [
    { id: "rep-echo-1", order_id: "ord-echo-1", code: "echo", name: "床旁超声心动图", priority: "urgent", status: "preliminary", resulted_at: "2026-08-25T05:10:00Z" }
  ],
  rulePack: samplePack,
  now: "2026-08-25T07:00:00Z"
});
const labFollowup = followup.items.find((item) => item.tracking_id.includes("ord-k-1"));
const echoFollowup = followup.items.find((item) => item.tracking_id.includes("ord-echo-1"));
assert.equal(labFollowup.stage, "resulted");
assert.equal(labFollowup.gap, "PENDING_CLINICIAN_ACKNOWLEDGEMENT");
assert.equal(labFollowup.overdue, true);
assert.equal(echoFollowup.stage, "preliminary");
assert.equal(echoFollowup.gap, "PENDING_FINAL_RESULT");

const acknowledged = trackHighRiskFollowup({
  observations: [{ id: "obs-k-2", code: "k", name: "血钾", status: "final", is_critical: true, acknowledged_at: "2026-08-25T06:30:00Z" }],
  now: "2026-08-25T07:00:00Z"
});
assert.equal(acknowledged.rule_status, "source_flags_only");
assert.equal(acknowledged.items[0].stage, "acknowledged");
assert.equal(acknowledged.counts.open, 0);

assert.throws(
  () => new ReadOnlyHospitalDataBridge({ connectors: [{ id: "unsafe-his", kind: "his", capabilities: ["read", "update"], readPatient: async () => ({}), update: async () => ({}) }] }),
  /BRIDGE_READ_ONLY_CAPABILITY_REQUIRED|BRIDGE_WRITE_METHOD_REJECTED/
);
assert.throws(
  () => new ReadOnlyHospitalDataBridge({ connectors: [{ id: "unsafe-order-api", kind: "his", capabilities: ["read"], readPatient: async () => ({}), orderMedication: async () => ({}) }] }),
  /BRIDGE_WRITE_METHOD_REJECTED/
);

const context = {
  tenant_id: "sandbox-hospital",
  doctor_id: "doctor-synthetic-1",
  patient_id: "patient-synthetic-1",
  encounter_id: "encounter-synthetic-1",
  specialty_rule_pack_id: "cardiology-inpatient-sandbox",
  time_window: "24h"
};
const fetchedAt = "2026-08-25T07:00:00Z";
const envelope = (source_system, records) => ({
  source_system,
  tenant_id: context.tenant_id,
  patient_id: context.patient_id,
  encounter_id: context.encounter_id,
  fetched_at: fetchedAt,
  source_version: "sandbox-v1",
  records
});
const bridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient", "encounter", "lis", "his", "financial_access"],
  connectors: [
    { id: "emr-patient", kind: "patient", capabilities: ["read"], readPatient: async () => envelope("emr-patient", [{ id: context.patient_id, name: "Synthetic Patient", age: 60, gender: "male", patient_id: context.patient_id, encounter_id: context.encounter_id }]) },
    { id: "emr-encounter", kind: "encounter", capabilities: ["read"], readPatient: async () => envelope("emr-encounter", [{ id: context.encounter_id, status: "in-progress", patient_id: context.patient_id, encounter_id: context.encounter_id }]) },
    { id: "lis-readonly", kind: "lis", capabilities: ["read"], readPatient: async () => envelope("lis-readonly", [{ id: "lis-k-bridge", order_id: "ord-k-bridge", code: "k", name: "Potassium", value: 2.5, unit: "mmol/L", status: "final", sample_time: "2026-08-25T06:00:00Z", is_critical: true, patient_id: context.patient_id, encounter_id: context.encounter_id }]) },
    { id: "his-readonly", kind: "his", capabilities: ["read"], readPatient: async () => envelope("his-readonly", [{ id: "ord-k-bridge", title: "Repeat potassium", code: "k", order_type: "laboratory", priority: "stat", status: "active", authored_on: "2026-08-25T05:30:00Z", patient_id: context.patient_id, encounter_id: context.encounter_id }]) },
    { id: "financial-access-readonly", kind: "financial_access", capabilities: ["read"], readPatient: async () => envelope("financial-access-readonly", [{ id: "affordability-bridge", kind: "affordability_screen", category: "medication", status: "barrier_reported", recorded_at: "2026-08-25T06:30:00Z", patient_id: context.patient_id, encounter_id: context.encounter_id }]) }
  ]
});

const snapshot = await bridge.readPatientSnapshot(context);
assert.equal(snapshot.completeness, "complete_for_configured_connectors");
assert.equal(snapshot.source_manifest.length, 5);
assert.equal(snapshot.dataFeeds.lis[0]._source.read_only, true);
assert.equal(snapshot.dataFeeds.financial_access[0]._source.kind, "financial_access");

const bridgedResult = await HospitalAgentAdapter.executePreRoundFromBridge({ context, bridge });
assert.equal(bridgedResult.security_contract.read_only_enforced, true);
assert.equal(bridgedResult.source_bridge.source_manifest.length, 5);
assert.equal(bridgedResult.summary.blocks.high_risk_followup.items.length, 1);
assert.equal(bridgedResult.summary.blocks.high_risk_followup.items[0].gap, "PENDING_CLINICIAN_ACKNOWLEDGEMENT");

const mismatchedBridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient"],
  connectors: [{
    id: "bad-patient",
    kind: "patient",
    capabilities: ["read"],
    readPatient: async () => ({ ...envelope("bad-patient", []), tenant_id: "wrong-tenant" })
  }]
});
await assert.rejects(() => mismatchedBridge.readPatientSnapshot(context), /BRIDGE_REQUIRED_SOURCE_UNAVAILABLE.*BRIDGE_TENANT_MISMATCH/);

console.log("✓ Clinical closure tracker, rule-pack fail-closed policy, and heterogeneous read-only bridge passed");
