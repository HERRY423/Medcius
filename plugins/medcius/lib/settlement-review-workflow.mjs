import { assertPatientSourceSnapshot } from './patient-source-snapshot.mjs';
import { reconcileRecordEvidence } from './record-evidence-reconciliation.mjs';
import { settlementFromNote } from './settlement-from-note.mjs';

// Explicit secondary workflow; not installed in the pre-round clinical core.
export async function reviewSettlementSnapshot({ snapshot, front_sheet_id, policy, codes, code_options = {}, precheck } = {}) {
  assertPatientSourceSnapshot(snapshot);
  const review = reconcileRecordEvidence({ snapshot, front_sheet_id, policy });
  const front = snapshot.records.notes.find(e => e.record.id === front_sheet_id && e.record.document_kind === 'front_sheet'
    && e.eligible && ['final', 'revised'].includes(e.lifecycle.result_status)).record;
  const settlement = settlementFromNote(front.text, codes, { ...code_options, evidenceReview: review });
  const grouping = precheck ? await precheck({ review, items: review.front_sheet_codes, as_of: review.period.to.slice(0, 10) })
    : { status: 'NOT_CONFIGURED', reason: 'LOCAL_GROUPER_REQUIRED', production_ready: false };
  return { schema_version: 'medcius.settlement-review-workflow.v1', snapshot_id: snapshot.snapshot_id,
    settlement, evidence_review: review, local_precheck: grouping,
    production_ready: false, clinical_evidence: 'NOT_ESTABLISHED', clinician_review_required: true };
}
