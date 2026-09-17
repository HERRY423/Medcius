// Stopwatch time-motion protocol for the first-hospital silent pilot.
// Pre-registered endpoint: safety non-inferiority AND mean time saved >= 90 seconds.
// Synthetic / in-silico packets can never flip clinical_evidence_pass.

import { TIME_MOTION_MIN_SAVED_SECONDS, classifyEvidenceReport } from "../../lib/clinical-landing-policy.mjs";

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function validateStopwatchRecord(record, index = 0) {
  if (!record || typeof record !== "object") {
    throw new Error(`STOPWATCH_RECORD_REQUIRED: index ${index}`);
  }
  if (typeof record.observer_id !== "string" || !record.observer_id.trim()) {
    throw new Error(`STOPWATCH_OBSERVER_ID_REQUIRED: index ${index}`);
  }
  const control = Number(record.control_seconds);
  const intervention = Number(record.intervention_seconds);
  if (!Number.isFinite(control) || control <= 0) {
    throw new Error(`STOPWATCH_CONTROL_SECONDS_INVALID: index ${index}`);
  }
  if (!Number.isFinite(intervention) || intervention < 0) {
    throw new Error(`STOPWATCH_INTERVENTION_SECONDS_INVALID: index ${index}`);
  }
  return {
    observer_id: record.observer_id.trim(),
    patient_id: record.patient_id || null,
    control_seconds: control,
    intervention_seconds: intervention,
    control_omissions: Number(record.control_omissions || 0),
    intervention_omissions: Number(record.intervention_omissions || 0),
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
  const meanSaved = records.length ? Number(mean(saved).toFixed(1)) : 0;
  const controlOmissions = records.reduce((sum, record) => sum + record.control_omissions, 0);
  const interventionOmissions = records.reduce((sum, record) => sum + record.intervention_omissions, 0);
  const nonInferior = interventionOmissions <= controlOmissions;
  const meetsTimeEndpoint = meanSaved >= TIME_MOTION_MIN_SAVED_SECONDS;
  const endpointsMet = nonInferior && meetsTimeEndpoint && records.length > 0;

  const clinicalPass = evidence.clinical_evidence_pass === true && endpointsMet && dataClass === "stopwatch_observation";

  return {
    protocol: "medcius-preround-stopwatch-v1",
    pre_registered_endpoints: {
      safety_non_inferiority: "intervention omissions <= control omissions",
      min_mean_saved_seconds: TIME_MOTION_MIN_SAVED_SECONDS,
    },
    sample_size: records.length,
    observer_count: observerIds.length,
    mean_saved_seconds: meanSaved,
    safety_non_inferiority: {
      control_omissions: controlOmissions,
      intervention_omissions: interventionOmissions,
      is_non_inferior: nonInferior,
    },
    time_endpoint_met: meetsTimeEndpoint,
    endpoints_met: endpointsMet,
    evidence: {
      ...evidence,
      clinical_evidence_pass: clinicalPass,
      blocked_reason: clinicalPass
        ? null
        : (evidence.blocked_reason || "CLINICAL_EVIDENCE_BLOCKED: stopwatch endpoints not met or IRB/observer packet incomplete."),
    },
  };
}
