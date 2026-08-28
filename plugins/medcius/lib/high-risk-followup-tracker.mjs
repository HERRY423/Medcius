const FINAL_STATUSES = new Set(["final", "amended", "corrected", "completed"]);
const PRELIMINARY_STATUSES = new Set(["preliminary", "partial", "in-progress", "in_progress"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "revoked", "entered-in-error", "entered_in_error"]);

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

function timeValue(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceEvidence(record, sourceType) {
  return {
    source_type: sourceType,
    source_id: record?.id || record?.source_record_id || null,
    source_system: record?._source?.system || record?.source_system || null,
    timestamp: record?.acknowledged_at || record?.resulted_at || record?.effective_time || record?.sample_time || record?.scheduled_time || record?.authored_on || record?.ordered_at || null,
    source_status: record?.status || null,
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

function isExplicitCritical(record) {
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
  if (sourceType === "order" && record?.id) return String(record.id);
  return String(
    record?.order_id ||
    record?.based_on_id ||
    record?.service_request_id ||
    record?.request_id ||
    `${sourceType}:${record?.id || recordCode(record) || "unknown"}`,
  );
}

function deriveStage(records) {
  const statuses = records.map((record) => lower(record.status));
  if (records.some((record) => record.acknowledged_at || record.acknowledged === true || lower(record.lifecycle_status) === "acknowledged")) return "acknowledged";
  if (statuses.some((status) => FINAL_STATUSES.has(status)) || records.some((record) => record.finalized_at)) return "resulted";
  if (statuses.some((status) => PRELIMINARY_STATUSES.has(status))) return "preliminary";
  if (records.some((record) => record.resulted_at)) return "resulted";
  if (records.some((record) => record.collected_at || record.specimen_received_at || record.sample_time)) return "collected";
  if (records.some((record) => record.scheduled_time || record.scheduled_at)) return "scheduled";
  if (statuses.some((status) => CANCELLED_STATUSES.has(status))) return "cancelled";
  return "ordered";
}

function stageTimestamp(stage, records) {
  const fields = {
    acknowledged: ["acknowledged_at"],
    resulted: ["resulted_at", "finalized_at", "effective_time", "sample_time"],
    preliminary: ["resulted_at", "effective_time", "sample_time"],
    collected: ["collected_at", "specimen_received_at", "sample_time"],
    scheduled: ["scheduled_time", "scheduled_at"],
    ordered: ["authored_on", "ordered_at", "created_at"],
    cancelled: ["cancelled_at", "updated_at"],
  };
  for (const field of fields[stage] || []) {
    const values = records.map((record) => record?.[field]).filter((value) => timeValue(value) != null);
    if (values.length) return values.sort((a, b) => timeValue(b) - timeValue(a))[0];
  }
  return null;
}

function gapForStage(stage) {
  if (stage === "ordered" || stage === "scheduled") return "PENDING_COLLECTION_OR_EXECUTION";
  if (stage === "collected" || stage === "preliminary") return "PENDING_FINAL_RESULT";
  if (stage === "resulted") return "PENDING_CLINICIAN_ACKNOWLEDGEMENT";
  if (stage === "cancelled") return "CANCELLED_OR_ENTERED_IN_ERROR_REQUIRES_REVIEW";
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

export function trackHighRiskFollowup({
  orders = [],
  observations = [],
  diagnosticReports = [],
  rulePack = null,
  now = new Date(),
} = {}) {
  const trajectories = new Map();
  const add = (record, sourceType) => {
    if (!record || typeof record !== "object") return;
    const key = trajectoryKey(record, sourceType);
    const entry = trajectories.get(key) || { key, records: [], evidence: [], sourceTypes: new Set() };
    entry.records.push(record);
    entry.evidence.push(sourceEvidence(record, sourceType));
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

  const items = [];
  for (const trajectory of trajectories.values()) {
    for (const rule of rules) {
      if (!matchesRule(rule, trajectory.records, trajectory.sourceTypes)) continue;
      const stage = deriveStage(trajectory.records);
      const timestamp = stageTimestamp(stage, trajectory.records);
      const dueMinutes = Number(rule?.due_minutes?.[stage]);
      const overdue = Number.isFinite(dueMinutes) && dueMinutes >= 0 && timeValue(timestamp) != null
        ? nowMs - timeValue(timestamp) > dueMinutes * 60_000
        : null;
      const representative = trajectory.records.find((record) => record.name || record.title || record.test_name || record.study_name) || trajectory.records[0];
      items.push({
        tracking_id: `${rule.rule_id}:${trajectory.key}`,
        rule_id: rule.rule_id,
        kind: rule.kind || "unknown",
        label: representative?.name || representative?.title || representative?.test_name || representative?.study_name || recordCode(representative) || "未命名检查检验",
        code: recordCode(representative) || null,
        stage,
        stage_timestamp: timestamp,
        required_stages: rule.required_stages,
        gap: gapForStage(stage),
        overdue,
        due_minutes: Number.isFinite(dueMinutes) ? dueMinutes : null,
        source_reported_high_risk: trajectory.records.some(isExplicitCritical),
        evidence: trajectory.evidence,
      });
    }
  }

  const deduplicated = [...new Map(items.map((item) => [item.tracking_id, item])).values()];
  return {
    schema_version: "medcius.high-risk-followup.v1",
    rule_pack: rulePack ? {
      pack_id: rulePack.pack_id,
      version: rulePack.version,
      sha256: rulePack.sha256 || null,
      data_class: rulePack.data_class,
    } : null,
    rule_status: configuredRules.length > 0 ? "configured" : "source_flags_only",
    interpretation: deduplicated.length > 0
      ? "tracked_high_risk_items_present"
      : "none_identified_from_available_rules_and_sources",
    items: deduplicated,
    counts: {
      total: deduplicated.length,
      open: deduplicated.filter((item) => item.stage !== "acknowledged" && item.stage !== "cancelled").length,
      acknowledged: deduplicated.filter((item) => item.stage === "acknowledged").length,
      overdue: deduplicated.filter((item) => item.overdue === true).length,
    },
  };
}
