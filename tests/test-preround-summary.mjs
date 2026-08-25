// Test Suite for Inpatient Pre-Round Patient Evolution Summary Flagship Plugin
// Validates: 24h/72h evolution diff, dynamic LIS lab ranges, med diff, pending reports,
// safety gaps, verbatim span citations, progress note draft generation, and CDS Hooks.

import assert from "node:assert/strict";
import { PatientEvolutionEngine, ITEM_CATEGORIES } from "../plugins/medcius/lib/patient-evolution-engine.mjs";
import { startServer } from "../plugins/medcius/servers/api/src/server.mjs";
import { generateToken, ROLES } from "../plugins/medcius/servers/api/src/auth-middleware.mjs";

console.log("== Testing Inpatient Pre-Round Patient Evolution Summary Flagship Plugin ==");

// ----------------------------------------------------
// Test 1: Unit Test - Deterministic Evolution Engine with Dynamic Reference Ranges & Verbatim Spans
// ----------------------------------------------------
console.log("\n[Test 1] Testing PatientEvolutionEngine dynamic reference ranges & verbatim spans...");

const samplePatient = {
  id: "IP-2026-90812",
  name: "张** (脱敏)",
  gender: "男",
  age: 65,
  bed_number: "床位 12",
  admission_date: "2026-08-21",
  primary_diagnosis: "冠心病，急性冠脉综合征，2型糖尿病",
};

const sampleNotes = [
  {
    id: "note-01",
    title: "病程记录",
    timestamp: new Date().toISOString(),
    text: "病程记录：今日晨起诉胸闷好转，无心悸，体温最高 37.8℃。急诊生化：血肌酐 142 μmol/L，血钾 4.1 mmol/L。",
  },
];

const sampleObs = [
  // 1a. Lab with hospital LIS dynamic referenceRange
  {
    id: "obs-scr-01",
    name: "血肌酐 (Scr)",
    code: "scr",
    value: 142,
    unit: "μmol/L",
    effective_time: new Date().toISOString(),
    report_name: "急诊生化八项",
    referenceRange: [{ low: { value: 59, unit: "μmol/L" }, high: { value: 104, unit: "μmol/L" } }],
    span: "血肌酐 142 μmol/L", // Real verbatim span from note
  },
  {
    id: "obs-scr-02",
    name: "血肌酐 (Scr)",
    code: "scr",
    value: 88,
    unit: "μmol/L",
    effective_time: new Date(Date.now() - 48 * 3600000).toISOString(),
    report_name: "入院生化",
    referenceRange: [{ low: { value: 59, unit: "μmol/L" }, high: { value: 104, unit: "μmol/L" } }],
  },
  // 1b. Lab with NO referenceRange provided (trend-only mode)
  {
    id: "obs-crp-01",
    name: "C反应蛋白 (CRP)",
    code: "crp",
    value: 18.5,
    unit: "mg/L",
    effective_time: new Date().toISOString(),
    report_name: "急诊检验",
    // No reference range!
  },
  {
    id: "obs-crp-02",
    name: "C反应蛋白 (CRP)",
    code: "crp",
    value: 45.0,
    unit: "mg/L",
    effective_time: new Date(Date.now() - 48 * 3600000).toISOString(),
    report_name: "入院检验",
  },
];

const sampleMeds = [
  { drug_name: "注射用头孢曲松钠", dosage: "2.0g", route: "ivgtt", frequency: "qd", change_type: "added", authored_on: new Date().toISOString() },
  { drug_name: "呋塞米片", dosage: "20mg", route: "po", frequency: "bid", change_type: "discontinued", end_date: new Date().toISOString(), stop_reason: "水肿消退，停用利尿剂" },
  { drug_name: "硝苯地平控释片", dosage: "60mg", route: "po", frequency: "qd", previous_dosage: "30mg qd", change_type: "adjusted", authored_on: new Date().toISOString() },
];

const sampleReports = [
  { name: "胸部 CT 平扫", status: "preliminary", ordered_at: new Date(Date.now() - 12 * 3600000).toISOString() },
  { name: "血液细菌培养及药敏", status: "registered", ordered_at: new Date(Date.now() - 36 * 3600000).toISOString() },
];

const sampleOrders = [
  { title: "24小时动态心电图 (Holter)", status: "draft", scheduled_time: "今日 09:30" },
  { title: "肾内科床旁会诊", order_type: "consult", department: "肾内科", purpose: "评估急性肾功能恶化原因", status: "active" },
];

const summary = PatientEvolutionEngine.analyzePatientEvolution({
  patient: samplePatient,
  timeWindow: "24h",
  notes: sampleNotes,
  observations: sampleObs,
  medications: sampleMeds,
  diagnosticReports: sampleReports,
  orders: sampleOrders,
  allergies: null, // Test allergy gap
});

// Assert Block 1: What Changed
assert.ok(summary.blocks.what_changed.clinical_symptoms.length >= 1);
assert.equal(summary.blocks.what_changed.clinical_symptoms[0].category, ITEM_CATEGORIES.FACT);
assert.ok(summary.blocks.what_changed.clinical_symptoms[0].span.includes("胸闷好转"));

// Assert Lab with Dynamic LIS Reference Range
const scrLab = summary.blocks.what_changed.abnormal_labs.find((l) => l.test_name.includes("肌酐"));
assert.ok(scrLab);
assert.equal(scrLab.current_value, 142);
assert.equal(scrLab.has_reference_range, true);
assert.equal(scrLab.ref_high, 104);
assert.equal(scrLab.is_abnormal, true);
assert.equal(scrLab.status_label, "⚠️ 偏高");
assert.equal(scrLab.trend_direction, "↑");
assert.equal(scrLab.span, "血肌酐 142 μmol/L", "Must preserve verbatim note span when present");

// Assert Lab with MISSING Reference Range -> Must be Trend-Only (is_abnormal = false, status_label = trend only)
const crpLab = summary.blocks.what_changed.abnormal_labs.find((l) => l.test_name.includes("CRP") || l.test_name.includes("C反应蛋白"));
assert.ok(crpLab);
assert.equal(crpLab.has_reference_range, false);
assert.equal(crpLab.is_abnormal, false, "Must NOT judge abnormal without LIS referenceRange");
assert.equal(crpLab.status_label, "无参考区间 (仅呈现趋势)");
assert.equal(crpLab.trend_direction, "↓");
assert.equal(crpLab.span, null, "Must NOT fabricate synthetic concatenated span");

// Assert Med Diff
assert.equal(summary.blocks.what_changed.medication_diff.added.length, 1);
assert.equal(summary.blocks.what_changed.medication_diff.added[0].drug_name, "注射用头孢曲松钠");
assert.equal(summary.blocks.what_changed.medication_diff.added[0].span, null, "Must NOT fabricate concatenated med span");

// Assert Block 2: What's Pending
assert.equal(summary.blocks.whats_pending.pending_reports.length, 2);
assert.equal(summary.blocks.whats_pending.pending_orders.length, 1);
assert.equal(summary.blocks.whats_pending.scheduled_consults.length, 1);

// Assert Block 3: Data Gaps
const allergyGap = summary.blocks.data_gaps.find((g) => g.gap_type === "ALLERGY_MISSING");
assert.ok(allergyGap, "Must identify missing allergy records as a critical gap");
assert.equal(allergyGap.category, ITEM_CATEGORIES.DATA_GAP);

// Assert Block 4: Evidence list
assert.ok(summary.blocks.evidence.length >= 8);
assert.ok(summary.blocks.evidence.every((e) => e.source_type && e.tag));

console.log("✓ PatientEvolutionEngine accurately computed 4 blocks, dynamic LIS ranges, med diff, and zero fake spans");

// ----------------------------------------------------
// Test 2: Progress Note Draft Generation
// ----------------------------------------------------
console.log("\n[Test 2] Testing structured daily progress note draft generation...");

const selectedIds = [
  summary.blocks.what_changed.clinical_symptoms[0].id,
  scrLab.id,
  crpLab.id,
  summary.blocks.what_changed.medication_diff.added[0].id,
  summary.blocks.what_changed.medication_diff.discontinued[0].id,
  summary.blocks.whats_pending.pending_reports[0].id,
  allergyGap.id,
];

const draft = PatientEvolutionEngine.generateProgressNoteDraft({
  summaryData: summary,
  selectedItemIds: selectedIds,
  doctorId: "DOC-8021",
  doctorName: "林德明 (主任医师)",
  customAdditions: "患者精神尚可，嘱低盐低脂饮食，卧床休息。",
});

assert.equal(draft.selected_count, 7);
assert.ok(draft.draft_text.includes("【日常查房记录 - 病情演变摘要】"));
assert.ok(draft.draft_text.includes("一、今日病情变化与症状演变"));
assert.ok(draft.draft_text.includes("二、主要异常检验及指标趋势"));
assert.ok(draft.draft_text.includes("血肌酐 (Scr): 142 μmol/L"));
assert.ok(draft.draft_text.includes("三、今日医嘱与用药方案调整"));
assert.ok(draft.draft_text.includes("新增: 注射用头孢曲松钠"));
assert.ok(draft.draft_text.includes("四、今日待办检查与追踪事项"));
assert.ok(draft.draft_text.includes("五、已知临床资料缺口提示"));
assert.ok(draft.draft_text.includes("林德明 (主任医师)"));
assert.ok(draft.draft_text.includes("低盐低脂饮食"));

console.log("✓ Structured daily progress note draft generated with physician sign-off attribution");

// ----------------------------------------------------
// Test 3: Live API & CDS Hooks Integration
// ----------------------------------------------------
console.log("\n[Test 3] Testing Live Server API & CDS Hooks Endpoints...");

const token = generateToken({
  sub: "DOC-8021",
  name: "林德明",
  roles: [ROLES.PHYSICIAN, ROLES.PHARMACIST],
  tenant_id: "hospital_test",
});
const authHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
  "X-Tenant-ID": "hospital_test",
};

const { server, port, host } = await startServer(0, "127.0.0.1");
const baseUrl = `http://${host}:${port}`;

try {
  // Test 3a: GET / (Sidebar HTML)
  console.log("  [3a] GET / (Sidebar UI)...");
  const resSidebar = await fetch(`${baseUrl}/sidebar`);
  assert.equal(resSidebar.status, 200);
  const html = await resSidebar.text();
  assert.ok(html.includes("住院医生查房前“患者变化摘要”"));
  assert.ok(html.includes("发生了什么变化"));
  assert.ok(html.includes("今天仍待处理什么"));
  assert.ok(html.includes("哪些资料不足"));
  assert.ok(html.includes("查看原始证据"));
  assert.ok(html.includes("插入查房记录"));
  console.log("  ✓ EHR Sidebar HTML UI served correctly with 4 dedicated blocks");

  // Test 3b: GET /api/v1/patient/evolution-summary
  console.log("  [3b] GET /api/v1/patient/evolution-summary...");
  const resSummary = await fetch(`${baseUrl}/api/v1/patient/evolution-summary?time_window=24h&patient_id=IP-2026-90812`, {
    headers: authHeaders,
  });
  assert.equal(resSummary.status, 200);
  const sumJson = await resSummary.json();
  assert.ok(sumJson.blocks.what_changed);
  assert.ok(sumJson.blocks.whats_pending);
  assert.ok(sumJson.blocks.data_gaps);
  assert.ok(sumJson.blocks.evidence);
  console.log(`  ✓ /api/v1/patient/evolution-summary returned ${sumJson.total_items_count} structured items`);

  // Test 3c: POST /api/v1/patient/progress-note-draft
  console.log("  [3c] POST /api/v1/patient/progress-note-draft...");
  const resDraft = await fetch(`${baseUrl}/api/v1/patient/progress-note-draft`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      summaryData: sumJson,
      selectedItemIds: selectedIds,
      doctorId: "DOC-8021",
      doctorName: "林德明 (主任医师)",
    }),
  });
  assert.equal(resDraft.status, 200);
  const draftJson = await resDraft.json();
  assert.ok(draftJson.draft_text);
  assert.equal(draftJson.doctor_id, "DOC-8021");
  console.log("  ✓ /api/v1/patient/progress-note-draft created physician-confirmed draft");

  // Test 3d: CDS Hook POST /cds-services/medcius-patient-evolution (Fail-Closed on empty context)
  console.log("  [3d] POST /cds-services/medcius-patient-evolution (Fail-Closed check)...");
  const resHookEmpty = await fetch(`${baseUrl}/cds-services/medcius-patient-evolution`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      hook: "patient-view",
      context: {},
    }),
  });
  assert.equal(resHookEmpty.status, 200);
  const hookEmptyJson = await resHookEmpty.json();
  assert.ok(hookEmptyJson.cards[0].summary.includes("未检出有效患者上下文"));
  console.log("  ✓ CDS Hook properly failed-closed when patient context was absent");

  console.log("\nALL INPATIENT PRE-ROUND EVOLUTION SUMMARY TESTS PASSED!");
} finally {
  server.close();
}
