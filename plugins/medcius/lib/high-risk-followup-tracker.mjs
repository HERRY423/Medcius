import { requiresRecordReconciliation } from "./record-lifecycle.mjs";
import { canonicalJson } from "../servers/shared/crypto.mjs";
import { classifyRecordLifecycle } from "./record-lifecycle.mjs";

const RESULT_STATUSES = new Set(["final", "revised"]);
const CURRENT_TIME_STATUSES = new Set(["in_window", "historical"]);
const FOLLOWUP_SOURCE_KINDS = new Set(["his", "his_orders", "order", "lis", "laboratory", "observation", "pacs", "imaging", "diagnostic_report"]);

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

function timeValue(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceEvidence(record, sourceType, lifecycle) {
  return {
    source_type: sourceType,
    source_id: lifecycle.source_id,
    record_identity: lifecycle.record_identity || record?.source_record_id || lifecycle.source_id,
    source_system: lifecycle.source_system,
    source_version: lifecycle.version_id,
    timestamp: lifecycle.change_time,
    event_time: lifecycle.event_time,
    event_time_status: lifecycle.event_time_status,
    recorded_at: lifecycle.recorded_at,
    recorded_time_status: lifecycle.recorded_time_status,
    source_updated_at: lifecycle.source_updated_at,
    change_time: lifecycle.change_time,
    change_time_status: lifecycle.change_time_status,
    source_status: lifecycle.source_status,
    supersedes_id: lifecycle.supersedes_id,
    supersedes_version_id: lifecycle.supersedes_version_id,
    acknowledged_at: lifecycle.acknowledged_at,
    acknowledged_version_id: lifecycle.acknowledged_version_id,
  };
}

function recordCode(record) {
  const code = typeof record?.code === "string"
    ? record.code
    : record?.code?.coding?.[0]?.code;
  return lower(code || record?.test_code || record?.order_code || record?.modality || record?.name || record?.title);
}

function recordPriority(record) {
  return lower(record?.priority || record?.urgency || record?.order_priority);
}

export function isExplicitCritical(record) {
  return record?.is_critical === true || record?.is_critical_reported === true || lower(record?.interpretation) === "critical";
}

function supportsKind(kind, records, sourceTypes) {
  if (kind === "laboratory") {
    return sourceTypes.has("observation") || records.some((record) => /lab|laboratory|检验/i.test(String(record?.order_type || record?.category || "")));
  }
  if (kind === "imaging") {
    return sourceTypes.has("diagnostic_report") || records.some((record) => /imag|radiology|pacs|影像|检查/i.test(String(record?.order_type || record?.category || "")));
  }
  return true;
}

function matchesRule(rule, records, sourceTypes) {
  if (!supportsKind(rule?.kind, records, sourceTypes)) return false;
  const match = rule?.match || {};
  if (match.explicit_critical && !records.some(isExplicitCritical)) return false;
  if (Array.isArray(match.codes) && match.codes.length > 0) {
    const allowed = new Set(match.codes.map(lower));
    if (!records.some((record) => allowed.has(recordCode(record)))) return false;
  }
  if (Array.isArray(match.priorities) && match.priorities.length > 0) {
    const allowed = new Set(match.priorities.map(lower));
    if (!records.some((record) => allowed.has(recordPriority(record)))) return false;
  }
  return Boolean(match.explicit_critical || match.codes?.length || match.priorities?.length);
}

function trajectoryKey(record, sourceType) {
  if (sourceType === "order" && (record?.source_record_id || record?.id)) return String(record.source_record_id || record.id);
  return String(
    record?.order_id ||
    record?.based_on_id ||
    record?.service_request_id ||
    record?.request_id ||
    `${sourceType}:${record?.source_record_id || record?.id || recordCode(record) || "unknown"}`,
  );
}

// Source versions are opaque identifiers. Their lexical or numeric order never
// proves that one clinical record replaces another.
function clinicalContent(record) {
  const content = { ...record };
  for (const key of Object.keys(content)) {
    if (/^acknowledged(?:_|$)/.test(key) || /^review(?:ed)?(?:_|$)/.test(key)) delete content[key];
  }
  for (const key of ["id", "source_record_id", "_source", "lifecycle", "_lifecycle", "recorded_at", "received_at", "ingested_at", "fetched_at", "updated_at", "last_updated", "source_updated_at", "version_id", "version", "source_version", "resource_version", "supersedes_id", "supersedes_version_id"]) delete content[key];
  if (content.meta && typeof content.meta === "object") {
    content.meta = { ...content.meta };
    delete content.meta.lastUpdated;
    delete content.meta.versionId;
    if (Object.keys(content.meta).length === 0) delete content.meta;
  }
  return canonicalJson(content);
}

function explicitlySupersedes(candidate, previous) {
  const next = candidate.lifecycle;
  const prior = previous.lifecycle;
  const nextIdentity = candidate.record.source_record_id || next.record_identity || next.source_id;
  const priorIdentity = previous.record.source_record_id || prior.record_identity || prior.source_id;
  const idMatches = next.supersedes_id && [String(prior.source_id), String(priorIdentity)].includes(String(next.supersedes_id));
  const versionMatches = next.supersedes_version_id && String(next.supersedes_version_id) === String(prior.version_id);
  return Boolean((idMatches && (!next.supersedes_version_id || versionMatches)) ||
    (versionMatches && nextIdentity === priorIdentity));
}

function versionTime(entry) {
  return timeValue(entry.lifecycle.source_updated_at) ?? timeValue(entry.lifecycle.change_time);
}

function stateForGroup(entries, nowMs) {
  const unique = [...new Map(entries.map((entry) => [canonicalJson(entry.record), entry])).values()];
  const uncertainty = [];
  if (unique.some(({ lifecycle }) => !lifecycle.source_id)) uncertainty.push("SOURCE_RECORD_ID_MISSING");
  const byVersion = new Map();
  for (const entry of unique) {
    if (!entry.lifecycle.version_id) continue;
    const key = `${entry.record.source_record_id || entry.lifecycle.record_identity || entry.lifecycle.source_id}:${entry.lifecycle.version_id}`;
    const prior = byVersion.get(key);
    if (prior && clinicalContent(prior.record) !== clinicalContent(entry.record)) uncertainty.push("SAME_VERSION_CONTENT_CONFLICT");
    byVersion.set(key, entry);
  }
  const candidates = unique.filter((candidate) => !unique.some((other) => other !== candidate && explicitlySupersedes(other, candidate)));
  let selected = null;
  if (candidates.length === 1) selected = candidates[0];
  else if (candidates.length === 0) uncertainty.push("CYCLIC_VERSION_RELATION");
  else if (candidates.every((entry) => CURRENT_TIME_STATUSES.has(entry.lifecycle.change_time_status) && versionTime(entry) != null && versionTime(entry) <= nowMs)) {
    const sorted = [...candidates].sort((a, b) => versionTime(b) - versionTime(a));
    const tied = sorted.filter((entry) => versionTime(entry) === versionTime(sorted[0]));
    if (new Set(tied.map((entry) => `${entry.lifecycle.version_id}:${clinicalContent(entry.record)}`)).size > 1) uncertainty.push("VERSION_ORDER_UNPROVEN");
    else selected = tied.sort((a, b) => (timeValue(b.lifecycle.acknowledged_at) ?? -Infinity) - (timeValue(a.lifecycle.acknowledged_at) ?? -Infinity))[0];
  } else uncertainty.push("VERSION_ORDER_UNPROVEN");

  const priorDifferentContent = selected && unique.some((entry) => entry !== selected && RESULT_STATUSES.has(entry.lifecycle.result_status) && clinicalContent(entry.record) !== clinicalContent(selected.record));
  const revisionResolved = selected && priorDifferentContent && selected.sourceType !== "order" && selected.lifecycle.result_status === "final";
  const lifecycle = selected ? { ...selected.lifecycle,
    ...(revisionResolved ? { change_type: "revision", result_status: "revised", change_time: selected.lifecycle.source_updated_at || selected.lifecycle.change_time } : {}),
  } : null;
  if (lifecycle && !CURRENT_TIME_STATUSES.has(lifecycle.change_time_status)) uncertainty.push("CHANGE_TIME_UNKNOWN_OR_OUTSIDE_AS_OF");
  if (lifecycle && timeValue(lifecycle.source_updated_at) > nowMs) uncertainty.push("VERSION_UPDATE_OUTSIDE_AS_OF");
  if (lifecycle && lifecycle.recorded_time_status === "future") uncertainty.push("RECORD_RECEIVED_OUTSIDE_AS_OF");
  if (lifecycle && lifecycle.result_status === "unknown") uncertainty.push("SOURCE_STATUS_UNKNOWN");
  if (lifecycle && lifecycle.event_time_status === "future") uncertainty.push("EVENT_TIME_OUTSIDE_AS_OF");
  const temporalKnown = uncertainty.length === 0;
  let reviewStatus = temporalKnown ? "pending" : "unknown";
  const ackMs = timeValue(lifecycle?.acknowledged_at);
  const changeMs = timeValue(lifecycle?.change_time);
  const acknowledgedId = selected?.record?.acknowledged_result_id || selected?.record?.acknowledged_record_id || null;
  const boundToId = acknowledgedId == null || String(acknowledgedId) === String(lifecycle?.source_id);
  const boundToVersion = lifecycle?.acknowledged_version_id == null ||
    (lifecycle?.version_id != null && String(lifecycle.acknowledged_version_id) === String(lifecycle.version_id));
  const revisionRequiresVersionBinding = lifecycle?.change_type === "revision";
  const revisionBound = !revisionRequiresVersionBinding || (lifecycle.version_id != null && lifecycle.acknowledged_version_id != null && boundToVersion);
  const acknowledgementConflict = selected?.record?.acknowledged === false && ackMs != null;
  if (acknowledgementConflict) uncertainty.push("ACKNOWLEDGEMENT_CONFLICT");
  // An acknowledgement must belong to the selected result and occur no earlier
  // than that result's actual change. Order acknowledgement never flows to results.
  if (acknowledgementConflict) reviewStatus = "unknown";
  else if (temporalKnown && ackMs != null && changeMs != null && ackMs >= changeMs && ackMs <= nowMs && boundToId && boundToVersion && revisionBound) reviewStatus = "acknowledged";
  else if (temporalKnown && ((selected?.record?.acknowledged === true && ackMs == null) || (ackMs != null && boundToVersion && !revisionBound))) reviewStatus = "unknown";
  const resultStatus = lifecycle?.result_status || "unknown";
  const closureStatus = !temporalKnown || acknowledgementConflict ? "unknown"
    : requiresRecordReconciliation(resultStatus) ? "requires_reconciliation"
      : RESULT_STATUSES.has(resultStatus) && selected.sourceType !== "order" && reviewStatus === "acknowledged" ? "closed" : "open";
  return {
    source_type: selected?.sourceType || unique[0]?.sourceType || "unknown",
    source_id: lifecycle?.source_id || unique[0]?.lifecycle?.source_id || null,
    record_identity: selected?.record?.source_record_id || lifecycle?.record_identity || lifecycle?.source_id || unique[0]?.record?.source_record_id || null,
    source_system: lifecycle?.source_system || unique[0]?.lifecycle?.source_system || null,
    version_id: lifecycle?.version_id || null,
    result_status: resultStatus,
    source_status: lifecycle?.source_status || null,
    review_status: reviewStatus,
    closure_status: closureStatus,
    change_type: lifecycle?.change_type || "unknown",
    stage_timestamp: lifecycle?.change_time || null,
    arrival_status: lifecycle?.arrival_status || "unknown",
    current_window_event: lifecycle && CURRENT_TIME_STATUSES.has(lifecycle.event_time_status) ? lifecycle.event_time_status === "in_window" : null,
    lifecycle,
    uncertainty_reasons: [...new Set(uncertainty)],
    evidence: unique.map(({ record, sourceType, lifecycle: entryLifecycle }) => sourceEvidence(record, sourceType, entryLifecycle)),
  };
}

function recordStates(entries, nowMs) {
  const groups = new Map();
  for (const [index, entry] of entries.entries()) {
    const key = `${entry.sourceType}:${entry.lifecycle.source_system || "unknown-source"}:${entry.record.source_record_id || entry.lifecycle.record_identity || entry.lifecycle.source_id || `missing-${index}`}`;
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  }
  // Explicit replacement IDs may connect result identities; sharing one order
  // alone must not merge distinct results or discard an unreviewed earlier one.
  let merged = true;
  while (merged) {
    merged = false;
    const allGroups = [...groups.entries()];
    for (let i = 0; i < allGroups.length && !merged; i++) {
      for (let j = i + 1; j < allGroups.length && !merged; j++) {
        const [aKey, a] = allGroups[i];
        const [bKey, b] = allGroups[j];
        if (a[0].sourceType !== b[0].sourceType || a[0].lifecycle.source_system !== b[0].lifecycle.source_system) continue;
        if (a.some((entry) => b.some((other) => explicitlySupersedes(entry, other) || explicitlySupersedes(other, entry)))) {
          groups.set(aKey, [...a, ...b]);
          groups.delete(bKey);
          merged = true;
        }
      }
    }
  }
  return [...groups.values()].map((group) => stateForGroup(group, nowMs));
}

function availabilityFor(rule, states, sourceAvailability) {
  const relevantKinds = new Set(["his", "his_orders", "order"]);
  if (rule.kind === "laboratory" || states.some((state) => state.source_type === "observation")) ["lis", "laboratory", "observation"].forEach((kind) => relevantKinds.add(kind));
  if (rule.kind === "imaging" || states.some((state) => state.source_type === "diagnostic_report")) ["pacs", "imaging", "diagnostic_report"].forEach((kind) => relevantKinds.add(kind));
  const sources = sourceAvailability.filter((source) => relevantKinds.has(lower(source.kind)) || states.some((state) => state.source_system && [source.connector_id, source.source_system].includes(state.source_system)));
  if (sources.some((source) => source.status === "unavailable")) return "unavailable";
  if (sources.some((source) => !["available", "available_empty"].includes(source.status))) return "unknown";
  return sources.length ? "available" : "not_reported";
}

function aggregateStates(states, availability) {
  const resultStates = states.filter((state) => state.source_type !== "order");
  const considered = resultStates.length ? resultStates : states;
  const reasons = [...new Set(states.flatMap((state) => state.uncertainty_reasons))];
  const terminals = states.filter((state) => requiresRecordReconciliation(state.result_status));
  const unknown = states.some((state) => state.closure_status === "unknown");
  const unresolved = considered.filter((state) => state.closure_status !== "closed");
  const representative = (unresolved.length ? unresolved : considered).slice().sort((a, b) => (timeValue(a.stage_timestamp) ?? Infinity) - (timeValue(b.stage_timestamp) ?? Infinity))[0];
  const terminalRepresentative = terminals.slice().sort((a, b) => (timeValue(b.stage_timestamp) ?? -Infinity) - (timeValue(a.stage_timestamp) ?? -Infinity))[0];
  const reviewStatus = considered.every((state) => state.review_status === "acknowledged") ? "acknowledged"
    : considered.some((state) => state.review_status === "acknowledged") ? "partially_acknowledged"
      : considered.some((state) => state.review_status === "unknown") ? "unknown" : "pending";
  const resultStatus = new Set(considered.map((state) => state.result_status)).size === 1 ? considered[0]?.result_status || "unknown" : "mixed";
  let closure = unknown ? "unknown" : terminals.length ? "requires_reconciliation"
    : resultStates.length && unresolved.length === 0 ? "closed" : "open";
  let stage = unknown ? "unknown" : terminals.some((state) => state.result_status === "entered_in_error") ? "entered_in_error"
    : terminals.length ? "cancelled" : closure === "closed" ? "acknowledged"
      : RESULT_STATUSES.has(representative?.result_status) ? "resulted" : representative?.result_status || "unknown";
  if (availability === "unavailable" || availability === "unknown") {
    closure = "unknown";
    stage = "unknown";
    reasons.push(availability === "unavailable" ? "SOURCE_INTERFACE_UNAVAILABLE" : "SOURCE_AVAILABILITY_UNKNOWN");
  }
  return {
    stage,
    stage_timestamp: terminalRepresentative?.stage_timestamp || representative?.stage_timestamp || null,
    result_status: resultStatus,
    review_status: reviewStatus,
    closure_status: closure,
    change_type: terminals.some((state) => state.result_status === "entered_in_error") ? "entered_in_error" : terminals.length ? "cancellation"
      : considered.some((state) => state.change_type === "revision") ? "revision" : representative?.change_type || "unknown",
    arrival_status: considered.some((state) => state.arrival_status === "late_record") ? "late_record" : representative?.arrival_status || "unknown",
    current_window_event: representative?.current_window_event ?? null,
    lifecycle: terminalRepresentative?.lifecycle || representative?.lifecycle || null,
    uncertainty_reasons: reasons,
  };
}

function gapForState({ stage, change_type: changeType }, availability) {
  if (availability === "unavailable") return "SOURCE_INTERFACE_UNAVAILABLE";
  if (availability === "unknown") return "SOURCE_AVAILABILITY_UNKNOWN";
  if (stage === "unknown") return "FOLLOWUP_STATE_UNKNOWN";
  if (stage === "ordered" || stage === "scheduled") return "PENDING_COLLECTION_OR_EXECUTION";
  if (stage === "collected" || stage === "preliminary") return "PENDING_FINAL_RESULT";
  if (stage === "resulted") return changeType === "revision" ? "PENDING_REVISED_RESULT_ACKNOWLEDGEMENT" : "PENDING_CLINICIAN_ACKNOWLEDGEMENT";
  if (stage === "cancelled") return "CANCELLED_REQUIRES_RECONCILIATION";
  if (stage === "entered_in_error") return "ENTERED_IN_ERROR_REQUIRES_RECONCILIATION";
  return null;
}

function sourceReportedRules(trajectories) {
  const rules = [];
  if ([...trajectories.values()].some((entry) => entry.records.some(isExplicitCritical))) {
    rules.push({
      rule_id: "source-reported-critical",
      kind: "source_reported",
      match: { explicit_critical: true },
      required_stages: ["ordered", "collected", "resulted", "acknowledged"],
      due_minutes: {},
    });
  }
  return rules;
}

// Expose the same source-review interpretation for ordinary result documentation checks.
export function getSourceRecordFollowupState(record, { sourceType = "diagnostic_report", now = new Date() } = {}) {
  return stateForGroup([{ record, sourceType, lifecycle: classifyRecordLifecycle(record, { sourceType, now }) }], new Date(now).getTime());
}

export function trackHighRiskFollowup({
  orders = [],
  observations = [],
  diagnosticReports = [],
  rulePack = null,
  now = new Date(),
  cutoffTime = null,
  sourceAvailability = [],
  unavailableSources = [],
} = {}) {
  const trajectories = new Map();
  const add = (record, sourceType) => {
    if (!record || typeof record !== "object") return;
    const key = trajectoryKey(record, sourceType);
    const entry = trajectories.get(key) || { key, records: [], entries: [], sourceTypes: new Set() };
    const lifecycle = classifyRecordLifecycle(record, { sourceType, now, cutoffTime });
    entry.records.push(record);
    entry.entries.push({ record, sourceType, lifecycle });
    entry.sourceTypes.add(sourceType);
    trajectories.set(key, entry);
  };
  orders.forEach((record) => add(record, "order"));
  observations.forEach((record) => add(record, "observation"));
  diagnosticReports.forEach((record) => add(record, "diagnostic_report"));

  const configuredRules = rulePack?.clinical_rules?.followup || [];
  const rules = configuredRules.length > 0 ? configuredRules : sourceReportedRules(trajectories);
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error("FOLLOWUP_INVALID_NOW");
  const availability = [...sourceAvailability, ...unavailableSources.map((source) => ({ ...source, status: "unavailable" }))];
  const relevantAvailability = availability.filter((source) => FOLLOWUP_SOURCE_KINDS.has(lower(source.kind)) ||
    [...trajectories.values()].some((trajectory) => trajectory.entries.some((entry) => entry.lifecycle.source_system &&
      [source.connector_id, source.source_system].includes(entry.lifecycle.source_system))));
  const blockedAvailability = relevantAvailability.filter((source) => !["available", "available_empty"].includes(source.status));

  const items = [];
  for (const trajectory of trajectories.values()) {
    for (const rule of rules) {
      if (!matchesRule(rule, trajectory.records, trajectory.sourceTypes)) continue;
      const states = recordStates(trajectory.entries, nowMs);
      const sourceStatus = availabilityFor(rule, states, availability);
      const state = aggregateStates(states, sourceStatus);
      const dueValue = rule?.due_minutes?.[state.stage];
      const dueMinutes = dueValue == null || dueValue === "" || typeof dueValue === "boolean" ? null : Number(dueValue);
      const overdue = state.closure_status === "open" && Number.isFinite(dueMinutes) && dueMinutes >= 0 && timeValue(state.stage_timestamp) != null
        ? nowMs - timeValue(state.stage_timestamp) > dueMinutes * 60_000
        : null;
      const representative = trajectory.records.find((record) => record.name || record.title || record.test_name || record.study_name) || trajectory.records[0];
      items.push({
        tracking_id: `${rule.rule_id}:${trajectory.key}`,
        rule_id: rule.rule_id,
        kind: rule.kind || "unknown",
        label: representative?.name || representative?.title || representative?.test_name || representative?.study_name || recordCode(representative) || "未命名检查检验",
        code: recordCode(representative) || null,
        ...state,
        availability_status: sourceStatus,
        record_states: states,
        required_stages: rule.required_stages,
        gap: gapForState(state, sourceStatus),
        overdue,
        due_minutes: Number.isFinite(dueMinutes) ? dueMinutes : null,
        source_reported_high_risk: trajectory.records.some(isExplicitCritical),
        evidence: trajectory.entries.map(({ record, sourceType, lifecycle }) => sourceEvidence(record, sourceType, lifecycle)),
      });
    }
  }

  const deduplicated = [...new Map(items.map((item) => [item.tracking_id, item])).values()];
  return {
    schema_version: "medcius.high-risk-followup.v2",
    rule_pack: rulePack ? {
      pack_id: rulePack.pack_id,
      version: rulePack.version,
      sha256: rulePack.sha256 || null,
      data_class: rulePack.data_class,
    } : null,
    rule_status: configuredRules.length > 0 ? "configured" : "source_flags_only",
    availability_status: blockedAvailability.some((source) => source.status === "unavailable") ? "unavailable"
      : blockedAvailability.length ? "unknown" : relevantAvailability.length ? "available" : "not_reported",
    source_availability: availability,
    unavailable_sources: blockedAvailability,
    interpretation: blockedAvailability.length > 0 ? "unknown_due_to_unavailable_sources" : deduplicated.length > 0
      ? "tracked_high_risk_items_present"
      : "none_identified_from_available_rules_and_sources",
    items: deduplicated,
    counts: {
      total: deduplicated.length,
      open: deduplicated.filter((item) => item.closure_status !== "closed").length,
      acknowledged: deduplicated.filter((item) => item.closure_status === "closed").length,
      requires_reconciliation: deduplicated.filter((item) => item.closure_status === "requires_reconciliation").length,
      unknown: deduplicated.filter((item) => item.closure_status === "unknown").length,
      overdue: deduplicated.filter((item) => item.overdue === true).length,
      complete_for_available_sources: relevantAvailability.length === 0 ? null : blockedAvailability.length === 0,
    },
  };
}
