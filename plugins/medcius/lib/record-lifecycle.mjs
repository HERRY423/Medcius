// Source lifecycle, occurrence time, and arrival are independent axes.
// No clock/fetch-time fallback, inferred finality, or clinical interpretation.
import { canonicalJson } from "../servers/shared/crypto.mjs";

const lower = (value) => String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
const first = (...values) => values.find((value) => value != null && value !== "") ?? null;
const measurements = (record) => Object.fromEntries(["temperature", "systolic_bp", "diastolic_bp", "heart_rate", "spo2", "respiratory_rate", "consciousness",
  "intake_ml", "output_ml", "oral_intake_ml", "iv_intake_ml", "urine_output_ml", "drain_output_ml"].map((key) => [key, record[key] ?? null]));
export const lifecycleTime = (value) => value == null || value === "" || typeof value === "boolean" ? null
  : Number.isFinite(new Date(value).getTime()) ? new Date(value).getTime() : null;

export function classifyRecordLifecycle(record = {}, { sourceType = "observation", now = new Date(), cutoffTime = null } = {}) {
  const nowMs = lifecycleTime(now);
  const cutoff = lifecycleTime(cutoffTime);
  if (nowMs == null) throw new Error("LIFECYCLE_INVALID_NOW");
  const timeStatus = (value) => {
    if (value == null || value === "") return "unknown";
    const time = lifecycleTime(value);
    return time == null ? "invalid" : time > nowMs ? "future" : cutoff != null && time < cutoff ? "historical" : "in_window";
  };
  const sourceStatus = first(record.source_status, record.status, record.report_status, record.result_status);
  const status = lower(first(record.result_status, record.status, record.report_status));
  const isOrder = ["order", "medication", "ServiceRequest", "MedicationRequest"].includes(sourceType);
  let resultStatus = "unknown";
  if (["cancelled", "canceled", "revoked", "discontinued", "stopped"].includes(status)) resultStatus = "cancelled";
  else if (["entered-in-error", "deleted"].includes(status)) resultStatus = "entered_in_error";
  else if (["amended", "corrected", "revised", "appended"].includes(status)) resultStatus = "revised";
  else if (["final", "completed"].includes(status)) resultStatus = "final";
  else if (["preliminary", "partial"].includes(status)) resultStatus = "preliminary";
  else if (["collected", "specimen-collected"].includes(status)) resultStatus = "collected";
  else if (["scheduled"].includes(status)) resultStatus = "scheduled";
  else if (isOrder && ["active", "draft", "ordered", "pending-execution", "on-hold"].includes(status)) resultStatus = "ordered";
  // registered/in-progress/pending do not prove collection or completion.
  const eventTime = first(record.event_time, record.timing?.t_event, record.effectiveDateTime, record.effective_time,
    record.sample_time, record.collected_at, record.study_time, record.occurred_at, record.timestamp,
    isOrder ? record.authored_on : null, isOrder ? record.ordered_at : null, isOrder ? record.start_time : null);
  const recordedAt = first(record.recorded_at, record.received_at, record.ingested_at, record.timing?.t_record, record.recorded);
  const updatedAt = first(record.revised_at, record.corrected_at, record.amended_at, record.updated_at, record.meta?.lastUpdated);
  const changeTime = resultStatus === "cancelled" || resultStatus === "entered_in_error"
    ? first(record.cancelled_at, record.canceled_at, record.stopped_at, record.end_date, record.changed_at, updatedAt)
    : resultStatus === "revised" ? first(updatedAt, record.resulted_at, record.issued)
    : ["final", "preliminary"].includes(resultStatus) ? first(record.resulted_at, record.issued, record.finalized_at, eventTime)
    : first(isOrder ? record.changed_at : null, eventTime);
  const arrivalStatus = timeStatus(recordedAt) === "future" ? "future"
    : timeStatus(eventTime) === "historical" && timeStatus(recordedAt) === "in_window" ? "late_record"
    : lifecycleTime(eventTime) != null && lifecycleTime(recordedAt) != null && lifecycleTime(recordedAt) >= lifecycleTime(eventTime)
      ? "not_late" : "unknown";
  const changeType = ({ final: isOrder ? "no_result" : first(record.resulted_at, record.issued, record.finalized_at) != null ? "new_result" : "unknown", revised: "revision", cancelled: "cancellation",
    entered_in_error: "entered_in_error", preliminary: "preliminary_result", ordered: "no_result", scheduled: "no_result", collected: "no_result" })[resultStatus] || "unknown";
  return {
    source_id: first(record.id, record.source_record_id, record._source?.record_id), source_type: sourceType,
    record_identity: first(record.source_record_id, record.id, record._source?.record_id),
    source_system: first(record._source?.system, record.source_system), source_status: sourceStatus,
    version_id: first(record.version_id, record.meta?.versionId), result_status: resultStatus, change_type: changeType,
    event_time: eventTime, event_time_status: timeStatus(eventTime), recorded_at: recordedAt, recorded_time_status: timeStatus(recordedAt),
    source_updated_at: updatedAt, change_time: changeTime, change_time_status: timeStatus(changeTime), arrival_status: arrivalStatus,
    change_time_basis: changeTime == null ? "unknown" : changeTime === eventTime ? "event_time_only" : "source_transition_time",
    supersedes_id: first(record.supersedes_id, record.replaces_id), supersedes_version_id: first(record.supersedes_version_id, record.previous_version_id),
    acknowledged_at: record.acknowledged_at ?? null, acknowledged_version_id: first(record.acknowledged_version_id, record.acknowledged_version),
    is_new_since_previous: null,
  };
}

export function lifecycleFields(record = {}) {
  const keys = ["source_status", "result_status", "version_id", "meta", "recorded_at", "received_at", "ingested_at", "event_time", "timing",
    "updated_at", "revised_at", "corrected_at", "amended_at", "cancelled_at", "canceled_at", "finalized_at", "supersedes_id", "supersedes_version_id",
    "replaces_id", "previous_version_id", "acknowledged_version_id", "acknowledged_version", "acknowledged_result_id", "source_system", "source_record_id",
    "end_date", "changed_at", "start_time", "stopped_at", "study_time", "issued", "resulted_at", "collected_at", "specimen_received_at",
    "scheduled_time", "scheduled_at", "authored_on", "ordered_at", "effective_time", "effectiveDateTime", "sample_time", "timestamp", "occurred_at",
    "patient_id", "encounter_id", "tenant_id"];
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

const normalizedValue = (value) => value == null || value === "" ? null : typeof value !== "boolean" && String(value).trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : value;
const normalizedCode = (record) => first(typeof record.code === "string" ? record.code : record.code?.coding?.[0]?.code,
  record.code?.text, record.test_code, record.order_code);

function referenceRanges(record) {
  const source = Array.isArray(record.referenceRange) ? record.referenceRange : record.referenceRange ? [record.referenceRange] : [];
  const fallback = {
    low: { value: first(record.ref_low, record.reference_low) }, high: { value: first(record.ref_high, record.reference_high) },
    text: first(record.reference_range_text, record.ref_text, record.reference_range),
  };
  const ranges = source.length ? source : [fallback];
  return ranges.map((range) => ({
    low: normalizedValue(first(range.low?.value, typeof range.low === "number" ? range.low : null, record.ref_low)),
    high: normalizedValue(first(range.high?.value, typeof range.high === "number" ? range.high : null, record.ref_high)),
    low_unit: first(range.low?.unit, range.low?.code), high_unit: first(range.high?.unit, range.high?.code),
    text: first(range.text, record.reference_range_text, record.ref_text, record.reference_range),
    type: range.type ?? null, applies_to: range.appliesTo ?? null, age: range.age ?? null,
  })).filter((range) => Object.values(range).some((value) => value != null));
}

// Canonical aliases make a raw record and its normalized representation
// comparable, while preserving every field used for clinical display/rules.
function clinicalProjection(record, state) {
  return {
    value: normalizedValue(first(record.value, record.valueQuantity?.value, record.result_value, record.valueString, record.valueInteger)),
    unit: first(record.unit, record.valueQuantity?.unit, record.valueQuantity?.code),
    code: normalizedCode(record), code_system: first(record.code_system, record.code?.coding?.[0]?.system),
    status: state.result_status, text: first(record.text, record.impression, record.impression_text, record.findings),
    reference_ranges: referenceRanges(record),
    critical: record.is_critical === true || record.is_critical_reported === true || lower(record.interpretation) === "critical",
    critical_reason: record.critical_reason ?? null,
    label: first(record.name, record.title, record.test_name, record.study_name, record.drug_name), span: record.span ?? null,
    order_id: first(record.order_id, record.service_request_id, record.based_on_id, record.request_id),
    priority: first(record.priority, record.urgency, record.order_priority),
    drug_name: first(record.drug_name, record.medication), dosage: first(record.dosage, record.dose, record.dosage_instruction),
    previous_dosage: record.previous_dosage ?? null, route: record.route ?? null, frequency: record.frequency ?? null,
    change_type: record.change_type ?? null, stop_reason: record.stop_reason ?? null,
    authored_on: first(record.authored_on, record.start_time), end_date: first(record.end_date, record.stopped_at),
    scheduled_time: first(record.scheduled_time, record.scheduled_at),
    patient_id: record.patient_id ?? null, encounter_id: record.encounter_id ?? null, tenant_id: record.tenant_id ?? null,
    measurements: Object.fromEntries(Object.entries(measurements(record)).map(([key, value]) => [key, normalizedValue(value)])),
  };
}

// Resolve versions of one resource, not separate measurements sharing a test
// code. Identifiers are opaque, and replacement links are resolved transitively.
export function resolveRecordVersions(records = [], options = {}) {
  const nowMs = lifecycleTime(options.now ?? new Date());
  const groups = [];
  const groupIndexes = new Map();
  records.forEach((record, index) => {
    const state = classifyRecordLifecycle(record, options);
    const key = canonicalJson([state.source_system, state.source_type, state.record_identity || `missing-id:${index}`]);
    if (!groupIndexes.has(key)) { groupIndexes.set(key, groups.length); groups.push([]); }
    const group = groups[groupIndexes.get(key)];
    const content = canonicalJson({ state, clinical: clinicalProjection(record, state), acknowledged: record.acknowledged ?? null,
      acknowledged_result_id: first(record.acknowledged_result_id, record.acknowledged_record_id) });
    const duplicate = group.find((entry) => entry.content === content);
    if (duplicate) duplicate.source_records.push(record);
    else group.push({ record, lifecycle: state, content, source_records: [record] });
  });
  const parent = groups.map((_, index) => index);
  const find = (index) => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
  const join = (a, b) => { const rootA = find(a); const rootB = find(b); if (rootA !== rootB) parent[rootB] = rootA; };
  for (let a = 0; a < groups.length; a++) for (let b = a + 1; b < groups.length; b++) {
    const linked = groups[a].some((entry) => groups[b].some((other) => {
      const next = entry.lifecycle, prior = other.lifecycle;
      return next.source_system === prior.source_system && next.source_type === prior.source_type &&
        ((next.supersedes_id != null && [prior.source_id, prior.record_identity].includes(next.supersedes_id)) ||
         (prior.supersedes_id != null && [next.source_id, next.record_identity].includes(prior.supersedes_id)));
    }));
    if (linked) join(a, b);
  }
  const components = new Map();
  groups.forEach((group, index) => { const root = find(index); components.set(root, [...(components.get(root) || []), ...group]); });
  const entries = [];
  for (const group of components.values()) {
    const future = (state) => [state.event_time_status, state.change_time_status, state.recorded_time_status].includes("future") ||
      (lifecycleTime(state.source_updated_at) != null && lifecycleTime(state.source_updated_at) > nowMs);
    const visible = group.filter(({ lifecycle: state }) => !future(state));
    const reasons = [];
    const clinicalContent = (entry) => canonicalJson(clinicalProjection(entry.record, entry.lifecycle));
    const reusedVersion = visible.some((entry, index) => entry.lifecycle.version_id != null && visible.slice(index + 1).some((other) =>
      entry.lifecycle.record_identity === other.lifecycle.record_identity && entry.lifecycle.version_id === other.lifecycle.version_id && clinicalContent(entry) !== clinicalContent(other)));
    if (reusedVersion) reasons.push("SAME_VERSION_CONTENT_CONFLICT");
    const edges = visible.map((candidate, index) => visible.flatMap((other, otherIndex) => {
      if (index === otherIndex) return [];
      const next = candidate.lifecycle, prior = other.lifecycle;
      const idMatches = next.supersedes_id != null && [prior.record_identity, prior.source_id].includes(next.supersedes_id);
      const versionMatches = next.supersedes_version_id != null && next.supersedes_version_id === prior.version_id;
      return ((idMatches && (next.supersedes_version_id == null || versionMatches)) ||
        (versionMatches && next.record_identity === prior.record_identity)) ? [otherIndex] : [];
    }));
    const clock = (entry) => lifecycleTime(first(entry.lifecycle.source_updated_at, entry.lifecycle.change_time));
    const reaches = (from, to, seen = new Set()) => {
      if (seen.has(from)) return false;
      seen.add(from);
      return edges[from].some((next) => next === to || reaches(next, to, seen));
    };
    if (visible.some((_, index) => reaches(index, index))) reasons.push("CYCLIC_VERSION_RELATION");
    if (visible.some((candidate, index) => edges[index].some((priorIndex) => clock(candidate) != null && clock(visible[priorIndex]) != null && clock(candidate) < clock(visible[priorIndex])))) reasons.push("VERSION_TIME_RELATION_CONFLICT");
    let winner = visible.length === 1 && reasons.length === 0 ? visible[0] : null;
    if (visible.length > 1 && reasons.length === 0) {
      const relational = visible.filter((_, index) => visible.every((_, otherIndex) => index === otherIndex || reaches(index, otherIndex)));
      if (relational.length === 1) winner = relational[0];
      else {
        const clocks = visible.map(clock);
        if (clocks.every((value) => value != null)) {
          const max = Math.max(...clocks);
          if (clocks.filter((value) => value === max).length === 1) winner = visible[clocks.indexOf(max)];
        }
        // A source may repeat one unchanged version when its review is added.
        // Resolve that narrow tie without hiding clinical/version conflicts.
        if (!winner && visible[0].lifecycle.version_id != null) {
          const withoutAcknowledgement = (state) => {
            const { acknowledged_at: _at, acknowledged_version_id: _version, ...rest } = state;
            return canonicalJson(rest);
          };
          const sameVersionAndContent = visible.every((entry) => entry.lifecycle.record_identity === visible[0].lifecycle.record_identity
            && entry.lifecycle.version_id === visible[0].lifecycle.version_id
            && clinicalContent(entry) === clinicalContent(visible[0])
            && withoutAcknowledgement(entry.lifecycle) === withoutAcknowledgement(visible[0].lifecycle));
          if (sameVersionAndContent) {
            const acknowledgementState = (entry) => {
              const state = entry.lifecycle;
              if (state.acknowledged_at == null || state.acknowledged_at === "") return entry.record.acknowledged === true ? "invalid" : "absent";
              const time = lifecycleTime(state.acknowledged_at);
              const changed = lifecycleTime(state.change_time);
              const target = first(entry.record.acknowledged_result_id, entry.record.acknowledged_record_id);
              return time != null && changed != null && time >= changed && time <= nowMs
                && state.acknowledged_version_id === state.version_id && entry.record.acknowledged !== false
                && (target == null || [state.source_id, state.record_identity].includes(target)) ? "valid" : "invalid";
            };
            const valid = visible.filter((entry) => acknowledgementState(entry) === "valid");
            if (valid.length && !visible.some((entry) => acknowledgementState(entry) === "invalid")) {
              winner = valid.slice().sort((a, b) => lifecycleTime(b.lifecycle.acknowledged_at) - lifecycleTime(a.lifecycle.acknowledged_at))[0];
            }
          }
        }
      }
      if (!winner) reasons.push("VERSION_ORDER_UNPROVEN");
    }
    if (winner && ["final", "revised"].includes(winner.lifecycle.result_status)
        && visible.some((other) => other !== winner && ["final", "revised"].includes(other.lifecycle.result_status) && clinicalContent(other) !== clinicalContent(winner))) {
      const revised = classifyRecordLifecycle({ ...winner.record, status: "corrected", result_status: "corrected" }, options);
      winner.lifecycle = { ...winner.lifecycle, change_type: "revision", change_time: revised.change_time, change_time_status: revised.change_time_status };
      if (future(winner.lifecycle)) { winner = null; reasons.push("VERSION_UPDATE_OUTSIDE_AS_OF"); }
    }
    for (const entry of group) {
      const { content: _content, ...publicEntry } = entry;
      entries.push({ ...publicEntry,
        selection_status: future(entry.lifecycle) ? "future" : !winner ? "conflict" : entry === winner ? "current" : "superseded",
        selection_reasons: [...reasons], is_current: entry === winner });
    }
  }
  return { entries, current_records: entries.filter((entry) => entry.is_current).map((entry) => entry.record) };
}

export function describeRecordLifecycle(state, label = "记录") {
  const text = {
    new_result: state.change_time_basis === "event_time_only" ? `${label}：来源标记为正式结果，未提供独立出具时间；不据此断言首次新增。` : `${label}：来源出具结果，人工确认情况需单独核对。`,
    revision: `${label}：来源修订结果；既往确认不能自动覆盖本次修订。`,
    cancellation: `${label}：来源已取消/撤销；不表示已执行或已完成人工复核。`,
    entered_in_error: `${label}：来源标记录入错误；原结果不再作为当前有效结果。`,
    preliminary_result: `${label}：来源为初步结果，正式结果尚未确认。`,
    no_result: `${label}：来源状态为 ${state.source_status}，不据此推断最终结果。`,
    unknown: state.result_status === "final" ? `${label}：来源标记为正式结果，但独立出具时间未知，不能断言本窗口新增；人工确认需单独核对。`
      : `${label}：来源状态未知或未识别，无法确认结果与闭环阶段。`,
  }[state.change_type];
  return `${text}${state.arrival_status === "late_record" ? ` 迟到记录：事件时间 ${state.event_time}，记录/接收时间 ${state.recorded_at}；不作为本窗口新发生的病情变化。` : ""}${["unknown", "invalid"].includes(state.change_time_status) ? " 状态变化时间未能确认。" : ""}`;
}
