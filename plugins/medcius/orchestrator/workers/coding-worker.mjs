// NHSA Coding Worker
// Resolves Chinese clinical diagnoses and procedures to NHSA ICD-10 & surgery classification codes.
// Attaches 6-field provenance (code_system, code_version, effective_date, retrieved_at, source, validation_status).

import { HANDLERS as chinaCodesHandlers } from "../../servers/china-codes/src/tools.mjs";

export class CodingWorker {
  constructor(options = {}) {
    this.name = "CodingWorker";
    this.options = options;
  }

  async run(input) {
    const diagnoses = Array.isArray(input?.diagnoses) ? input.diagnoses.map(String).filter(Boolean) : [];
    const procedures = Array.isArray(input?.procedures) ? input.procedures.map(String).filter(Boolean) : [];
    const patientGender = input?.patient_gender ?? input?.sex_cn ?? null;
    const includeSamples = Boolean(input?.include_samples ?? true); // Default true for internal pipeline probe

    const resolvedItems = [];
    const retrievedAt = new Date().toISOString();

    // 1. Resolve Diagnoses
    for (const diag of diagnoses) {
      const searchRes = chinaCodesHandlers.search_codes({
        query: diag,
        code_type: "diagnosis",
        include_samples: includeSamples,
        limit: 5,
      });

      const bestHit = searchRes.hits?.[0] ?? null;
      if (bestHit) {
        const valRes = chinaCodesHandlers.validate_code({
          code: bestHit.code,
          code_type: "diagnosis",
        });

        resolvedItems.push({
          term: diag,
          kind: "diagnosis",
          code: bestHit.code,
          name: bestHit.name,
          code_system: "医保版ICD-10",
          code_version: bestHit.code_version || "unknown",
          effective_date: bestHit.effective_date || "unknown",
          retrieved_at: retrievedAt,
          source: bestHit.source_name || "local china-codes corpus",
          validation_status: valRes.valid ? "valid" : "pending",
          is_category_only: bestHit.is_category_only,
          disclaimer: bestHit.disclaimer,
        });
      } else {
        resolvedItems.push({
          term: diag,
          kind: "diagnosis",
          code: "NOT_FOUND",
          name: diag,
          code_system: "医保版ICD-10",
          code_version: "unknown",
          effective_date: "unknown",
          retrieved_at: retrievedAt,
          source: "local china-codes corpus",
          validation_status: "unverifiable",
          note: "本地编码库未命中，需查阅国家医保局最新编码目录",
        });
      }
    }

    // 2. Resolve Procedures
    for (const proc of procedures) {
      const searchRes = chinaCodesHandlers.search_codes({
        query: proc,
        code_type: "procedure",
        include_samples: includeSamples,
        limit: 5,
      });

      const bestHit = searchRes.hits?.[0] ?? null;
      if (bestHit) {
        resolvedItems.push({
          term: proc,
          kind: "procedure",
          code: bestHit.code,
          name: bestHit.name,
          code_system: "医保版手术操作分类编码（ICD-9-CM-3 基础）",
          code_version: bestHit.code_version || "unknown",
          effective_date: bestHit.effective_date || "unknown",
          retrieved_at: retrievedAt,
          source: bestHit.source_name || "local china-codes corpus",
          validation_status: "valid",
        });
      } else {
        resolvedItems.push({
          term: proc,
          kind: "procedure",
          code: "NOT_FOUND",
          name: proc,
          code_system: "医保版手术操作分类编码（ICD-9-CM-3 基础）",
          code_version: "unknown",
          effective_date: "unknown",
          retrieved_at: retrievedAt,
          source: "local china-codes corpus",
          validation_status: "unverifiable",
        });
      }
    }

    // 3. Settlement List Checklist Verification
    const mainDiag = diagnoses[0] ?? "";
    const otherDiags = diagnoses.slice(1);
    const checkRes = chinaCodesHandlers.check_settlement_list({
      main_diagnosis: mainDiag,
      other_diagnoses: otherDiags,
      procedures,
      patient_gender: patientGender,
      include_samples: includeSamples,
    });

    return {
      worker: this.name,
      status: "completed",
      items: resolvedItems,
      settlement_checklist: checkRes,
      summary: {
        total_terms: diagnoses.length + procedures.length,
        resolved_count: resolvedItems.filter((i) => i.code !== "NOT_FOUND").length,
        checklist_passed: checkRes.checks?.every((c) => c.passed !== false) ?? true,
      },
    };
  }
}
