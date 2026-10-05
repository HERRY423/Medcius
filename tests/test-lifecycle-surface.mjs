// Synthetic acceptance checks for lifecycle + availability across the host,
// the read-only bridge, and the frozen research replay boundary.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.CLAUDE_MEDCIUS_DATA = mkdtempSync(join(tmpdir(), "medcius-lifecycle-surface-"));
process.env.CLAUDE_MEDCIUS_PHI_SALT = Buffer.alloc(16, 0x5a).toString("hex");
delete process.env.MEDCIUS_PROFILE;
delete process.env.NODE_ENV;
delete process.env.MEDCIUS_CLINICAL_LANDING;
delete process.env.MEDCIUS_LIVE_HOSPITAL_DATA;
const { HospitalAgentAdapter, getPreRoundResearchSnapshot } = await import("../plugins/medcius/lib/hospital-agent-adapter.mjs");
const { ReadOnlyHospitalDataBridge } = await import("../plugins/medcius/lib/read-only-hospital-data-bridge.mjs");
const { executeHisEmbedPreRound } = await import("../plugins/medcius/lib/his-embed-adapter.mjs");
const { GovernanceStateManager } = await import("../plugins/medcius/lib/governance-mode.mjs");
const { saveFrozenResearchRecord, readFrozenResearchRecord, replayFrozenResearchRecord } = await import("../plugins/medcius/lib/silent-research-archive.mjs");
const NOW = "2026-10-04T12:00:00.000Z";
const context = { tenant_id: "tenant-lifecycle-synthetic", doctor_id: "doctor-synthetic",
  patient_id: "patient-lifecycle-synthetic", encounter_id: "encounter-lifecycle-synthetic", as_of: NOW, clinical_landing: true };
const ownership = { tenant_id: context.tenant_id, patient_id: context.patient_id, encounter_id: context.encounter_id, ownership_status: "verified" };
const baseFeeds = { patient: { id: context.patient_id, ...ownership, name: "合成张三", gender: "male" },
  encounter: { id: context.encounter_id, ...ownership }, notes: [], nis: [], lis: [], pacs: [], his_orders: [] };
function availability(kind, status, count = null) {
  return { connector_id: `synthetic-${kind}`, kind, status, fetched_at: NOW, source_version: "synthetic-v1",
    record_count: count, accepted_record_count: count, reason_code: status === "unavailable" ? "SOURCE_TIMEOUT" : null };
}
function freeze(result) {
  const snapshot = getPreRoundResearchSnapshot(result);
  const saved = saveFrozenResearchRecord({ tenantId: context.tenant_id, patientId: context.patient_id,
    encounterId: context.encounter_id, asOf: NOW, governanceStage: "silent_pilot", sourceMode: "synthetic_replay",
    sourceManifest: result.source_bridge?.source_manifest || [], unavailableSources: result.source_bridge?.unavailable_sources || [],
    ...snapshot });
  const record = readFrozenResearchRecord(saved.case_id, { tenantId: context.tenant_id });
  assert.deepEqual(record.annotation_output, result.summary);
  assert.deepEqual(record.source_availability, record.engine_input.sourceAvailability);
  assert.deepEqual(record.source_availability, record.replay_input.sourceAvailability);
  assert.deepEqual(record.source_availability, record.annotation_output.blocks.source_availability);
  assert.equal(replayFrozenResearchRecord(saved.case_id, { tenantId: context.tenant_id }).match, true);
  return record;
}

const states = [availability("lis", "available_empty", 0), availability("notes", "unavailable"), availability("pacs", "unknown")];
const result = HospitalAgentAdapter.executePreRoundWorkflow({ host: "his_embed", context, dataFeeds: baseFeeds, sourceAvailability: states });
assert.deepEqual(result.summary.blocks.source_availability, states);
assert.equal(JSON.stringify(result).includes("合成张三"), false);
assert.equal(result.engine_input, undefined);
assert.equal(result.annotation_summary, undefined);
const record = freeze(result);
states[0].status = "unavailable";
assert.equal(record.annotation_output.blocks.source_availability[0].status, "available_empty");
assert.equal(getPreRoundResearchSnapshot(result).sourceAvailability[0].status, "available_empty");
const fromFeed = HospitalAgentAdapter.executePreRoundWorkflow({ host: "his_embed", context,
  dataFeeds: { ...baseFeeds, source_availability: record.source_availability } });
assert.deepEqual(fromFeed.summary.blocks.source_availability, record.source_availability);
freeze(fromFeed);
const snapshot = getPreRoundResearchSnapshot(result);
assert.throws(() => saveFrozenResearchRecord({ tenantId: context.tenant_id, patientId: context.patient_id,
  encounterId: context.encounter_id, asOf: NOW, governanceStage: "silent_pilot", sourceMode: "synthetic_replay",
  ...snapshot, sourceAvailability: [availability("lis", "unavailable")] }), /INTEGRITY_FAILED/);

function connector(kind, records, fails = false) {
  return { id: `synthetic-${kind}`, kind, capabilities: ["read"], async readPatient() {
    if (fails) throw new Error("SOURCE_TIMEOUT");
    return { ...ownership, records: structuredClone(records), fetched_at: NOW, source_version: "synthetic-v1", source_system: `synthetic-${kind}` };
  } };
}
const bridge = new ReadOnlyHospitalDataBridge({ connectors: [connector("patient", [baseFeeds.patient]), connector("encounter", [baseFeeds.encounter]),
  connector("lis", []), connector("notes", [], true)], requiredKinds: ["patient", "encounter"] });
const bridged = await HospitalAgentAdapter.executePreRoundFromBridge({ host: "his_embed", context, bridge });
const bridgeStates = bridged.source_bridge.source_availability;
assert.equal(bridgeStates.find((item) => item.kind === "lis").status, "available_empty");
assert.equal(bridgeStates.find((item) => item.kind === "notes").status, "unavailable");
assert.deepEqual(bridged.summary.blocks.source_availability, bridgeStates);
assert.equal(bridged.source_bridge.dataFeeds, undefined);
freeze(bridged);
const silent = await executeHisEmbedPreRound({ context, bridge, governance: new GovernanceStateManager("silent_pilot") });
assert.equal(silent.summary, null);
assert.deepEqual(silent.cards, []);
assert.deepEqual(silent.source_bridge.source_availability, bridgeStates);
assert.deepEqual(readFrozenResearchRecord(silent.research_record_id, { tenantId: context.tenant_id }).source_availability, bridgeStates);
await assert.rejects(() => HospitalAgentAdapter.executePreRoundFromBridge({ host: "his_embed", context,
  bridge: { async readPatientSnapshot() { return { dataFeeds: { ...baseFeeds, source_availability: [availability("lis", "available_empty", 0)] },
    source_availability: [availability("lis", "unavailable")], security_contract: { read_only_enforced: true } }; } } }), /SOURCE_AVAILABILITY/);

const lab = (id, changes) => ({ id, ...ownership, code: "k", name: "血钾", unit: "mmol/L",
  sample_time: "2026-10-04T08:00:00Z", resulted_at: "2026-10-04T08:30:00Z", status: "final", value: 4,
  _source: { system: "synthetic-lis", record_id: id }, ...changes });
const lifecycleFeeds = { ...baseFeeds, lis: [
  lab("lab-new", { sample_time: "2026-10-04T11:00:00Z", resulted_at: "2026-10-04T11:30:00Z", version_id: "1" }),
  lab("lab-revision", { value: 2.4, is_critical: true, version_id: "1", updated_at: "2026-10-04T08:30:00Z",
    acknowledged_at: "2026-10-04T09:00:00Z", acknowledged_version_id: "1" }),
  lab("lab-revision", { value: 3.9, status: "corrected", version_id: "2", updated_at: "2026-10-04T10:00:00Z",
    supersedes_version_id: "1", acknowledged_at: "2026-10-04T09:00:00Z", acknowledged_version_id: "1" }),
  lab("lab-cancelled", { value: 9.8, is_critical: true, status: "cancelled", cancelled_at: "2026-10-04T10:30:00Z" }),
  lab("lab-entered-error", { value: 9.9, is_critical: true, status: "entered-in-error", updated_at: "2026-10-04T10:30:00Z" }),
  lab("lab-unknown", { value: 8.8, status: "unrecognized-source-status" }),
  lab("lab-late", { value: 2.5, status: "final", sample_time: "2026-10-02T08:00:00Z", resulted_at: "2026-10-02T09:00:00Z",
    received_at: "2026-10-04T11:00:00Z" }),
] };
const changed = HospitalAgentAdapter.executePreRoundWorkflow({ host: "his_embed", context, dataFeeds: lifecycleFeeds,
  sourceAvailability: [availability("lis", "available", lifecycleFeeds.lis.length)] });
const changes = changed.summary.blocks.record_changes.items;
for (const [id, expected] of [["lab-new", "new_result"], ["lab-revision", "revision"], ["lab-cancelled", "cancellation"],
  ["lab-entered-error", "entered_in_error"], ["lab-unknown", "unknown"]]) {
  assert.ok(changes.some((item) => item.source_id === id && item.change_type === expected), `${id} must remain a distinct lifecycle event`);
}
const late = changes.find((item) => item.source_id === "lab-late");
assert.equal(late.arrival_status, "late_record");
assert.match(late.display_text, /迟到/);
assert.equal(late.event_time, "2026-10-02T08:00:00Z");
assert.equal(late.recorded_at, "2026-10-04T11:00:00Z");
const currentPanels = changed.summary.blocks.what_changed;
for (const id of ["lab-cancelled", "lab-entered-error", "lab-unknown", "lab-late"]) {
  assert.equal((currentPanels.critical_values || []).some((item) => item.observation_id === id), false, `${id} must not become a current critical value`);
}
const revisedFollowup = changed.summary.blocks.high_risk_followup.items.find((item) => item.evidence.some((evidence) => evidence.source_id === "lab-revision"));
assert.ok(revisedFollowup);
assert.notEqual(revisedFollowup.closure_status, "closed");
assert.notEqual(revisedFollowup.stage, "acknowledged");
const changedRecord = freeze(changed);
assert.deepEqual(changedRecord.annotation_output.blocks.record_changes, changed.summary.blocks.record_changes);
assert.ok(changedRecord.engine_input.recordHistory.observations.some((item) => item.id === "lab-late"));
assert.equal(changed.recordHistory, undefined);

console.log("PASS: lifecycle surface and frozen replay retain source availability; synthetic validation only");
