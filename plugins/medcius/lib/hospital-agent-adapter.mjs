// Host-Agnostic Hospital Agent Integration Adapter
// Bridges custom Hospital Agents (Dify, LangChain, LlamaIndex, CDS Hooks 2.0, Hospital EHR Portal)
// to the Medcius Core Plugin Engine with strict fail-closed safety, provenance, and PHI guard contracts.

import { PatientEvolutionEngine } from "./patient-evolution-engine.mjs";
import { ShiftHandoverEngine, SHIFT_TYPES } from "./shift-handover-engine.mjs";
import { ConsultPreparationEngine } from "./consult-preparation-engine.mjs";
import { DischargeReadinessEngine } from "./discharge-readiness-engine.mjs";
import { HospitalDataAdapter } from "./hospital-data-adapter.mjs";
import { loadSpecialtyRulePack } from "./specialty-rule-pack.mjs";
import { StagedDraftService } from "./staged-draft-service.mjs";
import { ClinicalSkillCatalog } from "./clinical-skill-catalog.mjs";
import { scanStructuredValue } from "../servers/phiguard/src/lib.mjs";
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { assertExplicitFeedOwnership, toModelSafe, containsRawStructuredPhi } from "./clinical-boundary.mjs";
import { createPhiEntitySession, guardSessionValue } from './phi-entity-session.mjs';
import { guardPatientSourceInput } from './patient-source-phi.mjs';
import { withPhiInferenceScope } from './phi-inference-scope.mjs';
import { assertSyncPhiAllowed } from './production-phi-policy.mjs';
import { resolvePhiDetector } from './phi-runtime.mjs';
import { loadChinaPharmacyCatalog, selectChinaPharmacyCatalog } from './china-pharmacy-catalog.mjs';
import { requiresProductionPhi } from './production-phi-policy.mjs';
import { PLUGIN_VERSION } from './plugin-version.mjs';

const HARD_IDENTIFIER_TYPES = new Set(["id_card", "phone_cn_mobile", "phone_cn_fixed", "bank_card", "email", "mrn_label"]);
// Raw research material never travels in the serializable host response.
const researchSnapshots = new WeakMap();

// Generic `name` fields are identities at a PHI boundary. Give only these
// contract-defined clinical names explicit domain keys before freezing them.
function canonicalClinicalFeeds(dataFeeds) {
  if (!dataFeeds) return dataFeeds;
  return { ...dataFeeds, his_orders: (dataFeeds.his_orders || []).map((order) => {
    const { name, ...rest } = order;
    return order.is_medication || order.drug_name
      ? { ...rest, drug_name: order.drug_name || name }
      : { ...rest, title: order.title || name };
  }) };
}

function encodeResearchRulePack(rulePack) {
  if (!rulePack?.clinical_rules?.restricted_antibiotics) return rulePack;
  return { ...rulePack, clinical_rules: { ...rulePack.clinical_rules,
    restricted_antibiotics: rulePack.clinical_rules.restricted_antibiotics.map(({ name, ...rule }) => ({ ...rule, drug_name: name })) } };
}

function decodeResearchRulePack(rulePack) {
  if (!rulePack?.clinical_rules?.restricted_antibiotics) return rulePack;
  return { ...rulePack, clinical_rules: { ...rulePack.clinical_rules,
    restricted_antibiotics: rulePack.clinical_rules.restricted_antibiotics.map(({ drug_name, ...rule }) => ({ ...rule, name: drug_name })) } };
}

export function getPreRoundResearchSnapshot(result) {
  const snapshot = researchSnapshots.get(result);
  if (!snapshot) throw new Error("RESEARCH_SNAPSHOT_UNAVAILABLE");
  return structuredClone(snapshot);
}

export function replayPreRoundResearchSnapshot(input) {
  return HospitalAgentAdapter.executePreRoundWorkflow({
    host: "his_embed",
    context: input.context,
    dataFeeds: input.dataFeeds,
    sourceAvailability: input.sourceAvailability,
    frozenRulePack: input.rule_pack_encoding === "clinical-drug-name-v1" ? decodeResearchRulePack(input.rulePack) : input.rulePack,
    pacsViewerProfile: input.pacsViewerProfile,
  }).summary;
}

export async function replayPreRoundResearchSnapshotAsync(input, options = {}) {
  return (await HospitalAgentAdapter.executePreRoundWorkflowAsync({
    host: 'his_embed', context: input.context, dataFeeds: input.dataFeeds,
    sourceAvailability: input.sourceAvailability, pacsViewerProfile: input.pacsViewerProfile,
    frozenRulePack: input.rule_pack_encoding === 'clinical-drug-name-v1' ? decodeResearchRulePack(input.rulePack) : input.rulePack,
    ...options,
  })).summary;
}

function assertNoHardIdentifiers(text) {
  const hit = scanStructuredValue(text).findings.find((finding) => HARD_IDENTIFIER_TYPES.has(finding.type));
  if (hit) {
    throw new Error(`FAIL_CLOSED_PHI_VIOLATION: Raw unredacted PHI detected in payload (${hit.type}). Processing blocked.`);
  }
}
import {
  CLINICAL_SURFACES,
  ENGINEERING_SURFACES,
  assertClinicalHostAllowed,
  assertSkillInvocable,
  resolveClinicalLanding,
} from "./clinical-landing-policy.mjs";

export const HOST_TYPES = {
  CODEX: ENGINEERING_SURFACES.CODEX,
  TRAE: ENGINEERING_SURFACES.TRAE,
  WORKBUDDY: ENGINEERING_SURFACES.WORKBUDDY,
  HOSPITAL_CUSTOM_AGENT: "hospital_custom_agent",
  CDS_HOOKS_ADAPTER: "cds_hooks_adapter",
  HIS_EMBED: CLINICAL_SURFACES.HIS_EMBED,
  HOSPITAL_SSO: CLINICAL_SURFACES.HOSPITAL_SSO,
};

export class HospitalAgentAdapter {
  /** Explicit dual-track ingress; raw free text never enters the sync engine. */
  static async executePreRoundWorkflowAsync({ localPhiDetector, signal, ...args }) {
    args = structuredClone(args);
    this.validateContextEnvelope(args.context);
    localPhiDetector = await resolvePhiDetector({ detector:localPhiDetector, context:args.context });
    return withPhiInferenceScope(args.context, localPhiDetector, async () => {
    const { input, session, receipt } = await guardPatientSourceInput({
      ...canonicalClinicalFeeds(args.dataFeeds), context: args.context,
      encounter: args.dataFeeds?.encounter ?? { id: args.context.encounter_id },
      source_availability: args.sourceAvailability ?? args.dataFeeds?.source_availability ?? [],
    }, { detector: localPhiDetector, signal });
    try {
      const { context, ...dataFeeds } = input;
      const result = await this.#executeGuardedPreRoundWorkflow({ ...args, context, dataFeeds,
        sourceAvailability: input.source_availability }, { localPhiDetector, signal });
      result.phi_guard = receipt;
      return result;
    } finally { session.dispose(); }
    });
  }
  static resolveRulePack(context) {
    const packId = context?.specialty_rule_pack_id;
    if (!packId) return null;
    const production = context?.profile === "production" || process.env.NODE_ENV === "production" || process.env.MEDCIUS_PROFILE === "production";
    return loadSpecialtyRulePack(packId, { production });
  }

  /**
   * Validate context envelope and enforce fail-closed security policy.
   */
  static validateContextEnvelope(context) {
    if (!context || typeof context !== "object") {
      throw new Error("FAIL_CLOSED: Missing context envelope payload");
    }
    const { tenant_id, doctor_id, patient_id, encounter_id } = context;

    if (!tenant_id || typeof tenant_id !== "string" || tenant_id.trim().length === 0) {
      throw new Error("FAIL_CLOSED: Missing or invalid tenant_id (租户标识缺失)");
    }
    if (!doctor_id || typeof doctor_id !== "string" || doctor_id.trim().length === 0) {
      throw new Error("FAIL_CLOSED: Missing or invalid doctor_id (医生身份标识缺失)");
    }
    if (!patient_id || typeof patient_id !== "string" || patient_id.trim().length === 0) {
      throw new Error("FAIL_CLOSED: Missing or invalid patient_id (患者主体标识缺失)");
    }
    if (!encounter_id || typeof encounter_id !== "string" || encounter_id.trim().length === 0) {
      throw new Error("FAIL_CLOSED: Missing or invalid encounter_id (就诊标识缺失)");
    }

    return true;
  }

  /**
   * Execute inpatient pre-round patient evolution workflow for any host agent.
   */
  static executePreRoundWorkflow({ host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT, context, dataFeeds, frozenRulePack = undefined, sourceAvailability = undefined, pacsViewerProfile = null }) {
    assertSyncPhiAllowed(context);
    return this.#executeGuardedPreRoundWorkflow({ host, context, dataFeeds, frozenRulePack, sourceAvailability, pacsViewerProfile });
  }

  static #executeGuardedPreRoundWorkflow({ host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT, context, dataFeeds, frozenRulePack = undefined, sourceAvailability = undefined, pacsViewerProfile = null }, asyncOptions) {
    dataFeeds = canonicalClinicalFeeds(dataFeeds);
    const availability = sourceAvailability ?? dataFeeds?.source_availability ?? [];
    if (!Array.isArray(availability)) throw new Error("FAIL_CLOSED_SOURCE_AVAILABILITY: expected an explicit array");
    // Capture exactly the source states supplied with this snapshot; an empty
    // feed alone never establishes that an interface succeeded or failed.
    const frozenAvailability = toModelSafe(structuredClone(availability));
    this.validateContextEnvelope(context);
    assertSkillInvocable({
      skillId: "patient-evolution-summary",
      host,
      clinicalLanding: context?.clinical_landing,
    });
    assertClinicalHostAllowed(host, { clinicalLanding: context?.clinical_landing });

    const { tenant_id, doctor_id, doctor_name, patient_id, encounter_id, time_window = "24h" } = context;
    const { patient, notes = [], nis = [], lis = [], pacs = [], his_orders = [], allergies = null } = dataFeeds || {};
    const rulePack = frozenRulePack === undefined ? this.resolveRulePack(context) : frozenRulePack;

    if (!patient || patient.id !== patient_id) {
      throw new Error(`FAIL_CLOSED: Patient record mismatch or missing in active ward context (expected ${patient_id})`);
    }

    assertExplicitFeedOwnership({ tenant_id, patient_id, encounter_id }, notes, "note");
    assertExplicitFeedOwnership({ tenant_id, patient_id, encounter_id }, nis, "nis");
    assertExplicitFeedOwnership({ tenant_id, patient_id, encounter_id }, lis, "lis");
    assertExplicitFeedOwnership({ tenant_id, patient_id, encounter_id }, pacs, "pacs");
    assertExplicitFeedOwnership({ tenant_id, patient_id, encounter_id }, his_orders, "his");
    assertNoHardIdentifiers({ patient, notes, nis, lis, pacs, his_orders });
    // Anchor and replay the same guarded note representation. Redacting only
    // after extraction changes offsets/digests and can break a frozen replay.
    const phiSession = createPhiEntitySession({ ...dataFeeds, context, encounter: dataFeeds.encounter ?? { id: encounter_id } });
    let guardedNotes;
    try { guardedNotes = JSON.parse(JSON.stringify(guardSessionValue(notes, { session: phiSession, context }), (_key, value) => value === undefined ? null : value)); }
    finally { phiSession.dispose(); }

    const asOf = context.as_of || context.now || new Date().toISOString();
    const asOfMs = new Date(asOf).getTime();
    if (!Number.isFinite(asOfMs)) throw new Error("FAIL_CLOSED: as_of is not a valid timestamp");
    const windowHours = time_window === "72h" ? 72 : 24;
    const cutoff = new Date(asOfMs - windowHours * 60 * 60 * 1000).toISOString();

    const nisNormalized = HospitalDataAdapter.normalizeNisFeed(nis, { rulePack, cutoffTime: cutoff, now: asOf });
    const lisNormalized = HospitalDataAdapter.normalizeLisFeed(lis, { rulePack, cutoffTime: cutoff, now: asOf });
    const pacsNormalized = HospitalDataAdapter.normalizePacsFeed(pacs, { cutoffTime: cutoff, now: asOf });
    const hisNormalized = HospitalDataAdapter.normalizeHisOrders(his_orders, { rulePack, now: asOfMs });

    const mergedObservations = [...(lisNormalized.observations || []), ...(nisNormalized.fhir_observations || [])];
    const chinaClinicalSource = dataFeeds.chinaClinical ?? (dataFeeds.clinical_quality?.length || rulePack?.clinical_rules?.china_reference_checks === true
      ? { records: dataFeeds.clinical_quality || [], region: context.region } : null);
    const chinaClinical = chinaClinicalSource ? { ...chinaClinicalSource,
      pharmacy_catalog: chinaClinicalSource.pharmacy_catalog || selectChinaPharmacyCatalog(loadChinaPharmacyCatalog({ production: requiresProductionPhi(context) }),
        [...hisNormalized.medications, ...(chinaClinicalSource.records || []).filter(r => r.kind === "medication")], { production: requiresProductionPhi(context) }) } : null;
    const engineInput = {
      patient,
      context: { tenant_id, doctor_id, patient_id, encounter_id, ...(requiresProductionPhi(context) ? { profile: "production" } : {}) },
      pacsViewerProfile,
      timeWindow: time_window,
      notes: guardedNotes,
      observations: mergedObservations,
      medications: hisNormalized.medications,
      chinaClinical,
      diagnosticReports: [],
      pacsFeed: pacs,
      nursingFeed: nis,
      orders: hisNormalized.orders,
      allergies,
      rulePack,
      sourceAvailability: frozenAvailability,
      recordHistory: {
        nis,
        observations: lisNormalized.history_records || [],
        diagnosticReports: pacsNormalized.history_records || [],
        orders: hisNormalized.orders || [],
      },
      now: asOf,
    };
    const finish = (engineOutput) => {
    const evolutionSummary = JSON.parse(JSON.stringify(engineOutput));

    const modelSafeSummary = toModelSafe(evolutionSummary);
    const outputPhiCheck = containsRawStructuredPhi(modelSafeSummary);
    if (outputPhiCheck.hit) {
      throw new Error(`FAIL_CLOSED_PHI_VIOLATION: Raw unredacted PHI detected in payload (${outputPhiCheck.type}). Processing blocked.`);
    }

    const provenanceDigest = sha256Hex(canonicalJson({
      tenant_id,
      patient_id,
      encounter_id,
      time_window,
      total_items: evolutionSummary.total_items_count,
      summary_sha256: sha256Hex(canonicalJson(modelSafeSummary)),
      timestamp: asOf,
    }));

    const result = toModelSafe({
      success: true,
      host_info: {
        host_type: host,
        adapter_version: PLUGIN_VERSION,
        workflow: "patient-evolution-summary",
      },
      context: {
        tenant_id,
        doctor_id,
        doctor_name: doctor_name || "Doctor",
        patient_id,
        encounter_id: encounter_id,
        time_window,
      },
      summary: modelSafeSummary,
      as_of: asOf,
      provenance: {
        envelope_sha256: provenanceDigest,
        evidence_count: evolutionSummary.blocks.evidence.length,
        verbatim_spans_count: evolutionSummary.selectable_items.filter((i) => i.span != null).length,
      },
      rule_pack: rulePack ? {
        pack_id: rulePack.pack_id,
        version: rulePack.version,
        sha256: rulePack.sha256,
        data_class: rulePack.data_class,
      } : {
        pack_id: null,
        status: "no_specialty_pack_source_flags_only",
      },
      security_contract: {
        fail_closed_verified: true,
        phi_leakage_detected: false,
        read_only_enforced: true,
      },
    });
    researchSnapshots.set(result, {
      engineInput: toModelSafe({ ...engineInput, rulePack: encodeResearchRulePack(rulePack), rule_pack_encoding: "clinical-drug-name-v1" }),
      engineOutput: modelSafeSummary,
      sourceAvailability: frozenAvailability,
      replayInput: toModelSafe({ context: { ...context, as_of: asOf }, dataFeeds: { ...dataFeeds, notes: guardedNotes, ...(chinaClinical ? { chinaClinical } : {}) },
        pacsViewerProfile,
        sourceAvailability: frozenAvailability, rulePack: encodeResearchRulePack(rulePack), rule_pack_encoding: "clinical-drug-name-v1" }),
    });
    return result;
    };
    return asyncOptions
      ? PatientEvolutionEngine.analyzePatientEvolutionAsync(engineInput, asyncOptions).then(finish)
      : finish(PatientEvolutionEngine.analyzePatientEvolution(engineInput));
  }

  /**
   * Read heterogeneous hospital sources through a bounded read-only bridge,
   * then execute the same pre-round workflow. The source manifest is returned
   * separately from clinician-facing output for audit and troubleshooting.
   */
  static async executePreRoundFromBridge({ host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT, context, bridge, localPhiDetector, signal }) {
    this.validateContextEnvelope(context);
    if (!bridge || typeof bridge.readPatientSnapshot !== "function") {
      throw new Error("FAIL_CLOSED: A ReadOnlyHospitalDataBridge instance is required");
    }
    const fixedContext = { ...context, as_of: context.as_of || context.now || new Date().toISOString() };
    localPhiDetector = await resolvePhiDetector({ detector: localPhiDetector, context: fixedContext });
    return withPhiInferenceScope(fixedContext, localPhiDetector, async () => {
    const snapshot = await bridge.readPatientSnapshot({ ...fixedContext }, { localPhiDetector, signal });
    if (snapshot?.security_contract?.read_only_enforced !== true) throw new Error("FAIL_CLOSED: Source read-only contract is unverified");
    if (snapshot.source_availability != null && snapshot.dataFeeds?.source_availability != null
        && canonicalJson(snapshot.source_availability) !== canonicalJson(snapshot.dataFeeds.source_availability)) {
      throw new Error("FAIL_CLOSED_SOURCE_AVAILABILITY: bridge and feed availability disagree");
    }
    const result = await this.executePreRoundWorkflowAsync({ host, context: fixedContext, dataFeeds: snapshot.dataFeeds, localPhiDetector, signal,
      sourceAvailability: snapshot.source_availability ?? snapshot.dataFeeds?.source_availability ?? [] });
    const response = {
      ...result,
      source_bridge: toModelSafe({
        schema_version: snapshot.schema_version,
        completeness: snapshot.completeness,
        source_manifest: snapshot.source_manifest,
        source_availability: researchSnapshots.get(result).sourceAvailability,
        unavailable_sources: snapshot.unavailable_sources,
        degraded_records: snapshot.degraded_records || [],
        read_only_enforced: snapshot.security_contract.read_only_enforced,
      }),
    };
    researchSnapshots.set(response, researchSnapshots.get(result));
    return response;
    });
  }

  /**
   * Execute shift handover workflow (SBAR / I-PASS model).
   */
  static executeShiftHandoverWorkflow({ host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT, context, dataFeeds, shiftType = SHIFT_TYPES.MORNING_TO_EVENING,
    handoverContext = {}, handoverEvents = [], verifyHandoverEvent, verifyHandoverHistory, eventsAsOf, windowStart }) {
    this.validateContextEnvelope(context);
    assertSkillInvocable({
      skillId: "shift-handover",
      host,
      clinicalLanding: context?.clinical_landing,
    });

    const { tenant_id, doctor_id, doctor_name, patient_id, encounter_id } = context;
    const { patient, encounter = {}, notes = [], nis = [], lis = [], pacs = [], his_orders = [], allergies = null } = dataFeeds || {};
    const rulePack = this.resolveRulePack(context);

    if (!patient || patient.id !== patient_id) {
      throw new Error(`FAIL_CLOSED: Patient record mismatch for handover (expected ${patient_id})`);
    }

    const asOf = context.as_of || new Date().toISOString();
    const handoverPackage = ShiftHandoverEngine.analyzePatientHandover({
      context: { tenant_id, patient_id, encounter_id }, asOf,
      windowStart: windowStart || context.window_start || new Date(new Date(asOf).getTime() - 24 * 3600_000).toISOString(),
      eventsAsOf, handoverContext, handoverEvents, verifyHandoverEvent, verifyHandoverHistory, rulePack,
      patient,
      encounter,
      notes,
      nursing: dataFeeds.nursing ?? nis,
      observations: dataFeeds.observations ?? lis,
      diagnosticReports: dataFeeds.diagnosticReports ?? pacs,
      medications: dataFeeds.medications ?? his_orders.filter(order => order.is_medication),
      orders: dataFeeds.orders ?? his_orders.filter(order => !order.is_medication),
      sourceAvailability: dataFeeds.source_availability ?? [],
      allergies,
      shiftType,
    });

    const draftText = ShiftHandoverEngine.generateHandoverText({
      handoverData: handoverPackage,
      outgoingDoctor: doctor_name || doctor_id,
    });

    const provenanceDigest = sha256Hex(canonicalJson({
      tenant_id,
      patient_id,
      encounter_id,
      shift_type: shiftType,
      packet_digest: handoverPackage.packet_digest,
      event_history: handoverPackage.handover_events,
    }));

    return {
      success: true,
      host_info: {
        host_type: host,
        adapter_version: PLUGIN_VERSION,
        workflow: "shift-handover",
      },
      context: {
        tenant_id,
        doctor_id,
        doctor_name: toModelSafe({ doctor_name: doctor_name || doctor_id }).doctor_name,
        patient_id,
        encounter_id: encounter_id || null,
      },
      handover: handoverPackage,
      draft_text: draftText,
      provenance: {
        envelope_sha256: provenanceDigest,
      },
      security_contract: {
        fail_closed_verified: true,
        read_only_enforced: true,
      },
    };
  }

  /**
   * Execute specialist consultation preparation workflow.
   */
  static executeConsultPrepWorkflow({ host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT, context, dataFeeds, consultRequest = {}, consultRequests = null }) {
    this.validateContextEnvelope(context);
    assertSkillInvocable({
      skillId: "consult-preparation",
      host,
      clinicalLanding: context?.clinical_landing,
    });

    if (!consultRequests && !consultRequest.department) {
      throw new Error("FAIL_CLOSED: Missing target department (consultRequest.department is required)");
    }

    const { tenant_id, doctor_id, doctor_name, patient_id, encounter_id } = context;
    const { patient, encounter = {}, notes = [], lis = [], pacs = [], his_orders = [], allergies = null } = dataFeeds || {};
    if (!patient || patient.id !== patient_id) {
      throw new Error(`FAIL_CLOSED: Patient record mismatch for consult preparation (expected ${patient_id})`);
    }

    const snapshot = ConsultPreparationEngine.createSnapshot({
      context: { tenant_id, patient_id, encounter_id }, patient, encounter, notes, allergies,
      asOf: context.as_of || new Date().toISOString(), observations: dataFeeds.observations ?? lis,
      diagnosticReports: dataFeeds.diagnosticReports ?? pacs,
      medications: dataFeeds.medications ?? his_orders.filter((order) => order.is_medication),
      orders: dataFeeds.orders ?? his_orders.filter((order) => !order.is_medication),
      sourceAvailability: dataFeeds.source_availability ?? [],
      nursing: dataFeeds.nursing ?? dataFeeds.nis ?? [],
    });
    const consultationViews = ConsultPreparationEngine.prepareConsultViews({ snapshot, consultRequests: consultRequests ?? [consultRequest] });
    const consultDossier = consultationViews.views[0];

    const briefText = ConsultPreparationEngine.generateConsultBriefText({
      consultDossier,
      requestingDoctor: doctor_name || doctor_id,
    });

    const provenanceDigest = sha256Hex(canonicalJson({
      tenant_id,
      patient_id,
      encounter_id,
      snapshot_id: snapshot.snapshot_id,
      dossier_digests: consultationViews.views.map((view) => view.dossier_sha256),
    }));

    return {
      success: true,
      host_info: {
        host_type: host,
        adapter_version: PLUGIN_VERSION,
        workflow: "consult-preparation",
      },
      context: {
        tenant_id,
        doctor_id,
        doctor_name: toModelSafe({ doctor_name: doctor_name || doctor_id }).doctor_name,
        patient_id,
        encounter_id: encounter_id || null,
      },
      dossier: consultDossier,
      consultation_views: consultationViews,
      brief_text: briefText,
      provenance: {
        envelope_sha256: provenanceDigest,
      },
      security_contract: {
        fail_closed_verified: true,
        read_only_enforced: true,
      },
    };
  }

  /**
   * Execute discharge readiness & completeness check workflow.
   */
  static executeDischargeReadinessWorkflow({ host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT, context, dataFeeds, dischargeMedications = [],
    medicationTransitions = [], followUpPlans = [], patientInstructions = [] }) {
    this.validateContextEnvelope(context);
    assertSkillInvocable({
      skillId: "discharge-readiness-check",
      host,
      clinicalLanding: context?.clinical_landing,
    });

    const { tenant_id, doctor_id, doctor_name, patient_id, encounter_id } = context;
    const { patient, encounter = {}, notes = [], pacs = [], his_orders = [], allergies = null, financial_access = [] } = dataFeeds || {};
    if (!patient || patient.id !== patient_id) {
      throw new Error(`FAIL_CLOSED: Patient record mismatch for discharge check (expected ${patient_id})`);
    }

    const readinessResult = DischargeReadinessEngine.evaluateDischargeReadiness({
      context: { tenant_id, patient_id, encounter_id }, asOf: context.as_of || new Date().toISOString(),
      patient,
      encounter,
      diagnosticReports: dataFeeds.diagnosticReports ?? pacs,
      observations: dataFeeds.observations ?? dataFeeds.lis ?? [],
      inpatientMedications: dataFeeds.medications ?? his_orders.filter(order => order.is_medication),
      chinaClinical: dataFeeds.chinaClinical ?? { region: context.region },
      orders: dataFeeds.orders ?? his_orders.filter(order => !order.is_medication),
      sourceAvailability: dataFeeds.source_availability ?? [],
      dischargeMedications, medicationTransitions, followUpPlans, patientInstructions,
      notes,
      allergies,
      financialAccessRecords: financial_access,
    });

    const checklistText = DischargeReadinessEngine.generateDischargeChecklistText({
      readinessResult,
      attendingDoctor: doctor_name || doctor_id,
    });

    const provenanceDigest = sha256Hex(canonicalJson({
      tenant_id,
      patient_id,
      encounter_id,
      packet_digest: readinessResult.packet_digest,
      financial_access_status: readinessResult.patient_affordability.assessment_status,
      as_of: readinessResult.as_of,
    }));

    return {
      success: true,
      host_info: {
        host_type: host,
        adapter_version: PLUGIN_VERSION,
        workflow: "discharge-readiness-check",
      },
      context: {
        tenant_id,
        doctor_id,
        doctor_name: toModelSafe({ doctor_name: doctor_name || doctor_id }).doctor_name,
        patient_id,
        encounter_id: encounter_id || null,
      },
      readiness: readinessResult,
      checklist_text: checklistText,
      provenance: {
        envelope_sha256: provenanceDigest,
      },
      security_contract: {
        fail_closed_verified: true,
        read_only_enforced: true,
      },
    };
  }

  /**
   * 4.1 Intent Routing & Catalog Approval Gate
   * Routes user intent to pre-approved clinical workflow skills, strictly validating against ClinicalSkillCatalog.
   * Rejects improvised workflows outside the catalog in production.
   */
  static routeAndExecuteWorkflow({
    skillId,
    host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT,
    context,
    dataFeeds,
    catalog = null,
    mode = "production",
    options = {},
  }) {
    assertSyncPhiAllowed(context);
    this.validateContextEnvelope(context);

    // 1. Enforce Catalog Verification if catalog is provided or in production
    if (catalog) {
      const eligibility = catalog.isSkillApproved(skillId, mode);
      if (!eligibility.isEligible) {
        throw new Error(`FAIL_CLOSED_SKILL_UNAPPROVED: Skill '${skillId}' is not approved for ${mode} execution (${eligibility.reason})`);
      }
    }

    assertSkillInvocable({
      skillId,
      host,
      clinicalLanding: context?.clinical_landing || mode === "clinical_landing",
    });

    // 2. Strict Intent Routing Dispatch
    switch (skillId) {
      case "patient-evolution-summary": {
        const result = this.executePreRoundWorkflow({ host, context, dataFeeds });
        const progressiveViews = StagedDraftService.generateProgressiveViewsFromSummary(result.summary, {
          patient: result.summary?.patient || toModelSafe(dataFeeds?.patient || {}),
          timeWindow: context.time_window || "24h",
        });
        return {
          ...result,
          progressive_views: progressiveViews,
        };
      }

      case "shift-handover": {
        return this.executeShiftHandoverWorkflow({
          host,
          context,
          dataFeeds,
          shiftType: options.shiftType || SHIFT_TYPES.MORNING_TO_EVENING,
          handoverContext: options.handoverContext, handoverEvents: options.handoverEvents,
          verifyHandoverEvent: options.verifyHandoverEvent, eventsAsOf: options.eventsAsOf, windowStart: options.windowStart,
          verifyHandoverHistory: options.verifyHandoverHistory,
        });
      }

      case "consult-preparation": {
        return this.executeConsultPrepWorkflow({
          host,
          context,
          dataFeeds,
          consultRequest: options.consultRequest || { department: options.department, purpose: options.purpose },
          consultRequests: options.consultRequests ?? null,
        });
      }

      case "discharge-readiness-check": {
        return this.executeDischargeReadinessWorkflow({
          host,
          context,
          dataFeeds,
          dischargeMedications: options.dischargeMedications || [],
          medicationTransitions: options.medicationTransitions || [], followUpPlans: options.followUpPlans || [],
          patientInstructions: options.patientInstructions || [],
        });
      }

      default: {
        throw new Error(`FAIL_CLOSED_UNREGISTERED_WORKFLOW: Improvised or unregistered clinical workflow '${skillId}' is prohibited. Only approved catalog skills may execute.`);
      }
    }
  }

  static async routeAndExecuteWorkflowAsync({ skillId, host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT,
    context, dataFeeds, catalog = null, mode = 'production', localPhiDetector, signal } = {}) {
    this.validateContextEnvelope(context);
    if (catalog && !catalog.isSkillApproved(skillId, mode).isEligible) throw new Error('FAIL_CLOSED_SKILL_UNAPPROVED');
    assertSkillInvocable({ skillId, host, clinicalLanding: context?.clinical_landing || mode === 'clinical_landing' });
    if (skillId !== 'patient-evolution-summary') throw new Error('PHI_ASYNC_WORKFLOW_NOT_ENABLED');
    const result = await this.executePreRoundWorkflowAsync({ host, context, dataFeeds, localPhiDetector, signal });
    const progressiveViews = StagedDraftService.generateProgressiveViewsFromSummary(result.summary, {
      patient: result.summary.patient, timeWindow: context.time_window || '24h',
    });
    return { ...result, progressive_views: progressiveViews };
  }

  /**
   * Generate doctor-confirmed progress note draft for host agent.
   */
  static generateProgressNoteDraft({ context, summaryData, selectedItemIds, customNotes = "" }) {
    this.validateContextEnvelope(context);
    if (resolveClinicalLanding({ host: context?.host, clinicalLanding: context?.clinical_landing })) {
      throw new Error("P0_DRAFT_SUPPRESSED_SILENT_PILOT: clinician-facing progress-note draft is disabled on the clinical landing surface");
    }

    const draft = PatientEvolutionEngine.generateProgressNoteDraft({
      summaryData,
      selectedItemIds,
      doctorId: context.doctor_id,
      doctorName: context.doctor_name || context.doctor_id,
      customAdditions: customNotes,
    });

    return {
      success: true,
      draft,
      audit: {
        doctor_id: context.doctor_id,
        selected_count: draft.selected_count,
        timestamp: new Date().toISOString(),
      },
    };
  }
}
