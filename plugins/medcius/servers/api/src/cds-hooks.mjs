// HL7 FHIR CDS Hooks 1.0/2.0 Provider for Medcius
// Implements: patient-view (Inpatient Pre-Round Patient Evolution Summary)
// Security & Governance: Fail-closed on missing data, zero synthetic fallback on real requests.

import { PatientEvolutionEngine } from "../../../lib/patient-evolution-engine.mjs";

export const CDS_SERVICES = [
  {
    id: "medcius-patient-evolution",
    hook: "patient-view",
    title: "Medcius 住院医生查房前“患者变化摘要”",
    description: "医生打开病历或进入查房列表时自动预取过去 24/72 小时症状演变、异常检验趋势、药物调整、待办检查与关键资料缺口。",
    prefetch: {
      patient: "Patient/{{context.patientId}}",
      conditions: "Condition?patient={{context.patientId}}&clinical-status=active",
      observations: "Observation?patient={{context.patientId}}&_sort=-date&_count=20",
      medications: "MedicationRequest?patient={{context.patientId}}&status=active",
      reports: "DiagnosticReport?patient={{context.patientId}}&_sort=-date&_count=10",
      orders: "ServiceRequest?patient={{context.patientId}}&status=active",
    },
  },
];

/** Extract patient demographics from FHIR Patient or context */
function parseFhirPatient(context, prefetch) {
  const pat = prefetch?.patient?.resource ?? prefetch?.patient ?? context?.patient;
  const patId = pat?.id ?? context?.patientId ?? null;

  if (!patId && !pat) {
    return null; // Fail-closed: missing patient context
  }

  let age = null;
  if (pat?.birthDate) {
    const birthYear = new Date(pat.birthDate).getFullYear();
    const curYear = new Date().getFullYear();
    age = curYear - birthYear;
  } else if (typeof pat?.age === "number") {
    age = pat.age;
  }

  const gender = pat?.gender || null;
  const sex_cn = gender === "male" ? "男" : gender === "female" ? "女" : null;

  return {
    id: patId || null,
    name: pat?.name?.[0]?.text || pat?.name || (patId ? `患者 (ID: ${patId})` : null),
    age: age || null,
    gender,
    sex_cn,
    bed_number: pat?.bed_number || pat?.bed || null,
    primary_diagnosis: pat?.primary_diagnosis || pat?.diagnosis || null,
    weight_kg: pat?.weight_kg || pat?.weightKg || null,
    encounter_id: context?.encounterId || pat?.encounter_id || prefetch?.encounter?.id || null,
  };
}

/** Extract observations from FHIR Bundle / Array */
function parseFhirObservations(context, prefetch) {
  const rawList = [
    ...(prefetch?.observations?.entry ?? []),
    ...(context?.observations ?? []),
  ];

  return rawList.map((item) => {
    const res = item.resource ?? item;
    return {
      id: res.id || null,
      name: res.code?.text || res.code?.coding?.[0]?.display || res.name || "检验项目",
      code: res.code?.coding?.[0]?.code || res.code || res.name || "unknown",
      value: res.valueQuantity?.value ?? res.value ?? null,
      unit: res.valueQuantity?.unit ?? res.unit ?? "",
      effective_time: res.effectiveDateTime || res.effective_time || res.timestamp || null,
      referenceRange: res.referenceRange || (res.ref_low != null || res.ref_high != null ? [{
        low: res.ref_low != null ? { value: res.ref_low, unit: res.unit } : undefined,
        high: res.ref_high != null ? { value: res.ref_high, unit: res.unit } : undefined,
        text: res.ref_text || res.reference_range,
      }] : null),
      report_name: res.report_name || "检验报告",
      span: res.span || null,
    };
  }).filter((o) => o.value != null);
}

/** Extract medications from FHIR Bundle / Array */
function parseFhirMedications(context, prefetch) {
  const rawList = [
    ...(prefetch?.medications?.entry ?? []),
    ...(context?.medications ?? []),
  ];

  return rawList.map((item) => {
    const res = item.resource ?? item;
    const drugName =
      res.medicationCodeableConcept?.text ||
      res.medicationCodeableConcept?.coding?.[0]?.display ||
      res.medicationReference?.display ||
      res.drug_name ||
      res.name ||
      "未知药品";

    const dose = res.dosageInstruction?.[0]?.text || res.dosage || "";
    return {
      id: res.id || null,
      drug_name: drugName,
      dosage: dose,
      route: res.route || "",
      frequency: res.frequency || "",
      change_type: res.change_type || (res.status === "active" ? "added" : (res.status === "stopped" ? "discontinued" : null)),
      authored_on: res.authoredOn || res.authored_on || null,
      end_date: res.endDate || res.end_date || null,
      stop_reason: res.stop_reason || null,
      span: res.span || null,
    };
  });
}

/** Extract diagnostic reports from FHIR Bundle / Array */
function parseFhirReports(context, prefetch) {
  const rawList = [
    ...(prefetch?.reports?.entry ?? []),
    ...(context?.diagnosticReports ?? []),
  ];

  return rawList.map((item) => {
    const res = item.resource ?? item;
    return {
      id: res.id || null,
      name: res.code?.text || res.code?.coding?.[0]?.display || res.name || res.title || "检查报告",
      status: res.status || "registered",
      ordered_at: res.effectiveDateTime || res.ordered_at || res.timestamp || null,
      span: res.span || null,
    };
  });
}

/** Extract orders/service requests */
function parseFhirOrders(context, prefetch) {
  const rawList = [
    ...(prefetch?.orders?.entry ?? []),
    ...(context?.orders ?? []),
  ];

  return rawList.map((item) => {
    const res = item.resource ?? item;
    return {
      id: res.id || null,
      title: res.code?.text || res.code?.coding?.[0]?.display || res.title || res.name || "医嘱项目",
      status: res.status || "active",
      order_type: res.order_type || (/会诊/.test(res.title || "") ? "consult" : "order"),
      department: res.department || null,
      purpose: res.purpose || null,
      scheduled_time: res.scheduled_time || null,
      span: res.span || null,
    };
  });
}

/** Handle incoming CDS Hook request */
export async function handleCdsHookRequest(serviceId, requestBody) {
  const { hook, user, context, prefetch } = requestBody || {};

  // 1. Fail-Closed: Validate user / practitioner context (HL7 CDS Hooks required context.userId)
  const userId = context?.userId || user || requestBody?.userId;
  if (!userId || String(userId).trim() === "") {
    return {
      cards: [
        {
          uuid: `card-err-user-${Date.now()}`,
          summary: "Medcius: 未检出操作医师身份上下文 (Missing userId)",
          detail: "HL7 CDS Hooks patient-view 标准要求传入当前登录医师标识 (context.userId)。系统已按合规要求安全关闭。",
          indicator: "warning",
          source: {
            label: "Medcius 患者变化摘要插件",
            url: "https://github.com/HERRY423/Medcius",
          },
        },
      ],
    };
  }

  // 2. Fail-Closed: Validate patient context presence
  const patient = parseFhirPatient(context, prefetch);
  if (!patient || !patient.id || patient.id === "UNKNOWN-PATIENT" || String(patient.id).trim() === "") {
    return {
      cards: [
        {
          uuid: `card-err-pat-${Date.now()}`,
          summary: "Medcius: 未检出有效患者上下文 (Missing patientId)",
          detail: "未提供有效的 Patient ID 或 FHIR Patient 资源。请在 EHR 患者病历界面中打开查房插件。",
          indicator: "info",
          source: {
            label: "Medcius 患者变化摘要插件",
            url: "https://github.com/HERRY423/Medcius",
          },
        },
      ],
    };
  }

  // Parse real clinical entities without injecting synthetic records
  const notes = context?.notes || [];
  const observations = parseFhirObservations(context, prefetch);
  const medications = parseFhirMedications(context, prefetch);
  const diagnosticReports = parseFhirReports(context, prefetch);
  const orders = parseFhirOrders(context, prefetch);
  const allergies = context?.allergies || prefetch?.allergies || null;

  const timeWindow = context?.time_window || "24h";

  const summary = PatientEvolutionEngine.analyzePatientEvolution({
    patient,
    timeWindow,
    notes,
    observations,
    medications,
    diagnosticReports,
    orders,
    allergies,
  });

  const b1 = summary.blocks.what_changed;
  const b2 = summary.blocks.whats_pending;
  const b3 = summary.blocks.data_gaps;

  const hasCritical = b1.abnormal_labs.some((l) => l.is_critical);
  const hasGaps = b3.length > 0;
  const totalChanges =
    b1.clinical_symptoms.length +
    b1.abnormal_labs.length +
    b1.medication_diff.added.length +
    b1.medication_diff.discontinued.length +
    b1.medication_diff.adjusted.length;

  const detailLines = [];
  detailLines.push(`【过去 ${timeWindow === "72h" ? "72" : "24"} 小时变化摘要】`);
  if (b1.clinical_symptoms.length) detailLines.push(`• 症状/体征: ${b1.clinical_symptoms[0].summary}`);
  if (b1.abnormal_labs.length) detailLines.push(`• 异常检验: ${b1.abnormal_labs.map((l) => `${l.test_name} ${l.current_value}${l.unit} (${l.trend_direction})`).join(", ")}`);
  if (b1.medication_diff.added.length) detailLines.push(`• 用药调整: 新增 ${b1.medication_diff.added.map((m) => m.drug_name).join(", ")}`);
  if (b2.pending_reports.length) detailLines.push(`• 今日待办: ${b2.pending_reports.map((r) => r.summary).join("; ")}`);
  if (b3.length) detailLines.push(`• 资料缺口: ${b3.map((g) => g.title).join(", ")}`);

  if (detailLines.length === 1) {
    detailLines.push("• 近期未检测到新增化验异常、医嘱调整或待办事项。");
  }

  const cards = [
    {
      uuid: `card-evo-${Date.now()}`,
      summary: `Medcius 查房摘要: ${patient.bed_number || "床位"} ${patient.name || "患者"} (近 24 小时 ${totalChanges} 项变化，${b2.pending_reports.length + b2.pending_orders.length} 项待办)`,
      detail: detailLines.join("\n"),
      indicator: hasCritical ? "critical" : (hasGaps ? "warning" : "info"),
      source: {
        label: "Medcius 患者变化摘要插件",
        url: "https://github.com/HERRY423/Medcius",
      },
      links: [
        {
          label: "打开查房前变化摘要侧边栏 (一屏速览 & 插入病程)",
          url: `/sidebar?patient_id=${patient.id}`,
          type: "smart",
          appContext: JSON.stringify({ patient_id: patient.id, time_window: timeWindow }),
        },
      ],
    },
  ];

  return { cards };
}
