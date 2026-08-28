import assert from "node:assert/strict";
import { TimelineReconstructor } from "../plugins/medcius/lib/timeline-reconstructor.mjs";
import { CausalAttributionEngine, DualTrackGatingEngine, THREE_STATE_EVALUATION } from "../plugins/medcius/lib/causal-attribution-engine.mjs";
import { StagedDraftService } from "../plugins/medcius/lib/staged-draft-service.mjs";
import { PatientEvolutionEngine } from "../plugins/medcius/lib/patient-evolution-engine.mjs";

console.log("=== Testing Medcius Clinical Landing Advancement Core Capabilities ===");

// -------------------------------------------------------------
// 1. Dual-Timestamp Timeline Reconstruction (Anti-Time-Inversion)
// -------------------------------------------------------------
console.log("▶ 1. Testing Dual-Timestamp Timeline Reconstruction...");

const mockObservations = [
  {
    id: "obs-lab-scr",
    conceptName: "肌酐",
    value: 175,
    unit: "umol/L",
    timing: {
      t_event: "2026-08-28T05:00:00Z",
      t_record: "2026-08-28T07:15:00Z",
      timestamp_uncertainty: false,
    },
  },
  {
    id: "note-late-entry",
    type: "NOTE_SEGMENT",
    text: "患者昨晚 22:00 突发胸闷气促，端坐呼吸 (次日早晨补记)",
    timing: {
      t_event: "2026-08-27T22:00:00Z", // Actual event occurrence
      t_record: "2026-08-28T08:00:00Z", // Late documentation time
      timestamp_uncertainty: false,
    },
  },
];

const reconstructed = TimelineReconstructor.reconstructTimeline(mockObservations);
assert.equal(reconstructed.length, 2);
assert.equal(reconstructed[0].id, "note-late-entry", "Topological sort must order the 22:00 night event before the 05:00 morning lab!");
assert.equal(reconstructed[0]._timeline_meta.lag_minutes, 600, "Documentation lag should be recorded as 10 hours (600 mins)");
console.log("  ✓ Correctly resolved late-entry note documentation time inversion!");

// -------------------------------------------------------------
// 2. Causal Attribution & 3-State Evidence Tree
// -------------------------------------------------------------
console.log("▶ 2. Testing Causal Attribution & 3-State Evidence Tree...");

const renalEvent = { concept: "肌酐 (Creatinine AKI)" };
const mockMeds = [
  { id: "med-01", name: "注射用万古霉素", dosage: "1.0g q12h", timing: { t_event: "2026-08-27T20:00:00Z" } },
];
const mockObsForCausal = [
  { id: "obs-fluid", conceptName: "24h出入量", value: -1200, unit: "mL" },
];

const causalResult = CausalAttributionEngine.analyzeAttributionsForEvent(renalEvent, {
  medications: mockMeds,
  observations: mockObsForCausal,
});

assert.equal(causalResult.attributions.length, 2, "Should identify both Nephrotoxic and Fluid balance parallel observations");
assert.equal(causalResult.attributions[0].observation_nature, "PARALLEL_EVIDENCE_OBSERVATION");
assert.equal(causalResult.attributions[0].diagnostic_ranking_prohibited, true, "Must prohibit diagnostic probability ranking in non-CDS posture");
assert.equal(causalResult.attributions[0].supporting_evidence[0].source_reference, "MedicationRequest/med-01");

// Verify 3-state gap evaluation
const missingEvalItems = causalResult.missing_evaluations.map((e) => e.item);
assert(missingEvalItems.some((i) => i.includes("尿常规")), "Missing urinalysis must be explicitly flagged as Not evaluated");
assert(missingEvalItems.some((i) => i.includes("血药浓度")), "Missing trough level must be explicitly flagged as Not evaluated");
assert.equal(causalResult.missing_evaluations[0].status, THREE_STATE_EVALUATION.NOT_EVALUATED);
console.log("  ✓ Causal attribution hypotheses and 3-state evaluation verified!");

// -------------------------------------------------------------
// 3. Dual-Track Gating Engine (Deterministic Hard Rules)
// -------------------------------------------------------------
console.log("▶ 3. Testing Dual-Track Gating Engine & Safety Arbitration...");

const criticalObs = [
  { id: "obs-k", conceptName: "血清钾", conceptCode: "2823-3", value: 6.4, unit: "mmol/L" },
  { id: "obs-scr", conceptName: "血肌酐", conceptCode: "2160-0", value: 240, referenceRange: { high: 104 } },
];

const gating = DualTrackGatingEngine.evaluateHardRules(criticalObs);
assert.equal(gating.passed, false, "Critical hyperkalemia & creatinine surge must trigger hard rule failure");
assert.equal(gating.violations.length, 2);
assert.equal(gating.forcedAlerts.length, 2);

const llmSummary = "患者病情平稳，夜间睡眠尚可。";
const arbitrated = DualTrackGatingEngine.arbitrateNarrative(llmSummary, gating);
assert(arbitrated.includes("【临床硬规则安全置顶】"), "Safety gating must inject forced alerts header");
assert(arbitrated.includes("重度高钾血症"), "Hyperkalemia alert must be forced to top");
console.log("  ✓ Dual-track safety gating correctly enforced deterministic overrides!");

// -------------------------------------------------------------
// 4. Staged Draft & 3-Tier Progressive Disclosure Views
// -------------------------------------------------------------
console.log("▶ 4. Testing Staged Draft & Progressive Disclosure Views...");

const progressiveViews = StagedDraftService.generateProgressiveViews({
  patient: { id: "P-8901", name: "张三", bed: "03床" },
  timeWindow: "24h",
  evolutionSummary: "夜间心衰症状加重，急查血钾 6.4 mmol/L",
  attributions: causalResult.attributions,
  missingEvaluations: causalResult.missing_evaluations,
  gatingResult: gating,
});

assert.equal(progressiveViews.glance.tier, "LEVEL_1_GLANCE");
assert.equal(progressiveViews.glance.color, "RED", "Critical gating violation must color Level 1 Glance red");
assert.equal(progressiveViews.digest.tier, "LEVEL_2_DIGEST");
assert.equal(progressiveViews.drilldown.tier, "LEVEL_3_DRILLDOWN");

const stagedDraft = StagedDraftService.createStagedDraft({
  patient: { id: "P-8901" },
  encounterId: "ENC-20260828",
  progressiveViews,
});

assert(stagedDraft.draft_id.startsWith("DRAFT-"));
assert.equal(stagedDraft.status, "PENDING_PHYSICIAN_CA_SIGNATURE");
assert(stagedDraft.rendered_markdown.includes("【查房前病情演变与交班记录草稿】"));
console.log("  ✓ Staged draft sandbox & 3-tier progressive view verified!");

console.log("\n🎉 ALL CLINICAL ADVANCEMENT CORE CAPABILITY TESTS PASSED!\n");
