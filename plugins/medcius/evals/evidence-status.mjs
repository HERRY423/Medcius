// Caller arguments cannot change the evidence class.
// clinical_evidence_pass stays false until an independent review records it.

export function resolveCallerEvidenceStatus({
  isDemo = true,
  metadata = null,
  ethicsApprovalNumber,
  allPrimaryMet = false,
  engineeringMetricsMet = allPrimaryMet,
} = {}) {
  const ethicsFieldPassed = ethicsApprovalNumber !== undefined
    || (metadata != null && (
      Object.prototype.hasOwnProperty.call(metadata, "ethics_approval_number")
      || Object.prototype.hasOwnProperty.call(metadata, "ethics_approval")
    ));
  const callerUpgradeAttempted = isDemo === false || ethicsFieldPassed;
  return {
    engineering_pass: engineeringMetricsMet === true,
    synthetic_validation_pass: allPrimaryMet === true && isDemo === true,
    clinical_evidence_pass: false,
    independent_review_pending: true,
    caller_upgrade_attempted: callerUpgradeAttempted,
    blocked_reason: callerUpgradeAttempted
      ? "EVIDENCE_CLASS_NOT_UPGRADABLE_BY_CALLER_ARGUMENT"
      : "CLINICAL_EVIDENCE_BLOCKED",
    data_source_verified: false,
    endpoint_pass: allPrimaryMet === true,
    human_acceptance: null,
  };
}

// Keys describe paired observations, not array positions. Keep malformed and
// duplicate records visible rather than allowing repetitions to inflate CIs.
export function inspectEvaluationKeys(records, idFields = ["case_id", "id"]) {
  const seen = new Set();
  let missing = 0;
  let duplicates = 0;
  for (const record of records) {
    const id = idFields.map((field) => record?.[field]).find((value) => typeof value === "string" && value.trim());
    if (!id) { missing++; continue; }
    const key = JSON.stringify([id, record.dimension ?? null]);
    if (seen.has(key)) duplicates++;
    seen.add(key);
  }
  return { missing_keys: missing, duplicate_keys: duplicates, complete: missing === 0 && duplicates === 0 };
}
