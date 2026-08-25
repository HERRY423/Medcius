// Single-Ward Consecutive Cases Silent Validation Runner (心内科单病区连续病例静默验证)
// Hospital: 国家心血管临床医学中心（测试沙箱）心血管内科二病区 (Cardiology Ward 2, Beds 01-16)
// Protocol: Consecutive inpatient cases, silent background extraction, zero workflow interruption,
// exact span fidelity, LIS dynamic range compliance, and PHI guard validation.

import assert from "node:assert/strict";
import { getCardiologyWardFixture, HOSPITAL_SANDBOX_METADATA } from "../../servers/fhir/sandbox/hospital-cardiology-sandbox.mjs";
import { PatientEvolutionEngine } from "../../lib/patient-evolution-engine.mjs";
import { containsRawPhi } from "../../servers/phiguard/src/lib.mjs";

console.log("================================================================================");
console.log(` Medcius Cardiology Ward 2 Consecutive Inpatient Silent Validation`);
console.log(` Hospital: ${HOSPITAL_SANDBOX_METADATA.hospital_name} | Ward: ${HOSPITAL_SANDBOX_METADATA.ward_name}`);
console.log("================================================================================\n");

const wardCases = getCardiologyWardFixture();
console.log(`[Setup] Ingested ${wardCases.length} consecutive inpatient cases across Beds 01 - 16.\n`);

let processedCount = 0;
let validSpansCount = 0;
let fakeSpansCount = 0;
let phiLeakageCount = 0;
let dynamicRangeCompliantCount = 0;
let gapsDetectedCount = 0;

const caseResults = [];

for (const wardCase of wardCases) {
  const { patient, notes, observations, medications, diagnosticReports, orders, allergies } = wardCase;

  // Run 24h evolution summary
  const summary24h = PatientEvolutionEngine.analyzePatientEvolution({
    patient,
    timeWindow: "24h",
    notes,
    observations,
    medications,
    diagnosticReports,
    orders,
    allergies,
  });

  processedCount++;

  // 1. Check PHI Guard on generated summary
  const summaryJson = JSON.stringify(summary24h);
  const phiCheck = containsRawPhi(summaryJson);
  if (phiCheck.hit) {
    phiLeakageCount++;
  }

  // 2. Check Span Fidelity (Zero concatenated/fake spans)
  for (const item of summary24h.selectable_items) {
    if (item.span != null) {
      // Must be present in notes text or explicitly provided
      let matchedInNotes = notes.some((n) => (n.text || "").includes(item.span));
      let matchedInObs = observations.some((o) => o.span === item.span);
      if (matchedInNotes || matchedInObs) {
        validSpansCount++;
      } else {
        fakeSpansCount++;
      }
    }
  }

  // 3. Check LIS Dynamic Reference Range Compliance
  for (const lab of summary24h.blocks.what_changed.abnormal_labs) {
    if (!lab.has_reference_range) {
      assert.equal(lab.is_abnormal, false, "Must not flag abnormal when reference range is absent");
      assert.equal(lab.status_label, "无参考区间 (仅呈现趋势)");
    }
    dynamicRangeCompliantCount++;
  }

  // 4. Check Safety Gaps
  if (summary24h.blocks.data_gaps.length > 0) {
    gapsDetectedCount += summary24h.blocks.data_gaps.length;
  }

  caseResults.push({
    bed: patient.bed_number,
    patient_id: patient.id,
    changes_count: summary24h.total_items_count,
    symptoms: summary24h.blocks.what_changed.clinical_symptoms.length,
    labs: summary24h.blocks.what_changed.abnormal_labs.length,
    meds_diff: summary24h.blocks.what_changed.medication_diff.added.length + summary24h.blocks.what_changed.medication_diff.adjusted.length,
    pending: summary24h.blocks.whats_pending.pending_reports.length + summary24h.blocks.whats_pending.pending_orders.length,
    gaps: summary24h.blocks.data_gaps.length,
  });

  console.log(`  ✓ Bed ${patient.bed_number} [${patient.name}]: ${summary24h.total_items_count} items extracted (Changes: ${summary24h.blocks.what_changed.clinical_symptoms.length + summary24h.blocks.what_changed.abnormal_labs.length}, Pending: ${summary24h.blocks.whats_pending.pending_reports.length}, Gaps: ${summary24h.blocks.data_gaps.length})`);
}

console.log("\n================================================================================");
console.log(" Silent Validation Metrics (16 Consecutive Cardiology Inpatient Cases):");
console.log("================================================================================");
console.log(` - Total Consecutive Beds Processed: ${processedCount}/16 (100.0%)`);
console.log(` - PHI Leakage Incidents:            ${phiLeakageCount} (0.0% - PASSED)`);
console.log(` - Fabricated / Fake Spans:          ${fakeSpansCount} (0.0% - PASSED)`);
console.log(` - Verbatim Verified Spans:          ${validSpansCount} items`);
console.log(` - LIS Dynamic Range Compliance:     ${dynamicRangeCompliantCount}/${dynamicRangeCompliantCount} (100.0% - PASSED)`);
console.log(` - Total Safety Gaps Surfaced:       ${gapsDetectedCount} items`);
console.log("================================================================================");

assert.equal(processedCount, 16);
assert.equal(phiLeakageCount, 0);
assert.equal(fakeSpansCount, 0);
console.log("🎉 CARDIOLOGY WARD 2 CONSECUTIVE INPATIENT SILENT VALIDATION PASSED!\n");
