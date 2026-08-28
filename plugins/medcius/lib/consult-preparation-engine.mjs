// Specialist Consultation Preparation Engine (专科会诊前资料整理引擎)
// Synthesizes clinical milestones, specialty-relevant lab timelines, active regimens,
// and pending reports into a targeted pre-consultation evidence dossier.

export class ConsultPreparationEngine {
  /**
   * Analyze patient records and prepare a targeted dossier for specialist consultation.
   * 
   * @param {Object} params
   * @param {Object} params.patient - Demographic & admission info
   * @param {Object} params.encounter - Encounter context
   * @param {Object} params.consultRequest - { department, purpose, question, urgency }
   * @param {Array} params.notes - Hospital progress notes
   * @param {Array} params.observations - Normalized LIS observations & labs
   * @param {Array} params.diagnosticReports - Imaging, pathology, and endoscopy reports
   * @param {Array} params.medications - Active medications
   * @param {Array} params.allergies - Known drug allergies
   */
  static prepareConsultDossier({
    patient = {},
    encounter = {},
    consultRequest = {},
    notes = [],
    observations = [],
    diagnosticReports = [],
    medications = [],
    allergies = null,
  }) {
    if (!patient.id) {
      throw new Error("FAIL_CLOSED: Missing patient_id for consultation preparation");
    }
    const targetDept = consultRequest.department || "专科会诊";
    const consultPurpose = consultRequest.purpose || consultRequest.title || "专科诊疗意见与方案指导";

    // 1. Consultation Objective & Core Clinical Problem
    const header = {
      patient_id: patient.id,
      patient_name: patient.name || "脱敏患者",
      bed_number: patient.bed_number || "床位",
      age: patient.age,
      gender: patient.gender,
      primary_diagnosis: patient.primary_diagnosis || "未记录",
      target_department: targetDept,
      purpose: consultPurpose,
      urgency: consultRequest.urgency || "常规会诊 (24h内完成)",
      requested_at: consultRequest.requested_at || new Date().toISOString(),
    };

    // 2. Specialty Relevance Keyword Filter
    let specialtyKeywords = [];
    if (/肾|透析|利尿/i.test(targetDept)) {
      specialtyKeywords = ["肌酐", "scr", "尿素", "bun", "egfr", "钾", "k+", "k", "钠", "na", "利尿", "水肿", "尿量", "肾", "ckd", "aki", "bnp", "probnp", "nt-probnp", "nt_probnp"];
    } else if (/心|循环/i.test(targetDept)) {
      specialtyKeywords = ["心肌酶", "肌钙蛋白", "ctni", "ctnt", "bnp", "probnp", "nt-probnp", "ecg", "心电图", "超声心动", "胸闷", "胸痛", "心衰", "冠脉"];
    } else if (/呼吸|肺/i.test(targetDept)) {
      specialtyKeywords = ["气促", "咳嗽", "痰", "胸片", "ct", "血气", "spo2", "氧分压", "哮喘", "慢阻肺", "感染"];
    } else if (/感染|抗生素/i.test(targetDept)) {
      specialtyKeywords = ["发热", "体温", "pct", "crp", "wbc", "培养", "药敏", "头孢", "美罗培南", "万古霉素"];
    } else if (/消化|内镜/i.test(targetDept)) {
      specialtyKeywords = ["腹痛", "便血", "呕血", "胃镜", "肠镜", "胆红素", "转氨酶", "黑便", "腹胀"];
    } else if (/神经/i.test(targetDept)) {
      specialtyKeywords = ["头晕", "意识", "偏瘫", "失语", "ct", "mri", "脑梗", "出血", "抽搐"];
    } else {
      specialtyKeywords = [targetDept];
    }

    // 3. Extract Relevant Clinical Notes & Spans
    const relevantNotes = [];
    for (const note of notes) {
      const text = note.text || "";
      const matches = specialtyKeywords.some((kw) => text.includes(kw));
      if (matches || /会诊|主诉|现病史/i.test(note.title || "")) {
        relevantNotes.push({
          note_id: note.id,
          title: note.title || "病程记录",
          timestamp: note.timestamp,
          excerpt: text.slice(0, 120),
        });
      }
    }

    // 4. Targeted Laboratory & Diagnostic Timeline
    const targetedLabs = [];
    for (const obs of observations) {
      const name = (obs.name || obs.test_name || obs.code || "").toLowerCase();
      const isTargeted = specialtyKeywords.some((kw) => name.includes(kw.toLowerCase()));
      if (isTargeted || obs.is_critical) {
        targetedLabs.push({
          test_name: obs.name || obs.test_name || obs.code,
          value: obs.value,
          unit: obs.unit || "",
          effective_time: obs.effective_time || obs.timestamp || null,
          is_critical: obs.is_critical || false,
          reference_range: obs.referenceRange || null,
        });
      }
    }

    // Sort labs chronologically
    targetedLabs.sort((a, b) => new Date(b.effective_time || 0).getTime() - new Date(a.effective_time || 0).getTime());

    // 5. Relevant Diagnostic Reports (PACS / Pathology / Cultures)
    const relevantReports = [];
    const pendingReports = [];
    for (const rep of diagnosticReports) {
      const repName = rep.name || rep.study_name || "检查报告";
      const isFinal = rep.status === "final";
      if (isFinal) {
        relevantReports.push({
          report_name: repName,
          ordered_at: rep.ordered_at,
          impression: rep.impression || "未见明显异常",
        });
      } else {
        pendingReports.push({
          report_name: repName,
          status: rep.status,
          ordered_at: rep.ordered_at,
          status_desc: "尚未出具最终报告",
        });
      }
    }

    // 6. Active Medication Regimen Relevant to Specialty
    const activeMeds = medications.map((m) => ({
      drug_name: m.drug_name || m.name,
      dosage: m.dosage || "",
      route: m.route || "po",
      frequency: m.frequency || "qd",
      authored_on: m.authored_on || null,
      is_antibiotic: m.antibiotic_info != null,
    }));

    const hasAllergyRecord = allergies != null && (!Array.isArray(allergies) || allergies.length > 0);
    const allergyStatus = hasAllergyRecord
      ? (Array.isArray(allergies) ? allergies.join("、") : allergies)
      : "未明确记录 (缺口)";

    return {
      success: true,
      header,
      allergy_status: allergyStatus,
      relevant_clinical_notes: relevantNotes,
      targeted_labs_timeline: targetedLabs,
      relevant_imaging_reports: relevantReports,
      pending_specialty_reports: pendingReports,
      active_medications: activeMeds,
      data_gaps: hasAllergyRecord ? [] : ["ALLERGY_MISSING: 过敏史记录缺失"],
    };
  }

  /**
   * Generate structured consultation dossier text for physician review.
   */
  static generateConsultBriefText({ consultDossier, requestingDoctor = "申请医师" }) {
    const { header, allergy_status, relevant_clinical_notes, targeted_labs_timeline, relevant_imaging_reports, pending_specialty_reports, active_medications } = consultDossier;

    const lines = [];
    lines.push(`【${header.target_department}会诊前资料摘要包】`);
    lines.push(`患者姓名：${header.patient_name} (${header.age}岁/${header.gender})  |  床位：${header.bed_number}  |  主诊断：${header.primary_diagnosis}`);
    lines.push(`申请科室/医师：${requestingDoctor}  |  会诊时效：${header.urgency}  |  生成时间：${new Date().toISOString().replace("T", " ").slice(0, 16)}`);
    lines.push("");

    lines.push(`一、会诊目的与拟解决核心问题`);
    lines.push(`  • 会诊诉求：${header.purpose}`);
    lines.push(`  • 过敏史状态：${allergy_status}`);
    lines.push("");

    lines.push(`二、本专科重点病程演变与病历摘录`);
    if (relevant_clinical_notes.length > 0) {
      relevant_clinical_notes.forEach((n) => lines.push(`  • [${n.title}] ${n.excerpt}...`));
    } else {
      lines.push(`  • 暂无直接匹配的专科病程摘录`);
    }
    lines.push("");

    lines.push(`三、针对性专科检验指标时间轴`);
    if (targeted_labs_timeline.length > 0) {
      targeted_labs_timeline.slice(0, 8).forEach((l) => {
        lines.push(`  • ${l.test_name}: ${l.value} ${l.unit} ${l.is_critical ? "🚨[危急值]" : ""} (${l.effective_time ? l.effective_time.slice(0, 10) : "近期"})`);
      });
    } else {
      lines.push(`  • 暂无相关专项检验记录`);
    }
    lines.push("");

    lines.push(`四、相关已出影像与专科检查结论`);
    if (relevant_imaging_reports.length > 0) {
      relevant_imaging_reports.forEach((r) => lines.push(`  • 【${r.report_name}】${r.impression}`));
    } else {
      lines.push(`  • 暂无近期相关专科影像报告`);
    }
    lines.push("");

    if (pending_specialty_reports.length > 0) {
      lines.push(`五、尚未回报的专科待办检查`);
      pending_specialty_reports.forEach((p) => lines.push(`  • [待出报告] ${p.report_name} (${p.status_desc})`));
      lines.push("");
    }

    lines.push(`六、当前主要用药方案`);
    if (active_medications.length > 0) {
      lines.push(`  • ${active_medications.map((m) => `${m.drug_name} ${m.dosage}`).join("、")}`);
    } else {
      lines.push(`  • 暂无活动用药医嘱`);
    }
    lines.push("");

    lines.push(`特别提示：本资料包为病历与检查信息结构化汇聚，供会诊专科医师床旁查体与制定会诊意见参考，不替代专科医生独立临床诊疗判断。`);

    return lines.join("\n");
  }
}
