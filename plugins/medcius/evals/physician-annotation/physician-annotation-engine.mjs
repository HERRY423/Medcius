// Independent Physician Annotation & Adjudication Evaluation Engine
// Evaluates double-blind clinical ratings against AI shadow extractions for Inpatient Evolution Summary

import { wilsonScore, mcnemarExact } from "../clinical-validation/run.mjs";
import { canonicalJson, sha256Hex } from "../../servers/shared/crypto.mjs";
import { inspectEvaluationKeys, resolveCallerEvidenceStatus } from "../evidence-status.mjs";

const ABSTENTION_VALUES = new Set(["abstain", "unknown", "not_evaluated"]);

// The endpoints that decide `allPrimaryMet`, declared once at module scope.
// A report must render every one of these: otherwise a "not met" verdict can
// sit above a table in which every printed row reports success.
export const PRIMARY_ENDPOINT_IDS = Object.freeze([
  "sensitivity_target_met",
  "sensitivity_ci_lower_met",
  "specificity_target_met",
  "zero_critical_escape_met",
  "zero_fabricated_spans_met",
  "inter_annotator_kappa_met",
  "all_disagreements_adjudicated",
  "evidence_anchors_complete",
  "record_keys_complete",
  "no_abstentions",
]);

function isAbstention(value) {
  return typeof value !== "string" || !value.trim() || ABSTENTION_VALUES.has(value.trim().toLowerCase());
}

/**
 * Compute Cohen's Kappa between Physician A and Physician B across categorical ratings.
 * Missing a rater side, or an empty comparison, is not agreement.
 */
export function computeClinicianCohensKappa(raterA, raterB) {
  if (!Array.isArray(raterA) || !Array.isArray(raterB)) return null;
  const n = raterA.length;
  if (n === 0 || raterB.length === 0 || raterA.length !== raterB.length) return null;
  if (raterA.some(isAbstention) || raterB.some(isAbstention)) return null;

  // Collect all unique categories
  const categories = Array.from(new Set([...raterA, ...raterB]));
  const k = categories.length;
  if (k <= 1) return null; // No category variation: expected agreement is one.

  // Build confusion matrix
  const matrix = Object.create(null);
  for (const c1 of categories) {
    matrix[c1] = Object.create(null);
    for (const c2 of categories) {
      matrix[c1][c2] = 0;
    }
  }

  for (let i = 0; i < n; i++) {
    const a = raterA[i];
    const b = raterB[i];
    matrix[a][b] = (matrix[a][b] || 0) + 1;
  }

  // Observed agreement Po
  let observedMatches = 0;
  for (const c of categories) {
    observedMatches += matrix[c][c] || 0;
  }
  const po = observedMatches / n;

  // Expected chance agreement Pe
  let pe = 0;
  for (const c of categories) {
    let rowSum = 0;
    let colSum = 0;
    for (const c2 of categories) {
      rowSum += matrix[c][c2] || 0;
      colSum += matrix[c2][c] || 0;
    }
    pe += (rowSum / n) * (colSum / n);
  }

  if (pe === 1) return null;
  return (po - pe) / (1 - pe);
}

/**
 * Evaluate physician annotation cases and produce multi-dimensional statistics.
 */
export function evaluatePhysicianAnnotation(cases, options = {}) {
  const isDemo = options.isDemo ?? true;
  const metadata = options.metadata ?? null;

  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("EMPTY_ANNOTATION_DATASET: Cases array cannot be empty");
  }
  if (cases.some((item) => !item || typeof item !== "object")) throw new Error("INVALID_ANNOTATION_RECORD");
  const keyIntegrity = inspectEvaluationKeys(cases);
  if (keyIntegrity.duplicate_keys) throw new Error("DUPLICATE_ANNOTATION_KEY");

  // 1. Resolve Final Gold Standard via Double-Blind + 3rd Adjudicator
  let unadjudicatedCount = 0;
  const resolved = cases.map((c) => {
    const completeRatings = !isAbstention(c.physician_a) && !isAbstention(c.physician_b);
    const agreed = completeRatings && c.physician_a === c.physician_b;
    let finalGold = null;
    let unadjudicated = false;

    if (!completeRatings) {
      unadjudicated = true;
      unadjudicatedCount++;
    } else if (agreed) {
      finalGold = c.physician_a;
    } else if (!isAbstention(c.adjudicator)) {
      finalGold = c.adjudicator;
    } else {
      // Disagreement without 3rd adjudicator MUST NOT silently default to Physician A
      finalGold = null;
      unadjudicated = true;
      unadjudicatedCount++;
    }

    const aiMatched = finalGold != null && !isAbstention(c.ai_extracted) && c.ai_extracted === finalGold;
    return {
      ...c,
      physicians_agreed: agreed,
      gold: finalGold,
      unadjudicated,
      ai_matched: aiMatched,
    };
  });

  // 2. Inter-annotator agreement (Cohen's Kappa)
  const kappa = computeClinicianCohensKappa(
    resolved.map((c) => c.physician_a),
    resolved.map((c) => c.physician_b),
  );

  // 3. Overall Concordance & Diagnostic Performance
  let tp = 0, fp = 0, fn = 0, tn = 0;
  let criticalEscapeCount = 0;
  let criticalMisclassificationCount = 0;
  let fakeSpanCount = 0;
  let missingEvidenceAnchors = 0;
  let abstentionCount = 0;
  let resolvedCount = 0;
  let goldPositiveCount = 0;
  let goldNegativeCount = 0;
  let predictedPositiveCount = 0;
  let predictedNegativeCount = 0;
  let misclassificationCount = 0;

  for (const c of cases) {
    if (typeof c.span !== "string" || !c.span.trim()) missingEvidenceAnchors++;
    else if (c.is_verbatim_span !== true) fakeSpanCount++;
    if (isAbstention(c.ai_extracted)) abstentionCount++;
  }

  for (const c of resolved) {
    if (c.unadjudicated || c.gold == null) {
      if (c.is_critical_point) criticalEscapeCount++;
      continue;
    }

    const isGoldPositive = c.gold !== "clear" && c.gold !== "none" && !isAbstention(c.gold);
    const aiAbstains = isAbstention(c.ai_extracted);
    const isAiPositive = !aiAbstains && c.ai_extracted !== "clear" && c.ai_extracted !== "none";
    resolvedCount++;
    if (isGoldPositive) goldPositiveCount++; else goldNegativeCount++;
    if (isAiPositive) predictedPositiveCount++;
    else if (!aiAbstains) predictedNegativeCount++;

    if (aiAbstains) {
      if (isGoldPositive) {
        fn++;
        if (c.is_critical_point) criticalEscapeCount++;
      }
    } else if (isAiPositive && isGoldPositive) {
      if (c.ai_extracted === c.gold) {
        tp++;
      } else {
        fp++;
        fn++;
        misclassificationCount++;
        if (c.is_critical_point) criticalMisclassificationCount++;
        if (c.is_critical_point) criticalEscapeCount++;
      }
    } else if (isAiPositive && !isGoldPositive) {
      fp++;
    } else if (!isAiPositive && isGoldPositive) {
      fn++;
      if (c.is_critical_point) criticalEscapeCount++;
    } else {
      tn++;
    }

  }

  // Exact positive category recovery is required; positive-to-positive errors
  // count as both missed and spurious labels, but never as extra observations.
  const sensitivity = wilsonScore(tp, goldPositiveCount);
  const specificity = wilsonScore(tn, goldNegativeCount);
  const ppv = wilsonScore(tp, predictedPositiveCount);
  const npv = wilsonScore(tn, predictedNegativeCount);
  const mc = misclassificationCount || abstentionCount || unadjudicatedCount
    ? { stat_b: null, stat_c: null, p: null, reason: "INCOMPLETE_OR_MULTICATEGORY_PAIRS" }
    : mcnemarExact(fp, fn);

  // 4. Stratification by clinical dimension
  const byDimension = {};
  for (const c of resolved) {
    const dim = c.dimension || "other";
    byDimension[dim] = byDimension[dim] || [];
    byDimension[dim].push(c);
  }

  const dimensionStats = {};
  for (const [dim, dimCases] of Object.entries(byDimension)) {
    let dimMatched = 0;
    for (const dc of dimCases) {
      if (dc.ai_matched) dimMatched++;
    }
    dimensionStats[dim] = {
      total: dimCases.length,
      matched: dimMatched,
      accuracy: (dimMatched / dimCases.length * 100).toFixed(1) + "%",
    };
  }

  // 5. Pre-registered Endpoints
  const endpoints = {
    sensitivity_target_met: (sensitivity.point ?? 0) >= 0.95,
    sensitivity_ci_lower_met: (sensitivity.low ?? 0) >= 0.90,
    specificity_target_met: (specificity.point ?? 0) >= 0.90,
    zero_critical_escape_met: criticalEscapeCount === 0,
    zero_fabricated_spans_met: fakeSpanCount === 0,
    inter_annotator_kappa_met: typeof kappa === "number" && kappa >= 0.80,
    all_disagreements_adjudicated: unadjudicatedCount === 0,
    evidence_anchors_complete: missingEvidenceAnchors === 0,
    record_keys_complete: keyIntegrity.complete,
    no_abstentions: abstentionCount === 0,
  };

  // Derived from the declared list, so the verdict and every report that
  // renders it cannot drift apart.
  const allPrimaryMet = PRIMARY_ENDPOINT_IDS.every((id) => endpoints[id] === true);

  return {
    isDemo,
    metadata,
    total_cases: resolved.length,
    key_integrity: keyIntegrity,
    unadjudicated_cases_count: unadjudicatedCount,
    cohens_kappa: typeof kappa === "number" ? kappa.toFixed(3) : null,
    overall: {
      tp, fp, fn, tn,
      scored_n: resolvedCount,
      gold_positive_n: goldPositiveCount,
      gold_negative_n: goldNegativeCount,
      predicted_positive_n: predictedPositiveCount,
      predicted_negative_n: predictedNegativeCount,
      misclassifications: misclassificationCount,
      sensitivity,
      specificity,
      ppv,
      npv,
      mcnemar: mc,
      critical_escapes: criticalEscapeCount,
      critical_misclassifications: criticalMisclassificationCount,
      fake_spans: fakeSpanCount,
      missing_evidence_anchors: missingEvidenceAnchors,
      abstentions: abstentionCount,
      unadjudicated: unadjudicatedCount,
    },
    dimensionStats,
    endpoints,
    primary_endpoint_ids: PRIMARY_ENDPOINT_IDS,
    allPrimaryMet,
    passClassification: resolveCallerEvidenceStatus({ isDemo, metadata, allPrimaryMet }),
    resolved,
  };
}
