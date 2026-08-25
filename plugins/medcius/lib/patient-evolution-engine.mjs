// Patient Evolution Summary Engine (住院医生查房前“患者变化摘要”确定性计算引擎)
// Core Flagship Engine: Computes 24h / 72h patient evolution, lab trends, medication diffs,
// pending reports/orders, and critical safety gaps with exact source spans.
// Boundary: Does NOT diagnose, does NOT formulate treatment plans, does NOT autonomously write back.
// Clinical Reference Safety: Prioritizes hospital LIS / FHIR referenceRange; strictly prohibits
// making high/low judgments when reference range is absent (trend-only mode); prohibits synthetic concatenated spans.

import { splitSections } from "./parse-cn-note.mjs";

export const ITEM_CATEGORIES = {
  FACT: "FACT",           // 【原文事实】
  RULE_ALERT: "RULE_ALERT", // 【规则提醒】
  DATA_GAP: "DATA_GAP",   // 【资料不足】
};

export const CATEGORY_LABELS = {
  [ITEM_CATEGORIES.FACT]: "【原文事实】",
  [ITEM_CATEGORIES.RULE_ALERT]: "【规则提醒】",
  [ITEM_CATEGORIES.DATA_GAP]: "【资料不足】",
};

export class PatientEvolutionEngine {
  /**
   * Analyze patient evolution across 24h or 72h window.
   */
  static analyzePatientEvolution({
    patient = {},
    timeWindow = "24h", // '24h' | '72h'
    notes = [],
    observations = [],
    medications = [],
    diagnosticReports = [],
    orders = [],
    allergies = null,
  }) {
    const windowHours = timeWindow === "72h" ? 72 : 24;
    const now = Date.now();
    const cutoffTime = now - windowHours * 60 * 60 * 1000;

    let nextItemId = 1;
    const genId = (prefix) => `${prefix}-${String(nextItemId++).padStart(3, "0")}`;

    // ----------------------------------------------------
    // BLOCK 1: 「发生了什么变化」 (What Changed)
    // ----------------------------------------------------
    const changes = {
      clinical_symptoms: [],
      abnormal_labs: [],
      medication_diff: {
        added: [],
        discontinued: [],
        adjusted: [],
      },
    };

    // 1a. Clinical Symptoms & Vitals Evolution from Notes (Verbatim Spans ONLY)
    for (const note of notes) {
      const noteTime = note.timestamp ? new Date(note.timestamp).getTime() : now;
      if (noteTime >= cutoffTime) {
        const sections = splitSections(note.text || "");
        const docName = note.title || note.note_type || "病程记录";

        // Check Progress / Chief Complaint / Vitals sections
        const progressSec = sections["病程记录"] || sections["现病史"] || sections["主诉"] || sections["诊疗经过"];
        if (progressSec) {
          const sentences = progressSec.split(/[。\n；;]/).map((s) => s.trim()).filter((s) => s.length >= 4);
          for (const s of sentences) {
            if (/体温|热|发热|最高|血压|心率|胸闷|气促|喘|呼吸|腹痛|咳嗽|咳痰|水肿|出入量|尿量/.test(s)) {
              // Exact verbatim span check: must exist verbatim in note.text
              const noteText = note.text || "";
              const spanVerified = noteText.includes(s) ? s : null;

              changes.clinical_symptoms.push({
                id: genId("SYM"),
                category: ITEM_CATEGORIES.FACT,
                tag: CATEGORY_LABELS[ITEM_CATEGORIES.FACT],
                title: "症状/体征演变",
                summary: s,
                span: spanVerified,
                source_type: "ClinicalNote",
                source_id: note.id || "note-recent",
                source_title: docName,
                timestamp: note.timestamp || new Date().toISOString(),
              });
            }
          }
        }
      }
    }

    // 1b. Abnormal Labs & Longitudinal Trend Calculation
    // Group observations by test code/name
    const obsByCode = {};
    for (const obs of observations) {
      const code = (obs.code || obs.name || "unknown").toLowerCase();
      obsByCode[code] = obsByCode[code] || [];
      obsByCode[code].push(obs);
    }

    for (const [code, obsList] of Object.entries(obsByCode)) {
      // Sort newest to oldest
      obsList.sort((a, b) => new Date(b.effective_time || b.timestamp || 0).getTime() - new Date(a.effective_time || a.timestamp || 0).getTime());

      const latest = obsList[0];
      const latestTime = new Date(latest.effective_time || latest.timestamp || now).getTime();
      const inWindow = latestTime >= cutoffTime;

      // Find previous baseline before latest
      const baseline = obsList.length > 1 ? obsList[1] : null;

      // Extract dynamic LIS / FHIR reference ranges
      const fhirRef = Array.isArray(latest.referenceRange) ? latest.referenceRange[0] : latest.referenceRange;
      const refLow = fhirRef?.low?.value ?? latest.ref_low ?? null;
      const refHigh = fhirRef?.high?.value ?? latest.ref_high ?? null;
      const refText = fhirRef?.text ?? latest.ref_text ?? latest.reference_range ?? null;

      const hasReferenceRange = refLow != null || refHigh != null;
      const latestVal = Number(latest.value);
      const testName = latest.display_name || latest.name || code;
      const unit = latest.unit || "";

      let isHigh = false;
      let isLow = false;
      let isCritical = false;
      let statusLabel = "无参考区间 (仅呈现趋势)";

      if (hasReferenceRange) {
        isHigh = refHigh != null && latestVal > refHigh;
        isLow = refLow != null && latestVal < refLow;
        isCritical = (refHigh != null && latestVal >= refHigh * 2.5) || (refLow != null && latestVal <= refLow * 0.5);
        statusLabel = isCritical ? "🚨 危急值" : (isHigh ? "⚠️ 偏高" : (isLow ? "⚠️ 偏低" : "正常"));
      }

      if (inWindow && (isHigh || isLow || baseline != null || hasReferenceRange)) {
        let trendDirection = "→";
        let deltaStr = "无历史对比";
        let deltaVal = 0;
        let deltaPct = 0;

        if (baseline != null) {
          const baseVal = Number(baseline.value);
          deltaVal = latestVal - baseVal;
          deltaPct = baseVal !== 0 ? (deltaVal / baseVal) * 100 : 0;
          if (deltaVal > 0) trendDirection = "↑";
          else if (deltaVal < 0) trendDirection = "↓";

          deltaStr = `基线: ${baseVal} ${unit} → 当前: ${latestVal} ${unit} (${trendDirection} ${deltaVal > 0 ? "+" : ""}${deltaVal.toFixed(1)} ${unit} / ${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(1)}%)`;
        } else {
          deltaStr = hasReferenceRange
            ? `当前: ${latestVal} ${unit} (参考区间: ${refLow ?? 0}-${refHigh ?? '-'} ${unit})`
            : `当前: ${latestVal} ${unit}`;
        }

        const isAbnormal = isHigh || isLow;

        // Strictly prohibit synthetic string concatenation for span!
        const verbatimSpan = latest.span || null;

        changes.abnormal_labs.push({
          id: genId("LAB"),
          category: ITEM_CATEGORIES.FACT,
          tag: CATEGORY_LABELS[ITEM_CATEGORIES.FACT],
          test_name: testName,
          current_value: latestVal,
          unit,
          has_reference_range: hasReferenceRange,
          ref_low: refLow,
          ref_high: refHigh,
          ref_text: refText,
          status_label: statusLabel,
          is_abnormal: isAbnormal,
          is_critical: isCritical,
          trend_direction: trendDirection,
          delta_summary: deltaStr,
          summary: `${testName}: ${latestVal} ${unit} [${statusLabel}] (${deltaStr})`,
          span: verbatimSpan,
          source_type: "Observation",
          source_id: latest.id || "obs-latest",
          source_title: latest.report_name || "检验报告",
          timestamp: latest.effective_time || latest.timestamp || new Date().toISOString(),
        });
      }
    }

    // 1c. Medication Regimen Diff (Added, Discontinued, Adjusted)
    for (const med of medications) {
      const authoredTime = med.authored_on ? new Date(med.authored_on).getTime() : 0;
      const endTime = med.end_date ? new Date(med.end_date).getTime() : 0;
      const medName = med.drug_name || med.name || "未知药品";
      const dose = med.dosage || med.dose || "";
      const route = med.route || "";
      const freq = med.frequency || "";
      const fullDose = [dose, route, freq].filter(Boolean).join(" ");
      const verbatimSpan = med.span || null;

      if (med.change_type === "added" || (authoredTime >= cutoffTime && med.status === "active" && !med.is_prior)) {
        changes.medication_diff.added.push({
          id: genId("MED-ADD"),
          category: ITEM_CATEGORIES.FACT,
          tag: CATEGORY_LABELS[ITEM_CATEGORIES.FACT],
          drug_name: medName,
          change_type: "新增用药",
          dosage_instruction: fullDose,
          summary: `新增: ${medName} ${fullDose}`,
          span: verbatimSpan,
          source_type: "MedicationRequest",
          source_id: med.id || "med-add",
          source_title: "医嘱单",
          timestamp: med.authored_on || new Date().toISOString(),
        });
      } else if (med.change_type === "discontinued" || (endTime >= cutoffTime && (med.status === "stopped" || med.status === "cancelled"))) {
        changes.medication_diff.discontinued.push({
          id: genId("MED-DISC"),
          category: ITEM_CATEGORIES.FACT,
          tag: CATEGORY_LABELS[ITEM_CATEGORIES.FACT],
          drug_name: medName,
          change_type: "停用医嘱",
          dosage_instruction: fullDose,
          reason: med.stop_reason || "医嘱停止",
          summary: `停用: ${medName} ${fullDose} (${med.stop_reason || "按期停止"})`,
          span: verbatimSpan,
          source_type: "MedicationRequest",
          source_id: med.id || "med-stop",
          source_title: "医嘱单",
          timestamp: med.end_date || new Date().toISOString(),
        });
      } else if (med.change_type === "adjusted" || med.previous_dosage) {
        changes.medication_diff.adjusted.push({
          id: genId("MED-ADJ"),
          category: ITEM_CATEGORIES.FACT,
          tag: CATEGORY_LABELS[ITEM_CATEGORIES.FACT],
          drug_name: medName,
          change_type: "剂量调整",
          summary: `调量: ${medName} ${med.previous_dosage} → ${fullDose}`,
          span: verbatimSpan,
          source_type: "MedicationRequest",
          source_id: med.id || "med-adj",
          source_title: "医嘱单",
          timestamp: med.authored_on || new Date().toISOString(),
        });
      }
    }

    // ----------------------------------------------------
    // BLOCK 2: 「今天仍待处理什么」 (What's Pending)
    // ----------------------------------------------------
    const pending = {
      pending_reports: [],
      pending_orders: [],
      scheduled_consults: [],
    };

    for (const rep of diagnosticReports) {
      if (rep.status === "registered" || rep.status === "preliminary" || rep.status === "pending") {
        pending.pending_reports.push({
          id: genId("REP-PEND"),
          category: ITEM_CATEGORIES.FACT,
          tag: CATEGORY_LABELS[ITEM_CATEGORIES.FACT],
          report_name: rep.name || rep.title || "待回报检查",
          category_type: rep.category || "PACS/LIS",
          requested_time: rep.ordered_at || rep.timestamp || new Date().toISOString(),
          status_desc: rep.status === "registered" ? "已送检/已采标本，等待检验报告" : "检查已完成，待出正式报告",
          summary: `待出报告: ${rep.name || rep.title} (${rep.status === "registered" ? "标本检验中" : "待出报告"})`,
          span: rep.span || null,
          source_type: "DiagnosticReport",
          source_id: rep.id || "rep-pend",
          source_title: "检查预约系统",
        });
      }
    }

    for (const ord of orders) {
      if (ord.status === "draft" || ord.status === "active" || ord.status === "pending_execution") {
        if (ord.order_type === "consult" || /会诊/.test(ord.title || "")) {
          pending.scheduled_consults.push({
            id: genId("ORD-CON"),
            category: ITEM_CATEGORIES.FACT,
            tag: CATEGORY_LABELS[ITEM_CATEGORIES.FACT],
            consult_department: ord.department || "专科会诊",
            purpose: ord.purpose || ord.title || "专科评估",
            summary: `待办会诊: ${ord.department || "专科"}会诊 (${ord.purpose || ord.title || "专科评估"})`,
            span: ord.span || null,
            source_type: "ServiceRequest",
            source_id: ord.id || "ord-con",
            source_title: "会诊申请单",
          });
        } else {
          pending.pending_orders.push({
            id: genId("ORD-PEND"),
            category: ITEM_CATEGORIES.FACT,
            tag: CATEGORY_LABELS[ITEM_CATEGORIES.FACT],
            order_name: ord.title || ord.name || "待执行医嘱",
            order_type: ord.order_type || "临时医嘱",
            summary: `待执行医嘱: ${ord.title || ord.name} (${ord.scheduled_time || "今日待执行"})`,
            span: ord.span || null,
            source_type: "ServiceRequest",
            source_id: ord.id || "ord-pend",
            source_title: "医嘱执行单",
          });
        }
      }
    }

    // ----------------------------------------------------
    // BLOCK 3: 「哪些资料不足」 (Critical Safety & Data Gaps)
    // ----------------------------------------------------
    const gaps = [];

    // Check Allergy History
    if (allergies == null || (Array.isArray(allergies) && allergies.length === 0)) {
      let noteAllergyFound = false;
      for (const n of notes) {
        if (/过敏史|过敏/.test(n.text || "")) {
          noteAllergyFound = true;
          break;
        }
      }
      if (!noteAllergyFound) {
        gaps.push({
          id: genId("GAP-ALG"),
          category: ITEM_CATEGORIES.DATA_GAP,
          tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP],
          gap_type: "ALLERGY_MISSING",
          severity: "HIGH",
          title: "过敏史未明确记录",
          summary: "【资料不足】过敏史缺失：当前系统与病历中无任何过敏史记录。使用高敏/抗菌药物前需重点补问并补录。",
          clinical_action_needed: "查房时向患者或家属明确核实青霉素、头孢菌素等药物过敏史并补录入病历",
          source_type: "AuditGap",
          source_id: "gap-allergy",
          span: null,
        });
      }
    }

    // Check Renal Function (Scr / eGFR) in last 48 hours
    const scrObs = observations.find((o) => /(?:scr|肌酐|creatinine)/i.test(o.code || o.name || ""));
    if (!scrObs) {
      gaps.push({
        id: genId("GAP-RENAL"),
        category: ITEM_CATEGORIES.DATA_GAP,
        tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP],
        gap_type: "RENAL_FUNCTION_MISSING",
        severity: "MEDIUM",
        title: "近期肾功能检验缺失",
        summary: "【资料不足】肾功能缺失：近 48 小时未查见血肌酐/eGFR 检验。无法精确进行肾功能梯度剂量评估。",
        clinical_action_needed: "若病情需要调整肾排泄药物，建议开具生化全套或急诊肾功能",
        source_type: "AuditGap",
        source_id: "gap-renal",
        span: null,
      });
    }

    // Check Patient Weight (especially crucial for pediatric / aminoglycosides / heparin)
    if (!patient.weight_kg && !patient.weightKg) {
      gaps.push({
        id: genId("GAP-WT"),
        category: ITEM_CATEGORIES.DATA_GAP,
        tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP],
        gap_type: "WEIGHT_MISSING",
        severity: "LOW",
        title: "入院体重未录入",
        summary: "【资料不足】入院体重未录入：缺少实际测量体重，无法精确按体表面积或体重换算剂量。",
        clinical_action_needed: "护士站补录患者入院体重",
        source_type: "AuditGap",
        source_id: "gap-weight",
        span: null,
      });
    }

    // ----------------------------------------------------
    // BLOCK 4: 「查看原始证据」 (Source Attribution & Raw Spans)
    // ----------------------------------------------------
    const allItems = [
      ...changes.clinical_symptoms,
      ...changes.abnormal_labs,
      ...changes.medication_diff.added,
      ...changes.medication_diff.discontinued,
      ...changes.medication_diff.adjusted,
      ...pending.pending_reports,
      ...pending.pending_orders,
      ...pending.scheduled_consults,
      ...gaps,
    ];

    const evidenceList = allItems.map((item) => ({
      item_id: item.id,
      category: item.category,
      tag: item.tag,
      title: item.title || item.test_name || item.drug_name || item.report_name || item.order_name || "临床事实",
      span: item.span || null,
      source_type: item.source_type,
      source_id: item.source_id,
      source_title: item.source_title || "病历与检验系统",
      timestamp: item.timestamp || null,
    }));

    return {
      patient: {
        id: patient.id || "UNKNOWN-PATIENT",
        name: patient.name || "未命名患者",
        gender: patient.gender || patient.sex_cn || "未知",
        age: patient.age || null,
        bed_number: patient.bed_number || "未分配床位",
        admission_date: patient.admission_date || null,
        primary_diagnosis: patient.primary_diagnosis || patient.diagnosis || "待录入主诊断",
      },
      time_window: timeWindow,
      generated_at: new Date().toISOString(),
      blocks: {
        what_changed: changes,
        whats_pending: pending,
        data_gaps: gaps,
        evidence: evidenceList,
      },
      total_items_count: allItems.length,
      selectable_items: allItems,
    };
  }

  /**
   * Generate Structured Inpatient Progress Note Draft for Physician Review.
   * Only includes items explicitly confirmed/selected by the physician.
   */
  static generateProgressNoteDraft({
    summaryData = {},
    selectedItemIds = [],
    doctorId = "DOC-8021",
    doctorName = "住院医师",
    customAdditions = "",
  }) {
    const allItems = summaryData.selectable_items || [];
    const selectedSet = new Set(selectedItemIds);
    const chosen = allItems.filter((i) => selectedSet.has(i.id));

    const symItems = chosen.filter((i) => i.id.startsWith("SYM"));
    const labItems = chosen.filter((i) => i.id.startsWith("LAB"));
    const medAdd = chosen.filter((i) => i.id.startsWith("MED-ADD"));
    const medDisc = chosen.filter((i) => i.id.startsWith("MED-DISC"));
    const medAdj = chosen.filter((i) => i.id.startsWith("MED-ADJ"));
    const repItems = chosen.filter((i) => i.id.startsWith("REP"));
    const ordItems = chosen.filter((i) => i.id.startsWith("ORD"));
    const gapItems = chosen.filter((i) => i.id.startsWith("GAP"));

    const lines = [];
    const dateStr = new Date().toISOString().replace("T", " ").slice(0, 16);
    lines.push(`【日常查房记录 - 病情演变摘要】`);
    lines.push(`记录时间：${dateStr}    查房医师：${doctorName} (${doctorId})`);
    lines.push(`患者姓名：${summaryData.patient?.name || '患者'}  床号：${summaryData.patient?.bed_number || '床位'}`);
    lines.push("");

    if (symItems.length > 0) {
      lines.push(`一、今日病情变化与症状演变：`);
      for (const it of symItems) lines.push(`  - ${it.summary} [出处：${it.source_title}]`);
      lines.push("");
    }

    if (labItems.length > 0) {
      lines.push(`二、主要异常检验及指标趋势：`);
      for (const it of labItems) lines.push(`  - ${it.test_name}: ${it.current_value} ${it.unit} (${it.delta_summary}) [出处：${it.source_title}]`);
      lines.push("");
    }

    if (medAdd.length > 0 || medDisc.length > 0 || medAdj.length > 0) {
      lines.push(`三、今日医嘱与用药方案调整：`);
      for (const it of medAdd) lines.push(`  - ${it.summary}`);
      for (const it of medDisc) lines.push(`  - ${it.summary}`);
      for (const it of medAdj) lines.push(`  - ${it.summary}`);
      lines.push("");
    }

    if (repItems.length > 0 || ordItems.length > 0) {
      lines.push(`四、今日待办检查与追踪事项：`);
      for (const it of repItems) lines.push(`  - ${it.summary}`);
      for (const it of ordItems) lines.push(`  - ${it.summary}`);
      lines.push("");
    }

    if (gapItems.length > 0) {
      lines.push(`五、已知临床资料缺口提示：`);
      for (const it of gapItems) lines.push(`  - ${it.title}: ${it.clinical_action_needed || it.summary}`);
      lines.push("");
    }

    if (customAdditions && customAdditions.trim()) {
      lines.push(`六、医师补充记录：`);
      lines.push(`  ${customAdditions.trim()}`);
      lines.push("");
    }

    lines.push(`---`);
    lines.push(`电子签名认证：${doctorName} (${doctorId})    状态：草稿已生成，待写入 EHR 查房病程`);

    return {
      draft_text: lines.join("\n"),
      selected_count: chosen.length,
      doctor_id: doctorId,
      doctor_name: doctorName,
      created_at: new Date().toISOString(),
    };
  }
}
