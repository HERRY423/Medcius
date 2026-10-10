// Data visibility, never a clinical negative or an independent critical-value monitor.
const time = value => typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export function assessCriticalVisibility({ sources = [], asOf, flaggedCount = null } = {}) {
  const cutoff = time(asOf);
  const coverage = (Array.isArray(sources) ? sources : []).map(source => {
    const watermark = time(source.synchronized_through), fetched = time(source.fetched_at);
    const reasons = [];
    if (!["available", "available_empty"].includes(source.status)) reasons.push("SOURCE_UNAVAILABLE_OR_UNKNOWN");
    if (source.query_read_complete !== true) reasons.push("QUERY_COMPLETENESS_UNKNOWN");
    if (cutoff == null || fetched == null || watermark == null) reasons.push("SYNC_TIME_UNKNOWN");
    else {
      if (watermark > fetched) reasons.push("SYNC_TIME_INCONSISTENT");
      if (watermark < cutoff) reasons.push("UPSTREAM_BEHIND_SNAPSHOT");
    }
    return { connector_id: source.connector_id ?? null, kind: source.kind ?? source.source_type ?? null,
      source_status: source.status ?? "unknown", fetched_at: source.fetched_at ?? null,
      synchronized_through: source.synchronized_through ?? null, query_read_complete: source.query_read_complete === true,
      reasons, evidence_status: "connector_reported_not_independently_verified" };
  });
  const reasons = [...new Set(coverage.flatMap(s => s.reasons))];
  if (!coverage.some(s => ["lis", "observations", "observation"].includes(s.kind))) reasons.push("LAB_SOURCE_COVERAGE_UNKNOWN");
  const count = Number.isInteger(flaggedCount) && flaggedCount >= 0 ? flaggedCount : null;
  return { schema_version: "medcius.critical-visibility.v1", as_of: asOf ?? null,
    observed_flagged_count: count, hospital_critical_absence: "NOT_ESTABLISHED", can_exclude_critical_values: false,
    coverage_status: reasons.length ? "incomplete_or_unknown" : "reported_snapshot_coverage_only",
    reasons, sources: coverage,
    message: count == null ? "本资料包不能用于排除危急值；请核对来源同步范围及各条原始结果。"
      : count ? "已返回资料含危急标记，需核对；仍不能排除未同步或未返回的其他危急结果。"
      : "当前返回资料未检出危急标记；不能据此认定无危急值或患者安全。",
    action: "请在院内 LIS/危急值通知通道核对最新结果；本摘要不替代医院既有危急值通知与闭环制度。",
    monitoring_status: "snapshot_only_not_live_monitor" };
}
