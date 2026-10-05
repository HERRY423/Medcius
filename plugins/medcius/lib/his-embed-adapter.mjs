// HIS-embed / hospital SSO adapter — the only frontline clinical surface after P0.
// Silent-pilot default: compute the pre-round snapshot, append an audit event,
// and return no doctor-facing cards or draft. Engineering hosts are rejected.

import { HospitalAgentAdapter, getPreRoundResearchSnapshot } from "./hospital-agent-adapter.mjs";
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
import { isFormalHospitalPath, resolveAuthorizedHospitalSource, resolveAuthorizedCaptureContext } from "./authorized-hospital-source.mjs";
import { saveFrozenResearchRecord } from "./silent-research-archive.mjs";

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
  authContext = null,
} = {}) {
  const resolvedHost = host === CLINICAL_SURFACES.HOSPITAL_SSO ? CLINICAL_SURFACES.HOSPITAL_SSO : CLINICAL_SURFACES.HIS_EMBED;
  assertClinicalHostAllowed(resolvedHost, { clinicalLanding: true });
  assertSkillInvocable({ skillId: CLINICAL_LANDING_SKILL, host: resolvedHost, clinicalLanding: true });
  assertLiveHospitalDataAllowed(siteActivation || {});

  const stage = governance.getCurrentStage ? governance.getCurrentStage() : GOVERNANCE_STAGES.RETROSPECTIVE_STUDY;
  assertHospitalGovernanceCap(stage);

  const formal = isFormalHospitalPath(stage.id);
  const requested = context || (formal ? (message?.payload || message || {}) : parseHisPatientContext(message || {}));
  let resolvedContext = { ...requested, clinical_landing: true };
  if (formal && dataFeeds) throw new Error("CALLER_FEEDS_FORBIDDEN");

  let activeBridge = bridge || null;
  let sourceMode = "caller_feeds";
  if (formal) {
    const source = resolveAuthorizedHospitalSource();
    if (activeBridge && activeBridge !== source.bridge) throw new Error("AUTHORIZED_SOURCE_OVERRIDE_FORBIDDEN");
    activeBridge = source.bridge;
    resolvedContext = await resolveAuthorizedCaptureContext({ auth: authContext, requestedContext: resolvedContext, source });
    if (siteActivation?.tenant_id && siteActivation.tenant_id !== resolvedContext.tenant_id) throw new Error("SITE_ACTIVATION_TENANT_MISMATCH");
    if (typeof auditAppend !== "function") throw new Error("AUTHORIZED_CAPTURE_AUDIT_REQUIRED");
    sourceMode = "authorized_bridge";
  } else if (activeBridge) {
    sourceMode = "synthetic_authorized_replay";
  }

  let result;
  if (activeBridge) {
    result = await HospitalAgentAdapter.executePreRoundFromBridge({
      host: resolvedHost,
      context: resolvedContext,
      bridge: activeBridge,
    });
  } else {
    result = HospitalAgentAdapter.executePreRoundWorkflow({
      host: resolvedHost,
      context: resolvedContext,
      dataFeeds,
    });
  }

  const researchSnapshot = getPreRoundResearchSnapshot(result);
  const frozen = saveFrozenResearchRecord({
    tenantId: resolvedContext.tenant_id,
    patientId: resolvedContext.patient_id,
    encounterId: resolvedContext.encounter_id,
    asOf: result.as_of,
    governanceStage: stage.id,
    sourceMode,
    sourceManifest: result.source_bridge?.source_manifest || [],
    unavailableSources: result.source_bridge?.unavailable_sources || [],
    degradedRecords: result.source_bridge?.degraded_records || [],
    ...researchSnapshot,
  });

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
      research_record_id: frozen.case_id,
      output_sha256: frozen.output_sha256,
      input_sha256: frozen.input_sha256,
      record_sha256: frozen.record_sha256,
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
    research_record_id: frozen.case_id,
    output_sha256: frozen.output_sha256,
    record_sha256: frozen.record_sha256,
    replayable: true,
    source_bridge: result.source_bridge ? {
      schema_version: result.source_bridge.schema_version,
      completeness: result.source_bridge.completeness,
      source_manifest: result.source_bridge.source_manifest,
      source_availability: result.source_bridge.source_availability,
      unavailable_sources: result.source_bridge.unavailable_sources,
      degraded_records: result.source_bridge.degraded_records || [],
      read_only_enforced: result.source_bridge.read_only_enforced,
    } : null,
    provenance: result.provenance,
    security_contract: {
      ...(result.security_contract || {}),
      clinician_display: display,
      writeback: false,
    },
  };
}
