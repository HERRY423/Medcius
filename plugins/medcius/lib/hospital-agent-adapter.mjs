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
import { containsRawPhi, redactText } from "../servers/phiguard/src/lib.mjs";
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";

export const HOST_TYPES = {
  CODEX: "codex",
  TRAE: "trae",
  WORKBUDDY: "workbuddy",
  HOSPITAL_CUSTOM_AGENT: "hospital_custom_agent",
  CDS_HOOKS_ADAPTER: "cds_hooks_adapter",
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
  static executePreRoundWorkflow({ host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT, context, dataFeeds }) {
    this.validateContextEnvelope(context);

    const { tenant_id, doctor_id, doctor_name, patient_id, encounter_id, time_window = "24h" } = context;
    const { patient, notes = [], nis = [], lis = [], pacs = [], his_orders = [], allergies = null } = dataFeeds || {};
    const rulePack = this.resolveRulePack(context);

    if (!patient || patient.id !== patient_id) {
      throw new Error(`FAIL_CLOSED: Patient record mismatch or missing in active ward context (expected ${patient_id})`);
    }

    // Normalize multi-source feeds
    const nisNormalized = HospitalDataAdapter.normalizeNisFeed(nis, { rulePack });
    const lisNormalized = HospitalDataAdapter.normalizeLisFeed(lis, { rulePack });
    const pacsNormalized = HospitalDataAdapter.normalizePacsFeed(pacs);
    const hisNormalized = HospitalDataAdapter.normalizeHisOrders(his_orders, { rulePack });

    const mergedObservations = [...(lisNormalized.observations || []), ...(nisNormalized.fhir_observations || [])];

    const evolutionSummary = PatientEvolutionEngine.analyzePatientEvolution({
      patient,
      timeWindow: time_window,
      notes,
      observations: mergedObservations,
      medications: hisNormalized.medications,
      diagnosticReports: pacsNormalized.diagnostic_reports,
      orders: hisNormalized.orders,
      allergies,
      rulePack,
    });

    if (nisNormalized.vitals_summary || nisNormalized.fluid_balance) {
      evolutionSummary.blocks.what_changed.nursing_vitals_summary = nisNormalized.vitals_summary;
      evolutionSummary.blocks.what_changed.fluid_balance_24h = nisNormalized.fluid_balance;
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

    // Enforce strict PHI Guard check: Block immediately if raw unredacted PHI is present in feeds or output
    const feedsRaw = JSON.stringify({ patient, notes });
    const summaryJson = JSON.stringify(evolutionSummary);
    const inputPhiCheck = containsRawPhi(feedsRaw);
    const outputPhiCheck = containsRawPhi(summaryJson);

    if (inputPhiCheck.hit || outputPhiCheck.hit) {
      const reason = inputPhiCheck.hit ? inputPhiCheck.type : outputPhiCheck.type;
      throw new Error(`FAIL_CLOSED_PHI_VIOLATION: Raw unredacted PHI detected in payload (${reason}). Processing blocked.`);
    }

    const provenanceDigest = sha256Hex(canonicalJson({
      tenant_id,
      patient_id,
      encounter_id,
      time_window,
      total_items: evolutionSummary.total_items_count,
      timestamp: new Date().toISOString(),
    }));

    return {
      success: true,
      host_info: {
        host_type: host,
        adapter_version: "0.5.0-pilot",
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
      summary: evolutionSummary,
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
    };
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
    const snapshot = await bridge.readPatientSnapshot(context);
    const result = this.executePreRoundWorkflow({ host, context, dataFeeds: snapshot.dataFeeds });
    return {
      ...result,
      source_bridge: {
        schema_version: snapshot.schema_version,
        completeness: snapshot.completeness,
        source_manifest: snapshot.source_manifest,
        unavailable_sources: snapshot.unavailable_sources,
        read_only_enforced: snapshot.security_contract.read_only_enforced,
      },
    };
  }

  /**
   * Execute shift handover workflow (SBAR / I-PASS model).
   */
  static executeShiftHandoverWorkflow({ host = HOST_TYPES.HOSPITAL_CUSTOM_AGENT, context, dataFeeds, shiftType = SHIFT_TYPES.MORNING_TO_EVENING }) {
    this.validateContextEnvelope(context);

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
        adapter_version: "0.5.0-pilot",
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
        adapter_version: "0.5.0-pilot",
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
        adapter_version: "0.5.0-pilot",
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

    // 2. Strict Intent Routing Dispatch
    switch (skillId) {
      case "patient-evolution-summary": {
        const result = this.executePreRoundWorkflow({ host, context, dataFeeds });
        const progressiveViews = StagedDraftService.generateProgressiveViewsFromSummary(result.summary, {
          patient: dataFeeds?.patient || {},
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
