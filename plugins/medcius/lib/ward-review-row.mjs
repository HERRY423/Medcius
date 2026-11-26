import { projectPreRoundFacts } from "./preround-fact-pack.mjs";
import { resolveTextAnchor } from "./evidence-anchors.mjs";

// A review is always anchored in the guarded, frozen source at the batch cutoff.
// Never use a live resource bearing the same ID to supply historical evidence.
const feeds = { observation: "lis", clinicalnote: "notes", note: "notes", diagnosticreport: "pacs",
  diagnostic_report: "pacs", medicationrequest: "his_orders", medication: "his_orders",
  servicerequest: "his_orders", order: "his_orders", nursingrecord: "nis", nursing: "nis" };
const sourceFields = ["id", "code", "test_code", "test_name", "name", "title", "drug_name", "value", "result_value", "unit",
  "ref_low", "ref_high", "reference_range_text", "status", "result_status", "sample_time", "effective_time", "timestamp",
  "drug_code", "drug_code_system", "order_id", "actual_dose", "dose_unit", "execution_status", "route", "specimen_type",
  "method_code", "assay_id", "assay_version", "assigned_to_id", "followup_due_at", "issued", "resulted_at", "authored_on", "scheduled_time", "performed_at", "version_id", "source_system", "impression", "conclusion", "dosage"];

export function wardReviewRow(summary, replayInput, engineInput) {
  const pack = projectPreRoundFacts(summary, replayInput.context);
  const workIds = new Set([...pack.worklist.change_ids, ...Object.values(pack.worklist.pending).flat()]);
  const sources = replayInput.dataFeeds;
  function evidence(ref) {
    const kind = String(ref.source_type ?? "").toLowerCase();
    const group = feeds[kind];
    const version = ref.version_id ?? ref.source_version;
    let candidates = sources[group] ?? [];
    if (kind === "medicationadministration") candidates = (sources.his_orders ?? []).flatMap(order =>
      order.record_kind === "administration" ? [order] : (order.administrations ?? []).map(e => ({ ...e,
        source_system: e.source_system ?? e._source?.system ?? order._source?.system ?? null })));
    const matches = candidates.filter(row => ref.source_id && row.id === ref.source_id
      && (ref.order_id == null || row.order_id === ref.order_id)
      && (version == null || version === (row.version_id ?? row.meta?.versionId ?? row.source_version))
      && (ref.source_system == null || ref.source_system === (row.source_system ?? row._source?.system)));
    const anchor = ref.text_anchor ?? ref.highlight;
    if (anchor) {
      const notes = (engineInput.notes ?? []).filter(row => resolveTextAnchor(anchor, row).highlight);
      if (notes.length === 1) return { source_id: ref.source_id, status: "verified_span", version_id: anchor.version_id,
        text: notes[0][anchor.field], start: anchor.start, end: anchor.end };
    } else if (matches.length === 1) {
      const row = matches[0];
      return { source_id: ref.source_id, status: "linked_record",
        fields: Object.fromEntries(sourceFields.filter(k => row[k] != null && typeof row[k] !== "object").map(k => [k, row[k]])) };
    }
    return { source_id: ref.source_id ?? null, status: "source_review_required" };
  }
  const facts = [], withheld = new Set(pack.held.map(item => item.item_id));
  for (const fact of pack.facts.filter(f => workIds.has(f.item_id))) {
    const refs = fact.evidence.source_references?.length ? fact.evidence.source_references : [fact.evidence];
    const resolved = refs.map(evidence);
    if (resolved.every(s => s.status !== "source_review_required")) facts.push({ ...fact, sources: resolved });
    else withheld.add(fact.item_id);
  }
  const visible = new Set(facts.map(f => f.item_id));
  const worklist = { ...pack.worklist, change_ids: pack.worklist.change_ids.filter(id => visible.has(id)),
    pending: Object.fromEntries(Object.entries(pack.worklist.pending).map(([k, ids]) => [k, ids.filter(id => visible.has(id))])),
    unclosed_followup: pack.worklist.unclosed_followup.map(t => ({ ...t, sources: t.evidence.map(evidence) })) };
  const electrolyteTrends = (summary.blocks.temporal_analysis?.electrolyte_trends ?? []).map(row => {
    const sources = row.source_references.map(evidence);
    return sources.some(s => s.status === "source_review_required")
      ? { metric: row.metric, status: "not_evaluable", reason: "FROZEN_PAIR_UNVERIFIED", delta: null, sources }
      : { ...row, sources };
  });
  const changes = summary.blocks.what_changed;
  const administrationDays = (changes.observed_antibiotic_days ?? changes.antibiotic_duration_alerts ?? []).map(row => {
    const refs = row.source_references ?? [{ source_type: "MedicationRequest", source_id: row.source_order_id }, ...(row.administration_evidence ?? [])];
    const sources = refs.map(evidence);
    const verified = row.duration_basis === "observed_administration_calendar_days" && sources.every(s => s.status === "linked_record");
    return { drug_name: row.drug_name, days: verified ? row.duration_days : null, sources };
  });
  return { context: pack.context, facts, worklist, withheld_count: withheld.size, critical_visibility: pack.critical_visibility,
    electrolyte_trends: electrolyteTrends, administration_days: administrationDays };
}
