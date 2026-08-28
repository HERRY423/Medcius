// Hospital Multi-Source Data Fusion & Virtual FHIR Normalizer
// Ingests: NIS (Nursing vitals & 24h fluid balance), LIS (Labs & Critical Values), PACS (Imaging & Impressions), HIS (Orders & Notes)
// Outputs: Standardized FHIR R4 Bundles & Normalized Clinical Feeds for PatientEvolutionEngine

import { loadSpecialtyRulePack } from "./specialty-rule-pack.mjs";

const LEGACY_SANDBOX_RULE_PACK = loadSpecialtyRulePack("cardiology-inpatient-sandbox");

/**
 * Compatibility export for synthetic fixtures only. Runtime normalization does
 * not apply these values unless a rule pack is passed explicitly.
 */
export const CRITICAL_VALUE_THRESHOLDS = LEGACY_SANDBOX_RULE_PACK.clinical_rules.critical_values;

/**
 * Compatibility export for synthetic fixtures only. Hospital-approved packs
 * must replace it in production.
 */
export const RESTRICTED_ANTIBIOTICS = LEGACY_SANDBOX_RULE_PACK.clinical_rules.restricted_antibiotics.map((rule) => ({
  ...rule,
  max_recommended_days: rule.review_after_days,
}));

/**
 * Calculate eGFR via CKD-EPI 2021 equation (mL/min/1.73 m2)
 * @param {number} scr - Serum creatinine in μmol/L
 * @param {number} age - Patient age
 * @param {string} gender - '男' / '女' or 'male' / 'female'
 */
export function calculateEgfrCkdEpi(scr, age, gender) {
  if (!scr || !age) return null;
  const isFemale = gender === "女" || gender === "female" || gender === "F";
  // Convert μmol/L to mg/dL: mg/dL = μmol/L / 88.4
  const scrMgDl = scr / 88.4;
  const kappa = isFemale ? 0.7 : 0.9;
  const alpha = isFemale ? -0.241 : -0.302;
  const genderMult = isFemale ? 1.012 : 1.0;

  const scrRatio = scrMgDl / kappa;
  const minPart = Math.min(scrRatio, 1) ** alpha;
  const maxPart = Math.max(scrRatio, 1) ** -1.2;
  const agePart = 0.9938 ** age;

  const egfr = 142 * minPart * maxPart * agePart * genderMult;
  return Math.round(egfr * 10) / 10;
}

export class HospitalDataAdapter {
  /**
   * 1. Normalize NIS (Nursing Info System) Vital Signs and 24h Fluid Balance
   */
  static normalizeNisFeed(nisFeed = [], { rulePack = null } = {}) {
    if (!Array.isArray(nisFeed) || nisFeed.length === 0) {
      return { vitals_summary: null, fluid_balance: null, fhir_observations: [] };
    }

    let tMax = -Infinity;
    let tMin = Infinity;
    let bpSystolicMax = -Infinity;
    let bpSystolicMin = Infinity;
    let bpDiastolicMax = -Infinity;
    let bpDiastolicMin = Infinity;
    let spo2Min = Infinity;
    let hrSum = 0;
    let hrCount = 0;

    let intakeTotal = 0;
    let outputTotal = 0;
    let urineTotal = 0;
    let drainTotal = 0;
    let stoolCount = 0;
    const drainDetails = [];

    const fhirObservations = [];

    for (const record of nisFeed) {
      // Temperature (°C)
      if (record.temperature != null) {
        const t = Number(record.temperature);
        if (t > tMax) tMax = t;
        if (t < tMin) tMin = t;
        fhirObservations.push({
          resourceType: "Observation",
          id: `obs-nis-temp-${record.id || Date.now()}`,
          code: { coding: [{ system: "http://loinc.org", code: "8310-5", display: "Body temperature" }] },
          valueQuantity: { value: t, unit: "°C" },
          effectiveDateTime: record.timestamp,
        });
      }

      // Blood Pressure (mmHg)
      if (record.systolic_bp != null && record.diastolic_bp != null) {
        const s = Number(record.systolic_bp);
        const d = Number(record.diastolic_bp);
        if (s > bpSystolicMax) bpSystolicMax = s;
        if (s < bpSystolicMin) bpSystolicMin = s;
        if (d > bpDiastolicMax) bpDiastolicMax = d;
        if (d < bpDiastolicMin) bpDiastolicMin = d;
      }

      // Heart Rate / Pulse (bpm)
      if (record.heart_rate != null) {
        hrSum += Number(record.heart_rate);
        hrCount++;
      }

      // SpO2 (%)
      if (record.spo2 != null) {
        const sp = Number(record.spo2);
        if (sp < spo2Min) spo2Min = sp;
      }

      // Fluid Intake (ml)
      if (record.oral_intake_ml != null) intakeTotal += Number(record.oral_intake_ml);
      if (record.iv_intake_ml != null) intakeTotal += Number(record.iv_intake_ml);
      if (record.intake_ml != null) intakeTotal += Number(record.intake_ml);

      // Fluid Output (ml)
      if (record.urine_output_ml != null) {
        const u = Number(record.urine_output_ml);
        outputTotal += u;
        urineTotal += u;
      }
      if (record.drain_output_ml != null) {
        const dr = Number(record.drain_output_ml);
        outputTotal += dr;
        drainTotal += dr;
        if (record.drain_name) {
          drainDetails.push({ name: record.drain_name, amount_ml: dr, description: record.drain_desc || "引流液" });
        }
      }
      if (record.stool_count != null) {
        stoolCount += Number(record.stool_count);
      }
    }

    const vitalsSummary = {
      t_max: tMax === -Infinity ? null : tMax,
      t_min: tMin === Infinity ? null : tMin,
      bp_max: bpSystolicMax === -Infinity ? null : `${bpSystolicMax}/${bpDiastolicMax} mmHg`,
      bp_min: bpSystolicMin === Infinity ? null : `${bpSystolicMin}/${bpDiastolicMin} mmHg`,
      hr_avg: hrCount > 0 ? Math.round(hrSum / hrCount) : null,
      spo2_min: spo2Min === Infinity ? null : `${spo2Min}%`,
    };

    const netBalance = intakeTotal - outputTotal;
    const fluidThresholds = rulePack?.clinical_rules?.ward_thresholds?.fluid_balance_net_ml;
    let fluidStatus = "已记录（未配置专科判断阈值）";
    if (fluidThresholds) {
      if (netBalance > fluidThresholds.high_attention_above) {
        fluidStatus = `触发规则包净正平衡关注边界 (> ${fluidThresholds.high_attention_above} ml)`;
      } else if (netBalance < fluidThresholds.low_attention_below) {
        fluidStatus = `触发规则包净负平衡关注边界 (< ${fluidThresholds.low_attention_below} ml)`;
      } else {
        fluidStatus = "未触发规则包液体平衡关注边界";
      }
    }
    const fluidBalance = {
      intake_total_ml: intakeTotal,
      output_total_ml: outputTotal,
      net_balance_ml: netBalance,
      net_balance_label: `${netBalance >= 0 ? "+" : ""}${netBalance} ml`,
      urine_24h_ml: urineTotal,
      drain_24h_ml: drainTotal,
      stool_24h_count: stoolCount,
      drain_details: drainDetails,
      status: fluidStatus,
      rule_pack_id: rulePack?.pack_id || null,
    };

    return { vitals_summary: vitalsSummary, fluid_balance: fluidBalance, fhir_observations: fhirObservations };
  }

  /**
   * 2. Normalize LIS (Laboratory Info System) and Detect Critical Values
   */
  static normalizeLisFeed(lisFeed = [], { rulePack = null } = {}) {
    if (!Array.isArray(lisFeed)) return { observations: [], critical_values: [] };

    const observations = [];
    const criticalValues = [];

    for (const item of lisFeed) {
      const codeKey = (item.code || item.test_code || "").toLowerCase();
      const val = Number(item.value ?? item.result_value);
      const unit = item.unit || "";
      const reportName = item.report_name || item.test_name || "检验报告";
      const sampleTime = item.effective_time || item.sample_time || new Date().toISOString();

      let isCritical = false;
      let criticalReason = null;

      // Context-conditioned rule check. With no explicit rule pack, only the
      // source system's own critical flag is retained; no universal fallback.
      const thresh = rulePack?.clinical_rules?.critical_values?.[codeKey];
      if (thresh && !isNaN(val)) {
        if (thresh.low != null && val <= thresh.low) {
          isCritical = true;
          criticalReason = `低于危急值下限 (≤ ${thresh.low} ${thresh.unit}): ${thresh.danger_hint}`;
        } else if (thresh.high != null && val >= thresh.high) {
          isCritical = true;
          criticalReason = `高于危急值上限 (≥ ${thresh.high} ${thresh.unit}): ${thresh.danger_hint}`;
        }
      }

      // Explicit LIS flag override
      if (item.is_critical_reported || item.is_critical) {
        isCritical = true;
        if (!criticalReason) criticalReason = "LIS 实验室系统上报危急值警报";
      }

      const obsObj = {
        id: item.id || `obs-lis-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: item.name || item.test_name || thresh?.name || item.code,
        code: codeKey || item.code,
        value: isNaN(val) ? item.value : val,
        unit: unit,
        effective_time: sampleTime,
        report_name: reportName,
        referenceRange: item.referenceRange || (item.reference_range_text ? [{ text: item.reference_range_text }] : []),
        is_critical: isCritical,
        critical_reason: criticalReason,
        span: item.span || null,
        status: item.status || item.result_status || "final",
        priority: item.priority || item.urgency || null,
        order_id: item.order_id || item.service_request_id || null,
        collected_at: item.collected_at || item.specimen_received_at || item.sample_time || null,
        resulted_at: item.resulted_at || item.issued || item.effective_time || item.sample_time || null,
        acknowledged_at: item.acknowledged_at || null,
        _source: item._source || null,
      };

      observations.push(obsObj);

      if (isCritical) {
        criticalValues.push({
          observation_id: obsObj.id,
          name: obsObj.name,
          value: obsObj.value,
          unit: obsObj.unit,
          report_name: reportName,
          sample_time: sampleTime,
          reason: criticalReason,
          urgency_action: "按医院批准的危急值制度完成临床确认与闭环；本插件仅追踪阶段，不给出处置建议",
          acknowledged_at: item.acknowledged_at || null,
          order_id: item.order_id || item.service_request_id || null,
        });
      }
    }

    return { observations, critical_values: criticalValues };
  }

  /**
   * 3. Normalize PACS (Imaging System) Reports and Extract Comparative Impressions
   */
  static normalizePacsFeed(pacsFeed = []) {
    if (!Array.isArray(pacsFeed)) return { diagnostic_reports: [], imaging_impressions: [] };

    const diagnosticReports = [];
    const imagingImpressions = [];

    for (const item of pacsFeed) {
      const modality = item.modality || "影像检查";
      const name = item.name || item.study_name || `${modality} 检查`;
      const status = item.status || (item.report_status === "final" ? "final" : "preliminary");
      const orderedAt = item.ordered_at || item.study_time || new Date().toISOString();
      const impression = item.impression || item.impression_text || item.findings || "";

      diagnosticReports.push({
        id: item.id || `pacs-rep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: name,
        modality: modality,
        status: status,
        ordered_at: orderedAt,
        impression: impression,
        code: item.code || item.study_code || null,
        priority: item.priority || item.urgency || null,
        order_id: item.order_id || item.service_request_id || item.based_on_id || null,
        scheduled_time: item.scheduled_time || null,
        resulted_at: item.resulted_at || item.issued || null,
        acknowledged_at: item.acknowledged_at || null,
        _source: item._source || null,
      });

      if (impression) {
        imagingImpressions.push({
          report_name: name,
          status: status,
          ordered_at: orderedAt,
          impression_summary: impression.trim(),
        });
      }
    }

    return { diagnostic_reports: diagnosticReports, imaging_impressions: imagingImpressions };
  }

  /**
   * 4. Normalize HIS (Hospital Info System) Orders & Track Antibiotic Durations
   */
  static normalizeHisOrders(ordersFeed = [], { rulePack = null, now = Date.now() } = {}) {
    if (!Array.isArray(ordersFeed)) return { medications: [], orders: [], antibiotic_alerts: [] };

    const medications = [];
    const orders = [];
    const antibioticAlerts = [];
    const antibioticRules = rulePack?.clinical_rules?.restricted_antibiotics || [];

    for (const item of ordersFeed) {
      if (item.is_medication || item.drug_name) {
        const drugName = item.drug_name || item.name;
        const authoredOn = item.authored_on || item.start_time || new Date().toISOString();
        const startTimestamp = new Date(authoredOn).getTime();
        const durationDays = Math.max(1, Math.ceil((now - startTimestamp) / (24 * 3600000)));

        // Check if restricted/special antibiotic
        const matchAnti = antibioticRules.find((a) => drugName.includes(a.name));
        let antiInfo = null;

        if (matchAnti) {
          const reviewAfterDays = matchAnti.review_after_days;
          const isOverdue = Number.isFinite(reviewAfterDays) ? durationDays >= reviewAfterDays : null;
          antiInfo = {
            drug_name: drugName,
            class: matchAnti.class,
            level: matchAnti.level,
            duration_days: durationDays,
            review_after_days: reviewAfterDays ?? null,
            is_overdue: isOverdue,
            alert_message: `【${matchAnti.level}】${drugName}已使用第 ${durationDays} 天。${isOverdue === true ? "已达到院内规则包配置的复核时间点，需由临床团队复核。" : "尚未达到规则包复核时间点。"}`,
          };
          antibioticAlerts.push(antiInfo);
        }

        medications.push({
          id: item.id || `med-his-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          drug_name: drugName,
          dosage: item.dosage || "",
          route: item.route || "po",
          frequency: item.frequency || "qd",
          change_type: item.change_type || "active",
          previous_dosage: item.previous_dosage,
          authored_on: authoredOn,
          stop_reason: item.stop_reason,
          antibiotic_info: antiInfo,
          _source: item._source || null,
        });
      } else {
        orders.push({
          id: item.id || `ord-his-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title: item.title || item.name,
          order_type: item.order_type || "general",
          department: item.department,
          purpose: item.purpose,
          status: item.status || "active",
          scheduled_time: item.scheduled_time || "今日待执行",
          code: item.code || item.order_code || null,
          priority: item.priority || item.urgency || item.order_priority || null,
          authored_on: item.authored_on || item.ordered_at || null,
          collected_at: item.collected_at || null,
          resulted_at: item.resulted_at || null,
          acknowledged_at: item.acknowledged_at || null,
          _source: item._source || null,
        });
      }
    }

    return { medications, orders, antibiotic_alerts: antibioticAlerts };
  }

  /**
   * 5. Structured Multi-Source Priority Alignment (结构化多源临床对齐图谱)
   * Correlates NIS vitals/fluids, LIS lab trends/criticals, PACS imaging impressions, and HIS orders
   * into cohesive clinical domains without forcing doctors to mentally reconstruct cross-system streams.
   */
  static alignMultiSourceTimeline({
    vitalsSummary = null,
    fluidBalance = null,
    observations = [],
    criticalValues = [],
    diagnosticReports = [],
    medications = [],
    orders = [],
    patient = {},
    rulePack = null,
  } = {}) {
    const alignments = [];

    // Helper: find observations by keyword
    const findObs = (kw) => {
      const target = kw.toLowerCase();
      return observations.filter((o) => {
        const code = String(o.code || "").toLowerCase();
        const name = String(o.name || "").toLowerCase();
        return code.includes(target) || name.includes(target);
      });
    };

    // Helper: find medications by keyword
    const findMeds = (kw) => {
      return medications.filter((m) => {
        const dName = String(m.drug_name || m.medication || "").toLowerCase();
        return dName.includes(kw.toLowerCase());
      });
    };

    // --- Domain 1: 液体平衡 - 肾功能 - 血压 - 利尿对齐 (Fluid / Renal / Hemodynamics) ---
    const scrObs = findObs("肌酐") || findObs("scr") || findObs("creatinine");
    const kObs = findObs("钾") || findObs("potassium");
    const diuretics = medications.filter((m) => {
      const d = String(m.drug_name || m.medication || "");
      return /呋塞米|托拉塞米|螺内酯|氢氯噻嗪|布美他尼|重组人脑利钠肽|新活素/.test(d);
    });
    const vasoactives = medications.filter((m) => {
      const d = String(m.drug_name || m.medication || "");
      return /硝普钠|硝酸甘油|去甲肾上腺素|多巴胺|肾上腺素|硝苯地平|美托洛尔|比索洛尔|卡维地洛/.test(d);
    });

    const hasFluid = fluidBalance != null;
    const hasScr = scrObs.length > 0;
    const hasDiuretic = diuretics.length > 0;
    const hasVaso = vasoactives.length > 0;

    if (hasFluid || hasScr || hasDiuretic || hasVaso) {
      const nisParts = [];
      if (fluidBalance) {
        nisParts.push(`24h入量 ${fluidBalance.intake_total_ml}ml, 出量 ${fluidBalance.output_total_ml}ml (尿量 ${fluidBalance.urine_24h_ml}ml), 净平衡 ${fluidBalance.net_balance_label}`);
      }
      if (vitalsSummary?.bp_max) {
        nisParts.push(`血压极值: ${vitalsSummary.bp_max} ~ ${vitalsSummary.bp_min || ""}`);
      }

      const lisParts = [];
      if (scrObs.length > 0) {
        const latestScr = scrObs[0];
        lisParts.push(`血肌酐: ${latestScr.value} ${latestScr.unit || "μmol/L"}`);
      }

      const hisParts = [];
      if (diuretics.length > 0) {
        hisParts.push(`利尿药: ${diuretics.map((d) => d.drug_name || d.medication).join("、")}`);
      }
      if (vasoactives.length > 0) {
        hisParts.push(`心血管/血管活性药: ${vasoactives.map((d) => d.drug_name || d.medication).join("、")}`);
      }

      let syn = "出入量与肾功能演变监控中";
      if (fluidBalance && fluidBalance.net_balance_ml > 800) {
        syn = `24h显著净正平衡 (${fluidBalance.net_balance_label})` + (diuretics.length > 0 ? "，已有在用利尿剂治疗" : "，提示关注容量负荷");
      } else if (fluidBalance && fluidBalance.urine_24h_ml < 500 && fluidBalance.urine_24h_ml > 0) {
        syn = `少尿状态 (24h 尿量 ${fluidBalance.urine_24h_ml}ml)` + (scrObs.length > 0 ? ` 伴肌酐 ${scrObs[0].value} μmol/L` : "");
      }

      alignments.push({
        domain_id: "fluid_renal_hemodynamic",
        domain_title: "液体平衡 - 肾功能 - 循环与利尿对齐",
        nis_summary: nisParts.join("；") || "无特定记录",
        lis_summary: lisParts.join("；") || "未查血肌酐",
        his_summary: hisParts.join("；") || "无在用利尿/血管活性药",
        clinical_synthesis: syn,
        requires_attention: fluidBalance?.net_balance_ml > 1000 || (fluidBalance?.urine_24h_ml > 0 && fluidBalance?.urine_24h_ml < 500),
      });
    }

    // --- Domain 2: 体温 - 感染指标 - 抗菌药物对齐 (Infection / Antimicrobial) ---
    const infObs = observations.filter((o) => {
      const n = String(o.name || o.code || "");
      return /白细胞|wbc|中性粒|crp|c反应蛋白|pct|降钙素原|培养/.test(n.toLowerCase());
    });
    const antibiotics = medications.filter((m) => {
      return m.antibiotic_info != null || /头孢|青霉素|他唑巴坦|舒巴坦|卡巴培南|培南|莫西沙星|左氧氟沙星|阿奇霉素|万古霉素|替考拉宁|利奈唑胺|阿米卡星/.test(m.drug_name || m.medication || "");
    });

    if (vitalsSummary?.t_max != null || infObs.length > 0 || antibiotics.length > 0) {
      const nisParts = [];
      if (vitalsSummary?.t_max) {
        nisParts.push(`最高体温: ${vitalsSummary.t_max}℃` + (vitalsSummary.t_max >= 38.5 ? " (高热)" : vitalsSummary.t_max >= 37.3 ? " (低热)" : " (正常)"));
      }

      const lisParts = infObs.map((o) => `${o.name || o.code}: ${o.value} ${o.unit || ""}`);
      const hisParts = antibiotics.map((a) => {
        const name = a.drug_name || a.medication;
        const dur = a.antibiotic_info?.duration_days ? `第${a.antibiotic_info.duration_days}天` : "";
        const lvl = a.antibiotic_info?.level ? `[${a.antibiotic_info.level}]` : "";
        return `${name} ${dur} ${lvl}`.trim();
      });

      let syn = "感染与体温指标平稳";
      if (vitalsSummary?.t_max >= 38.0) {
        syn = `监测到体温升高 (${vitalsSummary.t_max}℃)` + (antibiotics.length > 0 ? `，当前使用 ${antibiotics.map((a) => a.drug_name || a.medication).join("、")}` : "，未启用抗菌药物");
      } else if (antibiotics.some((a) => a.antibiotic_info?.is_overdue)) {
        syn = "抗菌药物已达院内规则包复核时间点，建议复核降阶梯或停药指征";
      }

      alignments.push({
        domain_id: "infection_temperature_antimicrobial",
        domain_title: "体温 - 感染指标 - 抗菌药物对齐",
        nis_summary: nisParts.join("；") || "体温平稳",
        lis_summary: lisParts.join("；") || "近期未见感染指标化验",
        his_summary: hisParts.join("；") || "未开立抗菌药物",
        clinical_synthesis: syn,
        requires_attention: (vitalsSummary?.t_max >= 38.5) || antibiotics.some((a) => a.antibiotic_info?.is_overdue),
      });
    }

    // --- Domain 3: 电解质异常与补给闭环对齐 (Electrolyte Balance & Replenishment) ---
    const electrolyteObs = observations.filter((o) => {
      const n = String(o.name || o.code || "").toLowerCase();
      return /钾|钠|钙|镁|k|na|ca|mg/.test(n) && (o.is_critical || o.value < 3.5 || o.value > 5.3 || o.value < 135 || o.value > 145);
    });
    const replenishments = medications.filter((m) => {
      const d = String(m.drug_name || m.medication || "");
      return /氯化钾|枸橼酸钾|碳酸氢钠|浓氯化钠|葡萄糖酸钙|硫酸镁/.test(d);
    });

    if (electrolyteObs.length > 0 || replenishments.length > 0) {
      const lisParts = electrolyteObs.map((o) => `${o.name || o.code}: ${o.value} ${o.unit || ""} (${o.is_critical ? "危急值" : "异常"})`);
      const hisParts = replenishments.map((m) => `${m.drug_name || m.medication} ${m.dosage || ""} ${m.route || ""}`);

      alignments.push({
        domain_id: "electrolytes_replenishment",
        domain_title: "电解质异常 - 纠正医嘱 - 复查闭环对齐",
        nis_summary: "生命体征同步监测",
        lis_summary: lisParts.join("；") || "电解质平稳",
        his_summary: hisParts.join("；") || "无电解质补充医嘱",
        clinical_synthesis: electrolyteObs.length > 0 && replenishments.length > 0 ? "已见电解质异常并开立对应用药，关注复查闭环" : (electrolyteObs.length > 0 ? "检出电解质异常，尚未见纠正医嘱" : "在用电解质补充药物"),
        requires_attention: electrolyteObs.some((o) => o.is_critical),
      });
    }

    // --- Domain 4: 心血管标志物与抗栓/扩冠用药对齐 (Cardiovascular Markers & Therapy) ---
    const cardiacObs = observations.filter((o) => {
      const n = String(o.name || o.code || "").toLowerCase();
      return /肌钙蛋白|ctni|ctnt|bnp|probnp|d-二聚体|ck-mb|inr|凝血/.test(n);
    });
    const cardiacMeds = medications.filter((m) => {
      const d = String(m.drug_name || m.medication || "");
      return /阿司匹林|氯吡格雷|替格瑞洛|肝素|依诺肝素|华法林|利伐沙班|达比加群|阿托伐他汀|瑞舒伐他汀|硝酸异山梨酯|单硝酸/.test(d);
    });
    const cardiacPacs = diagnosticReports.filter((r) => {
      const n = String(r.name || r.modality || "");
      return /心|冠脉|超声心动|cta|血管/.test(n);
    });

    if (cardiacObs.length > 0 || cardiacMeds.length > 0 || cardiacPacs.length > 0) {
      const lisParts = cardiacObs.map((o) => `${o.name || o.code}: ${o.value} ${o.unit || ""}`);
      const pacsParts = cardiacPacs.map((p) => `${p.name}: ${p.impression || p.status}`);
      const hisParts = cardiacMeds.map((m) => `${m.drug_name || m.medication}`);

      alignments.push({
        domain_id: "cardiovascular_biomarkers_medication",
        domain_title: "心血管标志物 - 影像 - 抗栓与调脂对齐",
        nis_summary: vitalsSummary?.bp_max ? `血压: ${vitalsSummary.bp_max}, 心率: ${vitalsSummary.hr_avg || "平稳"} bpm` : "体征平稳",
        lis_summary: lisParts.join("；") || "未复查心肌酶/BNP",
        pacs_summary: pacsParts.join("；") || "无近期心血管影像报告",
        his_summary: hisParts.join("；") || "无在用抗栓/调脂医嘱",
        clinical_synthesis: "心血管专科指标与用药协同监测中",
        requires_attention: cardiacObs.some((o) => o.is_critical),
      });
    }

    return alignments;
  }
}
