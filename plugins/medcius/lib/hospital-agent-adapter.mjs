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
import { containsRawPhi, scanText } from "../servers/phiguard/src/lib.mjs";
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { assertExplicitFeedOwnership, toModelSafe } from "./clinical-boundary.mjs";

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
  }).summary;
}

function assertNoHardIdentifiers(text) {
  const hit = scanText(String(text ?? "")).findings.find((finding) => HARD_IDENTIFIER_TYPES.has(finding.type));
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
  static executePreRoundWorkflow({ host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT, context, dataFeeds, frozenRulePack = undefined, sourceAvailability = undefined }) {
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
    assertNoHardIdentifiers(JSON.stringify({ patient, notes, nis, lis, pacs, his_orders }));

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
    const engineInput = {
      patient,
      context: { tenant_id, doctor_id, patient_id, encounter_id },
      timeWindow: time_window,
      notes,
      observations: mergedObservations,
      medications: hisNormalized.medications,
      diagnosticReports: pacsNormalized.diagnostic_reports,
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
    const engineOutput = PatientEvolutionEngine.analyzePatientEvolution(engineInput);
    const evolutionSummary = JSON.parse(JSON.stringify(engineOutput));

    if (nisNormalized.vitals_summary || nisNormalized.fluid_balance) {
      evolutionSummary.blocks.what_changed.nursing_vitals_summary = nisNormalized.vitals_summary;
      evolutionSummary.blocks.what_changed.fluid_balance_24h = nisNormalized.fluid_balance;
    }
    for (const gap of [
      ...(nisNormalized.data_gaps || []),
      ...(pacsNormalized.time_gaps || []),
      ...(hisNormalized.time_gaps || []),
    ]) {
      evolutionSummary.blocks.data_gaps.push({
        id: `GAP-SRC-${evolutionSummary.blocks.data_gaps.length + 1}`,
        category: "DATA_GAP",
        tag: "【资料不足】",
        ...gap,
      });
    }
    if (lisNormalized.critical_values?.length > 0) {
      evolutionSummary.blocks.what_changed.critical_values = lisNormalized.critical_values;
    }
    if (hisNormalized.antibiotic_alerts?.length > 0) {
      evolutionSummary.blocks.what_changed.antibiotic_duration_alerts = hisNormalized.antibiotic_alerts;
    }
    if (pacsNormalized.imaging_impressions?.length > 0) {
      evolutionSummary.blocks.what_changed.imaging_impressions = pacsNormalized.imaging_impressions;
    }

    const modelSafeSummary = toModelSafe(evolutionSummary);
    const outputPhiCheck = containsRawPhi(JSON.stringify(modelSafeSummary));
    if (outputPhiCheck.hit) {
      throw new Error(`FAIL_CLOSED_PHI_VIOLATION: Raw unredacted PHI detected in payload (${outputPhiCheck.type}). Processing blocked.`);
    }

    const provenanceDigest = sha256Hex(canonicalJson({
      tenant_id,
      patient_id,
      encounter_id,
      time_window,
      total_items: evolutionSummary.total_items_count,
      timestamp: asOf,
    }));

    const result = toModelSafe({
      success: true,
      host_info: {
        host_type: host,
        adapter_version: "0.8.0-pilot",
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
      replayInput: toModelSafe({ context: { ...context, as_of: asOf }, dataFeeds,
        sourceAvailability: frozenAvailability, rulePack: encodeResearchRulePack(rulePack), rule_pack_encoding: "clinical-drug-name-v1" }),
    });
    return result;
  }

  /**
   * Read heterogeneous hospital sources through a bounded read-only bridge,
   * then execute the same pre-round workflow. The source manifest is returned
   * separately from clinician-facing output for audit and troubleshooting.
   */
  static async executePreRoundFromBridge({ host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT, context, bridge }) {
    this.validateContextEnvelope(context);
    if (!bridge || typeof bridge.readPatientSnapshot !== "function") {
      throw new Error("FAIL_CLOSED: A ReadOnlyHospitalDataBridge instance is required");
    }
    const fixedContext = { ...context, as_of: context.as_of || context.now || new Date().toISOString() };
    const snapshot = await bridge.readPatientSnapshot({ ...fixedContext });
    if (snapshot?.security_contract?.read_only_enforced !== true) throw new Error("FAIL_CLOSED: Source read-only contract is unverified");
    if (snapshot.source_availability != null && snapshot.dataFeeds?.source_availability != null
        && canonicalJson(snapshot.source_availability) !== canonicalJson(snapshot.dataFeeds.source_availability)) {
      throw new Error("FAIL_CLOSED_SOURCE_AVAILABILITY: bridge and feed availability disagree");
    }
    const result = this.executePreRoundWorkflow({ host, context: fixedContext, dataFeeds: snapshot.dataFeeds,
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
  }

  /**
   * Execute shift handover workflow (SBAR / I-PASS model).
   */
  static executeShiftHandoverWorkflow({ host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT, context, dataFeeds, shiftType = SHIFT_TYPES.MORNING_TO_EVENING }) {
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

    const nisNormalized = HospitalDataAdapter.normalizeNisFeed(nis, { rulePack });
    const lisNormalized = HospitalDataAdapter.normalizeLisFeed(lis, { rulePack });
    const hisNormalized = HospitalDataAdapter.normalizeHisOrders(his_orders, { rulePack });

    const handoverPackage = ShiftHandoverEngine.analyzePatientHandover({
      patient,
      encounter,
      notes,
      vitals: nisNormalized,
      observations: lisNormalized.observations,
      medications: hisNormalized.medications,
      orders: hisNormalized.orders,
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
      timestamp: new Date().toISOString(),
    }));

    return {
      success: true,
      host_info: {
        host_type: host,
        adapter_version: "0.8.0-pilot",
        workflow: "shift-handover",
      },
      context: {
        tenant_id,
        doctor_id,
        doctor_name: doctor_name || "Doctor",
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
  static executeConsultPrepWorkflow({ host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT, context, dataFeeds, consultRequest = {} }) {
    this.validateContextEnvelope(context);
    assertSkillInvocable({
      skillId: "consult-preparation",
      host,
      clinicalLanding: context?.clinical_landing,
    });

    if (!consultRequest.department) {
      throw new Error("FAIL_CLOSED: Missing target department (consultRequest.department is required)");
    }

    const { tenant_id, doctor_id, doctor_name, patient_id, encounter_id } = context;
    const { patient, encounter = {}, notes = [], lis = [], pacs = [], his_orders = [], allergies = null } = dataFeeds || {};
    const rulePack = this.resolveRulePack(context);

    if (!patient || patient.id !== patient_id) {
      throw new Error(`FAIL_CLOSED: Patient record mismatch for consult preparation (expected ${patient_id})`);
    }

    const lisNormalized = HospitalDataAdapter.normalizeLisFeed(lis, { rulePack });
    const pacsNormalized = HospitalDataAdapter.normalizePacsFeed(pacs);
    const hisNormalized = HospitalDataAdapter.normalizeHisOrders(his_orders, { rulePack });

    const consultDossier = ConsultPreparationEngine.prepareConsultDossier({
      patient,
      encounter,
      consultRequest,
      notes,
      observations: lisNormalized.observations,
      diagnosticReports: pacsNormalized.diagnostic_reports,
      medications: hisNormalized.medications,
      allergies,
    });

    const briefText = ConsultPreparationEngine.generateConsultBriefText({
      consultDossier,
      requestingDoctor: doctor_name || doctor_id,
    });

    const provenanceDigest = sha256Hex(canonicalJson({
      tenant_id,
      patient_id,
      encounter_id,
      target_department: consultRequest.department,
      timestamp: new Date().toISOString(),
    }));

    return {
      success: true,
      host_info: {
        host_type: host,
        adapter_version: "0.8.0-pilot",
        workflow: "consult-preparation",
      },
      context: {
        tenant_id,
        doctor_id,
        doctor_name: doctor_name || "Doctor",
        patient_id,
        encounter_id: encounter_id || null,
      },
      dossier: consultDossier,
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
  static executeDischargeReadinessWorkflow({ host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT, context, dataFeeds, dischargeMedications = [] }) {
    this.validateContextEnvelope(context);
    assertSkillInvocable({
      skillId: "discharge-readiness-check",
      host,
      clinicalLanding: context?.clinical_landing,
    });

    const { tenant_id, doctor_id, doctor_name, patient_id, encounter_id } = context;
    const { patient, encounter = {}, notes = [], pacs = [], his_orders = [], allergies = null, financial_access = [] } = dataFeeds || {};
    const rulePack = this.resolveRulePack(context);

    if (!patient || patient.id !== patient_id) {
      throw new Error(`FAIL_CLOSED: Patient record mismatch for discharge check (expected ${patient_id})`);
    }

    const pacsNormalized = HospitalDataAdapter.normalizePacsFeed(pacs);
    const hisNormalized = HospitalDataAdapter.normalizeHisOrders(his_orders, { rulePack });

    const readinessResult = DischargeReadinessEngine.evaluateDischargeReadiness({
      patient,
      encounter,
      diagnosticReports: pacsNormalized.diagnostic_reports,
      inpatientMedications: hisNormalized.medications,
      dischargeMedications,
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
      is_ready: readinessResult.readiness_verdict.is_ready,
      financial_access_status: readinessResult.patient_affordability.assessment_status,
      timestamp: new Date().toISOString(),
    }));

    return {
      success: true,
      host_info: {
        host_type: host,
        adapter_version: "0.8.0-pilot",
        workflow: "discharge-readiness-check",
      },
      context: {
        tenant_id,
        doctor_id,
        doctor_name: doctor_name || "Doctor",
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
        });
      }

      case "consult-preparation": {
        return this.executeConsultPrepWorkflow({
          host,
          context,
          dataFeeds,
          consultRequest: options.consultRequest || { department: options.department || "心血管内科" },
        });
      }

      case "discharge-readiness-check": {
        return this.executeDischargeReadinessWorkflow({
          host,
          context,
          dataFeeds,
          dischargeMedications: options.dischargeMedications || [],
        });
      }

      default: {
        throw new Error(`FAIL_CLOSED_UNREGISTERED_WORKFLOW: Improvised or unregistered clinical workflow '${skillId}' is prohibited. Only approved catalog skills may execute.`);
      }
    }
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
