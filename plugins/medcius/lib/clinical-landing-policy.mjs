// P0 clinical-landing policy — single source of truth.
// Frontline clinical use is HIS-embed / hospital SSO + pre-round summary only.
// Codex / Trae / WorkBuddy remain engineering hosts. Frozen workflows stay in-repo
// for synthetic tests but cannot run on a clinical landing surface.

export const CLINICAL_LANDING_SKILL = "patient-evolution-summary";

export const SUPPORTING_DATA_SKILLS = Object.freeze([
  "fhir",
  "clinical-note-extract",
  "doc-extract",
]);

export const FROZEN_WORKFLOW_SKILLS = Object.freeze([
  "shift-handover",
  "consult-preparation",
  "discharge-readiness-check",
]);

export const CLINICAL_SURFACES = Object.freeze({
  HIS_EMBED: "his_embed",
  HOSPITAL_SSO: "hospital_sso",
});

export const ENGINEERING_SURFACES = Object.freeze({
  CODEX: "codex",
  TRAE: "trae",
  WORKBUDDY: "workbuddy",
  SANDBOX: "sandbox",
});

export const PREROUND_REQUIRED_KINDS = Object.freeze(["patient", "encounter", "nis", "lis", "his"]);
export const PREROUND_OPTIONAL_KINDS = Object.freeze(["pacs", "notes", "financial_access"]);

export const HOSPITAL_MAX_GOVERNANCE_LEVEL = 2;
export const HOSPITAL_MAX_GOVERNANCE_STAGE = "silent_pilot";
export const TIME_MOTION_MIN_SAVED_SECONDS = 90;
export const P0_FROZEN_MARKER = "P0-FROZEN";

function truthyEnv(name) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function isClinicalLandingEnabled() {
  return truthyEnv("MEDCIUS_CLINICAL_LANDING");
}

export function isLiveHospitalDataEnabled() {
  return truthyEnv("MEDCIUS_LIVE_HOSPITAL_DATA");
}

export function isEngineeringHost(host) {
  const value = String(host || "").trim().toLowerCase();
  return Object.values(ENGINEERING_SURFACES).includes(value);
}

export function isClinicalHost(host) {
  const value = String(host || "").trim().toLowerCase();
  return Object.values(CLINICAL_SURFACES).includes(value);
}

export function resolveClinicalLanding({ host, clinicalLanding } = {}) {
  return clinicalLanding === true || isClinicalLandingEnabled() || isClinicalHost(host);
}

/**
 * Engineering hosts cannot serve frontline clinical landing.
 */
export function assertClinicalHostAllowed(host, { clinicalLanding } = {}) {
  if (!resolveClinicalLanding({ host, clinicalLanding })) return true;
  if (!isClinicalHost(host)) {
    throw new Error(
      `P0_CLINICAL_HOST_REQUIRED: host '${host || ""}' is not a clinical surface. Frontline landing only allows his_embed or hospital_sso.`,
    );
  }
  return true;
}

/**
 * Frozen workflows remain callable from engineering tests.
 * HIS embed, hospital SSO, and MEDCIUS_CLINICAL_LANDING=1 reject them.
 */
export function assertSkillInvocable({ skillId, host, clinicalLanding } = {}) {
  if (!skillId || typeof skillId !== "string") {
    throw new Error("P0_SKILL_ID_REQUIRED: skillId is required");
  }
  if (skillId === CLINICAL_LANDING_SKILL || SUPPORTING_DATA_SKILLS.includes(skillId)) {
    return { ok: true, skillId, frozen: false };
  }
  if (FROZEN_WORKFLOW_SKILLS.includes(skillId)) {
    if (resolveClinicalLanding({ host, clinicalLanding })) {
      throw new Error(
        `P0_SKILL_FROZEN: '${skillId}' is frozen on the clinical landing surface. Only '${CLINICAL_LANDING_SKILL}' may run in HIS embed / hospital SSO / MEDCIUS_CLINICAL_LANDING=1.`,
      );
    }
    return { ok: true, skillId, frozen: true, engineering_only: true };
  }
  throw new Error(
    `P0_SKILL_UNREGISTERED: '${skillId}' is not on the clinical landing allowlist.`,
  );
}

export function assertHospitalGovernanceCap(stage) {
  const level = Number(stage?.level);
  if (!Number.isFinite(level)) {
    throw new Error("P0_GOVERNANCE_STAGE_REQUIRED: a governance stage object with level is required");
  }
  if (level > HOSPITAL_MAX_GOVERNANCE_LEVEL) {
    throw new Error(
      `P0_GOVERNANCE_CAP: clinical landing cannot exceed Level ${HOSPITAL_MAX_GOVERNANCE_LEVEL} (${HOSPITAL_MAX_GOVERNANCE_STAGE}). Doctor-facing alerts and writeback remain prohibited.`,
    );
  }
  return true;
}

/**
 * Evidence reports cannot upgrade synthetic / protocol-simulation data
 * to clinical_evidence_pass.
 */
export function classifyEvidenceReport({
  dataClass = "synthetic",
  irbProtocolId = null,
  observerIds = [],
  stopwatchRecords = [],
} = {}) {
  const normalized = String(dataClass || "synthetic").trim().toLowerCase();
  const isStopwatch = normalized === "stopwatch_observation";
  const hasIrb = typeof irbProtocolId === "string" && irbProtocolId.trim().length > 0;
  const hasObservers = Array.isArray(observerIds) && observerIds.length > 0;
  const hasRecords = Array.isArray(stopwatchRecords) && stopwatchRecords.length > 0;

  if (!isStopwatch || !hasIrb || !hasObservers || !hasRecords) {
    return {
      engineering_pass: true,
      synthetic_validation_pass: normalized !== "stopwatch_observation",
      clinical_evidence_pass: false,
      blocked_reason:
        "CLINICAL_EVIDENCE_BLOCKED: synthetic, protocol-simulation, or incomplete stopwatch packets cannot be reported as clinical evidence.",
      data_class: normalized,
    };
  }

  return {
    engineering_pass: true,
    synthetic_validation_pass: false,
    clinical_evidence_pass: false,
    pending_endpoint_evaluation: true,
    data_class: normalized,
    irb_protocol_id: irbProtocolId,
  };
}
