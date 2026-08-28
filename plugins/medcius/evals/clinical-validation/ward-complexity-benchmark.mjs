// Ward Complexity Benchmark & Clinical Quality Metrics Evaluator
// Evaluates AI Assistant vs Double-Blind Senior Physician Gold Standard across:
// 1. Critical Value Omission Rate (危急值漏报率 - Target: 0%)
// 2. Timeline Alignment Accuracy (时序拓扑对齐准确率)
// 3. Unsupported Causal Hallucination Rate (虚假归因率)
// 4. Inter-Rater Reliability (Cohen's Kappa & Wilson 95% CI)

import { wilsonScore } from "./run.mjs";

export class WardComplexityBenchmark {
  /**
   * Calculates Cohen's Kappa coefficient between model predictions and clinician gold standard.
   */
  static calculateCohenKappa(contingencyMatrix) {
    const { tp, fp, fn, tn } = contingencyMatrix;
    const total = tp + fp + fn + tn;
    if (total === 0) return 0;

    const pObserved = (tp + tn) / total;
    const pExpectedYes = ((tp + fp) * (tp + fn)) / (total * total);
    const pExpectedNo = ((tn + fn) * (tn + fp)) / (total * total);
    const pExpected = pExpectedYes + pExpectedNo;

    if (1 - pExpected === 0) return 1.0;
    const kappa = (pObserved - pExpected) / (1 - pExpected);
    return Math.round(kappa * 1000) / 1000;
  }

  /**
   * Evaluates a suite of complex clinical cases against gold standard annotations.
   */
  static evaluateCaseCohort(cases = []) {
    let totalCriticals = 0;
    let missedCriticals = 0;

    let totalTimelineEvents = 0;
    let correctTimelineOrders = 0;

    let totalAttributions = 0;
    let ungroundedAttributions = 0;

    let tp = 0, fp = 0, fn = 0, tn = 0;

    for (const c of cases) {
      // 1. Critical Value Omission Check
      const goldCriticals = c.gold_critical_alerts || [];
      const predCriticals = c.pred_critical_alerts || [];
      totalCriticals += goldCriticals.length;

      for (const gc of goldCriticals) {
        const found = predCriticals.some((pc) => String(pc).toLowerCase().includes(String(gc).toLowerCase()));
        if (!found) missedCriticals++;
      }

      // 2. Timeline Sorting Check
      if (c.timeline_evaluated) {
        totalTimelineEvents += c.timeline_total || 1;
        if (c.timeline_order_correct) {
          correctTimelineOrders += c.timeline_total || 1;
        }
      }

      // 3. Unsupported Causal Attributions (Hallucination)
      const predAttributions = c.pred_attributions || [];
      totalAttributions += predAttributions.length;
      for (const attr of predAttributions) {
        if (!attr.supporting_evidence || attr.supporting_evidence.length === 0) {
          ungroundedAttributions++;
        }
      }

      // 4. Clinical Decision Concordance
      if (c.decision_pred != null && c.decision_gold != null) {
        const p = Boolean(c.decision_pred);
        const g = Boolean(c.decision_gold);
        if (p && g) tp++;
        else if (p && !g) fp++;
        else if (!p && g) fn++;
        else tn++;
      }
    }

    const omissionRateWilson = wilsonScore(missedCriticals, totalCriticals);
    const timelineAccWilson = wilsonScore(correctTimelineOrders, totalTimelineEvents);
    const ungroundedRateWilson = wilsonScore(ungroundedAttributions, totalAttributions);
    const cohenKappa = this.calculateCohenKappa({ tp, fp, fn, tn });

    return {
      total_cases: cases.length,
      metrics: {
        critical_omission_rate: {
          missed: missedCriticals,
          total: totalCriticals,
          rate_pct: totalCriticals > 0 ? (missedCriticals / totalCriticals) * 100 : 0,
          wilson_ci: omissionRateWilson.str,
          gate_passed: missedCriticals === 0,
        },
        timeline_alignment_accuracy: {
          correct: correctTimelineOrders,
          total: totalTimelineEvents,
          rate_pct: totalTimelineEvents > 0 ? (correctTimelineOrders / totalTimelineEvents) * 100 : 100,
          wilson_ci: timelineAccWilson.str,
          gate_passed: (correctTimelineOrders / (totalTimelineEvents || 1)) >= 0.99,
        },
        ungrounded_attribution_rate: {
          ungrounded: ungroundedAttributions,
          total: totalAttributions,
          rate_pct: totalAttributions > 0 ? (ungroundedAttributions / totalAttributions) * 100 : 0,
          wilson_ci: ungroundedRateWilson.str,
          gate_passed: ungroundedAttributions === 0,
        },
        inter_rater_cohen_kappa: {
          kappa: cohenKappa,
          agreement_level: cohenKappa >= 0.85 ? "EXCELLENT" : cohenKappa >= 0.7 ? "GOOD" : "MODERATE",
          gate_passed: cohenKappa >= 0.80,
        },
      },
    };
  }
}
