// Clinical Shift Handover & Handoff Engine (临床交接班整理引擎)
// Implements SBAR (Situation, Background, Assessment, Recommendation) / I-PASS Inpatient Handoff Model
// Summarizes overnight critical monitoring points, drain alerts, scheduled lab follow-ups, and contingency plans.

export const SHIFT_TYPES = {
  MORNING_TO_EVENING: "day_to_night",     // 白班交夜班
  EVENING_TO_MORNING: "night_to_day",     // 夜班交白班
  WEEKEND_ON_CALL: "weekend_handoff",     // 周末总值班交接
};

export class ShiftHandoverEngine {
  /**
   * Analyze and generate SBAR structured handover package for a patient or ward.
   * 
   * @param {Object} params
   * @param {Object} params.patient - Patient demographic & admission info
   * @param {Object} params.encounter - Encounter details & care level
   * @param {Array} params.notes - Recent progress notes
   * @param {Object} params.vitals - Normalized NIS vitals summary & fluid balance
   * @param {Array} params.observations - Normalized LIS observations & critical values
   * @param {Array} params.medications - Active medications & infusions
   * @param {Array} params.orders - Active orders & scheduled overnight actions
   * @param {Array} params.allergies - Known allergies
   * @param {string} params.shiftType - One of SHIFT_TYPES
   */
  static analyzePatientHandover({
    patient = {},
    encounter = {},
    notes = [],
    vitals = {},
    observations = [],
    medications = [],
    orders = [],
    allergies = null,
    shiftType = SHIFT_TYPES.MORNING_TO_EVENING,
  }) {
    if (!patient.id) {
      throw new Error("FAIL_CLOSED: Patient identifier is required for clinical handover");
    }

    const { vitals_summary, fluid_balance } = vitals;

    // ----------------------------------------------------
    // S - Situation (当前现状)
    // ----------------------------------------------------
    const careLevel = encounter.care_level || (patient.bed_number === "01床" || patient.bed_number === "02床" ? "特级护理" : "一级护理");
    const situation = {
      bed_number: patient.bed_number || "未分配床位",
      patient_name: patient.name || "脱敏患者",
      age: patient.age,
      gender: patient.gender,
      primary_diagnosis: patient.primary_diagnosis || "入院待查",
      care_level: careLevel,
      acuity_status: careLevel === "特级护理" ? "🚨 重症监护/重点交班" : "稳定观察",
    };

    // ----------------------------------------------------
    // B - Background (背景信息与重要历程)
    // ----------------------------------------------------
    const allergySummary = allergies == null || (Array.isArray(allergies) && allergies.length === 0)
      ? "⚠️ 过敏史缺失 (需当面核实)"
      : (Array.isArray(allergies) ? allergies.join(", ") : String(allergies));

    const background = {
      admission_date: patient.admission_date || null,
      allergy_summary: allergySummary,
      has_allergy_gap: allergySummary.includes("缺失"),
      recent_procedures: [],
    };

    // Extract recent surgical or procedural notes
    for (const note of notes) {
      if (/术后|PCI|造影|穿刺|置管|引流|介入/i.test(note.text || "")) {
        background.recent_procedures.push({
          note_id: note.id,
          title: note.title || "手术/操作记录",
          timestamp: note.timestamp,
          summary: (note.text || "").slice(0, 100),
        });
      }
    }

    // ----------------------------------------------------
    // A - Assessment (值班重点评估与异常指标)
    // ----------------------------------------------------
    const criticalObservations = observations.filter((o) => o.is_critical);
    const abnormalLabs = observations.filter((o) => o.is_abnormal || (o.referenceRange?.length > 0 && o.is_critical));
    const activeInfusions = medications.filter((m) => m.route === "iv" || m.route === "ivgtt" || m.route === "泵入" || /多巴胺|去甲肾上腺素|硝酸甘油|呋塞米|胰岛素|胺碘酮/i.test(m.drug_name || ""));

    const assessment = {
      vitals_alerts: [],
      drain_alerts: [],
      critical_values: criticalObservations.map((c) => ({
        name: c.name,
        value: c.value,
        unit: c.unit,
        reason: c.critical_reason || "触发危急值",
      })),
      abnormal_labs_count: abnormalLabs.length,
      active_infusions: activeInfusions.map((m) => ({
        drug_name: m.drug_name,
        dosage: m.dosage,
        route: m.route,
      })),
      fluid_balance_status: fluid_balance?.status || "平稳",
    };

    // Vitals warning
    if (vitals_summary) {
      if (vitals_summary.t_max && vitals_summary.t_max >= 38.0) {
        assessment.vitals_alerts.push(`体温升高最高达 ${vitals_summary.t_max}℃`);
      }
      if (vitals_summary.spo2_min && parseInt(vitals_summary.spo2_min) < 93) {
        assessment.vitals_alerts.push(`SpO2 波动最低至 ${vitals_summary.spo2_min}`);
      }
    }

    // Drain alerts
    if (fluid_balance?.drain_details?.length > 0) {
      for (const d of fluid_balance.drain_details) {
        assessment.drain_alerts.push(`${d.name}: 24h 累计 ${d.amount_ml}ml (${d.description})`);
      }
    }

    // ----------------------------------------------------
    // R - Recommendation (值班待办、复查时点与应急预案)
    // ----------------------------------------------------
    const scheduledFollowUps = [];
    const contingencyPlans = [];

    // Collect scheduled follow-ups
    for (const ord of orders) {
      if (ord.scheduled_time || /复查|急查|监护|记录/i.test(ord.title || "")) {
        scheduledFollowUps.push({
          title: ord.title || ord.name,
          scheduled_time: ord.scheduled_time || "今晚/夜间待办",
          purpose: ord.purpose || "病情监测",
        });
      }
    }

    // Generate intelligent clinical contingency reminders
    if (criticalObservations.some((c) => /k|钾/i.test(c.code || c.name))) {
      contingencyPlans.push("【电解质应急】血钾异常波动，夜间注意心电监护 U 波/T 波演变，复查急诊电解质后按医嘱补钾或降钾。");
    }
    if (situation.primary_diagnosis.includes("心肌梗死") || situation.primary_diagnosis.includes("ACS")) {
      contingencyPlans.push("【胸痛应急】若夜间再发压榨性胸痛或心率骤降，立即行床旁 18 导联心电图、吸氧并遵医嘱急查肌钙蛋白/急请二线。");
    }
    if (situation.primary_diagnosis.includes("心力衰竭") || (fluid_balance && fluid_balance.net_balance_ml > 1000)) {
      contingencyPlans.push("【心衰容量负荷】患者处于明显正平衡，夜间若突发端坐呼吸或两肺湿啰音增多，注意半卧位吸氧及紧急利尿支持。");
    }

    return {
      patient_id: patient.id,
      shift_type: shiftType,
      generated_at: new Date().toISOString(),
      sbar: {
        situation,
        background,
        assessment,
        recommendation: {
          scheduled_follow_ups: scheduledFollowUps,
          contingency_plans: contingencyPlans,
        },
      },
    };
  }

  /**
   * Generate structured handoff card text.
   */
  static generateHandoverText({ handoverData, outgoingDoctor = "白班医师", incomingDoctor = "夜班值班医师" }) {
    const { sbar } = handoverData;
    const { situation, background, assessment, recommendation } = sbar;

    const lines = [];
    lines.push(`【临床交接班记录 (SBAR 模型)】`);
    lines.push(`交接床位：${situation.bed_number}  |  患者姓名：${situation.patient_name} (${situation.age}岁/${situation.gender})  |  分级：${situation.care_level}`);
    lines.push(`交班医师：${outgoingDoctor}  ➔  接班医师：${incomingDoctor}  |  时间：${new Date().toISOString().replace("T", " ").slice(0, 16)}`);
    lines.push("");

    lines.push(`一、S (现状 Situation)`);
    lines.push(`  • 主要诊断：${situation.primary_diagnosis}`);
    lines.push(`  • 当前状态：${situation.acuity_status}`);
    lines.push("");

    lines.push(`二、B (背景 Background)`);
    lines.push(`  • 过敏情况：${background.allergy_summary}`);
    if (background.recent_procedures.length > 0) {
      background.recent_procedures.forEach((p) => lines.push(`  • 近期操作：${p.title} (${p.summary.slice(0, 50)}...)`));
    } else {
      lines.push(`  • 近期操作：无特殊有创操作`);
    }
    lines.push("");

    lines.push(`三、A (评估 Assessment)`);
    if (assessment.critical_values.length > 0) {
      assessment.critical_values.forEach((c) => lines.push(`  • 🚨 危急值关注：${c.name} ${c.value} ${c.unit} (${c.reason})`));
    }
    if (assessment.vitals_alerts.length > 0) {
      assessment.vitals_alerts.forEach((v) => lines.push(`  • ⚠️ 体征预警：${v}`));
    }
    if (assessment.drain_alerts.length > 0) {
      assessment.drain_alerts.forEach((d) => lines.push(`  • 引流管路：${d}`));
    }
    if (assessment.active_infusions.length > 0) {
      lines.push(`  • 维持静脉通路/泵入：${assessment.active_infusions.map((m) => `${m.drug_name} ${m.dosage}`).join("、")}`);
    }
    if (assessment.critical_values.length === 0 && assessment.vitals_alerts.length === 0 && assessment.drain_alerts.length === 0) {
      lines.push(`  • 暂无危急值及特殊生命体征报警，整体平稳`);
    }
    lines.push("");

    lines.push(`四、R (建议与值班预案 Recommendation)`);
    if (recommendation.scheduled_follow_ups.length > 0) {
      recommendation.scheduled_follow_ups.forEach((f) => lines.push(`  • [待办复查] ${f.title} (${f.scheduled_time})`));
    } else {
      lines.push(`  • [待办复查] 暂无夜间指定复查`);
    }
    if (recommendation.contingency_plans.length > 0) {
      recommendation.contingency_plans.forEach((cp) => lines.push(`  • ${cp}`));
    }
    lines.push("");
    lines.push(`交接双方签字确认：交班人 [ ${outgoingDoctor} ]   接班人 [ ${incomingDoctor} ]`);

    return lines.join("\n");
  }
}
