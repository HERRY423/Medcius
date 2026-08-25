// Clinical Supervisor Multi-Agent Orchestrator
// Coordinates specialized workers (ExtractWorker, CodingWorker, PharmaWorker, AuditWorker)
// into structured DAG pipelines with strict schema enforcement, audit tracking, and error boundaries.

import { ExtractWorker } from "./workers/extract-worker.mjs";
import { CodingWorker } from "./workers/coding-worker.mjs";
import { PharmaWorker } from "./workers/pharma-worker.mjs";
import { AuditWorker } from "./workers/audit-worker.mjs";
import { escalationProtocol } from "./escalation.mjs";

export class ClinicalSupervisor {
  constructor(options = {}) {
    this.options = options;
    this.extractWorker = new ExtractWorker(options);
    this.codingWorker = new CodingWorker(options);
    this.pharmaWorker = new PharmaWorker(options);
    this.auditWorker = new AuditWorker(options);
    this.escalationProtocol = escalationProtocol;
  }

  /**
   * Complete End-to-End Clinical Encounter Processing:
   * 1. Extract clinical structure from free text note.
   * 2. Fan-out: Run CodingWorker on diagnoses/procedures + PharmaWorker on drugs/labs.
   * 3. Cross-validate findings & evaluate escalation thresholds.
   * 4. Record full trace to AuditWorker.
   * 5. Return consolidated, evidence-backed report.
   */
  async processEncounter({
    noteText = "",
    drugs = [],
    allergies = [],
    actor = "system:supervisor",
    subjectRef = null,
    includeSamples = false,
    signoff = null,
    tenant_id = "default",
  }) {
    const startTime = Date.now();
    const timeline = [];

    // ----------------------------------------------------
    // Phase 1: Note Extraction
    // ----------------------------------------------------
    let extraction = null;
    if (noteText && noteText.trim()) {
      extraction = await this.extractWorker.run({ text: noteText, id: "enc-note" });
      timeline.push({ phase: "extraction", durationMs: Date.now() - startTime, status: extraction.status });
    }

    // Extract diagnoses and procedures from note if not provided explicitly
    const rec = extraction?.record;
    const diagnoses = [];
    if (rec?.discharge_diagnosis_primary?.value) diagnoses.push(rec.discharge_diagnosis_primary.value);
    if (rec?.discharge_diagnosis_other?.value) {
      const others = rec.discharge_diagnosis_other.value.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
      diagnoses.push(...others);
    }
    if (!diagnoses.length && rec?.admission_diagnosis?.value) {
      diagnoses.push(rec.admission_diagnosis.value);
    }

    const procedures = [];
    if (rec?.procedures?.value) {
      const procs = rec.procedures.value.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
      procedures.push(...procs);
    }

    // Demographic & Lab Context
    const patientGender = rec?.demographics?.sex_cn || rec?.demographics?.sex;
    const patientAge = rec?.demographics?.age;
    const scrLab = rec?.labs?.find((l) => l.name === "肌酐");
    const scrUmolL = scrLab ? scrLab.value : undefined;

    // ----------------------------------------------------
    // Phase 2: Parallel Fan-Out (Coding + Pharmacology)
    // ----------------------------------------------------
    const phase2Start = Date.now();

    const [codingResult, pharmaResult] = await Promise.all([
      // Branch A: NHSA Coding
      diagnoses.length || procedures.length
        ? this.codingWorker.run({ diagnoses, procedures, patient_gender: patientGender, include_samples: includeSamples })
        : Promise.resolve({ status: "skipped", reason: "no diagnoses or procedures" }),

      // Branch B: Prescription & Pharmacology Review
      drugs.length
        ? this.pharmaWorker.run({
            patient: { age: patientAge, sex_cn: patientGender, scrUmolL },
            diagnoses,
            drugs,
            allergies,
            include_samples: includeSamples,
          })
        : Promise.resolve({ status: "skipped", reason: "no medications supplied" }),
    ]);

    timeline.push({ phase: "parallel_workers", durationMs: Date.now() - phase2Start });

    // ----------------------------------------------------
    // Phase 3: Consolidated Review, Cross-Validation & Escalation
    // ----------------------------------------------------
    const crossVal = this.escalationProtocol.crossValidateWorkers({
      extraction: rec,
      coding: codingResult,
      pharma: pharmaResult,
    });

    const escalation = this.escalationProtocol.evaluateEscalationThreshold({
      pharmaVerdict: pharmaResult,
      crossValidationAlerts: crossVal.alerts,
    });

    const summary = {
      diagnoses_resolved: codingResult?.items?.length ?? 0,
      coding_checklist_passed: codingResult?.settlement_checklist?.passed ?? true,
      pharma_verdict: pharmaResult?.verdict ?? "N/A",
      pharma_issues_count: pharmaResult?.issues_count ?? 0,
      cross_validation_passed: crossVal.crossValidationPassed,
      escalation_tier: escalation.escalationTier,
      requires_escalation: escalation.shouldEscalate,
    };

    // ----------------------------------------------------
    // Phase 4: Audit Trail Recording
    // ----------------------------------------------------
    const resolvedSubject = subjectRef || (patientGender && patientAge ? `[PSN:${patientGender}-${patientAge}]` : "[PSN:anonymous]");
    const auditRes = await this.auditWorker.run({
      action: "clinical_encounter_processed",
      actor,
      subject_ref: resolvedSubject,
      data_class: includeSamples ? "sample" : "official",
      tenant_id: tenant_id || "default",
      payload: {
        summary,
        coding_items: codingResult?.items?.map((i) => ({ code: i.code, name: i.name, status: i.validation_status })),
        pharma_verdict: pharmaResult?.verdict,
        g_gates: pharmaResult?.g_gates,
        cross_validation: crossVal,
        escalation,
      },
      signoff,
    });

    timeline.push({ phase: "audit", durationMs: Date.now() - startTime });

    return {
      status: "completed",
      supervisor: "ClinicalSupervisor",
      total_duration_ms: Date.now() - startTime,
      timeline,
      patient_profile: {
        gender: patientGender,
        age: patientAge,
        scr_umol_l: scrUmolL,
      },
      extraction: extraction?.record ?? null,
      coding: codingResult,
      pharmacology: pharmaResult,
      cross_validation: crossVal,
      escalation,
      audit: auditRes,
      summary,
    };
  }

  /** Direct Prescription Review API wrapper */
  async reviewPrescription(params) {
    const pharmaRes = await this.pharmaWorker.run(params);
    const auditRes = await this.auditWorker.run({
      action: "rx_review_verdict",
      actor: params.actor ?? "clinician:pharmacist",
      subject_ref: params.subjectRef ?? "[PSN:rx-review]",
      tenant_id: params.tenant_id ?? "default",
      data_class: params.include_samples ? "sample" : "official",
      payload: {
        verdict: pharmaRes.verdict,
        drugs: params.drugs,
        issues: pharmaRes.issues,
        g_gates: pharmaRes.g_gates,
      },
      signoff: params.signoff,
    });
    return {
      ...pharmaRes,
      audit: auditRes,
    };
  }

  /** Direct Coding Resolution API wrapper */
  async resolveCoding(params) {
    const codeRes = await this.codingWorker.run(params);
    const auditRes = await this.auditWorker.run({
      action: "coding_resolved",
      actor: params.actor ?? "coder:specialist",
      subject_ref: params.subjectRef ?? "[PSN:coding]",
      tenant_id: params.tenant_id ?? "default",
      data_class: params.include_samples ? "sample" : "official",
      payload: {
        total_items: codeRes.items?.length,
        items: codeRes.items,
      },
    });
    return {
      ...codeRes,
      audit: auditRes,
    };
  }

  /** Direct Note Extraction API wrapper */
  async extractNote(params) {
    return this.extractWorker.run(params);
  }
}
