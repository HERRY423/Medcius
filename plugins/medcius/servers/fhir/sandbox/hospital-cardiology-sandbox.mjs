// Realistic Inpatient Cardiology Ward Sandbox (真实医院心内科沙箱与患者/就诊绑定)
// Model Hospital: 北京协和医院 / 华西医院标准心内科病区 (Cardiology Ward 2, Beds 01-16)
// Provides: SMART on FHIR 2.2 context binding, patient/encounter prefetch, and realistic timeline fixtures.

export const HOSPITAL_SANDBOX_METADATA = {
  hospital_id: "HOSP-PKU-CARDIO",
  hospital_name: "国家心血管临床医学中心（测试沙箱）",
  ward_name: "心血管内科住院二病区",
  ward_code: "WARD-CARDIO-02",
  fhir_base_url: "http://127.0.0.1:8080/fhir/r4",
  smart_launch_url: "http://127.0.0.1:8080/smart/launch",
  smart_auth_url: "http://127.0.0.1:8080/smart/auth",
  smart_token_url: "http://127.0.0.1:8080/smart/token",
  consecutive_beds_count: 16,
};

/** Generate 16 consecutive realistic cardiology ward patients */
export function getCardiologyWardFixture() {
  const now = Date.now();
  const h = (hours) => new Date(now - hours * 3600000).toISOString();

  const patients = [
    {
      patient: {
        id: "pat-cardio-001",
        name: "张** (脱敏)",
        gender: "男",
        age: 68,
        bed_number: "01床",
        admission_date: h(72),
        primary_diagnosis: "冠心病，急性前壁ST段抬高型心肌梗死，PCI术后，高血压3级",
        weight_kg: 74,
      },
      encounter: { id: "enc-cardio-001", status: "in-progress", class: "IMP", period: { start: h(72) } },
      notes: [
        {
          id: "note-001-1",
          title: "查房病程记录",
          timestamp: h(4),
          text: "主诉：胸痛明显缓解，活动后轻度气促。体检：体温 36.8℃，心率 72 次/分，两肺底未闻及湿啰音。急查生化提示肌酐轻度上升。",
        },
      ],
      observations: [
        { id: "obs-001-scr-1", name: "血肌酐 (Scr)", code: "scr", value: 138, unit: "μmol/L", effective_time: h(4), referenceRange: [{ low: { value: 59, unit: "μmol/L" }, high: { value: 104, unit: "μmol/L" } }] },
        { id: "obs-001-scr-0", name: "血肌酐 (Scr)", code: "scr", value: 85, unit: "μmol/L", effective_time: h(48), referenceRange: [{ low: { value: 59, unit: "μmol/L" }, high: { value: 104, unit: "μmol/L" } }] },
        { id: "obs-001-k-1", name: "血钾 (K+)", code: "k", value: 4.3, unit: "mmol/L", effective_time: h(4), referenceRange: [{ low: { value: 3.5, unit: "mmol/L" }, high: { value: 5.3, unit: "mmol/L" } }] },
        { id: "obs-001-trop-1", name: "肌钙蛋白I (cTnI)", code: "ctni", value: 1.25, unit: "ng/mL", effective_time: h(4), referenceRange: [{ low: { value: 0, unit: "ng/mL" }, high: { value: 0.04, unit: "ng/mL" } }] },
      ],
      medications: [
        { id: "med-001-1", drug_name: "阿司匹林肠溶片", dosage: "100mg", route: "po", frequency: "qd", change_type: "added", authored_on: h(12) },
        { id: "med-001-2", drug_name: "替格瑞洛片", dosage: "90mg", route: "po", frequency: "bid", change_type: "added", authored_on: h(12) },
        { id: "med-001-3", drug_name: "硝酸甘油注射液", dosage: "5mg", route: "ivgtt", frequency: "st", change_type: "discontinued", end_date: h(6), stop_reason: "胸痛缓解停用静脉硝酸酯" },
      ],
      diagnosticReports: [
        { id: "rep-001-1", name: "床旁超声心动图", status: "preliminary", ordered_at: h(8) },
      ],
      orders: [
        { id: "ord-001-1", title: "24小时动态心电图", status: "active", scheduled_time: "今日 10:00" },
        { id: "ord-001-2", title: "心血管重症监护", status: "active" },
      ],
      allergies: ["青霉素"],
    },
    {
      patient: {
        id: "pat-cardio-002",
        name: "王** (脱敏)",
        gender: "女",
        age: 74,
        bed_number: "02床",
        admission_date: h(96),
        primary_diagnosis: "缺血性心肌病，全心衰竭 (NYHA IV级)，2型糖尿病",
        weight_kg: 62,
      },
      encounter: { id: "enc-cardio-002", status: "in-progress", class: "IMP", period: { start: h(96) } },
      notes: [
        {
          id: "note-002-1",
          title: "病程记录",
          timestamp: h(6),
          text: "现病史：夜间阵发性呼吸困难较前好转，双下肢重度水肿稍有减轻。今日尿量 1850ml。查房诉口干。",
        },
      ],
      observations: [
        { id: "obs-002-bnp-1", name: "NT-proBNP", code: "nt_probnp", value: 3820, unit: "pg/mL", effective_time: h(6), referenceRange: [{ low: { value: 0, unit: "pg/mL" }, high: { value: 300, unit: "pg/mL" } }] },
        { id: "obs-002-bnp-0", name: "NT-proBNP", code: "nt_probnp", value: 5600, unit: "pg/mL", effective_time: h(48), referenceRange: [{ low: { value: 0, unit: "pg/mL" }, high: { value: 300, unit: "pg/mL" } }] },
        { id: "obs-002-k-1", name: "血钾 (K+)", code: "k", value: 3.3, unit: "mmol/L", effective_time: h(6), referenceRange: [{ low: { value: 3.5, unit: "mmol/L" }, high: { value: 5.3, unit: "mmol/L" } }] },
      ],
      medications: [
        { id: "med-002-1", drug_name: "呋塞米注射液", dosage: "40mg", route: "iv", frequency: "bid", change_type: "adjusted", previous_dosage: "20mg bid", authored_on: h(8) },
        { id: "med-002-2", drug_name: "氯化钾缓释片", dosage: "1.0g", route: "po", frequency: "tid", change_type: "added", authored_on: h(6) },
      ],
      diagnosticReports: [
        { id: "rep-002-1", name: "胸部正侧位片 (DR)", status: "preliminary", ordered_at: h(12) },
      ],
      orders: [
        { id: "ord-002-1", title: "特级护理及出入量严密记录", status: "active" },
        { id: "ord-002-2", title: "肾内科床旁会诊", order_type: "consult", department: "肾内科", purpose: "利尿剂抵抗及电解质管理评估", status: "active" },
      ],
      allergies: [], // Test allergy gap detection
    },
  ];

  // Fill remaining 14 consecutive cardiology beds with realistic structured profiles
  for (let bed = 3; bed <= 16; bed++) {
    const bedStr = `${String(bed).padStart(2, "0")}床`;
    const patId = `pat-cardio-${String(bed).padStart(3, "0")}`;
    const isMale = bed % 2 === 1;
    const age = 50 + (bed * 2) % 35;
    const diag = bed % 3 === 0
      ? "阵发性心房颤动，心功能II级"
      : (bed % 3 === 1 ? "原发性高血压3级（极高危），冠状动脉粥样硬化" : "非ST段抬高型急性冠脉综合征");

    patients.push({
      patient: {
        id: patId,
        name: `${isMale ? "刘" : "陈"}** (脱敏)`,
        gender: isMale ? "男" : "女",
        age,
        bed_number: bedStr,
        admission_date: h(bed * 8 + 24),
        primary_diagnosis: diag,
        weight_kg: isMale ? 72 : 58,
      },
      encounter: { id: `enc-cardio-${bed}`, status: "in-progress", class: "IMP", period: { start: h(bed * 8 + 24) } },
      notes: [
        {
          id: `note-${bed}-1`,
          title: "病程记录",
          timestamp: h(5),
          text: `查房记录：${bedStr}患者今日无特殊不适诉求，夜间睡眠好，体温正常，心率 ${65 + (bed % 15)} 次/分，血压平稳。`,
        },
      ],
      observations: [
        {
          id: `obs-${bed}-scr-1`,
          name: "血肌酐 (Scr)",
          code: "scr",
          value: 78 + (bed % 20),
          unit: "μmol/L",
          effective_time: h(5),
          referenceRange: [{ low: { value: 59, unit: "μmol/L" }, high: { value: 104, unit: "μmol/L" } }],
        },
      ],
      medications: [
        {
          id: `med-${bed}-1`,
          drug_name: "琥珀酸美托洛尔缓释片",
          dosage: "47.5mg",
          route: "po",
          frequency: "qd",
          change_type: "added",
          authored_on: h(10),
        },
      ],
      diagnosticReports: [
        { id: `rep-${bed}-1`, name: "心电图 (常规12导联)", status: "registered", ordered_at: h(12) },
      ],
      orders: [
        { id: `ord-${bed}-1`, title: "心电监护及生命体征监测", status: "active" },
      ],
      allergies: bed % 4 === 0 ? null : ["无已知药物过敏"],
    });
  }

  return patients;
}

/** SMART on FHIR 2.2 Launch Helper */
export function createSmartLaunchContext(patientId, doctorId = "DOC-PKU-CARDIO-8801") {
  return {
    iss: HOSPITAL_SANDBOX_METADATA.fhir_base_url,
    launch: `launch-${patientId}-${Date.now()}`,
    patient: patientId,
    encounter: `enc-${patientId.replace("pat-", "")}`,
    user: doctorId,
    scope: "launch/patient patient/*.read encounter/*.read openid profile",
  };
}
