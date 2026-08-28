// Independent Physician Annotation & Adjudication Evaluation Engine
// Evaluates double-blind clinical ratings against AI shadow extractions for Inpatient Evolution Summary

import { wilsonScore, mcnemarExact } from "../clinical-validation/run.mjs";
import { canonicalJson, sha256Hex } from "../../servers/shared/crypto.mjs";

/**
 * Compute Cohen's Kappa between Physician A and Physician B across categorical ratings.
 */
export function computeClinicianCohensKappa(raterA, raterB) {
  const n = raterA.length;
  if (n === 0) return 1.0;

  // Collect all unique categories
  const categories = Array.from(new Set([...raterA, ...raterB]));
  const k = categories.length;
  if (k <= 1) return 1.0;

  // Build confusion matrix
  const matrix = {};
  for (const c1 of categories) {
    matrix[c1] = {};
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

  if (pe === 1) return 1.0;
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

  // 1. Resolve Final Gold Standard via Double-Blind + 3rd Adjudicator
  let unadjudicatedCount = 0;
  const resolved = cases.map((c) => {
    const agreed = c.physician_a === c.physician_b;
    let finalGold = null;
    let unadjudicated = false;

    if (agreed) {
      finalGold = c.physician_a;
    } else if (c.adjudicator != null) {
      finalGold = c.adjudicator;
    } else {
      // Disagreement without 3rd adjudicator MUST NOT silently default to Physician A
      finalGold = null;
      unadjudicated = true;
      unadjudicatedCount++;
    }

    const aiMatched = finalGold != null && c.ai_extracted === finalGold;
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
  let fakeSpanCount = 0;

  for (const c of resolved) {
    if (c.gold == null) continue; // Skip unadjudicated cases from valid score matrix

    const isGoldPositive = c.gold !== "clear" && c.gold !== "none";
    const isAiPositive = c.ai_extracted !== "clear" && c.ai_extracted !== "none";

    if (isAiPositive && isGoldPositive) {
      if (c.ai_extracted === c.gold) {
        tp++;
      } else {
        // Partial or mismatched extraction category
        fp++;
      }
    } else if (isAiPositive && !isGoldPositive) {
      fp++;
    } else if (!isAiPositive && isGoldPositive) {
      fn++;
      if (c.is_critical_point) {
        criticalEscapeCount++;
      }
    } else {
      tn++;
    }

    // Check span fidelity
    if (c.span != null && !c.is_verbatim_span) {
      fakeSpanCount++;
    }
  }

  const sensitivity = wilsonScore(tp, tp + fn);
  const specificity = wilsonScore(tn, tn + fp);
  const ppv = wilsonScore(tp, tp + fp);
  const npv = wilsonScore(tn, tn + fn);
  const mc = mcnemarExact(fp, fn);

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
    inter_annotator_kappa_met: kappa >= 0.80,
    all_disagreements_adjudicated: unadjudicatedCount === 0,
  };

  const allPrimaryMet =
    endpoints.sensitivity_target_met &&
    endpoints.sensitivity_ci_lower_met &&
    endpoints.specificity_target_met &&
    endpoints.zero_critical_escape_met &&
    endpoints.zero_fabricated_spans_met &&
    endpoints.inter_annotator_kappa_met &&
    endpoints.all_disagreements_adjudicated;

  return {
    isDemo,
    metadata,
    total_cases: resolved.length,
    unadjudicated_cases_count: unadjudicatedCount,
    cohens_kappa: kappa.toFixed(3),
    overall: {
      tp, fp, fn, tn,
      sensitivity,
      specificity,
      ppv,
      npv,
      mcnemar: mc,
      critical_escapes: criticalEscapeCount,
      fake_spans: fakeSpanCount,
    },
    dimensionStats,
    endpoints,
    allPrimaryMet,
    passClassification: {
      engineering_pass: allPrimaryMet,
      synthetic_validation_pass: allPrimaryMet,
      clinical_evidence_pass: !isDemo && allPrimaryMet && metadata?.ethics_approval_number != null,
    },
    resolved,
  };
}
