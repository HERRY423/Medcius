// Patient affordability and access context for bounded clinical workflows.
// This module reports source-bound facts and gaps. It never calculates benefits,
// predicts out-of-pocket cost, recommends treatment substitutions, or decides discharge.

const KINDS = new Set([
  "affordability_screen",
  "coverage_verification",
  "patient_cost_estimate",
  "assistance_referral",
]);

const CATEGORIES = new Set([
  "medication",
  "follow_up",
  "transportation",
  "equipment",
  "home_care",
  "other",
]);

const STATUSES = {
  affordability_screen: new Set(["barrier_reported", "no_barrier_reported", "unknown", "not_completed"]),
  coverage_verification: new Set(["verified", "pending", "denied", "not_verified"]),
  patient_cost_estimate: new Set(["available", "unavailable", "expired"]),
  assistance_referral: new Set(["offered", "accepted", "declined", "pending", "completed"]),
};

function validDate(value) {
  return typeof value === "string" && value.trim() && !Number.isNaN(new Date(value).getTime());
}

function sourceReference(record) {
  if (
    typeof record?.source_reference?.source_system === "string"
    && record.source_reference.source_system.trim()
    && typeof record?.source_reference?.resource_id === "string"
    && record.source_reference.resource_id.trim()
  ) {
    return {
      source_system: record.source_reference.source_system,
      resource_id: record.source_reference.resource_id,
    };
  }
  if (
    typeof record?._source?.system === "string"
    && record._source.system.trim()
    && typeof record?._source?.record_id === "string"
    && record._source.record_id.trim()
  ) {
    return {
      source_system: record._source.system,
      resource_id: record._source.record_id,
    };
  }
  return null;
}

function validateRecord(record) {
  const source = sourceReference(record);
  if (!record || typeof record !== "object") return { ok: false, reason: "RECORD_OBJECT_REQUIRED" };
  if (typeof record.id !== "string" || !record.id.trim()) return { ok: false, reason: "RECORD_ID_REQUIRED" };
  if (!KINDS.has(record.kind)) return { ok: false, reason: "UNSUPPORTED_KIND" };
  if (!CATEGORIES.has(record.category)) return { ok: false, reason: "UNSUPPORTED_CATEGORY" };
  if (!STATUSES[record.kind].has(record.status)) return { ok: false, reason: "UNSUPPORTED_STATUS" };
  if (!validDate(record.recorded_at)) return { ok: false, reason: "RECORDED_AT_REQUIRED" };
  if (!source) return { ok: false, reason: "SOURCE_REFERENCE_REQUIRED" };

  if (record.kind === "patient_cost_estimate" && record.status === "available") {
    if (!Number.isFinite(record.amount) || record.amount < 0) return { ok: false, reason: "VALID_AMOUNT_REQUIRED" };
    if (typeof record.currency !== "string" || !record.currency.trim()) return { ok: false, reason: "CURRENCY_REQUIRED" };
    if (!validDate(record.valid_until)) return { ok: false, reason: "VALID_UNTIL_REQUIRED" };
  }

  return { ok: true, source };
}

function publicFact(record, source) {
  const base = {
    id: record.id,
    kind: record.kind,
    category: record.category,
    status: record.status,
    recorded_at: record.recorded_at,
    source_reference: source,
  };
  if (record.kind === "patient_cost_estimate" && record.status === "available") {
    return {
      ...base,
      amount: record.amount,
      currency: record.currency,
      valid_until: record.valid_until,
      estimate_scope_code: record.estimate_scope_code || null,
      disclaimer: "Source-provided estimate only; not a bill, benefit determination, or guaranteed patient payment.",
    };
  }
  return base;
}

function actionFor(fact) {
  if (fact.kind === "affordability_screen" && fact.status === "barrier_reported") {
    return { code: "REFER_FOR_HUMAN_AFFORDABILITY_REVIEW", category: fact.category, source_reference: fact.source_reference };
  }
  if (fact.kind === "coverage_verification" && ["pending", "denied", "not_verified"].includes(fact.status)) {
    return { code: "VERIFY_COVERAGE_WITH_AUTHORIZED_SERVICE", category: fact.category, source_reference: fact.source_reference };
  }
  if (fact.kind === "patient_cost_estimate" && ["unavailable", "expired"].includes(fact.status)) {
    return { code: "REQUEST_CURRENT_PATIENT_SPECIFIC_ESTIMATE", category: fact.category, source_reference: fact.source_reference };
  }
  if (fact.kind === "assistance_referral" && ["offered", "accepted", "pending"].includes(fact.status)) {
    return { code: "TRACK_ASSISTANCE_REFERRAL", category: fact.category, source_reference: fact.source_reference };
  }
  return null;
}

export function buildPatientAffordabilityContext({ records = [], dischargeMedicationCount = 0 } = {}) {
  if (!Array.isArray(records)) throw new Error("AFFORDABILITY_RECORDS_ARRAY_REQUIRED");

  const verifiedFacts = [];
  const dataGaps = [];
  for (const record of records) {
    const validation = validateRecord(record);
    if (!validation.ok) {
      dataGaps.push({
        code: "UNVERIFIED_AFFORDABILITY_RECORD_IGNORED",
        record_id: typeof record?.id === "string" ? record.id : null,
        reason: validation.reason,
      });
      continue;
    }
    verifiedFacts.push(publicFact(record, validation.source));
  }

  const screens = verifiedFacts.filter((fact) => fact.kind === "affordability_screen");
  const medicationCoverage = verifiedFacts.filter(
    (fact) => fact.kind === "coverage_verification" && fact.category === "medication",
  );
  if (screens.length === 0) dataGaps.push({ code: "AFFORDABILITY_SCREEN_NOT_AVAILABLE" });
  if (dischargeMedicationCount > 0 && medicationCoverage.length === 0) {
    dataGaps.push({ code: "DISCHARGE_MEDICATION_COVERAGE_NOT_VERIFIED" });
  }

  const actionItems = verifiedFacts.map(actionFor).filter(Boolean);
  const hasReportedBarrier = screens.some((fact) => fact.status === "barrier_reported");
  const hasExplicitNoBarrier = screens.some((fact) => fact.status === "no_barrier_reported");

  let assessmentStatus = "unknown";
  if (hasReportedBarrier || actionItems.length > 0) assessmentStatus = "action_needed";
  else if (verifiedFacts.length > 0 && dataGaps.length > 0) assessmentStatus = "incomplete";
  else if (hasExplicitNoBarrier) assessmentStatus = "no_barrier_reported_for_screened_categories";
  else if (verifiedFacts.length > 0) assessmentStatus = "reviewed_no_current_action";

  return {
    schema_version: "medcius.patient-affordability-context.v1",
    assessment_status: assessmentStatus,
    follow_up_required: actionItems.length > 0 || dataGaps.length > 0,
    verified_facts: verifiedFacts,
    action_items: actionItems,
    data_gaps: dataGaps,
    boundary: {
      affects_clinical_discharge_verdict: false,
      automatic_treatment_substitution: false,
      calculated_out_of_pocket_amount: false,
      note: "Clinician, pharmacist, social worker, financial counselor, or payer staff must verify any action with the patient.",
    },
  };
}
