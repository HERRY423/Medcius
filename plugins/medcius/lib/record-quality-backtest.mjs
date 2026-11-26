import { assertPatientSourceSnapshot } from "./patient-source-snapshot.mjs";
import { reconcileRecordEvidence, validateRecordReviewPolicy } from "./record-evidence-reconciliation.mjs";
import { buildRecordQualityReport } from "./nhsa-record-quality-engine.mjs";
import { currentEncounterDocument, encounterDocumentReference } from "./encounter-document-ref.mjs";
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { detachedFrozenOutput } from "./output-consistency.mjs";

const hash = value => sha256Hex(canonicalJson(value));
const comparisonKey = row => canonicalJson([row.section, row.code, row.condition_id ?? null]);
const findingSections = ["evidence", "front_sheet", "settlement_list"];
const present = value => typeof value === "string" && value.trim().length > 0;

function compareReference(reference, snapshotId, findings, complete) {
  if (reference == null) return { status: "unlabeled" };
  if (reference.snapshot_hash !== snapshotId || !complete || !Array.isArray(reference.findings)
      || reference.findings.some(row => !findingSections.includes(row?.section) || !present(row.code)
        || (row.condition_id != null && !present(row.condition_id)))) return { status: "reference_unverified" };
  const predicted = new Set(findings.map(comparisonKey));
  const expected = new Set(reference.findings.map(comparisonKey));
  if (expected.size !== reference.findings.length) return { status: "reference_unverified" };
  return { status: "compared", matched: [...expected].filter(key => predicted.has(key)).length,
    flagged_only: [...predicted].filter(key => !expected.has(key)).length,
    reference_only: [...expected].filter(key => !predicted.has(key)).length };
}

// Retrospective, read-only replay. The caller supplies authorized guarded
// snapshots and a versioned review policy. No coding/grouper API is invoked.
export function backtestRecordQuality({ tenantId, policy, cases } = {}) {
  if (!Array.isArray(cases) || !cases.length || typeof tenantId !== "string" || !tenantId.trim() || tenantId === "default") {
    throw new Error("BACKTEST_COHORT_REQUIRED");
  }
  policy = validateRecordReviewPolicy(structuredClone(policy));
  const seen = new Set();
  for (const { snapshot } of cases) {
    assertPatientSourceSnapshot(snapshot);
    const { tenant_id, encounter_id } = snapshot.context;
    if (tenant_id !== tenantId || seen.has(encounter_id)) throw new Error("BACKTEST_COHORT_SCOPE_MISMATCH");
    seen.add(encounter_id);
  }
  const results = cases.map(({ snapshot, reference }, index) => {
    const base = { position: index + 1, snapshot_hash: snapshot.snapshot_id };
    const front = currentEncounterDocument(snapshot, "front_sheet", { requireFinal: true });
    if (!front.entry) return { ...base, status: "not_evaluated", reason: `front_sheet_${front.status}` };
    try {
      const review = reconcileRecordEvidence({ snapshot, front_sheet_id: front.entry.record.id, policy });
      const quality = entry => buildRecordQualityReport(entry.record.text, { diagnosis_codes: entry.record.diagnoses });
      const settlement = currentEncounterDocument(snapshot, "settlement_list", { requireFinal: true });
      const checks = [["front_sheet", quality(front.entry)]];
      if (settlement.entry) checks.push(["settlement_list", quality(settlement.entry)]);
      const findings = [
        ...review.findings.map(finding => ({ section: "evidence", code: finding.code, condition_id: finding.condition_id })),
        ...checks.flatMap(([section, report]) => ["element_gaps", "algebra_conflicts", "legality_conflicts", "advisory_hints"]
          .flatMap(key => report[key].map(finding => ({ section, code: finding.code, condition_id: null })))),
      ];
      return { ...base, status: settlement.entry ? "reviewed" : "partially_reviewed", evidence_status: review.status,
        documents: { front_sheet: { status: front.status, reference: encounterDocumentReference(front.entry) },
          settlement_list: { status: settlement.status, reference: settlement.entry ? encounterDocumentReference(settlement.entry) : null } },
        evidence_hash: review.digest, findings, reference_comparison: compareReference(reference, snapshot.snapshot_id, findings,
          Boolean(settlement.entry) && review.coverage.every(source => source.status === "complete")) };
    } catch (error) {
      const reason = ["RECONCILIATION_COMPLETE_ENCOUNTER_PERIOD_REQUIRED", "RECONCILIATION_UNIQUE_FINAL_FRONT_SHEET_REQUIRED",
        "RECORD_REVIEW_INPUT_LIMIT"].includes(error?.message) ? error.message : "BACKTEST_CASE_FAILED";
      return { ...base, status: "not_evaluated", reason };
    }
  });
  const compared = results.filter(row => row.reference_comparison?.status === "compared");
  const counts = { total: cases.length, reviewed: results.filter(row => row.status === "reviewed").length,
    partially_reviewed: results.filter(row => row.status === "partially_reviewed").length,
    not_evaluated: results.filter(row => row.status === "not_evaluated").length };
  const report = { schema_version: "medcius.record-quality-backtest.v1",
    policy: { id: policy.id, version: policy.version, data_class: policy.data_class, sha256: hash(policy) },
    counts, cases: results,
    reference_comparison: { cases_compared: compared.length, matched: null, flagged_only: null, reference_only: null,
      ...(compared.length ? Object.fromEntries(["matched", "flagged_only", "reference_only"].map(key =>
        [key, compared.reduce((sum, row) => sum + row.reference_comparison[key], 0)])) : {}) },
    clinical_evidence: "NOT_ESTABLISHED", writeback: false };
  return detachedFrozenOutput({ ...report, packet_sha256: hash(report) });
}
