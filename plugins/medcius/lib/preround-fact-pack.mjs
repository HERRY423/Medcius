import { assertEvolutionConsistency, detachedFrozenOutput } from "./output-consistency.mjs";
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { wardInstant } from "./ward-roster.mjs";

const linkedAnchors = new Set(["resource_linked", "verbatim_verified", "sources_linked"]);
const fields = ["presence", "temporality", "experiencer", "assertion", "result_status", "change_type", "selection_status", "arrival_status",
  "event_time", "recorded_at", "current_value", "unit", "has_reference_range", "ref_low", "ref_high", "is_abnormal", "is_critical",
  "trend_direction", "drug_name", "dosage", "previous_dosage", "route", "frequency", "report_name", "order_name", "requested_time",
  "owner_id", "due_at", "source_status", "status_desc", "findings", "impression", "consult_department", "purpose"];

// Project an already guarded, coherent pre-round output for human review in
// the host. Clinical narratives and action suggestions are outside this packet.
export function projectPreRoundFacts(summary, context) {
  assertEvolutionConsistency(summary);
  const cutoff = wardInstant(context.as_of);
  if (cutoff == null || summary.patient.id !== context.patient_id || wardInstant(summary.generated_at) !== cutoff) {
    throw new Error("FACT_PACK_CONTEXT_MISMATCH");
  }
  const blocks = summary.blocks;
  const sources = new Map(blocks.evidence.map(item => [item.item_id, item]));
  const facts = [], held = [];
  for (const item of summary.selectable_items) {
    if (!["FACT", "CRITICAL"].includes(item.category)) continue;
    const evidence = sources.get(item.id);
    if (!linkedAnchors.has(evidence?.anchor_status) || (item.selection_status != null && item.selection_status !== "current")) {
      held.push({ item_id: item.id, state: item.selection_status ?? evidence?.anchor_status ?? "unknown" });
      continue;
    }
    facts.push({ item_id: item.id, label: evidence.title, verbatim: evidence.text_anchor?.exact ?? evidence.highlight?.exact ?? null,
      attributes: Object.fromEntries(fields.filter(key => item[key] !== undefined).map(key => [key, item[key]])), evidence });
  }
  const factIds = new Set(facts.map(item => item.item_id));
  const changed = blocks.what_changed;
  const worklist = {
    change_ids: [...blocks.record_changes.items, ...changed.clinical_symptoms, ...changed.abnormal_labs,
      ...changed.imaging_changes, ...Object.values(changed.medication_diff).flat()].filter(item => factIds.has(item.id)).map(item => item.id),
    pending: Object.fromEntries(["pending_reports", "pending_orders", "scheduled_consults"].map(key => [key,
      blocks.whats_pending[key].filter(item => factIds.has(item.id)).map(item => item.id)])),
    unclosed_followup: blocks.high_risk_followup.items.flatMap(item => {
      const evidence = item.evidence.filter(source => source.source_id);
      if (item.closure_status === "closed" || !evidence.length) return [];
      return [{ tracking_id: item.tracking_id, stage: item.stage, closure_status: item.closure_status,
        label: item.label, owner_id: item.owner_id ?? null, ownership_status: item.ownership_status ?? "assignment_unverified",
        due_at: item.due_at ?? null, deadline_basis: item.deadline_basis ?? "unknown", overdue: item.overdue ?? null, review_status: item.review_status, evidence }];
    }),
  };
  const report = { schema_version: "medcius.pre-round-fact-pack.v1", context: {
    tenant_id: context.tenant_id, patient_id: context.patient_id, encounter_id: context.encounter_id, as_of: new Date(cutoff).toISOString() },
    time_window: summary.time_window, summary_sha256: sha256Hex(canonicalJson(summary)),
    facts, worklist, held, gaps: blocks.data_gaps.map(gap => ({ item_id: gap.id, gap_type: gap.gap_type,
      source_id: gap.source_id ?? null })), source_availability: blocks.source_availability,
    critical_visibility: summary.critical_visibility, writeback: false };
  return detachedFrozenOutput({ ...report, packet_sha256: sha256Hex(canonicalJson(report)) });
}
