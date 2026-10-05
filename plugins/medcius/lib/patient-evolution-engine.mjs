// Patient Evolution Summary Engine (住院医生查房前“患者变化摘要”确定性计算引擎)
// Enhanced: Multi-source data fusion (NIS vitals/fluids, LIS critical values, PACS impressions, HIS antibiotics),
// Dynamic eGFR (CKD-EPI), and Clinical Safety / Quality Control rules hardening.

import { splitSections, extractConTextAssertion } from "./parse-cn-note.mjs";
import { HospitalDataAdapter, calculateEgfrCkdEpi, normalizeLabUnit } from "./hospital-data-adapter.mjs";
import { trackHighRiskFollowup } from "./high-risk-followup-tracker.mjs";
import { PostHocClaimVerifier } from "./post-hoc-verifier.mjs";
import { classifySourceTime } from "./clinical-boundary.mjs";
import { classifyRecordLifecycle, resolveRecordVersions, describeRecordLifecycle } from "./record-lifecycle.mjs";

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
    context = null,
    timeWindow = "24h", // '24h' | '72h'
    notes = [],
    observations = [],
    medications = [],
    diagnosticReports = [],
    orders = [],
    allergies = null,
    nursingFeed = [],
    nisFeed = [],
    pacsFeed = [],
    lisFeed = [],
    rulePack = null,
    sourceManifest = null,
    sourceAvailability = [],
    recordHistory = {},
    now = new Date(),
  }) {
    const patientId = patient?.id || context?.patient_id;
    if (!patientId || patientId === "UNKNOWN-PATIENT" || String(patientId).trim() === "") {
      throw new Error("INVALID_PATIENT_CONTEXT: Missing or invalid Patient ID. System fails closed to prevent ungrounded synthesis.");
    }

    if (context) {
      for (const field of ["tenant_id", "doctor_id", "patient_id", "encounter_id"]) {
        if (typeof context[field] !== "string" || !context[field].trim()) {
          throw new Error(`INVALID_CONTEXT_FAIL_CLOSED: Missing required context field '${field}'.`);
        }
      }
      if (patient.id && patient.id !== context.patient_id) {
        throw new Error(`CONTEXT_PATIENT_MISMATCH_FAIL_CLOSED: patient.id (${patient.id}) !== context.patient_id (${context.patient_id})`);
      }
    }

    if (timeWindow !== "24h" && timeWindow !== "72h") {
      throw new Error(`INVALID_TIME_WINDOW: Expected '24h' or '72h', got '${timeWindow}'. System fails closed.`);
    }

    const windowHours = timeWindow === "72h" ? 72 : 24;
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) throw new Error("INVALID_TIME_CONTEXT: now must be a valid timestamp");
    const cutoffTime = nowMs - windowHours * 60 * 60 * 1000;

    const assertFeedIdentity = (record, label) => {
      if (!record || typeof record !== "object") return;
      if (record.patient_id && record.patient_id !== patientId) {
        throw new Error(`FAIL_CLOSED_PATIENT_MISMATCH: ${label} ${record.id || ""} belongs to ${record.patient_id}, not ${patientId}`);
      }
      if (context?.encounter_id && record.encounter_id && record.encounter_id !== context.encounter_id) {
        throw new Error(`FAIL_CLOSED_ENCOUNTER_MISMATCH: ${label} ${record.id || ""} belongs to ${record.encounter_id}, not ${context.encounter_id}`);
      }
      if (context?.tenant_id && record.tenant_id && record.tenant_id !== context.tenant_id) {
        throw new Error(`FAIL_CLOSED_TENANT_MISMATCH: ${label} ${record.id || ""} belongs to ${record.tenant_id}, not ${context.tenant_id}`);
      }
    };
    for (const note of notes) assertFeedIdentity(note, "note");
    for (const obs of observations) assertFeedIdentity(obs, "observation");
    for (const med of medications) assertFeedIdentity(med, "medication");
    for (const report of diagnosticReports) assertFeedIdentity(report, "diagnostic_report");
    for (const order of orders) assertFeedIdentity(order, "order");
    for (const row of lisFeed) assertFeedIdentity(row, "lis");

    // Verify Source Manifest Hash Integrity if provided
    if (Array.isArray(sourceManifest)) {
      for (const entry of sourceManifest) {
        if (!entry.payload_sha256 || typeof entry.payload_sha256 !== "string") {
          throw new Error(`INVALID_SOURCE_MANIFEST_FAIL_CLOSED: Connector '${entry.connector_id || "unknown"}' missing payload_sha256.`);
        }
      }
    }

    let nextItemId = 1;
    const genId = (prefix) => `${prefix}-${String(nextItemId++).padStart(3, "0")}`;

    // 0. Multi-Source Normalization (F-04, F-05, F-06)
    let normalizedVitals = null;
    let normalizedFluids = null;
    let nisTimeGaps = [];
    const activeNis = (nursingFeed && nursingFeed.length > 0) ? nursingFeed : (nisFeed || []);
    if (activeNis && activeNis.length > 0) {
      for (const row of activeNis) assertFeedIdentity(row, "nis");
      const nisResult = HospitalDataAdapter.normalizeNisFeed(activeNis, { rulePack, cutoffTime, now: nowMs });
      normalizedVitals = nisResult.vitals_summary;
      normalizedFluids = nisResult.fluid_balance;
      nisTimeGaps = nisResult.data_gaps || [];
    }

    let combinedObservations = [...observations];
    let topCriticalValues = [];
    let adapterDataGaps = [];
    let observationHistory = [...(recordHistory.observations || [])];
    if (lisFeed && lisFeed.length > 0) {
      const lisResult = HospitalDataAdapter.normalizeLisFeed(lisFeed, { rulePack, cutoffTime, now: nowMs });
      combinedObservations.push(...lisResult.observations);
      observationHistory.push(...(lisResult.history_records || []));
      topCriticalValues.push(...lisResult.critical_values);
      if (lisResult.data_gaps?.length > 0) {
        adapterDataGaps.push(...lisResult.data_gaps);
      }
    }

    let combinedReports = [...diagnosticReports];
    let reportHistory = [...(recordHistory.diagnosticReports || [])];
    let imagingImpressions = [];
    let pacsTimeGaps = [];
    if (pacsFeed && pacsFeed.length > 0) {
      for (const row of pacsFeed) assertFeedIdentity(row, "pacs");
      const pacsResult = HospitalDataAdapter.normalizePacsFeed(pacsFeed, { cutoffTime, now: nowMs });
      combinedReports.push(...pacsResult.diagnostic_reports);
      reportHistory.push(...(pacsResult.history_records || []));
      imagingImpressions.push(...pacsResult.imaging_impressions);
      pacsTimeGaps = pacsResult.time_gaps || [];
    }

    let combinedMedications = [...medications];
    let antibioticAlerts = [];
    const hisResult = HospitalDataAdapter.normalizeHisOrders(combinedMedications, { rulePack, now: nowMs });
    antibioticAlerts = hisResult.antibiotic_alerts;
    const orderTimeGaps = hisResult.time_gaps || [];

    const gaps = [];
    const resolutions = [
      resolveRecordVersions([...observationHistory, ...combinedObservations], { sourceType: "observation", now: nowMs, cutoffTime }),
      resolveRecordVersions([...reportHistory, ...combinedReports], { sourceType: "diagnostic_report", now: nowMs, cutoffTime }),
      resolveRecordVersions([...(recordHistory.orders || []), ...orders], { sourceType: "order", now: nowMs, cutoffTime }),
      resolveRecordVersions(combinedMedications, { sourceType: "medication", now: nowMs, cutoffTime }),
      resolveRecordVersions([...(recordHistory.nis || []), ...activeNis], { sourceType: "nursing", now: nowMs, cutoffTime }),
      resolveRecordVersions(notes, { sourceType: "note", now: nowMs, cutoffTime }),
    ];
    // Keep every distinct version for follow-up, but do not count raw and
    // normalized representations of the same source version as a conflict.
    const highRiskFollowup = trackHighRiskFollowup({
      orders: resolutions[2].entries.map(({ record }) => record),
      observations: resolutions[0].entries.map(({ record }) => record),
      diagnosticReports: resolutions[1].entries.map(({ record }) => record),
      sourceAvailability,
      rulePack,
      now: nowMs,
      cutoffTime,
    });
    const usableResult = (record, sourceType) => !["cancelled", "entered_in_error"].includes(classifyRecordLifecycle(record, { sourceType, now: nowMs, cutoffTime }).result_status);
    combinedObservations = resolutions[0].current_records.filter((record) => usableResult(record, "observation"));
    combinedReports = resolutions[1].current_records;
    orders = resolutions[2].current_records;
    combinedMedications = resolutions[3].current_records;
    notes = resolutions[5].current_records.filter((record) => usableResult(record, "note"));
    topCriticalValues = topCriticalValues.filter((item) => combinedObservations.some((record) => record.id === item.observation_id
      && (record.version_id ?? record.meta?.versionId ?? null) === (item.version_id ?? null)));
    imagingImpressions = imagingImpressions.filter((item) => combinedReports.some((record) => record.id === item.id && usableResult(record, "diagnostic_report")
      && (record.version_id ?? record.meta?.versionId ?? null) === (item.version_id ?? null)));
    const changeItems = [];
    for (const entry of resolutions.flatMap((resolution) => resolution.entries)) {
      const { record, lifecycle: state, selection_status: selectionStatus } = entry;
      if (selectionStatus === "future" || selectionStatus === "conflict") gaps.push({
        id: genId("GAP-STATE"), category: ITEM_CATEGORIES.DATA_GAP, tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP],
        gap_type: selectionStatus === "conflict" ? "SOURCE_VERSION_CONFLICT" : state.source_type === "observation" ? "OBSERVATION_TIME_FUTURE" : state.source_type === "note" ? "NOTE_TIME_FUTURE" : "SOURCE_RECORD_TIME_FUTURE",
        severity: "MEDIUM", title: "来源状态不可作为当前事实", summary: selectionStatus === "conflict" ? "资源版本顺序或内容冲突，当前有效版本未知。" : "来源时间晚于复核时点，未纳入当前事实或闭环判断。",
        source_type: state.source_type, source_id: state.source_id, span: null, timestamp: state.change_time });
      const relevant = state.change_time_status === "in_window" || state.arrival_status === "late_record"
        || ["unknown", "invalid"].includes(state.change_time_status) || selectionStatus === "conflict" || selectionStatus === "future";
      if (!relevant) continue;
      if (state.source_type === "note" && !["revision", "cancellation", "entered_in_error"].includes(state.change_type)
          && state.arrival_status !== "late_record" && !["conflict", "future"].includes(selectionStatus)) continue;
      const label = record.name || record.title || record.test_name || record.study_name || record.drug_name || "来源记录";
      const explanation = selectionStatus === "superseded" ? " 已被本次可用的后续版本替代，不参与当前数值比较。"
        : selectionStatus === "conflict" ? " 同一资源版本顺序或内容冲突，当前版本未知。"
        : selectionStatus === "future" ? " 来源时间晚于复核时点，未作为当前事实。" : "";
      changeItems.push({ id: genId("CHANGE"), category: ITEM_CATEGORIES.FACT, tag: "【记录变化】", ...state,
        selection_status: selectionStatus, title: label, timestamp: state.change_time, span: record.span || null,
        summary: describeRecordLifecycle(state, label) + explanation,
        display_text: describeRecordLifecycle(state, label) + explanation });
    }
    const recordChanges = { items: changeItems, counts: Object.fromEntries(["new_result", "revision", "cancellation", "entered_in_error", "preliminary_result", "unknown", "late_record"].map((kind) =>
      [kind, changeItems.filter((item) => {
        if (["superseded", "future"].includes(item.selection_status)) return false;
        if (kind === "unknown") return item.change_type === "unknown" || item.selection_status === "conflict";
        if (item.selection_status !== "current") return false;
        if (kind === "late_record") return item.arrival_status === kind;
        return item.change_type === kind && (kind !== "new_result" || item.change_time_status === "in_window");
      }).length])) };
    for (const source of sourceAvailability) {
      if (source.status === "available") continue;
      const descriptions = { unavailable: "接口不可用，本次未能读取该来源；无法判断是否存在结果或未闭环事项。",
        unknown: "来源完整性或记录归属无法确认；无法判断是否存在结果或未闭环事项。",
        available_empty: "接口读取成功，本次返回零条记录；不等于未做检查、无异常或已闭环。" };
      gaps.push({ id: genId("GAP-SOURCE"), category: ITEM_CATEGORIES.DATA_GAP, tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP],
        gap_type: `SOURCE_${String(source.status).toUpperCase()}`, title: `${source.kind || "数据"}来源状态`, severity: "MEDIUM",
        summary: descriptions[source.status] || "来源状态未知。", source_type: "SourceAvailability", source_id: source.connector_id || null,
        source_status: source.status, timestamp: source.fetched_at || null, span: null });
    }
    for (const gap of [...nisTimeGaps, ...pacsTimeGaps, ...orderTimeGaps]) {
      gaps.push({
        id: genId("GAP"),
        category: ITEM_CATEGORIES.DATA_GAP,
        tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP],
        gap_type: gap.gap_type || "SOURCE_TIME_GAP",
        severity: gap.severity || "MEDIUM",
        title: gap.title || "来源时间不足",
        summary: gap.summary || "来源时间未知或落在窗口外，未当作当前事实。",
        source_type: gap.source_type || "AuditGap",
        source_id: gap.source_id || null,
        span: null,
        timestamp: null,
      });
    }

    // 0b. Structured Multi-Source Cross-System Clinical Alignment
    const structuredAlignments = HospitalDataAdapter.alignMultiSourceTimeline({
      vitalsSummary: normalizedVitals,
      fluidBalance: normalizedFluids,
      observations: combinedObservations.filter((record) => classifyRecordLifecycle(record, { sourceType: "observation", now: nowMs, cutoffTime }).event_time_status === "in_window"),
      criticalValues: topCriticalValues,
      diagnosticReports: combinedReports.filter((record) => {
        const state = classifyRecordLifecycle(record, { sourceType: "diagnostic_report", now: nowMs, cutoffTime });
        return ["final", "preliminary", "revised"].includes(state.result_status) && state.event_time_status === "in_window";
      }),
      medications: hisResult.current_medications,
      orders: hisResult.current_orders,
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
        ? `最高体温: ${normalizedVitals.t_max != null ? normalizedVitals.t_max + '℃' : '未提供'}，血压: ${normalizedVitals.bp_max || '未提供'}，心率: ${normalizedVitals.hr_avg ?? '未提供'} bpm`
        : "";
      const fText = normalizedFluids
        ? `窗口内已记录入量: ${normalizedFluids.intake_total_ml ?? '未提供'}ml，出量: ${normalizedFluids.output_total_ml ?? '未提供'}ml (尿量 ${normalizedFluids.urine_24h_ml ?? '未提供'}ml)，净平衡: ${normalizedFluids.net_balance_label} [${normalizedFluids.status}]`
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
      const noteEventTime = note.event_time || note.timing?.t_event || note.effective_time || note.timestamp;
      const noteTime = classifySourceTime(noteEventTime, { nowMs, cutoffMs: cutoffTime });
      if (noteTime.status !== "in_window") {
        gaps.push({
          id: genId("GAP"),
          category: ITEM_CATEGORIES.DATA_GAP,
          tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP],
          gap_type: `NOTE_TIME_${noteTime.status.toUpperCase()}`,
          severity: "MEDIUM",
          title: "病程时间不可用",
          summary: `病程记录 ${note.id || ""} 的时间为 ${noteTime.status}，未纳入当前窗口症状。`,
          source_type: "ClinicalNote",
          source_id: note.id || null,
          span: null,
          timestamp: noteEventTime || null,
        });
        continue;
      }
      {
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
                timestamp: noteEventTime || null,
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

    for (const [code, groupedObservations] of Object.entries(obsByCode)) {
      const obsList = [];
      for (const observation of groupedObservations) {
        const observationTime = observation.effective_time || observation.timestamp || null;
        const classification = classifySourceTime(observationTime, { nowMs, cutoffMs: cutoffTime });
        if (["unknown", "invalid", "future"].includes(classification.status)) {
          gaps.push({ id: genId("GAP"), category: ITEM_CATEGORIES.DATA_GAP, tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP],
            gap_type: `OBSERVATION_TIME_${classification.status.toUpperCase()}`, severity: "MEDIUM", title: "检验时间不可用",
            summary: `${observation.display_name || observation.name || code} 的检验时间为 ${classification.status}，未纳入当前窗口或历史对比。`,
            source_type: "Observation", source_id: observation.id || null, span: null, timestamp: observationTime });
        } else obsList.push(observation);
      }
      if (!obsList.length) continue;
      obsList.sort((a, b) => new Date(b.effective_time || b.timestamp || 0).getTime() - new Date(a.effective_time || a.timestamp || 0).getTime());

      const latest = obsList[0];
      const sourceTime = latest.effective_time || latest.timestamp || null;
      const timeClass = classifySourceTime(sourceTime, { nowMs, cutoffMs: cutoffTime });
      if (timeClass.status === "unknown" || timeClass.status === "invalid" || timeClass.status === "future") {
        gaps.push({
          id: genId("GAP"),
          category: ITEM_CATEGORIES.DATA_GAP,
          tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP],
          gap_type: `OBSERVATION_TIME_${timeClass.status.toUpperCase()}`,
          severity: "MEDIUM",
          title: "检验时间不可用",
          summary: `${latest.display_name || latest.name || code} 的检验时间为 ${timeClass.status}，未纳入当前窗口，也未据此计算 eGFR。`,
          source_type: "Observation",
          source_id: latest.id || null,
          span: null,
          timestamp: sourceTime,
        });
        continue;
      }
      const inWindow = timeClass.status === "in_window";
      const baseline = obsList.length > 1 ? obsList[1] : null;
      const resultLifecycle = resolutions[0].entries.find((entry) => entry.record === latest)?.lifecycle
        || classifyRecordLifecycle(latest, { sourceType: "observation", now: nowMs, cutoffTime });

      const latestVal = latest.value == null || typeof latest.value === "boolean" || String(latest.value).trim() === "" ? NaN : Number(latest.value);
      const testName = latest.display_name || latest.name || code;
      const unit = latest.unit || "";
      const fhirRef = Array.isArray(latest.referenceRange) ? latest.referenceRange[0] : latest.referenceRange;
      const rawRefLow = fhirRef?.low?.value ?? latest.ref_low ?? null;
      const rawRefHigh = fhirRef?.high?.value ?? latest.ref_high ?? null;
      const referenceValue = (value, referenceUnit) => {
        if (value == null || typeof value === "boolean" || String(value).trim() === "") return null;
        return normalizeLabUnit(Number(value), referenceUnit, unit, code).comparableValue;
      };
      const refLow = referenceValue(rawRefLow, fhirRef?.low?.unit ?? unit);
      const refHigh = referenceValue(rawRefHigh, fhirRef?.high?.unit ?? unit);
      const referenceInvalid = (rawRefLow != null && refLow == null) || (rawRefHigh != null && refHigh == null)
        || (refLow != null && refHigh != null && refLow > refHigh);
      const refText = fhirRef?.text ?? latest.ref_text ?? latest.reference_range ?? null;
      const hasReferenceRange = !referenceInvalid && (refLow != null || refHigh != null);
      if (referenceInvalid) gaps.push({ id: genId("GAP-REF"), category: ITEM_CATEGORIES.DATA_GAP,
        tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP], gap_type: "REFERENCE_RANGE_UNUSABLE", severity: "MEDIUM",
        title: "参考区间不可比较", summary: `${testName} 的参考区间数值、上下限顺序或单位不可确认，未据此判定正常或异常。`,
        source_type: "Observation", source_id: latest.id || null, span: null, timestamp: sourceTime });

      let isHigh = false;
      let isLow = false;
      let isCritical = latest.is_critical || false;
      let statusLabel = "无参考区间 (仅呈现趋势)";

      if (hasReferenceRange && Number.isFinite(latestVal)) {
        isHigh = refHigh != null && latestVal > refHigh;
        isLow = refLow != null && latestVal < refLow;
        statusLabel = isCritical ? "🚨 危急值" : (isHigh ? "⚠️ 偏高" : (isLow ? "⚠️ 偏低" : "正常"));
      }

      // Check eGFR if test is serum creatinine (Strict: require age, gender, compatible unit & steady-state)
      if (inWindow && /(?:scr|肌酐|creatinine)/i.test(code) && Number.isFinite(latestVal)) {
        if (patient.age != null && patient.gender != null) {
          const normLatest = normalizeLabUnit(latestVal, unit, "umol/L", "scr");
          if (!normLatest.compatible || normLatest.comparableValue == null) {
            patientEgfr = null;
            gaps.push({
              id: genId("GAP-EGFR-UNIT"),
              category: ITEM_CATEGORIES.DATA_GAP,
              tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP],
              gap_type: "CREATININE_UNIT_INCOMPATIBLE",
              severity: "MEDIUM",
              title: "肌酐单位无法兼容归一化",
              summary: `【资料不足】肌酐检测单位 (${unit || "未提供"}) 无法安全转换为 μmol/L，暂停 eGFR 估算以防临床误判。`,
              clinical_action_needed: "核实检验报告原始单据并确认肌酐检测单位",
              source_type: "AuditGap",
              source_id: latest.id || "gap-egfr-unit",
              span: latest.span || null,
            });
          } else {
            // KDIGO AKI / Creatinine instability check:
            // eGFR (CKD-EPI) assumes steady-state renal function. In rapidly changing creatinine,
            // static eGFR is clinically invalid and dangerous.
            let isAkiUnstable = false;
            if (baseline != null) {
              const baseVal = Number(baseline.value);
              const normBase = normalizeLabUnit(baseVal, baseline.unit, "umol/L", "scr");
              if (normBase.compatible && normBase.comparableValue != null) {
                const scrDelta = normLatest.comparableValue - normBase.comparableValue;
                const scrPctRise = normBase.comparableValue > 0 ? scrDelta / normBase.comparableValue : 0;
                // KDIGO: absolute increase >= 26.5 umol/L (0.3 mg/dL) or relative increase >= 50%
                if (scrDelta >= 26.5 || scrPctRise >= 0.5) {
                  isAkiUnstable = true;
                  patientEgfr = null; // Block static eGFR calculation during acute surge
                  // This conservative calculation guard is not a source-reported
                  // critical flag, a diagnosis, or an approved response-time rule.
                  gaps.push({
                    id: genId("GAP-AKI-EGFR"),
                    category: ITEM_CATEGORIES.DATA_GAP,
                    tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP],
                    gap_type: "CREATININE_NON_STEADY_STATE",
                    severity: "HIGH",
                    title: "eGFR 计算前提待核对",
                    summary: `【资料不足】两次肌酐记录存在明显差异 (${normBase.comparableValue} → ${normLatest.comparableValue} μmol/L)。当前资料未确认稳态计算前提，暂停 eGFR 估算；此结果不作疾病判断。`,
                    clinical_action_needed: "核对两次原始记录、采样时间与计算适用条件",
                    source_type: "AuditGap",
                    source_id: latest.id || null,
                    evidence: [baseline, latest].map((observation) => ({ source_id: observation.id || null, timestamp: observation.effective_time || observation.timestamp || null })),
                    span: null,
                  });
                }
              }
            }

            if (!isAkiUnstable) {
              patientEgfr = calculateEgfrCkdEpi(normLatest.comparableValue, patient.age, patient.gender);
            }
          }
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
          const normalizedBaseline = normalizeLabUnit(baseVal, baseline.unit, unit, code);
          if (baseline.value != null && String(baseline.value).trim() !== "" && normalizedBaseline.compatible && Number.isFinite(latestVal)) {
          deltaVal = latestVal - normalizedBaseline.comparableValue;
          deltaPct = normalizedBaseline.comparableValue !== 0 ? (deltaVal / normalizedBaseline.comparableValue) * 100 : null;
          if (deltaVal > 0) trendDirection = "↑";
          else if (deltaVal < 0) trendDirection = "↓";

          deltaStr = `基线: ${normalizedBaseline.comparableValue} ${unit} → 当前: ${latestVal} ${unit} (${trendDirection} ${deltaVal > 0 ? "+" : ""}${deltaVal.toFixed(1)} ${unit} / ${deltaPct == null ? "百分比不可计算" : `${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(1)}%`})`;
          } else { deltaStr = "历史对比不可用：数值或单位不完整/不兼容"; trendDirection = null; }
        } else {
          deltaStr = hasReferenceRange
            ? `当前: ${Number.isFinite(latestVal) ? latestVal : "未提供有效数值"} ${unit} (参考区间: ${refLow ?? '未提供'}-${refHigh ?? '未提供'} ${unit})`
            : `当前: ${Number.isFinite(latestVal) ? latestVal : "未提供有效数值"} ${unit}`;
        }

        const isAbnormal = hasReferenceRange ? (isHigh || isLow || isCritical) : Boolean(isCritical);
        const verbatimSpan = latest.span || null;

        const labItem = {
          id: genId("LAB"),
          category: isCritical ? ITEM_CATEGORIES.CRITICAL : ITEM_CATEGORIES.FACT,
          tag: CATEGORY_LABELS[isCritical ? ITEM_CATEGORIES.CRITICAL : ITEM_CATEGORIES.FACT],
          test_name: testName,
          current_value: Number.isFinite(latestVal) ? latestVal : null,
          result_status: resultLifecycle.result_status,
          change_type: resultLifecycle.change_type,
          version_id: resultLifecycle.version_id,
          arrival_status: resultLifecycle.arrival_status,
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
          summary: `${testName}: ${Number.isFinite(latestVal) ? latestVal : "未提供有效数值"} ${unit} [${statusLabel}] (${deltaStr})${resultLifecycle.result_status === "unknown" ? "；来源结果状态未知，不能据此视为已出具或已确认" : resultLifecycle.change_type === "revision" ? "；来源修订结果，需核对当前版本" : resultLifecycle.result_status === "preliminary" ? "；来源初步结果，非正式报告" : ""}`,
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
        timestamp: imp.event_time || imp.study_time || null,
        ordered_at: imp.ordered_at || null,
        result_status: classifyRecordLifecycle({ status: imp.status }, { sourceType: "diagnostic_report", now: nowMs }).result_status,
      });
    }

    // 1e. Medication Regimen Diff
    for (const med of combinedMedications) {
      // A cancelled or invalid order does not prove the patient started or
      // stopped taking a medication; retain it in record_changes instead.
      if (["cancelled", "canceled", "revoked", "entered-in-error", "entered_in_error"].includes(String(med.status || "").toLowerCase())) continue;
      const authoredTime = med.authored_on ? new Date(med.authored_on).getTime() : 0;
      const endTime = med.end_date ? new Date(med.end_date).getTime() : 0;
      const medName = med.drug_name || med.name || "未知药品";
      const dose = med.dosage || med.dose || "";
      const route = med.route || "";
      const freq = med.frequency || "";
      const fullDose = [dose, route, freq].filter(Boolean).join(" ");
      const verbatimSpan = med.span || null;
      const changeTimestamp = med.change_type === "discontinued" || med.status === "stopped" || med.status === "cancelled"
        ? (med.end_date || med.changed_at || null) : (med.changed_at || med.authored_on || null);
      const changeTime = classifySourceTime(changeTimestamp, { nowMs, cutoffMs: cutoffTime });
      if (changeTime.status !== "in_window") {
        if (changeTime.status !== "stale") gaps.push({
          id: genId("GAP-MED-TIME"), category: ITEM_CATEGORIES.DATA_GAP, tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP],
          gap_type: `MEDICATION_TIME_${changeTime.status.toUpperCase()}`, severity: "MEDIUM",
          title: "医嘱变更时间不可用", summary: `${medName} 的变更时间未能核验，未计入当前窗口的用药变化。`,
          source_type: "MedicationRequest", source_id: med.id || null, timestamp: changeTimestamp,
        });
        continue;
      }

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
      status_unknown: changeItems.filter((item) => item.change_type === "unknown" || item.selection_status === "conflict"),
      cancelled_or_invalid: changeItems.filter((item) => ["cancellation", "entered_in_error"].includes(item.change_type)),
      late_records: changeItems.filter((item) => item.arrival_status === "late_record"),
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
          status_desc: rep.status === "registered" ? "来源已登记；采集、执行和出具结果尚未确认" : "来源标记为待报告/初步结果，正式报告尚未确认",
          summary: `报告阶段待追踪: ${rep.name || rep.title || "检查"} (来源状态: ${rep.status}；不据此推断检查已完成)`,
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
            summary: `医嘱阶段待追踪: ${ord.title || ord.name || "医嘱"} (来源状态: ${ord.status}；${ord.scheduled_time || "执行时间未确认"})`,
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

    // NEWS2 remains an engineering calculation candidate. P0 has no approved
    // deterioration-alert intended use or clinical response policy.

    // ----------------------------------------------------
    // BLOCK 4: 「哪些资料不足」 (Critical Safety & Data Gaps)
    // ----------------------------------------------------
    // (gaps initialized at top of analyzePatientEvolution to capture earlier extraction gaps)

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
          summary: "【资料不足】当前可用来源未能确认过敏史；不表示无过敏，也不表示尚未询问或记录。",
          clinical_action_needed: "核对来源可用性与原始过敏史记录",
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
        summary: "【资料不足】当前可用来源未能确认近期肾功能结果；不据此推断未做检查或结果正常。",
        clinical_action_needed: "核对来源可用性、原始检验及其状态和时间",
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
        title: "当前资料未能确认体重",
        summary: "【资料不足】当前可用记录未提供有效体重，不能据此断言尚未测量或录入。",
        clinical_action_needed: "核对来源与原始测量记录",
        source_type: "AuditGap",
        source_id: "gap-weight",
        span: null,
      });
    }

    // Check Multi-Source Adapter Data Gaps (F-04, F-06)
    if (adapterDataGaps && adapterDataGaps.length > 0) {
      for (const adGap of adapterDataGaps) {
        gaps.push({
          id: genId("GAP-DATA"),
          category: ITEM_CATEGORIES.DATA_GAP,
          tag: CATEGORY_LABELS[ITEM_CATEGORIES.DATA_GAP],
          gap_type: "ADAPTER_DATA_QUALITY_GAP",
          severity: "HIGH",
          title: "多源数据质量或单位不兼容缺口",
          summary: `【资料不足】${adGap.reason}`,
          clinical_action_needed: "核实原始检验报告单的采样时间及检测单位",
          source_type: "HospitalDataAdapter",
          source_id: `gap-ad-${adGap.code || "unknown"}`,
          span: null,
        });
      }
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
      ...changeItems,
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
        record_changes: recordChanges,
        source_availability: sourceAvailability.map((source) => ({ ...source })),
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
    doctorId = null,
    doctorName = null,
    customAdditions = "",
  }) {
    if (!doctorId || typeof doctorId !== "string" || !doctorId.trim()) {
      throw new Error("INVALID_DOCTOR_CONTEXT: Missing required doctorId for progress note draft generation under fail-closed audit contract.");
    }
    const resolvedDoctorName = (doctorName && typeof doctorName === "string" && doctorName.trim()) || doctorId;

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
    const recordChangeItems = chosen.filter((i) => i.id.startsWith("CHANGE"));

    const lines = [];
    const dateStr = new Date().toISOString().replace("T", " ").slice(0, 16);
    lines.push(`【日常查房记录 - 病情演变摘要】`);
    lines.push(`记录时间：${dateStr}    查房医师：${resolvedDoctorName} (${doctorId})`);
    const pName = summaryData.patient?.name || "未录入姓名";
    const pBed = summaryData.patient?.bed_number || "未分配床位";
    const pDiag = summaryData.patient?.primary_diagnosis || "未明确主诊断（待主管医师评估补充）";
    lines.push(`患者姓名：${pName}  床号：${pBed}  主诊断：${pDiag}`);
    if (summaryData.patient?.egfr) {
      lines.push(`肾功能估算：eGFR ${summaryData.patient.egfr} mL/min/1.73m² (CKD-EPI 2021)`);
    }
    lines.push("");

    if (recordChangeItems.length > 0) {
      lines.push("记录状态与迟到资料");
      recordChangeItems.forEach((item) => lines.push(`  • ${item.summary} [^${item.id}]`));
      lines.push("");
    }

    // Section 0: Structured Multi-Source Alignment
    if (alignItems.length > 0) {
      lines.push("【多源跨系统临床对齐 (NIS/LIS/PACS/HIS)】");
      alignItems.forEach((i) => lines.push(`  • ${i.summary} [^${i.id}]`));
      lines.push("");
    }

    // Section 1: Vitals & Symptoms
    lines.push("一、今日病情变化与症状演变");
    if (vitalsItem) {
      lines.push(`  • ${vitalsItem.summary} [^${vitalsItem.id}]`);
    }
    if (symItems.length > 0) {
      symItems.forEach((i) => lines.push(`  • ${i.summary} [^${i.id}]`));
    }
    if (!vitalsItem && symItems.length === 0) {
      lines.push("  • 暂无选中症状演变记录");
    }
    lines.push("");

    // Section 2: Abnormal Labs & Imaging
    lines.push("二、主要异常检验及指标趋势");
    if (labItems.length > 0) {
      labItems.forEach((i) => lines.push(`  • [检验] ${i.summary} [^${i.id}]`));
    }
    if (pacsItems.length > 0) {
      pacsItems.forEach((i) => lines.push(`  • [影像] ${i.summary} [^${i.id}]`));
    }
    if (labItems.length === 0 && pacsItems.length === 0) {
      lines.push("  • 暂无选中异常检验或影像");
    }
    lines.push("");

    // Section 3: Medication Changes
    lines.push("三、今日医嘱与用药方案调整");
    if (medAdd.length > 0) {
      medAdd.forEach((i) => lines.push(`  • [新增] ${i.summary} [^${i.id}]`));
    }
    if (medDisc.length > 0) {
      medDisc.forEach((i) => lines.push(`  • [停用] ${i.summary} [^${i.id}]`));
    }
    if (medAdj.length > 0) {
      medAdj.forEach((i) => lines.push(`  • [调量] ${i.summary} [^${i.id}]`));
    }
    if (medAdd.length === 0 && medDisc.length === 0 && medAdj.length === 0) {
      lines.push("  • 暂无选中药物调整记录；不据此判断实际方案是否变化");
    }
    lines.push("");

    // Section 4: Pending & Rules
    lines.push("四、今日待办检查与追踪事项");
    if (repItems.length > 0) {
      repItems.forEach((i) => lines.push(`  • [待出报告] ${i.summary} [^${i.id}]`));
    }
    if (ordItems.length > 0) {
      ordItems.forEach((i) => lines.push(`  • [待办事项] ${i.summary} [^${i.id}]`));
    }
    if (ruleItems.length > 0) {
      ruleItems.forEach((i) => lines.push(`  • [临床提醒] ${i.summary} [^${i.id}]`));
    }
    if (repItems.length === 0 && ordItems.length === 0 && ruleItems.length === 0) {
      lines.push("  • 暂无选中待办记录；不代表所有事项已闭环");
    }
    lines.push("");

    // Section 5: Data Gaps
    if (gapItems.length > 0) {
      lines.push("五、已知临床资料缺口提示");
      gapItems.forEach((i) => lines.push(`  • [资料缺口] ${i.summary} [^${i.id}]`));
      lines.push("");
    }

    // Section 6: Custom Additions
    if (customAdditions && customAdditions.trim()) {
      lines.push("六、医师查房意见与下一步处置");
      lines.push(`  ${customAdditions.trim()}`);
      lines.push("");
    }

    lines.push(`医师签名：${resolvedDoctorName}（查房记录草稿，待医师确认签署）`);

    const draftText = lines.join("\n");
    const verificationReport = PostHocClaimVerifier.verifyClaims({
      narrativeText: draftText,
      verifiableItems: chosen,
    });

    return {
      draft_text: draftText,
      selected_count: chosen.length,
      doctor_id: doctorId,
      doctor_name: resolvedDoctorName,
      generated_at: new Date().toISOString(),
      doctor: { id: doctorId, name: resolvedDoctorName },
      verification_report: verificationReport,
    };
  }

  /**
   * Deterministically verify narrative claims against grounded items (F-01).
   */
  static verifyProgressNoteDraft(draftText = "", availableItems = [], options = {}) {
    return PostHocClaimVerifier.verifyClaims({
      narrativeText: draftText,
      verifiableItems: availableItems,
      options,
    });
  }
}
