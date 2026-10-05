// Source lifecycle fields are factual source metadata. Fetch time is deliberately
// excluded: it cannot establish when a result was created, amended or received.
export const SOURCE_LIFECYCLE_FIELDS = Object.freeze([
  "status", "source_status", "result_status", "version_id", "source_record_id",
  "event_time", "recorded_at", "updated_at", "resulted_at", "cancelled_at",
  "acknowledged_at", "acknowledged_version_id", "acknowledged_result_version",
  "supersedes_id", "supersedes_version_id", "change_type", "end_date", "changed_at",
]);

export function sourceLifecycle(row = {}) {
  const lifecycle = {};
  for (const field of SOURCE_LIFECYCLE_FIELDS) {
    if (Object.hasOwn(row, field)) lifecycle[field] = row[field] ?? null;
  }
  lifecycle.source_status = row.source_status ?? row.status ?? row.report_status ?? row.order_status ?? null;
  lifecycle.version_id = row.version_id ?? row.source_record_version ?? row.version ?? null;
  lifecycle.recorded_at = row.recorded_at ?? null;
  lifecycle.updated_at = row.updated_at ?? null;
  lifecycle.acknowledged_version_id = row.acknowledged_version_id ?? row.acknowledged_result_version ?? null;
  return lifecycle;
}

export function fhirLifecycle(resource = {}) {
  return {
    source_status: resource.status ?? null,
    version_id: resource.meta?.versionId ?? null,
    resource_type: resource.resourceType ?? null,
    recorded_at: null,
    updated_at: resource.meta?.lastUpdated ?? null,
    event_time: resource.effectiveDateTime ?? resource.effectiveInstant ?? resource.effectivePeriod?.start ?? null,
    resulted_at: resource.issued ?? null,
  };
}

// Preserve the original HL7 value in status/source_status; only the separate
// normalized result_status uses this explicit map. Unknown codes remain null.
export function hl7ResultStatus(code) {
  return ({ F: "final", C: "corrected", D: "entered-in-error", P: "preliminary",
    R: "preliminary", I: "registered", X: "cancelled", U: "final", W: "entered-in-error" })[String(code ?? "").toUpperCase()] ?? null;
}
