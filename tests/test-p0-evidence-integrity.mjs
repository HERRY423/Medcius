import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveCallerEvidenceStatus } from "../plugins/medcius/evals/evidence-status.mjs";
import { computeClinicianCohensKappa, evaluatePhysicianAnnotation } from "../plugins/medcius/evals/physician-annotation/physician-annotation-engine.mjs";
import { buildPhysicianAnnotationReport } from "../plugins/medcius/evals/physician-annotation/physician-annotation-report.mjs";
import { computeCohensKappa, evaluateShadowStudy, buildShadowReport } from "../plugins/medcius/evals/shadow-mode/shadow-study.mjs";
import { evaluateStopwatchProtocol } from "../plugins/medcius/evals/time-motion/stopwatch-protocol.mjs";
import { TimeMotionAnalyzer } from "../plugins/medcius/evals/time-motion/time-motion-analyzer.mjs";
import { pairValidationRows, wilsonScore, mcnemarExact } from "../plugins/medcius/evals/clinical-validation/run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
const annotation = (overrides = {}) => ({ case_id: "synthetic-a", dimension: "symptoms", physician_a: "present", physician_b: "present", ai_extracted: "present", span: "合成观察", is_verbatim_span: true, is_critical_point: true, ...overrides });
const shadow = (overrides = {}) => ({ case_id: "synthetic-s", pharmacist_a: "flag", pharmacist_b: "flag", predicted: "flag", hospital_center: "synthetic-center", department: "synthetic-department", drug_class: "synthetic-class", ...overrides });

test("caller claims and truthy strings never authorize clinical evidence", () => {
  for (const options of [ {}, { isDemo: false }, { isDemo: false, ethicsApprovalNumber: "IRB-CLAIM", allPrimaryMet: true }, { metadata: { ethics_approval: true }, allPrimaryMet: "false" } ]) {
    assert.equal(resolveCallerEvidenceStatus(options).clinical_evidence_pass, false);
  }
  assert.equal(resolveCallerEvidenceStatus({ allPrimaryMet: "false" }).endpoint_pass, false);
  assert.equal(resolveCallerEvidenceStatus({ isDemo: false, allPrimaryMet: true }).synthetic_validation_pass, false);
});

test("missing raters, unknown adjudication and missing spans stay unresolved", () => {
  const result = evaluatePhysicianAnnotation([
    annotation({ physician_a: null, physician_b: null, span: "" }),
    annotation({ case_id: "synthetic-b", physician_a: "present", physician_b: "clear", adjudicator: "unknown", is_verbatim_span: false }),
  ]);
  assert.equal(result.unadjudicated_cases_count, 2);
  assert.equal(result.overall.scored_n, 0);
  assert.equal(result.overall.missing_evidence_anchors, 1);
  assert.equal(result.overall.fake_spans, 1);
  assert.equal(result.overall.sensitivity.point, null);
  assert.equal(result.allPrimaryMet, false);
  assert.equal(result.resolved[0].physicians_agreed, false);
});

test("wrong positive category is a safety miss without inflating case counts", () => {
  const result = evaluatePhysicianAnnotation([
    annotation({ ai_extracted: "different_condition" }),
    annotation({ case_id: "synthetic-b", physician_a: "clear", physician_b: "clear", ai_extracted: "clear" }),
  ]);
  assert.equal(result.overall.tp, 0);
  assert.equal(result.overall.fp, 1);
  assert.equal(result.overall.fn, 1);
  assert.equal(result.overall.critical_escapes, 1);
  assert.equal(result.overall.critical_misclassifications, 1);
  assert.equal(result.overall.scored_n, 2);
  assert.equal(result.overall.specificity.point, 1);
  assert.equal(result.overall.sensitivity.point, 0);
  assert.equal(result.overall.mcnemar.p, null);
  assert.equal(result.allPrimaryMet, false);
});

test("abstentions on negative gold do not disappear from specificity", () => {
  const p = evaluatePhysicianAnnotation([
    annotation({ physician_a: "clear", physician_b: "clear", ai_extracted: null }),
    annotation({ case_id: "synthetic-b", physician_a: "clear", physician_b: "clear", ai_extracted: "clear" }),
  ]);
  assert.equal(p.overall.specificity.point, 0.5);
  assert.equal(p.overall.abstentions, 1);
  assert.equal(p.endpoints.no_abstentions, false);
  const s = evaluateShadowStudy([
    shadow({ pharmacist_a: "clear", pharmacist_b: "clear", predicted: "unexpected" }),
    shadow({ case_id: "synthetic-s2", pharmacist_a: "clear", pharmacist_b: "clear", predicted: "clear" }),
  ]);
  assert.equal(s.overall.specificity.point, 0.5);
  assert.equal(s.overall.abstentions, 1);
  assert.equal(s.overall.scored_n, 2);
  assert.equal(s.allPrimaryMet, false);
});

test("unknown labels are not agreement and degenerate Kappa is unavailable", () => {
  assert.equal(computeCohensKappa(["unknown"], ["unknown"]), null);
  assert.equal(computeCohensKappa(["flag"], ["flag"]), null);
  assert.equal(computeClinicianCohensKappa(["present"], ["present"]), null);
  const s = evaluateShadowStudy([shadow({ pharmacist_a: "unknown", pharmacist_b: "unknown", adjudicator: "clear" })]);
  assert.equal(s.overall.pending, 1);
  assert.equal(s.overall.tn, 0);
  assert.equal(s.overall.f1, "n/a");
});

test("duplicates reject instead of shrinking confidence intervals", () => {
  assert.throws(() => evaluatePhysicianAnnotation([annotation(), annotation()]), /DUPLICATE_ANNOTATION_KEY/);
  assert.throws(() => evaluateShadowStudy([shadow(), shadow()]), /DUPLICATE_SHADOW_KEY/);
  const missingKey = evaluatePhysicianAnnotation([annotation({ case_id: null })]);
  assert.equal(missingKey.key_integrity.missing_keys, 1);
  assert.equal(missingKey.endpoints.record_keys_complete, false);
});

test("reports cannot label unverified caller data as a real clinical study", () => {
  const s = evaluateShadowStudy([shadow({ predicted: "clear" })], { isDemo: false, metadata: { ethics_approval_number: "IRB-CLAIM" } });
  const report = buildShadowReport(s);
  assert.match(report, /NOT CLINICAL EVIDENCE/);
  assert.doesNotMatch(report, /REAL CLINICAL STUDY/);
  assert.match(report, /未达标或不可计算/);
  const p = buildPhysicianAnnotationReport(evaluatePhysicianAnnotation([annotation({ ai_extracted: "clear" })], { isDemo: false }));
  assert.match(p, /NOT CLINICAL EVIDENCE/);
  assert.match(p, /未达标或不可计算/);
});

test("empty stopwatch and missing omissions are unknown, never zero-safe", () => {
  const empty = evaluateStopwatchProtocol({ records: [] });
  assert.equal(empty.mean_saved_seconds, null);
  assert.equal(empty.safety_non_inferiority.control_omissions, null);
  assert.equal(empty.safety_non_inferiority.is_non_inferior, null);
  assert.equal(empty.evidence.engineering_pass, false);
  assert.equal(empty.evidence.synthetic_validation_pass, false);
  const missing = evaluateStopwatchProtocol({ records: [{ observer_id: "synthetic-observer", control_seconds: 200, intervention_seconds: 50 }] });
  assert.equal(missing.safety_non_inferiority.intervention_omissions, null);
  assert.equal(missing.missing_safety_records.intervention, 1);
  assert.equal(missing.endpoints_met, false);
  assert.equal(missing.descriptive_endpoints_met, false);
});

test("invalid timing and safety values cannot coerce to valid measurements", () => {
  const record = { observer_id: "synthetic-observer", control_seconds: 200, intervention_seconds: 50, control_omissions: 0, intervention_omissions: 0 };
  for (const value of [null, "", "0", false, NaN]) {
    assert.throws(() => evaluateStopwatchProtocol({ records: [{ ...record, intervention_seconds: value }] }), /SECONDS_INVALID/);
  }
  for (const value of [-1, 0.5, "0", false, NaN]) {
    assert.throws(() => evaluateStopwatchProtocol({ records: [{ ...record, intervention_omissions: value }] }), /OMISSIONS_INVALID/);
  }
  const complete = evaluateStopwatchProtocol({ data_class: "stopwatch_observation", irb_protocol_id: "IRB-CLAIM", records: [record] });
  assert.equal(complete.descriptive_endpoints_met, true);
  assert.equal(complete.safety_non_inferiority.is_non_inferior, null);
  assert.equal(complete.endpoints_met, false);
  assert.equal(complete.evidence.clinical_evidence_pass, false);
});

test("time-motion keeps incomplete observations and zero denominators explicit", () => {
  const result = TimeMotionAnalyzer.analyzeCohort([{ manual: { duration_seconds: 200, navigation_clicks: 0, nasa_tlx_score: 0 }, medcius: { duration_seconds: 50, navigation_clicks: 0, nasa_tlx_score: 0 } }]);
  assert.equal(result.safety_non_inferiority.manual_omissions, null);
  assert.equal(result.safety_non_inferiority.is_non_inferior, null);
  assert.equal(result.interaction_metrics.clicks_saved_percentage, null);
  assert.equal(result.cognitive_load_metrics.workload_reduction_percentage, null);
  assert.equal(result.evidence.engineering_pass, false);
  assert.equal(result.evidence.synthetic_validation_pass, false);
});

test("paired validation requires both sides, unique compound keys and valid labels", () => {
  const gold = [{ case_id: "A", dimension: "symptom", gold: "flag" }];
  const pred = [{ case_id: "A", dimension: "symptom", predicted: "clear" }];
  assert.equal(pairValidationRows(gold, pred).length, 1);
  assert.throws(() => pairValidationRows([...gold, ...gold], pred), /DUPLICATE_VALIDATION_KEY/);
  assert.throws(() => pairValidationRows(gold, [...pred, ...pred]), /DUPLICATE_VALIDATION_KEY/);
  assert.throws(() => pairValidationRows(gold, [{ ...pred[0], case_id: "B" }]), /missing_predictions=1, missing_gold=1/);
  assert.throws(() => pairValidationRows([], []), /EMPTY_VALIDATION_DATASET/);
  assert.throws(() => pairValidationRows(gold, [{ ...pred[0], predicted: "unknown" }]), /VALIDATION_LABEL_INVALID/);
  const distinct = [{ case_id: "A|B", dimension: "C", gold: "flag" }, { case_id: "A", dimension: "B|C", gold: "clear" }];
  assert.equal(pairValidationRows(distinct, distinct.map((r) => ({ ...r, predicted: r.gold }))).length, 2);
});

test("binomial statistics distinguish no data and remain finite on large pairs", () => {
  assert.equal(wilsonScore(0, 0).point, null);
  assert.equal(wilsonScore(0, 10).computable, true);
  assert.ok(wilsonScore(0, 10).high > 0);
  assert.throws(() => wilsonScore(11, 10), /INVALID_BINOMIAL_COUNTS/);
  assert.equal(mcnemarExact(0, 10).p, 0.001953125);
  assert.ok(mcnemarExact(600, 600).p > 0.99);
});

test("failed CLI invalidates an earlier successful report at the same path", () => {
  const base = join(root, "out", "p0-evidence-integrity");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "run-"));
  const gold = join(dir, "gold.jsonl"), pred = join(dir, "pred.jsonl"), report = join(dir, "report.md");
  writeFileSync(gold, JSON.stringify({ case_id: "synthetic-a", dimension: "symptom", gold: "flag" }) + "\n");
  writeFileSync(pred, JSON.stringify({ case_id: "synthetic-a", dimension: "symptom", predicted: "flag" }) + "\n");
  const args = [join(root, "plugins/medcius/evals/clinical-validation/run.mjs"), "--gold", gold, "--pred", pred, "--out", report];
  assert.equal(spawnSync(process.execPath, args, { encoding: "utf8" }).status, 0);
  assert.match(readFileSync(report, "utf8"), /100.0%/);
  writeFileSync(pred, JSON.stringify({ case_id: "synthetic-unmatched", dimension: "symptom", predicted: "flag" }) + "\n");
  assert.equal(spawnSync(process.execPath, args, { encoding: "utf8" }).status, 1);
  const invalid = readFileSync(report, "utf8");
  assert.match(invalid, /status: INVALID/);
  assert.doesNotMatch(invalid, /100.0%/);
});

console.log(`P0 evidence integrity: ${checks} adversarial groups passed (synthetic only).`);
