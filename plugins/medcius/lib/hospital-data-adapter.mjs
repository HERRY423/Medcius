// Hospital Multi-Source Data Fusion & Virtual FHIR Normalizer
// Ingests: NIS (Nursing vitals & 24h fluid balance), LIS (Labs & Critical Values), PACS (Imaging & Impressions), HIS (Orders & Notes)
// Outputs: Standardized FHIR R4 Bundles & Normalized Clinical Feeds for PatientEvolutionEngine

/**
 * Standard Critical Value Clinical Thresholds (根据国家卫健委《医疗质量安全核心制度》检验危急值通用范围)
 */
export const CRITICAL_VALUE_THRESHOLDS = {
  k: { name: "血钾", low: 2.8, high: 6.2, unit: "mmol/L", danger_hint: "严重心律失常 / 心脏骤停风险" },
  na: { name: "血钠", low: 120, high: 160, unit: "mmol/L", danger_hint: "严重渗透压紊乱 / 脑水肿风险" },
  scr: { name: "血肌酐", high: 350, unit: "μmol/L", danger_hint: "急性肾损伤 (AKI 3期) 风险" },
  ctni: { name: "肌钙蛋白I", high: 1.0, unit: "ng/mL", danger_hint: "急性心肌坏死 / ACS 高危" },
  bnp: { name: "BNP/NT-proBNP", high: 5000, unit: "pg/mL", danger_hint: "急性失代偿性心力衰竭" },
  plt: { name: "血小板", low: 30, unit: "x10^9/L", danger_hint: "自发性严重出血风险" },
  wbc: { name: "白细胞", low: 1.5, high: 30.0, unit: "x10^9/L", danger_hint: "严重骨髓抑制或脓毒症反应" },
  glu: { name: "血糖", low: 2.2, high: 22.2, unit: "mmol/L", danger_hint: "低血糖昏迷或高渗高血糖状态 (HHS)" },
};

/**
 * Restricted / Special Class Antibiotics Classification (限制使用级与特殊使用级抗菌药物目录)
 */
export const RESTRICTED_ANTIBIOTICS = [
  { name: "头孢曲松", class: "三代头孢", level: "限制使用级", max_recommended_days: 7 },
  { name: "头孢他啶", class: "三代头孢", level: "限制使用级", max_recommended_days: 7 },
  { name: "头孢哌酮舒巴坦", class: "三代头孢+酶抑制剂", level: "限制使用级", max_recommended_days: 7 },
  { name: "哌拉西林他唑巴坦", class: "广谱青霉素+酶抑制剂", level: "限制使用级", max_recommended_days: 7 },
  { name: "莫西沙星", class: "呼吸喹诺酮", level: "限制使用级", max_recommended_days: 7 },
  { name: "左氧氟沙星", class: "喹诺酮类", level: "限制使用级", max_recommended_days: 7 },
  { name: "美罗培南", class: "碳青霉烯类", level: "特殊使用级", max_recommended_days: 5 },
  { name: "亚胺培南西司他丁", class: "碳青霉烯类", level: "特殊使用级", max_recommended_days: 5 },
  { name: "万古霉素", class: "糖肽类", level: "特殊使用级", max_recommended_days: 7 },
  { name: "去甲万古霉素", class: "糖肽类", level: "特殊使用级", max_recommended_days: 7 },
  { name: "利奈唑胺", class: "恶唑烷酮类", level: "特殊使用级", max_recommended_days: 7 },
  { name: "替加环素", class: "甘氨酰环素类", level: "特殊使用级", max_recommended_days: 7 },
  { name: "多粘菌素B", class: "多粘菌素类", level: "特殊使用级", max_recommended_days: 7 },
];

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
  static normalizeNisFeed(nisFeed = []) {
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
    const fluidBalance = {
      intake_total_ml: intakeTotal,
      output_total_ml: outputTotal,
      net_balance_ml: netBalance,
      net_balance_label: `${netBalance >= 0 ? "+" : ""}${netBalance} ml`,
      urine_24h_ml: urineTotal,
      drain_24h_ml: drainTotal,
      stool_24h_count: stoolCount,
      drain_details: drainDetails,
      status: netBalance > 1000 ? "显著正平衡 (需警惕容量负荷过重)" : (netBalance < -1000 ? "显著负平衡 (有效循环容量关注)" : "基本平衡"),
    };

    return { vitals_summary: vitalsSummary, fluid_balance: fluidBalance, fhir_observations: fhirObservations };
  }

  /**
   * 2. Normalize LIS (Laboratory Info System) and Detect Critical Values
   */
  static normalizeLisFeed(lisFeed = []) {
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

      // Rule check against national critical thresholds
      const thresh = CRITICAL_VALUE_THRESHOLDS[codeKey];
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
          urgency_action: "危急值需在 30 分钟内完成临床医师处置与闭环记录",
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
  static normalizeHisOrders(ordersFeed = []) {
    if (!Array.isArray(ordersFeed)) return { medications: [], orders: [], antibiotic_alerts: [] };

    const medications = [];
    const orders = [];
    const antibioticAlerts = [];
    const now = Date.now();

    for (const item of ordersFeed) {
      if (item.is_medication || item.drug_name) {
        const drugName = item.drug_name || item.name;
        const authoredOn = item.authored_on || item.start_time || new Date().toISOString();
        const startTimestamp = new Date(authoredOn).getTime();
        const durationDays = Math.max(1, Math.ceil((now - startTimestamp) / (24 * 3600000)));

        // Check if restricted/special antibiotic
        const matchAnti = RESTRICTED_ANTIBIOTICS.find((a) => drugName.includes(a.name));
        let antiInfo = null;

        if (matchAnti) {
          const isOverdue = durationDays >= matchAnti.max_recommended_days;
          antiInfo = {
            drug_name: drugName,
            class: matchAnti.class,
            level: matchAnti.level,
            duration_days: durationDays,
            max_recommended_days: matchAnti.max_recommended_days,
            is_overdue: isOverdue,
            alert_message: `【${matchAnti.level}】${drugName}已使用第 ${durationDays} 天。${isOverdue ? "已达常规疗程上限，建议结合复查感染指标（PCT/CRP）与病原药敏结果评估降阶梯或停药。" : "需持续观察感染控制情况与脏器功能。"}`
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
        });
      }
    }

    return { medications, orders, antibiotic_alerts: antibioticAlerts };
  }
}
