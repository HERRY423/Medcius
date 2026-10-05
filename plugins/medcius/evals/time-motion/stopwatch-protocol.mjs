// Stopwatch time-motion protocol for the first-hospital silent pilot.
// Pre-registered endpoint: safety non-inferiority AND mean time saved >= 90 seconds.
// Synthetic / in-silico packets can never flip clinical_evidence_pass.

import { TIME_MOTION_MIN_SAVED_SECONDS, classifyEvidenceReport } from "../../lib/clinical-landing-policy.mjs";

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function validateStopwatchRecord(record, index = 0) {
  if (!record || typeof record !== "object") {
    throw new Error(`STOPWATCH_RECORD_REQUIRED: index ${index}`);
  }
  if (typeof record.observer_id !== "string" || !record.observer_id.trim()) {
    throw new Error(`STOPWATCH_OBSERVER_ID_REQUIRED: index ${index}`);
  }
  const control = record.control_seconds;
  const intervention = record.intervention_seconds;
  if (!Number.isFinite(control) || control <= 0) {
    throw new Error(`STOPWATCH_CONTROL_SECONDS_INVALID: index ${index}`);
  }
  if (!Number.isFinite(intervention) || intervention < 0) {
    throw new Error(`STOPWATCH_INTERVENTION_SECONDS_INVALID: index ${index}`);
  }
  const omissionCount = (field) => {
    const value = record[field];
    if (value == null) return null;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`STOPWATCH_OMISSIONS_INVALID: ${field}, index ${index}`);
    return value;
  };
  return {
    observer_id: record.observer_id.trim(),
    patient_id: record.patient_id || null,
    control_seconds: control,
    intervention_seconds: intervention,
    control_omissions: omissionCount("control_omissions"),
    intervention_omissions: omissionCount("intervention_omissions"),
  };
}

/**
 * Evaluate a stopwatch packet against the pre-registered 90-second endpoint.
 * Synthetic packets are scored for engineering only and remain BLOCKED.
 */
export function evaluateStopwatchProtocol(packet = {}) {
  const dataClass = packet.data_class || "synthetic";
  const records = Array.isArray(packet.records) ? packet.records.map(validateStopwatchRecord) : [];
  const observerIds = [...new Set(records.map((record) => record.observer_id))];
  const evidence = classifyEvidenceReport({
    dataClass,
    irbProtocolId: packet.irb_protocol_id,
    observerIds,
    stopwatchRecords: records,
  });

  const saved = records.map((record) => record.control_seconds - record.intervention_seconds);
  const meanSaved = records.length ? Number(mean(saved).toFixed(1)) : null;
  const missingControl = records.filter((record) => record.control_omissions == null).length;
  const missingIntervention = records.filter((record) => record.intervention_omissions == null).length;
  const controlOmissions = records.length && !missingControl ? records.reduce((sum, record) => sum + record.control_omissions, 0) : null;
  const interventionOmissions = records.length && !missingIntervention ? records.reduce((sum, record) => sum + record.intervention_omissions, 0) : null;
  const comparison = controlOmissions == null || interventionOmissions == null ? null : interventionOmissions <= controlOmissions;
  const meetsTimeEndpoint = meanSaved != null && meanSaved >= TIME_MOTION_MIN_SAVED_SECONDS;
  const complete = records.length > 0 && missingControl === 0 && missingIntervention === 0;
  const descriptiveEndpointsMet = comparison === true && meetsTimeEndpoint && complete;
  // A count comparison has no non-inferiority margin, sampling model or CI.
  // It cannot establish the pre-registered safety endpoint.
  const endpointsMet = false;

  const clinicalPass = false;
  let blockedReason = null;
  if (evidence.blocked_reason) blockedReason = evidence.blocked_reason;
  else if (endpointsMet) {
    blockedReason = "INDEPENDENT_REVIEW_PENDING: statistical endpoints are computable but caller arguments cannot authorize clinical evidence.";
  } else {
    blockedReason = "ENDPOINTS_NOT_MET";
  }

  return {
    protocol: "medcius-preround-stopwatch-v1",
    pre_registered_endpoints: {
      safety_non_inferiority: "NOT_EVALUATED: requires an approved statistical analysis and independent review",
      descriptive_safety_screen: "intervention omissions <= control omissions",
      min_mean_saved_seconds: TIME_MOTION_MIN_SAVED_SECONDS,
    },
    sample_size: records.length,
    observer_count: observerIds.length,
    mean_saved_seconds: meanSaved,
    missing_safety_records: { control: missingControl, intervention: missingIntervention },
    safety_non_inferiority: {
      control_omissions: controlOmissions,
      intervention_omissions: interventionOmissions,
      is_non_inferior: null,
      descriptive_omission_comparison_pass: comparison,
      status: "NOT_EVALUATED",
    },
    time_endpoint_met: meetsTimeEndpoint,
    endpoints_met: endpointsMet,
    descriptive_endpoints_met: descriptiveEndpointsMet,
    evidence: {
      ...evidence,
      engineering_pass: complete,
      synthetic_validation_pass: ["synthetic", "in_silico", "protocol_simulation"].includes(dataClass) && descriptiveEndpointsMet,
      clinical_evidence_pass: clinicalPass,
      endpoints_met: endpointsMet,
      independent_review_pending: endpointsMet,
      blocked_reason: blockedReason,
    },
  };
}
