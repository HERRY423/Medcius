import { assertSkillInvocable } from "./clinical-landing-policy.mjs";
import { assertSyncPhiAllowed } from "./production-phi-policy.mjs";
import { assertPatientSourceSnapshot } from "./patient-source-snapshot.mjs";
import { normalizeOrderExecution } from "./order-execution.mjs";
import { ShiftHandoverEngine, SHIFT_TYPES } from "./shift-handover-engine.mjs";
import { readWardRoster, wardInstant } from "./ward-roster.mjs";
import { detachedFrozenOutput } from "./output-consistency.mjs";
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";

const pendingOrder = new Set(["ordered", "pending-execution", "scheduled"]);
const pendingExecution = new Set(["ordered", "nurse_unverified", "nurse_verified", "pharmacy_reviewed", "dispensed"]);

// Offline preparation from one verified roster and encounter snapshots at the
// end of a specified night shift. Reviewed events stay in each SBAR packet.
export function prepareWardNightHandover({ scope, roster, patients, windowStart, previousWardHandover = null, verifyPreviousWardHandover, host = "sandbox" } = {}) {
  assertSkillInvocable({ skillId: "shift-handover", host, clinicalLanding: scope?.clinical_landing });
  assertSyncPhiAllowed(scope);
  const members = readWardRoster(roster, scope);
  const start = wardInstant(windowStart), end = wardInstant(scope.as_of);
  if (start == null || start >= end) throw new Error("WARD_HANDOVER_WINDOW_REQUIRED");
  if (!Array.isArray(patients)) throw new Error("WARD_HANDOVER_SNAPSHOTS_REQUIRED");
  const byEncounter = new Map(members.map(member => [member.encounter_id, member]));
  const cases = new Map();
  for (const args of patients) {
    const snapshot = assertPatientSourceSnapshot(args?.snapshot);
    assertSyncPhiAllowed(snapshot.context);
    assertSkillInvocable({ skillId: "shift-handover", host, clinicalLanding: snapshot.context.clinical_landing });
    const { tenant_id, patient_id, encounter_id } = snapshot.context;
    if (tenant_id !== scope.tenant_id || byEncounter.get(encounter_id)?.patient_id !== patient_id
        || (snapshot.encounter.ward_id != null && snapshot.encounter.ward_id !== scope.ward_id)
        || wardInstant(snapshot.as_of) !== end || cases.has(encounter_id)) throw new Error("WARD_HANDOVER_SNAPSHOT_SCOPE_MISMATCH");
    cases.set(encounter_id, args);
  }

  const priorByEncounter = new Map();
  if (previousWardHandover != null) {
    const { digest, ...prior } = structuredClone(previousWardHandover);
    const priorEnd = wardInstant(prior.as_of);
    if (prior.schema_version !== "medcius.ward-night-handover.v1" || prior.tenant_id !== scope.tenant_id || prior.ward_id !== scope.ward_id
        || priorEnd == null || priorEnd > start || !Array.isArray(prior.priority) || digest !== sha256Hex(canonicalJson(prior))
        || typeof verifyPreviousWardHandover !== "function" || verifyPreviousWardHandover(digest, { ...scope }) !== true) {
      throw new Error("WARD_PREVIOUS_HANDOVER_UNVERIFIED");
    }
    for (const row of prior.priority) {
      const packet = row.sbar_packet;
      if (!packet || wardInstant(packet.as_of) !== priorEnd || packet.context?.encounter_id !== row.encounter_id
          || packet.context.patient_id !== row.patient_id || packet.context.tenant_id !== prior.tenant_id || priorByEncounter.has(row.encounter_id)) {
        throw new Error("WARD_PREVIOUS_HANDOVER_UNVERIFIED");
      }
      priorByEncounter.set(row.encounter_id, packet);
    }
  }
  const inShift = value => {
    const time = wardInstant(value);
    return time != null && time > start && time <= end;
  };
  const entries = members.map(member => {
    const args = cases.get(member.encounter_id);
    const encounter = args?.snapshot.encounter;
    if (!encounter || encounter.status !== "in-progress" || (encounter.class?.code ?? encounter.class) !== "IMP") {
      return { ...member, status: "source_review_required", reason: encounter ? "ACTIVE_ENCOUNTER_UNVERIFIED" : "SNAPSHOT_MISSING" };
    }
    const prior = priorByEncounter.get(member.encounter_id);
    const packet = ShiftHandoverEngine.analyzePatientHandover({ ...args, windowStart, shiftType: SHIFT_TYPES.EVENING_TO_MORNING,
      ...(prior ? { previousHandover: prior, verifyPreviousHandover: digest => digest === prior.packet_digest } : {}) });
    const criticalValues = packet.sbar.assessment.critical_values.filter(row =>
      [row.lifecycle.event_time, row.lifecycle.change_time, row.lifecycle.recorded_at].some(inShift));
    const openFollowups = [...packet.high_risk_followup.items, ...packet.carryover].filter(row => row.closure_status !== "closed" && row.evidence.some(e => e.source_id));
    const pendingOrders = packet.sbar.recommendation.scheduled_follow_ups.flatMap(row => {
      const status = String(row.record.status ?? row.lifecycle.source_status ?? "").toLowerCase().replaceAll("_", "-");
      if (!["ordered", "scheduled"].includes(row.lifecycle.result_status) || !inShift(row.scheduled_time ?? row.lifecycle.event_time)) return [];
      const execution = normalizeOrderExecution(row.record, { now: packet.as_of });
      if (execution.administrations.length || execution.gaps.length || (execution.execution_status != null
          && !pendingExecution.has(execution.execution_status))) return [];
      if (!pendingOrder.has(status) && !(status === "active" && pendingExecution.has(execution.execution_status))) return [];
      return [{ title: row.title, owner_id: row.record.assigned_to_id ?? null, due_at: wardInstant(row.record.followup_due_at) == null ? null : row.record.followup_due_at, evidence: row.evidence, scheduled_at: row.scheduled_time, source_status: row.lifecycle.source_status,
        execution_status: execution.execution_status ?? "unknown" }];
    });
    const signals = { critical_values: criticalValues, unresolved_followup: openFollowups, pending_orders: pendingOrders };
    const reasons = Object.keys(signals).filter(key => signals[key].length > 0);
    if (!reasons.length) return { ...member, snapshot_id: packet.snapshot_id, status: "no_priority_signal_in_supplied_records",
      source_coverage: packet.source_visibility.coverage_status };
    return { ...member, status: "priority", reasons, signals, sbar_packet: packet };
  });
  const priority = entries.filter(entry => entry.status === "priority").sort((a, b) =>
    Number(b.reasons.includes("critical_values")) - Number(a.reasons.includes("critical_values"))
    || Number(b.reasons.includes("unresolved_followup")) - Number(a.reasons.includes("unresolved_followup")));
  const result = { schema_version: "medcius.ward-night-handover.v1", tenant_id: scope.tenant_id, ward_id: scope.ward_id,
    as_of: new Date(end).toISOString(), window_start: new Date(start).toISOString(),
    roster_source: { source_id: roster.source_id, version: roster.source_version, synchronized_through: roster.synchronized_through },
    counts: { roster: members.length, priority: priority.length, source_review_required: entries.filter(e => e.status === "source_review_required").length },
    priority, remaining: entries.filter(entry => entry.status !== "priority") };
  return detachedFrozenOutput({ ...result, digest: sha256Hex(canonicalJson(result)) });
}
