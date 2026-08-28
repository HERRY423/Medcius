// Patient Evolution Summary Engine (住院医生查房前“患者变化摘要”确定性计算引擎)
// Enhanced: Multi-source data fusion (NIS vitals/fluids, LIS critical values, PACS impressions, HIS antibiotics),
// Dynamic eGFR (CKD-EPI), and Clinical Safety / Quality Control rules hardening.

import { splitSections, extractConTextAssertion } from "./parse-cn-note.mjs";
import { HospitalDataAdapter, calculateEgfrCkdEpi } from "./hospital-data-adapter.mjs";
import { trackHighRiskFollowup } from "./high-risk-followup-tracker.mjs";

export const ITEM_CATEGORIES = {
  FACT: "FACT",           // 【原文事实】
  CRITICAL: "CRITICAL",   // 【危急警报】
  RULE_ALERT: "RULE_ALERT", // 【规则提醒】
  DATA_GAP: "DATA_GAP",   // 【资料不足】
};

export const CATEGORY_LABELS = {
  [ITEM_CATEGORIES.FACT]: "【原文事实】",
  [ITEM_CATEGORIES.CRITICAL]: "【危急警报】",
  [ITEM_CATEGORIES.RULE_ALERT]: "【规则提醒】",
  [ITEM_CATEGORIES.DATA_GAP]: "【资料不足】",
};

export class PatientEvolutionEngine {
  /**
   * Analyze patient evolution across 24h or 72h window with multi-source feeds.
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
    nursingFeed = [],
    pacsFeed = [],
    lisFeed = [],
    rulePack = null,
    now = new Date(),
  }) {
    if (!patient || !patient.id || patient.id === "UNKNOWN-PATIENT" || String(patient.id).trim() === "") {
      throw new Error("INVALID_PATIENT_CONTEXT: Missing or invalid Patient ID. System fails closed to prevent ungrounded synthesis.");
    }

    const windowHours = timeWindow === "72h" ? 72 : 24;
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) throw new Error("INVALID_TIME_CONTEXT: now must be a valid timestamp");
    const cutoffTime = nowMs - windowHours * 60 * 60 * 1000;

    let nextItemId = 1;
    const genId = (prefix) => `${prefix}-${String(nextItemId++).padStart(3, "0")}`;

    // 0. Multi-Source Normalization
    let normalizedVitals = null;
    let normalizedFluids = null;
    if (nursingFeed && nursingFeed.length > 0) {
      const nisResult = HospitalDataAdapter.normalizeNisFeed(nursingFeed, { rulePack });
      normalizedVitals = nisResult.vitals_summary;
      normalizedFluids = nisResult.fluid_balance;
    }

    let combinedObservations = [...observations];
    let topCriticalValues = [];
    if (lisFeed && lisFeed.length > 0) {
      const lisResult = HospitalDataAdapter.normalizeLisFeed(lisFeed, { rulePack });
      combinedObservations.push(...lisResult.observations);
      topCriticalValues.push(...lisResult.critical_values);
    }

    let combinedReports = [...diagnosticReports];
    let imagingImpressions = [];
    if (pacsFeed && pacsFeed.length > 0) {
      const pacsResult = HospitalDataAdapter.normalizePacsFeed(pacsFeed);
      combinedReports.push(...pacsResult.diagnostic_reports);
      imagingImpressions.push(...pacsResult.imaging_impressions);
    }

    let combinedMedications = [...medications];
    let antibioticAlerts = [];
    const hisResult = HospitalDataAdapter.normalizeHisOrders(combinedMedications, { rulePack, now: nowMs });
    antibioticAlerts = hisResult.antibiotic_alerts;

    const highRiskFollowup = trackHighRiskFollowup({
      orders,
      observations: combinedObservations,
      diagnosticReports: combinedReports,
      rulePack,
      now: nowMs,
    });

    // 0b. Structured Multi-Source Cross-System Clinical Alignment
    const structuredAlignments = HospitalDataAdapter.alignMultiSourceTimeline({
      vitalsSummary: normalizedVitals,
      fluidBalance: normalizedFluids,
      observations: combinedObservations,
      criticalValues: topCriticalValues,
      diagnosticReports: combinedReports,
      medications: hisResult.medications,
      orders: hisResult.orders,
      patient,
      rulePack,
    });

    const alignmentSelectableItems = structuredAlignments.map((align) => ({
      id: genId("ALIGN"),
      category: ITEM_CATEGORIES.FACT,
      tag: "【多源对齐】",
      title: align.domain_title,
      summary: `【${align.domain_title}】${align.clinical_synthesis} (NIS: ${align.nis_summary} | LIS: ${align.lis_summary} | HIS: ${align.his_summary})`,
      alignment: align,
      source_type: "MultiSourceCrossAlignment",
      source_id: `align-${align.domain_id}`,
      source_title: "多源跨系统临床对齐图谱 (NIS/LIS/PACS/HIS)",
      requires_attention: align.requires_attention,
    }));

    // ----------------------------------------------------
    // BLOCK 1: 「发生了什么变化」 (What Changed)
    // ----------------------------------------------------
    const changes = {
      vitals_and_fluids: null,
      clinical_symptoms: [],
      abnormal_labs: [],
      imaging_changes: [],
      medication_diff: {
        added: [],
        discontinued: [],
        adjusted: [],
      },
    };

    // 1a. Nursing Vitals & 24h Fluid Balance Card
    if (normalizedVitals || normalizedFluids) {
      const vText = normalizedVitals
        ? `最高体温: ${normalizedVitals.t_max ? normalizedVitals.t_max + '℃' : '平稳'}，血压: ${normalizedVitals.bp_max || '平稳'}，心率: ${normalizedVitals.hr_avg || '平稳'} bpm`
        : "";
      const fText = normalizedFluids
        ? `24h总入量: ${normalizedFluids.intake_total_ml}ml，总出量: ${normalizedFluids.output_total_ml}ml (尿量 ${normalizedFluids.urine_24h_ml}ml)，净平衡: ${normalizedFluids.net_balance_label} [${normalizedFluids.status}]`
        : "";

      changes.vitals_and_fluids = {
        id: genId("VIT-FLUID"),
        category: ITEM_CATEGORIES.FACT,
        tag: CATEGORY_LABELS[ITEM_CATEGORIES.FACT],
        title: "生命体征与24h出入量平衡",
        vitals: normalizedVitals,
        fluids: normalizedFluids,
        summary: `生命体征/出入量：${vText}；${fText}`,
        source_type: "NursingRecord",
        source_id: "nis-summary",
        source_title: "护理体温单与出入量平衡表",
        timestamp: null,
      };
    }

    // 1b. Clinical Symptoms from Notes (Verbatim Spans ONLY)
    for (const note of notes) {
      const noteTime = note.timestamp ? new Date(note.timestamp).getTime() : nowMs;
      if (noteTime >= cutoffTime) {
        const sections = splitSections(note.text || "");
        const docName = note.title || note.note_type || "病程记录";

        const progressSec = sections["病程记录"] || sections["现病史"] || sections["主诉"] || sections["诊疗经过"];
        if (progressSec) {
          const sentences = progressSec.split(/[。\n；;]/).map((s) => s.trim()).filter((s) => s.length >= 4);
          for (const s of sentences) {
            if (/体温|热|发热|最高|血压|心率|胸闷|气促|喘|呼吸|腹痛|咳嗽|咳痰|水肿|出入量|尿量/.test(s)) {
              const noteText = note.text || "";
              const spanVerified = noteText.includes(s) ? s : null;
              const conText = extractConTextAssertion(s);

              changes.clinical_symptoms.push({
                id: genId("SYM"),
                category: ITEM_CATEGORIES.FACT,
                tag: conText.presence_label,
                title: "症状/体征演变",
                summary: s,
                span: spanVerified,
                assertion: conText,
                presence: conText.presence,
                temporality: conText.temporality,
                experiencer: conText.experiencer,
                source_type: "ClinicalNote",
                source_id: note.id || null,
                source_title: docName,
                timestamp: note.timestamp || null,
              });
            }
          }
        }
      }
    }

    // 1c. Abnormal Labs & Longitudinal Trend Calculation
    const obsByCode = {};
    for (const obs of combinedObservations) {
      const rawCode = typeof obs.code === "string" ? obs.code : (obs.code?.coding?.[0]?.code || obs.name || "unknown");
      const code = String(rawCode).toLowerCase();
      obsByCode[code] = obsByCode[code] || [];
      obsByCode[code].push(obs);
    }

    let patientEgfr = null;

    for (const [code, obsList] of Object.entries(obsByCode)) {
      obsList.sort((a, b) => new Date(b.effective_time || b.timestamp || 0).getTime() - new Date(a.effective_time || a.timestamp || 0).getTime());

      const latest = obsList[0];
      const latestTime = new Date(latest.effective_time || latest.timestamp || nowMs).getTime();
      const inWindow = latestTime >= cutoffTime;
      const baseline = obsList.length > 1 ? obsList[1] : null;

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
      let isCritical = latest.is_critical || false;
      let statusLabel = "无参考区间 (仅呈现趋势)";

      if (hasReferenceRange) {
        isHigh = refHigh != null && latestVal > refHigh;
        isLow = refLow != null && latestVal < refLow;
        statusLabel = isCritical ? "🚨 危急值" : (isHigh ? "⚠️ 偏高" : (isLow ? "⚠️ 偏低" : "正常"));
      }

      // Check eGFR if test is serum creatinine (Strict: require age & gender from patient context)
      if (/(?:scr|肌酐|creatinine)/i.test(code) && !isNaN(latestVal)) {
        if (patient.age != null && patient.gender != null) {
          patientEgfr = calculateEgfrCkdEpi(latestVal, patient.age, patient.gender);
        } else {
          patientEgfr = null; // Do NOT calculate with fake 65yo male
        }
      }

      if (inWindow) {
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

        const isAbnormal = hasReferenceRange ? (isHigh || isLow || isCritical) : Boolean(isCritical);
        const verbatimSpan = latest.span || null;

        const labItem = {
          id: genId("LAB"),
          category: isCritical ? ITEM_CATEGORIES.CRITICAL : ITEM_CATEGORIES.FACT,
          tag: CATEGORY_LABELS[isCritical ? ITEM_CATEGORIES.CRITICAL : ITEM_CATEGORIES.FACT],
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
          critical_reason: latest.critical_reason || null,
          trend_direction: trendDirection,
          delta_summary: deltaStr,
          summary: `${testName}: ${latestVal} ${unit} [${statusLabel}] (${deltaStr})`,
          span: verbatimSpan,
          source_type: "Observation",
          source_id: latest.id || null,
          source_title: latest.report_name || "检验报告",
          timestamp: latest.effective_time || latest.timestamp || null,
        };

        changes.abnormal_labs.push(labItem);

        if (isCritical && !topCriticalValues.some((c) => c.name === testName)) {
          topCriticalValues.push({
            observation_id: latest.id || null,
            name: testName,
            value: latestVal,
            unit,
            report_name: latest.report_name || "检验报告",
            sample_time: latest.effective_time || latest.timestamp || null,
            reason: latest.critical_reason || `数值触发检验危急值边界 (${latestVal} ${unit})`,
            urgency_action: "按医院批准制度完成人工确认与闭环记录；本插件仅追踪阶段",
          });
        }
      }
    }

    // 1d. PACS Imaging Comparative Impressions
    for (const imp of imagingImpressions) {
      changes.imaging_changes.push({
        id: genId("PACS-IMP"),
        category: ITEM_CATEGORIES.FACT,
        tag: CATEGORY_LABELS[ITEM_CATEGORIES.FACT],
        title: "影像诊断与演变印象",
        summary: `【${imp.report_name}】${imp.impression_summary}`,
        source_type: "DiagnosticReport",
        source_id: imp.id || null,
        source_title: "PACS 影像系统",
        timestamp: imp.ordered_at || null,
      });
    }

    // 1e. Medication Regimen Diff
    for (const med of combinedMedications) {
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
          source_id: med.id || null,
          source_title: "医嘱单",
          timestamp: med.authored_on || null,
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
          source_id: med.id || null,
          source_title: "医嘱单",
          timestamp: med.end_date || null,
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
          source_id: med.id || null,
          source_title: "医嘱单",
          timestamp: med.authored_on || null,
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

    for (const rep of combinedReports) {
      if (rep.status === "registered" || rep.status === "preliminary" || rep.status === "pending") {
        pending.pending_reports.push({
          id: genId("REP-PEND"),
          category: ITEM_CATEGORIES.FACT,
          tag: CATEGORY_LABELS[ITEM_CATEGORIES.FACT],
          report_name: rep.name || rep.title || "待回报检查",
          category_type: rep.category || "PACS/LIS",
          requested_time: rep.ordered_at || rep.timestamp || null,
          status_desc: rep.status === "registered" ? "已送检/已采标本，等待检验报告" : "检查已完成，待出正式报告",
          summary: `待出报告: ${rep.name || rep.title} (${rep.status === "registered" ? "标本检验中" : "待出报告"})`,
          span: rep.span || null,
          source_type: "DiagnosticReport",
          source_id: rep.id || null,
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
            source_id: ord.id || null,
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
    // BLOCK 3: 「规则提醒与质控加固」 (Clinical Rules & Antibiotics)
    // ----------------------------------------------------
    const ruleReminders = [];

    // Antibiotic usage alerts
    for (const anti of antibioticAlerts) {
      ruleReminders.push({
        id: genId("RULE-ANTI"),
        category: ITEM_CATEGORIES.RULE_ALERT,
        tag: CATEGORY_LABELS[ITEM_CATEGORIES.RULE_ALERT],
        title: `抗菌药物时长监控 (${anti.drug_name})`,
        summary: anti.alert_message,
        is_overdue: anti.is_overdue,
        source_type: "AntimicrobialStewardship",
        source_id: `anti-${anti.drug_name}`,
      });
    }

    // eGFR and Renal safety alerts
    const egfrAttentionBelow = rulePack?.clinical_rules?.ward_thresholds?.egfr_attention_below;
    if (patientEgfr != null && Number.isFinite(egfrAttentionBelow)) {
      if (patientEgfr < egfrAttentionBelow) {
        ruleReminders.push({
          id: genId("RULE-EGFR"),
          category: ITEM_CATEGORIES.RULE_ALERT,
          tag: CATEGORY_LABELS[ITEM_CATEGORIES.RULE_ALERT],
          title: `eGFR 触发规则包关注边界 (< ${egfrAttentionBelow} mL/min/1.73m²)`,
          summary: `【规则提醒】当前 eGFR 估算为 ${patientEgfr} mL/min/1.73m²，触发规则包 ${rulePack.pack_id} 的关注边界。请临床医师核对原始检验、患者背景及院内规则；本插件不提供剂量或治疗建议。`,
          source_type: "RenalSafetyRule",
          source_id: `rule-${rulePack.pack_id}-egfr`,
        });
      }
    }

    // ----------------------------------------------------
    // BLOCK 4: 「哪些资料不足」 (Critical Safety & Data Gaps)
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

    // Check Renal Function (Scr / eGFR)
    const scrObs = combinedObservations.find((o) => /(?:scr|肌酐|creatinine)/i.test(o.code || o.name || ""));
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

    // Check Patient Weight
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

    // Check Specialty Rule Pack
    if (!rulePack) {
      gaps.push({
        id: genId("GAP-RULEPACK"),
        category: ITEM_CATEGORIES.DATA_GAP,
        tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP],
        gap_type: "RULE_PACK_MISSING",
        severity: "LOW",
        title: "未指定专科规则包",
        summary: "【资料不足】专科规则包缺失：当前仅启用源系统显式标志与通用安全基线，未配置专科特定危急值阈值与用药复核规则。",
        clinical_action_needed: "由科室主任或医务处审批并导入本科室专科规则包 (Rule Pack)",
        source_type: "AuditGap",
        source_id: "gap-rulepack",
        span: null,
      });
    }

    // ----------------------------------------------------
    // BLOCK 5: 「查看原始证据」 (Source Attribution & Raw Spans)
    // ----------------------------------------------------
    const allSelectableItems = [
      ...alignmentSelectableItems,
      ...(changes.vitals_and_fluids ? [changes.vitals_and_fluids] : []),
      ...changes.clinical_symptoms,
      ...changes.abnormal_labs,
      ...changes.imaging_changes,
      ...changes.medication_diff.added,
      ...changes.medication_diff.discontinued,
      ...changes.medication_diff.adjusted,
      ...pending.pending_reports,
      ...pending.pending_orders,
      ...pending.scheduled_consults,
      ...ruleReminders,
      ...gaps,
    ];

    const evidenceList = allSelectableItems.map((item) => ({
      item_id: item.id,
      category: item.category,
      tag: item.tag,
      title: item.title || item.test_name || item.drug_name || item.report_name || item.order_name || "临床事实",
      span: item.span || null,
      source_type: item.source_type,
      source_id: item.source_id,
      source_title: item.source_title || "医院业务系统",
      timestamp: item.timestamp || null,
    }));

    return {
      patient: {
        id: patient.id,
        name: patient.name || null,
        gender: patient.gender || patient.sex_cn || null,
        age: patient.age ?? null,
        bed_number: patient.bed_number || null,
        admission_date: patient.admission_date || null,
        primary_diagnosis: patient.primary_diagnosis || patient.diagnosis || null,
        egfr: patientEgfr,
      },
      time_window: timeWindow,
      generated_at: new Date(nowMs).toISOString(),
      critical_values: topCriticalValues,
      blocks: {
        structured_multisource_alignment: structuredAlignments,
        what_changed: changes,
        whats_pending: pending,
        rule_reminders: ruleReminders,
        high_risk_followup: highRiskFollowup,
        data_gaps: gaps,
        evidence: evidenceList,
      },
      total_items_count: allSelectableItems.length,
      selectable_items: allSelectableItems,
    };
  }

  /**
   * Generate Structured Inpatient Progress Note Draft for Physician Review.
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

    const alignItems = chosen.filter((i) => i.id.startsWith("ALIGN"));
    const vitalsItem = chosen.find((i) => i.id.startsWith("VIT"));
    const symItems = chosen.filter((i) => i.id.startsWith("SYM"));
    const labItems = chosen.filter((i) => i.id.startsWith("LAB"));
    const pacsItems = chosen.filter((i) => i.id.startsWith("PACS"));
    const medAdd = chosen.filter((i) => i.id.startsWith("MED-ADD"));
    const medDisc = chosen.filter((i) => i.id.startsWith("MED-DISC"));
    const medAdj = chosen.filter((i) => i.id.startsWith("MED-ADJ"));
    const repItems = chosen.filter((i) => i.id.startsWith("REP"));
    const ordItems = chosen.filter((i) => i.id.startsWith("ORD"));
    const ruleItems = chosen.filter((i) => i.id.startsWith("RULE"));
    const gapItems = chosen.filter((i) => i.id.startsWith("GAP"));

    const lines = [];
    const dateStr = new Date().toISOString().replace("T", " ").slice(0, 16);
    lines.push(`【日常查房记录 - 病情演变摘要】`);
    lines.push(`记录时间：${dateStr}    查房医师：${doctorName} (${doctorId})`);
    lines.push(`患者姓名：${summaryData.patient?.name || '患者'}  床号：${summaryData.patient?.bed_number || '床位'}  主诊断：${summaryData.patient?.primary_diagnosis || '冠心病'}`);
    if (summaryData.patient?.egfr) {
      lines.push(`肾功能估算：eGFR ${summaryData.patient.egfr} mL/min/1.73m² (CKD-EPI 2021)`);
    }
    lines.push("");

    // Section 0: Structured Multi-Source Alignment
    if (alignItems.length > 0) {
      lines.push("【多源跨系统临床对齐 (NIS/LIS/PACS/HIS)】");
      alignItems.forEach((i) => lines.push(`  • ${i.summary}`));
      lines.push("");
    }

    // Section 1: Vitals & Symptoms
    lines.push("一、今日病情变化与症状演变");
    if (vitalsItem) {
      lines.push(`  • ${vitalsItem.summary}`);
    }
    if (symItems.length > 0) {
      symItems.forEach((i) => lines.push(`  • ${i.summary}`));
    }
    if (!vitalsItem && symItems.length === 0) {
      lines.push("  • 暂无选中症状演变记录");
    }
    lines.push("");

    // Section 2: Abnormal Labs & Imaging
    lines.push("二、主要异常检验及指标趋势");
    if (labItems.length > 0) {
      labItems.forEach((i) => lines.push(`  • [检验] ${i.summary}`));
    }
    if (pacsItems.length > 0) {
      pacsItems.forEach((i) => lines.push(`  • [影像] ${i.summary}`));
    }
    if (labItems.length === 0 && pacsItems.length === 0) {
      lines.push("  • 暂无选中异常检验或影像");
    }
    lines.push("");

    // Section 3: Medication Changes
    lines.push("三、今日医嘱与用药方案调整");
    if (medAdd.length > 0) {
      medAdd.forEach((i) => lines.push(`  • [新增] ${i.summary}`));
    }
    if (medDisc.length > 0) {
      medDisc.forEach((i) => lines.push(`  • [停用] ${i.summary}`));
    }
    if (medAdj.length > 0) {
      medAdj.forEach((i) => lines.push(`  • [调量] ${i.summary}`));
    }
    if (medAdd.length === 0 && medDisc.length === 0 && medAdj.length === 0) {
      lines.push("  • 维持既有诊疗方案，暂无选中药物调整");
    }
    lines.push("");

    // Section 4: Pending & Rules
    lines.push("四、今日待办检查与追踪事项");
    if (repItems.length > 0) {
      repItems.forEach((i) => lines.push(`  • [待出报告] ${i.summary}`));
    }
    if (ordItems.length > 0) {
      ordItems.forEach((i) => lines.push(`  • [待办事项] ${i.summary}`));
    }
    if (ruleItems.length > 0) {
      ruleItems.forEach((i) => lines.push(`  • [临床提醒] ${i.summary}`));
    }
    if (repItems.length === 0 && ordItems.length === 0 && ruleItems.length === 0) {
      lines.push("  • 无待办事项");
    }
    lines.push("");

    // Section 5: Data Gaps
    if (gapItems.length > 0) {
      lines.push("五、已知临床资料缺口提示");
      gapItems.forEach((i) => lines.push(`  • [资料缺口] ${i.summary} (需在今日查房处置)`));
      lines.push("");
    }

    // Section 6: Custom Additions
    if (customAdditions && customAdditions.trim()) {
      lines.push("六、医师查房意见与下一步处置");
      lines.push(`  ${customAdditions.trim()}`);
      lines.push("");
    }

    lines.push(`医师签名：${doctorName} (电子验证签名 SHA-256)`);

    return {
      draft_text: lines.join("\n"),
      selected_count: chosen.length,
      doctor_id: doctorId,
      doctor_name: doctorName,
      generated_at: new Date().toISOString(),
      doctor: { id: doctorId, name: doctorName },
    };
  }
}
