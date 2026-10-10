// Freeze source-attributed discharge documents; this does not authenticate clinical approval.
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { assertExplicitFeedOwnership, toModelSafe, referenceTail } from "./clinical-boundary.mjs";
import { scanStructuredValue } from "../servers/phiguard/src/lib.mjs";
import { resolveRecordVersions, lifecycleTime } from "./record-lifecycle.mjs";

export function readDischargeDocuments(records, { context, asOf, kind }) {
  if (!Array.isArray(records)) throw new Error("FAIL_CLOSED: Discharge documents must be an array");
  const excluded = [], candidates = [];
  for (const original of records) {
    if (!original || typeof original !== "object" || Array.isArray(original)) throw new Error("FAIL_CLOSED: Invalid discharge document");
    if (scanStructuredValue(original).total > 0) throw new Error("FAIL_CLOSED_PHI: Discharge document requires PHI Guard");
    assertExplicitFeedOwnership(context, [original, { patient_id: original.source_patient_id || referenceTail(original.subject?.reference),
      encounter_id: original.source_encounter_id || referenceTail(original.encounter?.reference), tenant_id: original.source_tenant_id }], kind);
    const record = toModelSafe(structuredClone(original));
    const source = record.source_reference;
    let reason = [record.id, source?.resource_id, source?.source_system].some(v => typeof v !== "string" || !v.trim()) ? "SOURCE_REFERENCE_MISSING" : null;
    const recorded = lifecycleTime(record.recorded_at);
    if (recorded == null || typeof record.recorded_at !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(record.recorded_at)) reason ||= "SOURCE_TIME_MISSING_OR_INVALID";
    if (recorded > lifecycleTime(asOf)) reason ||= "future";
    if (record.updated_at != null && lifecycleTime(record.updated_at) == null) reason ||= "SOURCE_TIME_INVALID";
    if (reason) { excluded.push({ source_id: record.id ?? null, reason }); continue; }
    // Whole-document content participates in conflict detection, including links, owners and plans.
    candidates.push({ ...record, source_record_id: source.resource_id, source_system: source.source_system,
      timestamp: record.recorded_at, text: canonicalJson(record), _document: record });
  }
  const resolved = resolveRecordVersions(candidates, { sourceType: kind, now: asOf });
  const current = [];
  for (const entry of resolved.entries) {
    if (!entry.is_current) { excluded.push({ source_id: entry.record._document.id, reason: entry.selection_status }); continue; }
    const record = entry.record._document;
    if (["cancelled", "entered_in_error"].includes(entry.lifecycle.result_status) || ["cancelled", "canceled", "entered-in-error", "entered_in_error", "withdrawn", "revoked", "stopped"].includes(record.status)) {
      excluded.push({ source_id: record.id, reason: "source_withdrawn" }); continue;
    }
    current.push({ record, evidence: { source_type: kind, source_id: record.id, source_reference: record.source_reference,
      version_id: record.version_id ?? null, recorded_at: record.recorded_at,
      content_sha256: sha256Hex(canonicalJson(record)), authority: "source_attributed_not_clinical_signoff",
      ownership_basis: record.patient_id && record.encounter_id ? "source_record" : "feed_context" } });
  }
  current.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  excluded.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return { current, excluded, snapshot_digest: sha256Hex(canonicalJson({ current, excluded })) };
}
