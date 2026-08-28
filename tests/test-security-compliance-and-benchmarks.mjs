import assert from "node:assert/strict";
import { EnhancedPhiGuard } from "../plugins/medcius/lib/enhanced-phi-guard.mjs";
import { OnPremAirGapGuard } from "../plugins/medcius/lib/onprem-airgap-guard.mjs";
import { SaMDComplianceTracker, SAMD_RISK_TIERS } from "../plugins/medcius/lib/samd-compliance-tracker.mjs";
import { WardComplexityBenchmark } from "../plugins/medcius/evals/clinical-validation/ward-complexity-benchmark.mjs";

console.log("=== Testing Security, Privacy, Air-Gap, SaMD & Clinical Benchmark Hardening ===");

// -------------------------------------------------------------
// 1. Enhanced PHI Guard (Implicit PHI & Eponym Protection)
// -------------------------------------------------------------
console.log("▶ 1. Testing Enhanced PHI Guard...");

const rawClinicalText = `
患者张伟，男，58岁。患者系某市委局长，陪护人家属姓名：李红梅。
入院诊断：库欣综合征 (Cushing syndrome)、2型糖尿病、阿尔茨海默病。
病案号：BA-20260828-9901，联系电话：13812345678。
查体：巴宾斯基征 (Babinski) 阴性。
`;

const phiResult = EnhancedPhiGuard.sanitize(rawClinicalText, { salt: "TEST_SALT_9988" });

// Assert implicit PHI removed
assert(!phiResult.sanitized.includes("张伟"), "Patient name must be pseudonymized");
assert(!phiResult.sanitized.includes("李红梅"), "Relative caregiver name must be pseudonymized");
assert(!phiResult.sanitized.includes("13812345678"), "Phone number must be masked");
assert(!phiResult.sanitized.includes("BA-20260828-9901"), "Record ID must be masked");

// Assert medical eponyms preserved
assert(phiResult.sanitized.includes("库欣综合征"), "Medical eponym '库欣综合征' must NOT be masked!");
assert(phiResult.sanitized.includes("Cushing syndrome"), "Medical eponym 'Cushing syndrome' must NOT be masked!");
assert(phiResult.sanitized.includes("阿尔茨海默病"), "Medical eponym '阿尔茨海默病' must NOT be masked!");
assert(phiResult.sanitized.includes("巴宾斯基征"), "Medical eponym '巴宾斯基征' must NOT be masked!");
console.log("  ✓ Enhanced PHI Guard successfully removed implicit PHI while preserving medical eponyms!");

// -------------------------------------------------------------
// 2. On-Premise Air-Gap Endpoint Guard
// -------------------------------------------------------------
console.log("▶ 2. Testing On-Premise Air-Gap Guard...");

// Valid on-prem endpoints
const localEndpoint = OnPremAirGapGuard.validateEndpoint("http://127.0.0.1:8000/v1");
assert.equal(localEndpoint.compliant, true);

const internalLan = OnPremAirGapGuard.validateEndpoint("http://10.200.15.88:8080/v1");
assert.equal(internalLan.compliant, true);

// Invalid public cloud endpoint must throw
assert.throws(
  () => OnPremAirGapGuard.validateEndpoint("https://api.openai.com/v1"),
  /AIRGAP_GUARD_BLOCKED/,
  "Public cloud model endpoint must be blocked under air-gap policy"
);
console.log("  ✓ On-Premise Air-Gap Guard successfully enforced private network boundary!");

// -------------------------------------------------------------
// 3. SaMD Compliance & Audit Tracker
// -------------------------------------------------------------
console.log("▶ 3. Testing SaMD Compliance & Audit Tracker...");

const samdRecord = SaMDComplianceTracker.buildComplianceRecord({
  patientId: "P-7701",
  encounterId: "ENC-001",
  rawInputFeeds: { vitals: "stable", labs: { k: 4.2 } },
  modelVersion: "Medcius-OnPrem-v0.3.0",
  deterministicRulesPassed: true,
  riskClassification: SAMD_RISK_TIERS.TIER_II_CLINICAL_DECISION_SUPPORT,
  physicianAction: {
    doctorId: "DOC-8021",
    action: "ACCEPTED_AND_SIGNED",
    caSigned: true,
    timestamp: "2026-08-28T09:00:00Z",
  },
});

assert(samdRecord.samd_record_id.startsWith("SAMD-"));
assert.equal(samdRecord.regulatory_metadata.risk_classification, "TIER_II_CDS");
assert.equal(samdRecord.provenance_chain.input_sha256.length, 64, "Input feed SHA-256 hash must be 64-char hex string");
assert.equal(samdRecord.physician_oversight.ca_signature_present, true);
console.log("  ✓ SaMD compliance & cryptographic provenance record created successfully!");

// -------------------------------------------------------------
// 4. Ward Complexity Benchmark & Clinical Quality Metrics
// -------------------------------------------------------------
console.log("▶ 4. Testing Ward Complexity Benchmark & Clinical Quality Metrics...");

const benchmarkCases = [
  {
    case_id: "CASE-01",
    gold_critical_alerts: ["高钾血症 6.4 mmol/L"],
    pred_critical_alerts: ["【危急值】高钾血症 6.4 mmol/L"],
    timeline_evaluated: true,
    timeline_total: 5,
    timeline_order_correct: true,
    pred_attributions: [{ hypothesis: "AKI", supporting_evidence: ["万古霉素用药记录"] }],
    decision_pred: true,
    decision_gold: true,
  },
  {
    case_id: "CASE-02",
    gold_critical_alerts: ["肌酐翻倍"],
    pred_critical_alerts: ["肌酐翻倍 240 umol/L"],
    timeline_evaluated: true,
    timeline_total: 4,
    timeline_order_correct: true,
    pred_attributions: [{ hypothesis: "心衰加重", supporting_evidence: ["BNP升高"] }],
    decision_pred: false,
    decision_gold: false,
  },
];

const benchResults = WardComplexityBenchmark.evaluateCaseCohort(benchmarkCases);

assert.equal(benchResults.metrics.critical_omission_rate.missed, 0, "Critical omission rate must be 0%");
assert.equal(benchResults.metrics.critical_omission_rate.gate_passed, true);
assert.equal(benchResults.metrics.timeline_alignment_accuracy.rate_pct, 100);
assert.equal(benchResults.metrics.ungrounded_attribution_rate.ungrounded, 0);
assert.equal(benchResults.metrics.inter_rater_cohen_kappa.agreement_level, "EXCELLENT");
console.log("  ✓ Ward complexity clinical benchmark metrics verified!");

console.log("\n🎉 ALL PRIVACY, AIR-GAP, SAMD & CLINICAL BENCHMARK TESTS PASSED!\n");
