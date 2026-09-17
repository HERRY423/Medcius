// HIS-embed / hospital SSO adapter — the only frontline clinical surface after P0.
// Silent-pilot default: compute the pre-round snapshot, append an audit event,
// and return no doctor-facing cards or draft. Engineering hosts are rejected.

import { HospitalAgentAdapter } from "./hospital-agent-adapter.mjs";
import {
  CLINICAL_LANDING_SKILL,
  CLINICAL_SURFACES,
  PREROUND_REQUIRED_KINDS,
  assertClinicalHostAllowed,
  assertHospitalGovernanceCap,
  assertSkillInvocable,
} from "./clinical-landing-policy.mjs";
import { GOVERNANCE_STAGES, globalGovernance } from "./governance-mode.mjs";
import { assertLiveHospitalDataAllowed } from "./site-activation-gate.mjs";

const REQUIRED_CONTEXT = ["tenant_id", "doctor_id", "patient_id", "encounter_id"];

export function parseHisPatientContext(message = {}) {
  const payload = message.payload && typeof message.payload === "object" ? message.payload : message;
  const context = {
    tenant_id: payload.tenant_id || payload.tenantId || null,
    doctor_id: payload.doctor_id || payload.doctorId || payload.userId || payload.user_id || null,
    doctor_name: payload.doctor_name || payload.doctorName || null,
    patient_id: payload.patient_id || payload.patientId || null,
    encounter_id: payload.encounter_id || payload.encounterId || null,
    time_window: payload.time_window || payload.timeWindow || "24h",
    sso_token: payload.sso_token || payload.ssoToken || null,
    specialty_rule_pack_id: payload.specialty_rule_pack_id || payload.rulePackId || null,
    clinical_landing: true,
  };
  for (const field of REQUIRED_CONTEXT) {
    if (typeof context[field] !== "string" || !context[field].trim()) {
      throw new Error(`HIS_EMBED_CONTEXT_FAIL_CLOSED: missing ${field}`);
    }
  }
  return context;
}

function clinicianDisplayFor(stage) {
  if (stage?.allows_live_alerts) return "cards";
  return "suppressed_silent_pilot";
}

/**
 * Run the flagship pre-round workflow for a HIS iframe / SSO session.
 * Silent-pilot: no cards, no draft, no writeback.
 */
export async function executeHisEmbedPreRound({
  host = CLINICAL_SURFACES.HIS_EMBED,
  message,
  context,
  dataFeeds,
  bridge,
  governance = globalGovernance,
  siteActivation = null,
  auditAppend = null,
} = {}) {
  const resolvedHost = host === CLINICAL_SURFACES.HOSPITAL_SSO ? CLINICAL_SURFACES.HOSPITAL_SSO : CLINICAL_SURFACES.HIS_EMBED;
  assertClinicalHostAllowed(resolvedHost, { clinicalLanding: true });
  assertSkillInvocable({ skillId: CLINICAL_LANDING_SKILL, host: resolvedHost, clinicalLanding: true });
  assertLiveHospitalDataAllowed(siteActivation || {});

  const stage = governance.getCurrentStage ? governance.getCurrentStage() : GOVERNANCE_STAGES.RETROSPECTIVE_STUDY;
  assertHospitalGovernanceCap(stage);

  const resolvedContext = context || parseHisPatientContext(message || {});
  resolvedContext.clinical_landing = true;

  let result;
  if (bridge) {
    result = await HospitalAgentAdapter.executePreRoundFromBridge({
      host: resolvedHost,
      context: resolvedContext,
      bridge,
    });
  } else {
    result = HospitalAgentAdapter.executePreRoundWorkflow({
      host: resolvedHost,
      context: resolvedContext,
      dataFeeds,
    });
  }

  const itemCount = result?.summary?.total_items_count ?? 0;
  const display = clinicianDisplayFor(stage);
  const silent = display !== "cards";

  const shadow = {
    silent,
    clinician_display: display,
    governance_stage: stage.id,
    skill_id: CLINICAL_LANDING_SKILL,
    required_kinds: [...PREROUND_REQUIRED_KINDS],
    computed_item_count: itemCount,
    writeback: false,
    cards: [],
  };

  if (typeof auditAppend === "function") {
    await auditAppend({
      event_type: "his_embed_silent_capture",
      tenant_id: resolvedContext.tenant_id,
      patient_id: resolvedContext.patient_id,
      encounter_id: resolvedContext.encounter_id,
      governance_stage: stage.id,
      item_count: itemCount,
      envelope_sha256: result?.provenance?.envelope_sha256 || null,
    });
  }

  return {
    success: true,
    host: resolvedHost,
    silent,
    cards: [],
    draft: null,
    shadow,
    summary: silent ? null : result.summary,
    source_bridge: result.source_bridge || null,
    provenance: result.provenance,
    security_contract: {
      ...(result.security_contract || {}),
      clinician_display: display,
      writeback: false,
    },
  };
}
