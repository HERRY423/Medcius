// Synthetic engineering regressions; no real patient data or clinical outcomes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { calculateChineseMdrd, classifyChineseAdultBmi } from "../plugins/medcius/lib/calculation-reference.mjs";
import { evaluateChinaClinicalRules } from "../plugins/medcius/lib/china-clinical-rules.mjs";
import { listChinaSpecialtyRulePacks, loadChinaSpecialtyRulePack } from "../plugins/medcius/lib/specialty-rule-pack.mjs";
import { prepareChinaPharmacyCatalog, resolveChinaPharmacyRecord, selectChinaPharmacyCatalog, checkChinaMedicationSafety, buildChinaMedicationCoverage } from "../plugins/medcius/lib/china-pharmacy-catalog.mjs";
import { buildPatientAffordabilityContext } from "../plugins/medcius/lib/patient-affordability-context.mjs";
import { PatientEvolutionEngine } from "../plugins/medcius/lib/patient-evolution-engine.mjs";
import { HospitalAgentAdapter } from "../plugins/medcius/lib/hospital-agent-adapter.mjs";
import { ReadOnlyHospitalDataBridge } from "../plugins/medcius/lib/read-only-hospital-data-bridge.mjs";
import { createViewLibraryConnectors } from "../plugins/medcius/lib/connectors/view-library-connector.mjs";
import { createPatientSourceSnapshotAsync } from "../plugins/medcius/lib/patient-source-snapshot.mjs";
import { sha256Hex } from "../plugins/medcius/servers/shared/crypto.mjs";

const asOf = "2026-11-02T12:00:00Z";
const context = { patient_id: "synthetic-patient", encounter_id: "synthetic-encounter", tenant_id: "synthetic-hospital", doctor_id: "synthetic-doctor", as_of: asOf, region: "CN-TEST" };
const patient = { id: context.patient_id, age: 50, gender: "male" };
const row = (kind, id, values = {}) => ({ id, kind, ...context, status: "final", recorded_at: "2026-11-02T11:30:00Z",
  source_reference: { source_system: "synthetic-his", resource_id: id }, ...values });
const run = records => evaluateChinaClinicalRules({ records, context, patient, asOf });
const check = (result, code) => result.checks.find(x => x.code === code);
const renal = { age: 50, sex: "male", creatinine: 88.4, creatinine_unit: "umol/L", stable_renal_function: true, adult_ckd: true, pregnant: false, dialysis: false };
const bmi = value => classifyChineseAdultBmi({ age: 25, weight_kg: value * 4, height_cm: 200, pregnant_or_postpartum: false, athlete: false });
const product = { approval_number: "SYNTHETIC-PRODUCT-A", manufacturer: "synthetic-maker", dosage_form: "synthetic-injection", spec: "synthetic-spec" };
const sourceBytes = "SYNTHETIC pharmacy policy; NOT a clinical label or payer determination.\n";
const policy = (kind, id, values = {}) => ({ id, kind, product, data_class: "synthetic", source: {
  organization: "synthetic-pharmacy", url: "https://example.invalid/policy", version: "synthetic-v1", locator: "synthetic table 1",
  document_sha256: sha256Hex(sourceBytes), reviewed_by: "synthetic-reviewer", review_status: "approved" },
  effective_from: "2026-01-01", effective_to: "2026-12-31", region: "CN-TEST", ...values });
const catalog = records => prepareChinaPharmacyCatalog({ schema_version: "medcius.china-pharmacy-catalog.v1", version: "synthetic-v1", records });
const queryContext = { region: "CN-TEST", hospital_id: context.tenant_id, as_of: asOf };
const detector = { execution: "local", id: "synthetic-test-detector", version: "v1", async detect(text) { return { complete: true, text_sha256: sha256Hex(text), spans: [] }; } };

test("Chinese MDRD numerical references, explicit units and non-CKD/unstable exclusions", () => {
  assert.equal(calculateChineseMdrd(renal).value, 86.9);
  assert.equal(calculateChineseMdrd({ ...renal, creatinine: 1, creatinine_unit: "mg/dL" }).value, 86.9);
  assert.equal(calculateChineseMdrd({ ...renal, age: 60, sex: "female", creatinine: 176.8 }).value, 28.2);
  for (const change of [{ age: 17 }, { sex: "unknown" }, { creatinine_unit: null }, { creatinine: NaN }, { creatinine: 0 },
    { stable_renal_function: false }, { stable_renal_function: undefined }, { adult_ckd: false }, { pregnant: true }, { dialysis: true }]) {
    assert.equal(calculateChineseMdrd({ ...renal, ...change }).value, null);
  }
  assert.equal(calculateChineseMdrd(renal).dose_adjustment_basis, false);
});

test("China BMI classifies unrounded 18.5 / 24 / 28 boundaries and abstains outside scope", () => {
  for (const [value, category] of [[18.49, "underweight"], [18.5, "normal"], [23.999, "normal"], [24, "overweight"], [27.999, "overweight"], [28, "obesity"]]) assert.equal(bmi(value).category, category);
  for (const extra of [{ age: 17 }, { pregnant_or_postpartum: true }, { athlete: true }, { height_cm: 0 }, { weight_kg: Infinity }]) {
    assert.equal(classifyChineseAdultBmi({ age: 50, weight_kg: 70, height_cm: 170, athlete: false, pregnant_or_postpartum: false, ...extra }).value, null);
  }
});

test("national reference packs preserve provenance and explicit cohort eligibility", () => {
  assert.equal(listChinaSpecialtyRulePacks().length, 7);
  for (const id of listChinaSpecialtyRulePacks()) assert.ok(loadChinaSpecialtyRulePack(id).source_reference.url.startsWith("https://"));
  for (const packId of ["cn-stemi", "cn-heart-failure", "cn-pneumonia", "cn-cerebral-infarction"]) {
    const enrollment = row("disease_enrollment", "enrol", { pack_id: packId, eligible: true, criteria_version: "NHC-2020", eligibility_source_id: "diagnosis-1" });
    const pack = loadChinaSpecialtyRulePack(packId);
    const result = run([enrollment, row("quality_node", "node", { enrollment_id: "enrol", node_id: pack.nodes[0][0], performed: true })]);
    assert.equal(check(result, pack.nodes[0][0]).status, "documented");
    assert.equal(check(result, pack.nodes[1][0]).status, "unknown");
    assert.equal(result.institutional_rates, null);
    assert.equal(check(run([{ ...enrollment, eligible: undefined }]), "DISEASE_ELIGIBILITY_UNKNOWN").status, "unknown");
  }
});

test("future, conflicting, unowned, cancelled and cross-patient records cannot satisfy checks", () => {
  const base = row("anthropometry", "bmi", { weight_kg: 70, height_cm: 170, pregnant_or_postpartum: false, athlete: false });
  for (const changes of [{ recorded_at: "2027-01-01T12:00:00Z" }, { source_reference: null }, { tenant_id: undefined }, { status: "cancelled" }, { kind: "anything" }]) {
    const r = run([{ ...base, ...changes }]);
    assert.equal(r.calculations.china_adult_bmi.value, null);
    assert.ok(check(r, "CLINICAL_RECORD_EXCLUDED"));
  }
  assert.equal(run([base, { ...base, weight_kg: 80 }]).calculations.china_adult_bmi.value, null);
  assert.throws(() => run([{ ...base, patient_id: "other-patient" }]), /CONTEXT_MISMATCH/);
});

test("2025 core monitoring covers source-bound records without fabricating a hospital rate", () => {
  const scope = row("core_quality_scope", "core");
  const result = run([scope, row("quality_node", "round", { enrollment_id: "core", node_id: "CN-CORE-ROUND", performed: true }),
    row("quality_node", "surgery", { enrollment_id: "core", node_id: "CN-CORE-SURGICAL", not_applicable: true, reason_code: "NO_SURGERY" })]);
  assert.equal(check(result, "CN-CORE-ROUND").status, "documented");
  assert.equal(check(result, "CN-CORE-CONSULT").status, "unknown");
  assert.equal(check(result, "CN-CORE-SURGICAL").status, "exception_documented");
  assert.equal(result.institutional_rates, null);
});

test("Padua/Caprini checks require explicit factors, bleeding, prevention and re-assessment", () => {
  const base = row("vte_assessment", "vte", { population: "medical", tool: "Padua", tool_version: "2010", assessed_at: "2026-11-02T10:00:00Z", score: 4,
    factors_complete: true, bleeding_risk_assessed: true, prevention_decision_documented: true });
  assert.ok(run([base]).checks.every(x => x.status === "documented"));
  for (const change of [{ tool: "Caprini" }, { tool_version: undefined }, { factors_complete: false }, { score: undefined }, { last_clinical_change_at: "2026-11-02T11:00:00Z" }]) assert.equal(check(run([{ ...base, ...change }]), "VTE_SCALE").status, "unknown");
  assert.equal(check(run([{ ...base, bleeding_risk_assessed: undefined }]), "VTE_BLEEDING").status, "unknown");
  assert.equal(check(run([row("vte_requirement", "requirement")]), "VTE_ASSESSMENT_MISSING").status, "unknown");
});

const op = values => row("perioperative_antibiotic", "op", { purpose: "prophylaxis", route: "IV", agent_class: "standard", incision_class: "I",
  incision_at: "2026-11-01T10:00:00Z", infusion_started_at: "2026-11-01T09:00:00Z", infusion_completed_at: "2026-11-01T09:30:00Z", prophylaxis_stopped_at: "2026-11-02T09:00:00Z", ...values });
test("perioperative administration windows include endpoints and long-infusion exceptions", () => {
  assert.equal(check(run([op()]), "PERIOP_FIRST_DOSE").status, "documented");
  assert.equal(check(run([op({ infusion_started_at: "2026-11-01T09:31:00Z", infusion_completed_at: "2026-11-01T09:50:00Z" })]), "PERIOP_FIRST_DOSE").status, "review_required");
  assert.equal(check(run([op({ agent_class: "vancomycin", infusion_started_at: "2026-11-01T08:00:00Z" })]), "PERIOP_FIRST_DOSE").status, "documented");
  assert.equal(check(run([op({ infusion_completed_at: "2026-11-01T10:10:00Z" })]), "PERIOP_FIRST_DOSE").status, "review_required");
  assert.equal(check(run([op({ infusion_started_at: null })]), "PERIOP_FIRST_DOSE").status, "unknown");
});
test("clean-incision duration checks 24h/48h exceptions, ongoing course and invalid time", () => {
  assert.equal(check(run([op()]), "PERIOP_CLASS_I_DURATION").status, "documented");
  assert.equal(check(run([op({ prophylaxis_stopped_at: "2026-11-02T09:01:00Z" })]), "PERIOP_CLASS_I_DURATION").status, "review_required");
  assert.equal(check(run([op({ prophylaxis_stopped_at: null, prophylaxis_ongoing: true })]), "PERIOP_CLASS_I_DURATION").status, "review_required");
  assert.equal(check(run([op({ cardiac_surgery: true, extension_reviewed: true, extension_source_id: "extension", prophylaxis_stopped_at: "2026-11-02T11:00:00Z" })]), "PERIOP_CLASS_I_DURATION").status, "documented");
  assert.equal(check(run([op({ prophylaxis_stopped_at: "2027-01-01T00:00:00Z" })]), "PERIOP_CLASS_I_DURATION").status, "unknown");
  assert.equal(check(run([op({ purpose: "treatment" })]), "PERIOP_TREATMENT_EXCLUDED").status, "not_applicable");
});

test("versioned pharmacy records match exact product, region, hospital and effective period", () => {
  const grade = policy("antimicrobial_grade", "grade", { grade: "special", hospital_id: context.tenant_id });
  const cat = catalog([grade]);
  assert.equal(resolveChinaPharmacyRecord(cat, "antimicrobial_grade", product, queryContext).record.grade, "special");
  for (const change of [{ region: "elsewhere" }, { hospital_id: "elsewhere" }, { as_of: "2027-01-01T00:00:00Z" }, { as_of: undefined }]) assert.equal(resolveChinaPharmacyRecord(cat, "antimicrobial_grade", product, { ...queryContext, ...change }).status, "unknown");
  assert.equal(resolveChinaPharmacyRecord(cat, "antimicrobial_grade", { ...product, spec: "other" }, queryContext).status, "unknown");
  assert.equal(selectChinaPharmacyCatalog(cat, []).records.length, 0);
  assert.equal(selectChinaPharmacyCatalog(cat, [product]).records.length, 1);
  assert.equal(resolveChinaPharmacyRecord(catalog([grade, { ...grade, id: "conflict" }]), "antimicrobial_grade", product, queryContext).reason, "CATALOG_CONFLICT");
  assert.throws(() => resolveChinaPharmacyRecord(cat, "antimicrobial_grade", product, { ...queryContext, production: true }), /OFFICIAL_REQUIRED/);
  assert.throws(() => catalog([{ ...grade, source: { ...grade.source, review_status: "pending" } }]), /REVIEWED_SOURCE/);
  assert.throws(() => catalog([{ ...grade, confidential_price: 1 }]), /UNSUPPORTED_FIELD/);
});

test("special antibiotic culture collection and authorized consent cannot be replaced by orders or senior rounds", () => {
  const med = row("medication", "med", { ...product, drug_name: "美罗培南", status: "active" });
  const admin = row("antibiotic_administration", "admin", { medication_id: "med", first_dose: true, administered_at: "2026-11-02T10:00:00Z" });
  const culture = row("microbiology", "culture", { medication_id: "med", test_type: "culture", specimen_collected: true, collected_at: "2026-11-02T09:00:00Z" });
  const consent = row("antibiotic_authorization", "consent", { medication_id: "med", consent: true, institution_authorized: true, qualified_senior_expert: true, prescriber_authorized: true, consented_at: "2026-11-02T09:00:00Z" });
  const cat = catalog([policy("antimicrobial_grade", "grade", { grade: "special", hospital_id: context.tenant_id })]);
  const assess = records => evaluateChinaClinicalRules({ records, context, patient, asOf, pharmacyCatalog: cat, region: "CN-TEST" });
  assert.equal(check(assess([med, admin, culture, consent]), "SPECIAL_ANTIBIOTIC_AUTHORIZATION").status, "documented");
  assert.equal(check(assess([med, admin, culture, consent]), "ANTIMICROBIAL_CULTURE").status, "documented");
  assert.equal(check(assess([med, admin, { ...culture, specimen_collected: false }]), "ANTIMICROBIAL_CULTURE").status, "unknown");
  assert.equal(check(assess([med, admin, { ...culture, collected_at: "2026-11-02T11:00:00Z" }]), "ANTIMICROBIAL_CULTURE").status, "unknown");
  assert.equal(check(assess([med, culture, consent]), "ANTIMICROBIAL_CULTURE").status, "unknown");
  const result = assess([med, admin, row("senior_round", "round", { medication_id: "med", senior_qualification: true })]);
  assert.equal(check(result, "SPECIAL_ANTIBIOTIC_SENIOR_ROUND").status, "documented");
  assert.equal(check(result, "SPECIAL_ANTIBIOTIC_AUTHORIZATION").status, "unknown");
});

test("TCM/western overlap includes acetaminophen without asserting liver injury or safety", () => {
  const result = checkChinaMedicationSafety({ medications: [{ id: "a", drug_name: "复方感冒灵颗粒" }, { id: "b", drug_name: "对乙酰氨基酚片" }], catalog: catalog([]), context: queryContext });
  assert.deepEqual(result.findings.find(f => f.code === "ACTIVE_INGREDIENT_DUPLICATION").ingredients, ["acetaminophen"]);
  assert.equal(result.negative_screen_means_safe, false);
  assert.equal(checkChinaMedicationSafety({ medications: [{ id: "a", drug_name: "复方感冒灵" }], catalog: catalog([]) }).findings[0].status, "unknown");
});

test("current local antimicrobial grade takes precedence over a generic special-use candidate", () => {
  const med = row("medication", "med", { ...product, drug_name: "万古霉素", status: "active" });
  for (const grade of ["non_restricted", "restricted", "special"]) {
    const cat = catalog([policy("antimicrobial_grade", "grade", { grade, hospital_id: context.tenant_id })]);
    const r = evaluateChinaClinicalRules({ records: [med], context, patient, asOf, region: "CN-TEST", pharmacyCatalog: cat });
    assert.equal(check(r, "ANTIMICROBIAL_GRADE").details.grade, grade);
    assert.equal(Boolean(check(r, "SPECIAL_ANTIBIOTIC_AUTHORIZATION")), grade === "special");
  }
});

test("TCM injection diluent checks are bound to product, phase, concentration and volume", () => {
  const cat = catalog([policy("product", "label", { ingredients: ["synthetic-tcm"], tcm_injection: true,
    diluents: [{ phase: "infusion", solvent: "glucose", concentration_percent: 5, min_ml: 100, max_ml: 250 }] })]);
  const med = { id: "a", ...product, tcm_injection: true, mixed_with_other_drugs: false, diluents: [{ phase: "infusion", solvent: "glucose", concentration_percent: 5, volume_ml: 200 }] };
  const assess = m => checkChinaMedicationSafety({ medications: [m], catalog: cat, context: queryContext }).findings.find(f => f.code === "TCM_INJECTION_DILUENT");
  assert.equal(assess(med).status, "documented");
  assert.equal(assess({ ...med, diluents: [{ ...med.diluents[0], concentration_percent: 10 }] }).status, "review_required");
  assert.equal(assess({ ...med, spec: "other" }).status, "unknown");
  assert.equal(assess({ ...med, diluents: [] }).status, "unknown");
});

test("A/B, negotiated, dual-channel, VBP and payment limits remain separate scoped facts", () => {
  const cat = catalog([policy("reimbursement", "pay", { category: "B", negotiated: true, catalog_code: "SYNTHETIC-CODE", payment_scope: "SYNTHETIC indication restriction" }),
    policy("dual_channel", "channel", { selected: false }), policy("vbp", "vbp", { selected: true, procurement_batch: "synthetic-batch" })]);
  const meds = [{ id: "med", ...product }];
  const coverage = buildChinaMedicationCoverage({ medications: meds, catalog: cat, context: queryContext })[0];
  assert.equal(coverage.insurance_category, "B"); assert.equal(coverage.dual_channel, false); assert.equal(coverage.vbp_selected, true);
  assert.equal(coverage.patient_payment_eligibility, "not_determined"); assert.equal(coverage.automatic_substitution, false);
  const unscoped = buildChinaMedicationCoverage({ medications: meds, catalog: cat, context: { ...queryContext, region: "elsewhere" } })[0];
  assert.equal(unscoped.insurance_category, null); assert.equal(unscoped.dual_channel, null);
  const access = buildPatientAffordabilityContext({ medications: meds, pharmacyCatalog: cat, context, region: "CN-TEST", asOf });
  assert.equal(access.medication_coverage_context[0].insurance_category, "B");
  assert.equal(access.boundary.affects_clinical_discharge_verdict, false);
});

test("long-term medication access is visible in round cards and remains a human payment review", () => {
  const cat = catalog([policy("reimbursement", "pay", { category: "A", negotiated: false, catalog_code: "SYNTHETIC-CODE", payment_scope: "SYNTHETIC terms" })]);
  const med = row("medication", "long-term", { ...product, drug_name: "合成药品", therapy_horizon: "long_term" });
  const r = evaluateChinaClinicalRules({ records: [med], context, patient, asOf, region: "CN-TEST", pharmacyCatalog: cat });
  const access = check(r, "CHINA_LONG_TERM_MEDICATION_ACCESS");
  assert.equal(access.status, "review_required");
  assert.equal(access.details.insurance_category, "A");
  assert.equal(access.details.patient_payment_eligibility, "not_determined");
});

test("HIS optional clinical quality view crosses async guard and appears in canonical round cards", async () => {
  const measurement = row("anthropometry", "bmi", { weight_kg: 96, height_cm: 200, pregnant_or_postpartum: false, athlete: false });
  const connectors = createViewLibraryConnectors({ extraViews: ["clinical_quality"], queryView: async name => name === "v_medcius_patient" ? [{ ...patient, patient_id: patient.id }]
    : name === "v_medcius_encounter" ? [{ id: context.encounter_id, patient_id: patient.id, encounter_id: context.encounter_id, status: "in-progress", class: "IMP" }]
      : name === "v_medcius_clinical_quality" ? [{ ...measurement, unwanted_sensitive_field: "not-retained" }] : [] });
  const bridge = new ReadOnlyHospitalDataBridge({ connectors, localPhiDetector: detector });
  const read = await bridge.readPatientSnapshot(context);
  assert.equal(read.dataFeeds.clinical_quality.length, 1);
  assert.equal(read.dataFeeds.clinical_quality[0].unwanted_sensitive_field, undefined);
  const response = await HospitalAgentAdapter.executePreRoundWorkflowAsync({ context, dataFeeds: read.dataFeeds, localPhiDetector: detector });
  assert.equal(response.summary.patient.china_adult_bmi.category, "overweight");
  assert.ok(response.summary.selectable_items.some(x => x.check_code === "CHINESE_ADULT_BMI"));
  assert.match(response.summary.selectable_items.find(x => x.check_code === "CHINESE_ADULT_BMI").summary, /BMI 24 kg\/m²，超重/);
  const snapshot = await createPatientSourceSnapshotAsync({ context, patient, encounter: { id: context.encounter_id }, asOf, chinaClinical: { records: [measurement] } }, { detector });
  assert.equal(snapshot.china_clinical.records[0].id, "bmi");
});

test("new renal estimates honor observed creatinine instability and preserve original CKD-EPI field", () => {
  const input = { context, patient, now: asOf, chinaClinical: { records: [row("renal_assessment", "renal", renal)] },
    observations: [{ id: "cr-1", code: "scr", value: 88.4, unit: "umol/L", effective_time: "2026-11-01T15:00:00Z" },
      { id: "cr-2", code: "scr", value: 176.8, unit: "umol/L", effective_time: "2026-11-02T10:00:00Z" }] };
  const result = PatientEvolutionEngine.analyzePatientEvolution(input);
  assert.equal(result.patient.egfr, null);
  assert.equal(result.patient.chinese_mdrd.value, null);
  assert.equal(check(result.blocks.china_clinical_checks, "CHINESE_MDRD").status, "unknown");
});

test("offline catalog import verifies source bytes, rejects overwrite and rejects samples for production", () => {
  const dir = mkdtempSync(join(tmpdir(), "medcius-cn-import-")); const docs = join(dir, "docs"); mkdirSync(docs);
  writeFileSync(join(docs, "synthetic.txt"), sourceBytes);
  const input = join(dir, "input.json"), output = join(dir, "output.json");
  writeFileSync(input, JSON.stringify(catalog([policy("product", "label", { ingredients: ["synthetic"] })])));
  const args = ["scripts/import-cn-pharmacy-catalog.mjs", "--input", input, "--output", output, "--source-dir", docs];
  const result = spawnSync(process.execPath, [...args, "--synthetic"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(output)).records.length, 1);
  assert.notEqual(spawnSync(process.execPath, [...args, "--synthetic"], { encoding: "utf8" }).status, 0);
  assert.notEqual(spawnSync(process.execPath, args, { encoding: "utf8" }).status, 0);
});

test("drug-label tools expose calculators, source checks and ingredient fallback alongside old API", async () => {
  process.env.CLAUDE_MEDCIUS_DATA = mkdtempSync(join(tmpdir(), "medcius-cn-tools-"));
  const { HANDLERS } = await import("../plugins/medcius/servers/drug-labels/src/tools.mjs");
  const { TOOLS } = await import("../plugins/medcius/servers/drug-labels/src/schemas.mjs");
  for (const name of ["calc_cn_reference", "china_pharmacy_lookup", "check_cn_clinical"]) assert.ok(TOOLS.some(t => t.name === name) && HANDLERS[name]);
  assert.equal(HANDLERS.calc_cn_reference({ calculation: "c_mdrd_175", inputs: renal }).value, 86.9);
  const dup = HANDLERS.check_duplicate_therapy({ drugs: ["复方感冒灵片", "对乙酰氨基酚片"] });
  assert.ok(dup.china_ingredient_screen.findings.some(f => f.code === "ACTIVE_INGREDIENT_DUPLICATION"));
  assert.equal(HANDLERS.corpus_status().production_ready, false);
});
