import { resolveTextAnchor } from "./evidence-anchors.mjs";
import { assessCriticalVisibility } from "./critical-visibility.mjs";
// Mechanical consistency only: this does not establish clinical correctness.
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { deepFreeze as freeze } from "../servers/shared/immutable.mjs";

const fail = code => { throw new Error(`OUTPUT_CONSISTENCY_FAILED: ${code}`); };
const equal = (a, b, code) => { if (canonicalJson(a) !== canonicalJson(b)) fail(code); };
export function detachedFrozenOutput(value) {
  const copy = structuredClone(value);
  freeze(copy);
  return copy;
}

export function assertEvolutionConsistency(d) {
  const items = d.selectable_items, b = d.blocks;
  if (!Array.isArray(items) || !b) fail("SUMMARY_SHAPE");
  if (d.total_items_count !== items.length || new Set(items.map(i => i.id)).size !== items.length) fail("ITEM_COUNT_OR_ID");
  const changes = b.what_changed, pending = b.whats_pending;
  const expected = [...b.record_changes.items, ...items.filter(i => i.alignment), ...(changes.vitals_and_fluids ? [changes.vitals_and_fluids] : []),
    ...changes.clinical_symptoms, ...changes.abnormal_labs, ...changes.imaging_changes,
    ...Object.values(changes.medication_diff).flat(), ...pending.pending_reports, ...pending.pending_orders, ...pending.scheduled_consults,
    ...b.rule_reminders, ...b.data_gaps];
  equal(expected, items, "PANELS_VS_SELECTABLE_ITEMS");
  equal(items.filter(i => i.alignment).map(i => i.alignment), b.structured_multisource_alignment, "ALIGNMENT_PANELS");
  equal(b.evidence.map(e => e.item_id), items.map(i => i.id), "EVIDENCE_COVERAGE");
  for (let i = 0; i < items.length; i++) for (const key of ["source_type", "source_id", "source_system", "version_id", "span", "timestamp"]) {
    equal(b.evidence[i][key] ?? null, items[i][key] ?? null, `EVIDENCE_${key}`);
  }
  equal(changes.critical_values, d.critical_values, "CRITICAL_PANELS");
  if (d.critical_visibility) equal(d.critical_visibility, assessCriticalVisibility({ sources: b.source_availability,
    asOf: d.generated_at, flaggedCount: d.critical_values.length }), "CRITICAL_VISIBILITY");
  for (const c of d.critical_values) {
    const record = b.record_changes.items.find(r => r.selection_status === "current" && r.source_type === "observation"
      && r.source_id === c.observation_id && r.source_system === c.source_system && r.version_id === c.version_id);
    if (record) equal(record.result_status, c.result_status, "CRITICAL_LIFECYCLE");
  }
  return d;
}

function verifyTextEvidence(evidence, record) {
  if (evidence?.text_anchor && resolveTextAnchor(evidence.text_anchor, record).highlight === null) fail("TEXT_ANCHOR_SNAPSHOT_MISMATCH");
}

export function assertConsultConsistency(d) {
  const { dossier_sha256, ...payload } = d;
  if (dossier_sha256) equal(dossier_sha256, sha256Hex(canonicalJson(payload)), "CONSULT_CONTENT_DIGEST");
  equal(d.views.glance.purpose, d.header.purpose, "CONSULT_PURPOSE");
  equal(d.views.glance.question, d.header.question, "CONSULT_QUESTION");
  equal(d.views.glance.data_gaps, d.data_gaps, "CONSULT_GAPS");
  equal(d.views.drilldown.snapshot_id, d.snapshot_id, "CONSULT_SNAPSHOT");
  for (const [key, rows] of Object.entries(d.views.drilldown.sections)) {
    equal(rows, d[key], `CONSULT_SECTION_${key}`);
    const digest = d.views.digest[key];
    equal(d.views.glance.counts[key], rows.length, "CONSULT_COUNT");
    equal(digest.total, rows.length, "CONSULT_TOTAL");
    equal(digest.items, rows.filter((r, i) => i < 5 || r.source_critical), "CONSULT_DIGEST");
    equal(digest.remaining, rows.length - digest.items.length, "CONSULT_REMAINING");
    for (const row of rows) if (!d.evidence_records.some(e => e.evidence.content_sha256 === row.evidence.content_sha256
      && e.evidence.source_id === row.evidence.source_id && e.selection_status === "current")) fail("CONSULT_SOURCE");
  }
  for (const row of d.relevant_clinical_notes) verifyTextEvidence(row.evidence, d.evidence_records.find(e => e.evidence.content_sha256 === row.evidence.content_sha256)?.record);
  return d;
}

export function assertDischargeConsistency(d) {
  const { packet_digest, ...payload } = d;
  if (packet_digest) equal(packet_digest, sha256Hex(canonicalJson(payload)), "DISCHARGE_CONTENT_DIGEST");
  equal(d.documentation_summary.findings_count, d.findings.length, "DISCHARGE_FINDINGS_COUNT");
  for (const row of d.source_notes || []) verifyTextEvidence(row.evidence, row.record);
  if (d.clinical_suitability.assessed !== false || d.clinical_suitability.is_suitable_for_discharge !== null || d.readiness_verdict.is_ready !== null) fail("DISCHARGE_DECISION_BOUNDARY");
  for (const [key, domain] of Object.entries(d.domains)) {
    equal(domain.findings, d.findings.filter(f => f.domain === key), "DISCHARGE_FINDINGS");
    equal(domain.status, !domain.items.length ? "unknown" : domain.findings.length ? "gaps_present" : "fields_present_in_supplied_records", "DISCHARGE_DOMAIN_STATUS");
  }
  for (const r of d.domains.results.items) if (r.result_review_status === "closed" && (!['final', 'revised'].includes(r.result_status) || r.review_status !== "acknowledged")) fail("DISCHARGE_RESULT_CLOSURE");
  return d;
}

export function assertHandoverConsistency(d) {
  const { patient_id, generated_at, packet_digest, events_as_of, handover_events, event_history_digest, responsibility, boundary, ...packet } = d;
  equal(packet_digest, sha256Hex(canonicalJson(packet)), "HANDOVER_PACKET");
  equal(event_history_digest, sha256Hex(canonicalJson(handover_events)), "HANDOVER_HISTORY");
  equal(patient_id, d.context.patient_id, "HANDOVER_PATIENT");
  equal(generated_at, d.as_of, "HANDOVER_TIME");
  if (responsibility.event_history_completeness !== "host_verified_complete" && responsibility.current_responsible_doctor_id !== null) fail("HANDOVER_RESPONSIBILITY_UNKNOWN");
  const rows = [...d.sbar.background.source_notes, ...d.sbar.assessment.source_observations, ...d.sbar.assessment.diagnostic_reports,
    ...d.sbar.assessment.medication_orders, ...d.sbar.assessment.nursing_records, ...d.sbar.recommendation.scheduled_follow_ups];
  for (const row of rows) verifyTextEvidence(row.evidence, row.record);
  for (const change of d.record_changes) {
    const row = rows.find(r => r.evidence.content_sha256 === change.evidence.content_sha256 && r.evidence.source_type === change.evidence.source_type);
    if (row) for (const key of ["result_status", "change_type", "version_id"]) equal(row.lifecycle[key], change.lifecycle[key], `HANDOVER_${key}`);
  }
  return d;
}
