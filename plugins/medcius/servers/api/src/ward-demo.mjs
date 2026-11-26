import { getCardiologyMultiSourceFeeds } from "../../fhir/sandbox/hospital-cardiology-sandbox.mjs";
import { HospitalAgentAdapter, getPreRoundResearchSnapshot } from "../../../lib/hospital-agent-adapter.mjs";
import { wardReviewRow } from "../../../lib/ward-review-row.mjs";

// The clinical service reads the audited archive. This cache contains only fixed synthetic fixtures.
const timeZone = "Asia/Shanghai";
const dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
let cache;
export function syntheticWardView(position = null, patientContext = null) {
  const now = new Date(), date = dateFormat.format(now);
  if (cache?.ward_date !== date) {
    const asOf = now.toISOString();
    const entries = getCardiologyMultiSourceFeeds({ now: asOf }).map((feeds, i) => {
      const context = { tenant_id: "synthetic-demo", doctor_id: "synthetic-reviewer", patient_id: feeds.patient.id,
        encounter_id: feeds.encounter?.id ?? "synthetic-encounter-" + (i+1), as_of: asOf, timezone: timeZone,
        specialty_rule_pack_id: "cardiology-inpatient-sandbox" };
      const result = HospitalAgentAdapter.executePreRoundWorkflow({ host: "sandbox", context, dataFeeds: feeds });
      const { engineInput, replayInput } = getPreRoundResearchSnapshot(result);
      const row = wardReviewRow(result.summary, replayInput, engineInput);
      return { ...row, position: i + 1, bed_number: feeds.patient.bed_number?.replace(/床$/, "") ?? null, status: "captured",
        source_coverage: "incomplete_or_unknown", worklist_counts: { record_changes: { displayed: new Set(row.worklist.change_ids).size },
          pending_items: Object.values(row.worklist.pending).flat().length, followup_open_or_unknown: row.worklist.unclosed_followup.length } };
    });
    cache = { synthetic: true, ward_date: date, time_zone: timeZone, as_of: asOf, status: "captured", entries };
  }
  if (patientContext) {
    position = cache.entries.find(r => ["patient_id","encounter_id","tenant_id"].every(k => r.context[k] === patientContext[k]))?.position ?? 0;
  }
  if (position !== null && (!Number.isSafeInteger(position) || position < 1 || position > cache.entries.length)) return null;
  return { ...cache, entries: position === null ? cache.entries.map(({ position, bed_number, status, source_coverage, worklist_counts }) =>
    ({ position, bed_number, status, source_coverage, worklist_counts })) : [cache.entries[position - 1]] };
}
