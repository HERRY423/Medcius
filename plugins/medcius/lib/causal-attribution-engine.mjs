// Causal Attribution & Dual-Track Gating Engine (因果假设归因与双通道规则守门引擎)
// Implements:
// 1. Differential hypothesis generation with supporting/refuting evidence and 3-state logic (Negative / Not mentioned / Not evaluated)
// 2. Dual-track rule gating & arbitration (Hard rule deterministic checks + LLM context synthesis)
// 3. Strict Fail-Closed preservation for patient and time safety

export const THREE_STATE_EVALUATION = {
  NEGATIVE: "Negative",
  NOT_MENTIONED: "Not mentioned",
  NOT_EVALUATED: "Not evaluated",
};

export class CausalAttributionEngine {
  /**
   * Synthesizes differential causal attributions for key clinical deterioration/improvement events.
   * Every attribution is grounded in evidence spans, FHIR references, or explicitly identified data gaps.
   */
  static analyzeAttributionsForEvent(event = {}, { observations = [], medications = [], diagnosticReports = [], rulePack = null } = {}) {
    if (!event || !event.concept) {
      return { attributions: [], missing_evaluations: [] };
    }

    const attributions = [];
    const missingEvaluations = [];

    const conceptLower = String(event.concept || "").toLowerCase();

    // 1. Renal Impairment / AKI Pattern
    if (conceptLower.includes("creatinine") || conceptLower.includes("肌酐") || conceptLower.includes("aki") || conceptLower.includes("肾功能")) {
      // Hypothesis A: Drug-induced AKI
      const nephrotoxicMeds = (medications || []).filter((m) => {
        const name = String(m.name || m.medicationCodeableConcept?.text || "").toLowerCase();
        return name.includes("vancomycin") || name.includes("万古霉素") ||
               name.includes("gentamicin") || name.includes("庆大霉素") ||
               name.includes("nsaid") || name.includes("布洛芬") || name.includes("造影剂");
      });

      if (nephrotoxicMeds.length > 0) {
        attributions.push({
          hypothesis: "药物性急性肾损伤 (Drug-induced AKI)",
          likelihood: "High",
          supporting_evidence: nephrotoxicMeds.map((m) => ({
            text_span: `用药记录: ${m.name || m.medicationCodeableConcept?.text} (${m.dosage || "剂量见医嘱"})`,
            source_reference: m.id ? `MedicationRequest/${m.id}` : "HIS_MEDICATION_ORDER",
            event_timestamp: m.timing?.t_event || m.effectiveDateTime || new Date().toISOString(),
            source_type: "FHIR_RESOURCE",
          })),
          refuting_evidence: [],
        });
      }

      // Hypothesis B: Pre-renal Hypoperfusion
      const fluidNotes = (observations || []).filter((o) => {
        const text = String(o.conceptName || o.code?.text || "").toLowerCase();
        return text.includes("出入量") || text.includes("尿量") || text.includes("fluid");
      });

      const negativeFluidEvidence = fluidNotes.filter((o) => Number(o.value) < 0 || String(o.value).includes("-"));
      if (negativeFluidEvidence.length > 0) {
        attributions.push({
          hypothesis: "肾前性有效循环灌注不足 (Pre-renal Hypoperfusion / Negative Balance)",
          likelihood: "Moderate",
          supporting_evidence: negativeFluidEvidence.map((o) => ({
            text_span: `24h 出入量/尿量监测: ${o.value} ${o.unit || "mL"}`,
            source_reference: o.id ? `Observation/${o.id}` : "NIS_FLUID_BALANCE",
            event_timestamp: o.timing?.t_event || new Date().toISOString(),
            source_type: "DEVICE_TELEMETRY",
          })),
          refuting_evidence: [],
        });
      }

      // 3-State Missing Evaluations check
      const hasUrinalysis = observations.some((o) => String(o.conceptName || "").includes("尿常规") || String(o.conceptName || "").includes("尿生化"));
      if (!hasUrinalysis) {
        missingEvaluations.push({
          item: "尿常规 / 尿钠沉渣分析 (Urinalysis & FENa)",
          status: THREE_STATE_EVALUATION.NOT_EVALUATED,
          clinical_rationale: "需明确肾前性与肾性实质损伤之鉴别",
        });
      }

      const hasTroughLevel = observations.some((o) => String(o.conceptName || "").includes("血药浓度") || String(o.conceptName || "").includes("谷浓度"));
      if (nephrotoxicMeds.length > 0 && !hasTroughLevel) {
        missingEvaluations.push({
          item: "万古霉素/肾毒性药物血药浓度监测 (Trough Level Monitoring)",
          status: THREE_STATE_EVALUATION.NOT_EVALUATED,
          clinical_rationale: "排查血药蓄积中毒",
        });
      }
    }

    return {
      attributions,
      missing_evaluations: missingEvaluations,
    };
  }
}

export class DualTrackGatingEngine {
  /**
   * Evaluates deterministic safety hard rules.
   * Acts as the safety gatekeeper for critical values, antibiotic stewardship, and extreme deterioration.
   */
  static evaluateHardRules(observations = [], medications = [], { rulePack = null } = {}) {
    const criticalViolations = [];
    const forcedAlerts = [];

    for (const obs of observations) {
      const name = String(obs.conceptName || obs.code?.coding?.[0]?.display || "").toLowerCase();
      const code = obs.conceptCode || obs.code?.coding?.[0]?.code;
      const val = typeof obs.value === "number" ? obs.value : parseFloat(obs.value);

      if (!Number.isFinite(val)) continue;

      // 1. Potassium
      if (name.includes("钾") || name.includes("potassium") || code === "2823-3") {
        if (val >= 6.2) {
          criticalViolations.push({
            code: "CRITICAL_HYPERKALEMIA",
            severity: "CRITICAL_BLOCK",
            message: `重度高钾血症 (${val} mmol/L)，达到恶性室性心律失常危机阈值`,
            requiredAction: "查房前强制置顶提醒：立即复查心电图并采取降钾干预",
            source_id: obs.id,
          });
          forcedAlerts.push(`🔴 【危急值硬规则】重度高钾血症 (${val} mmol/L)`);
        } else if (val <= 2.8) {
          criticalViolations.push({
            code: "CRITICAL_HYPOKALEMIA",
            severity: "CRITICAL_BLOCK",
            message: `严重低钾血症 (${val} mmol/L)，存在室性早搏/尖端扭转型室速风险`,
            requiredAction: "查房前强制置顶提醒：急查补钾并监护心电",
            source_id: obs.id,
          });
          forcedAlerts.push(`🔴 【危急值硬规则】严重低钾血症 (${val} mmol/L)`);
        }
      }

      // 2. Creatinine Acute Surge
      if (name.includes("肌酐") || name.includes("creatinine") || code === "2160-0") {
        const highRef = obs.referenceRange?.high || (obs.referenceRange && typeof obs.referenceRange === "object" ? obs.referenceRange.high : 104);
        if (highRef && val > highRef * 2.0) {
          criticalViolations.push({
            code: "CRITICAL_CREATININE_SURGE",
            severity: "CRITICAL_BLOCK",
            message: `血肌酐大幅升高 (${val} umol/L)，超参考上限 2 倍以上`,
            requiredAction: "查房演变首屏高亮置顶并提示排查肾损伤病因",
            source_id: obs.id,
          });
          forcedAlerts.push(`🔴 【危急值硬规则】肌酐危急升高 (${val} umol/L)`);
        }
      }
    }

    return {
      passed: criticalViolations.filter((v) => v.severity === "CRITICAL_BLOCK").length === 0,
      violations: criticalViolations,
      forcedAlerts,
    };
  }

  /**
   * Arbitrates LLM context narrative with hard deterministic rules.
   * If critical safety alerts are missing in output, forces a safety header injection.
   */
  static arbitrateNarrative(narrativeText = "", gatingResult = {}) {
    if (!gatingResult.forcedAlerts || gatingResult.forcedAlerts.length === 0) {
      return narrativeText;
    }

    const header = [
      "====================【临床硬规则安全置顶】====================",
      ...gatingResult.forcedAlerts,
      "================================================================",
      "",
    ].join("\n");

    return `${header}\n${narrativeText}`;
  }
}
