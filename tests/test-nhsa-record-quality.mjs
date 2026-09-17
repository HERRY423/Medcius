// Unit & Integration Tests for NHSA Record Quality Engine (病案首页/结算清单要素质量核对)
// Validates: deterministic element gaps (必填要素), algebra conflicts (住院天数/费用代数),
// legality conflicts (离院方式取值、死亡一致性、性别/年龄-诊断章节冲突),
// advisory hints (待查主诊断/肿瘤病理/损伤外部原因), fail-closed behavior,
// catalog restriction keyword hints, settlement integration, and contract-schema shape.
// All fixtures are SYNTHETIC. Not a DRG/DIP grouper; no coding suggestions; no adjudication.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRecordQualityReport } from "../plugins/medcius/lib/nhsa-record-quality-engine.mjs";
import {
  parseCnNote,
  parseEncounterDates,
  parseDischargeMethod,
  parseFees,
  parseCnDate,
} from "../plugins/medcius/lib/parse-cn-note.mjs";
import { settlementFromNote } from "../plugins/medcius/lib/settlement-from-note.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(__dirname, "..", "plugins", "medcius");

console.log("== Testing NHSA Record Quality Engine (病案/结算清单要素质量核对) ==");

// ----------------------------------------------------
// Part 1: Parser extensions (backward-compatible additions)
// ----------------------------------------------------
console.log("\n[Part 1] Parser: dates, stay days, discharge method, fees, pathology...");

const iso = parseCnDate("2024年8月3日");
assert.equal(iso, "2024-08-03");
assert.equal(parseCnDate("2024/08/03"), "2024-08-03");
assert.equal(parseCnDate("2024-13-01"), null);

const dates = parseEncounterDates("入院日期：2024-08-01 出院日期：2024-08-10 住院天数：3天");
assert.equal(dates.admission_date.value, "2024-08-01");
assert.equal(dates.discharge_date.value, "2024-08-10");
assert.equal(dates.recorded_stay_days.value, 3);
assert.equal(dates.computed_stay_days, 10);

const methodNum = parseDischargeMethod("离院方式：5");
assert.equal(methodNum.value, 5);
const methodName = parseDischargeMethod("离院方式：医嘱转院");
assert.equal(methodName.value, 2);
const methodMissing = parseDischargeMethod("无离院方式记载");
assert.equal(methodMissing.value, null);

const fees = parseFees("费用明细：总费用 5,000 元，床位费 200 元，药品费 3,000 元，检验费 1,000 元");
assert.equal(fees.total.value, 5000);
assert.equal(fees.items.length, 3);
assert.equal(fees.sum, 4200);

const qualityNote = `出院记录
患者：测试甲（SYNTHETIC） 性别：女 年龄：55岁
入院日期：2024-08-01 出院日期：2024-08-09
住院天数：9天
离院方式：1 医嘱离院
出院诊断：胃恶性肿瘤
病理：腺癌。
出院医嘱：嘱两周后门诊复查。`;
const parsed = parseCnNote(qualityNote);
assert.equal(parsed.encounter_dates.computed_stay_days, 9);
assert.equal(parsed.discharge_method.value, 1);
assert.ok(parsed.pathology.value.includes("腺癌"));
assert.ok(parsed.discharge_instructions.value.includes("复查"));
console.log("✓ Parser extracts dates/stay-days/method/fees/pathology/instructions");

// ----------------------------------------------------
// Part 2: Element gaps (必填要素缺口)
// ----------------------------------------------------
console.log("\n[Part 2] Element gaps: missing primary diagnosis, missing discharge method, missing dates...");

const rMissingDx = buildRecordQualityReport(`出院记录\n患者：合成（SYNTHETIC） 性别：女 年龄：45岁\n主诉：头晕 3 天。`);
assert.ok(rMissingDx.element_gaps.some((g) => g.code === "PRIMARY_DISCHARGE_DIAGNOSIS_MISSING" && g.severity === "HIGH"));
assert.equal(rMissingDx.check_status, "action_needed");
assert.ok(rMissingDx.element_gaps.some((g) => g.code === "DISCHARGE_METHOD_MISSING"));

const rMissingDates = buildRecordQualityReport(
  "出院记录\n患者：合成（SYNTHETIC） 性别：女 年龄：45岁\n离院方式：1 医嘱离院\n出院诊断：急性阑尾炎",
);
assert.ok(rMissingDates.element_gaps.some((g) => g.code === "ENCOUNTER_DATE_MISSING"));

console.log("✓ Element gaps reported with HIGH/MEDIUM severity and fail-closed statuses");

// ----------------------------------------------------
// Part 3: Algebra conflicts (确定性代数校验)
// ----------------------------------------------------
console.log("\n[Part 3] Algebra: stay-days mismatch, fee total unbalanced, no false positives when balanced...");

const rStay = buildRecordQualityReport(
  "出院记录\n性别：男 年龄：58岁\n入院日期：2024-08-01 出院日期：2024-08-10\n住院天数：3天\n离院方式：1\n出院诊断：急性胆囊炎",
);
const stayFinding = rStay.algebra_conflicts.find((f) => f.code === "STAY_DAYS_MISMATCH");
assert.ok(stayFinding);
assert.equal(stayFinding.evidence.expected, 10);
assert.equal(stayFinding.evidence.actual, 3);
assert.ok(stayFinding.evidence.span.includes("住院天数"));

const rFee = buildRecordQualityReport(
  "出院记录\n性别：女 年龄：62岁\n入院日期：2024-08-01 出院日期：2024-08-08\n住院天数：8天\n离院方式：1\n出院诊断：2型糖尿病\n费用明细：总费用 5000 元，床位费 200 元，药品费 3000 元，检验费 1000 元，护理费 100 元",
);
const feeFinding = rFee.algebra_conflicts.find((f) => f.code === "FEE_TOTAL_UNBALANCED");
assert.ok(feeFinding);
assert.equal(feeFinding.evidence.expected, 4300);
assert.equal(feeFinding.evidence.actual, 5000);

const rBalanced = buildRecordQualityReport(
  "出院记录\n性别：女 年龄：62岁\n入院日期：2024-08-01 出院日期：2024-08-08\n住院天数：8天\n离院方式：1\n出院诊断：2型糖尿病\n费用明细：总费用 4300 元，床位费 200 元，药品费 3000 元，检验费 1000 元，护理费 100 元",
);
assert.ok(!rBalanced.algebra_conflicts.some((f) => f.code === "FEE_TOTAL_UNBALANCED"));

console.log("✓ Algebra conflicts computed deterministically with span-bound evidence");

// ----------------------------------------------------
// Part 4: Legality conflicts (取值域与人群-章节规则)
// ----------------------------------------------------
console.log("\n[Part 4] Legality: illegal discharge method, death consistency, obstetric/neonatal conflicts...");

const rMethod = buildRecordQualityReport(
  "出院记录\n性别：女 年龄：30岁\n入院日期：2024-08-01 出院日期：2024-08-08\n住院天数：8天\n离院方式：7\n出院诊断：急性阑尾炎",
);
assert.ok(rMethod.legality_conflicts.some((f) => f.code === "DISCHARGE_METHOD_ILLEGAL" && f.evidence.actual === 7));

const rDeathMissing = buildRecordQualityReport(
  "出院记录\n性别：男 年龄：70岁\n入院日期：2024-08-01 出院日期：2024-08-05\n住院天数：5天\n离院方式：5 死亡\n出院诊断：急性心肌梗死",
);
assert.ok(rDeathMissing.legality_conflicts.some((f) => f.code === "DEATH_METHOD_WITHOUT_DEATH_RECORD"));

const rDeathOk = buildRecordQualityReport(
  "出院记录\n性别：男 年龄：70岁\n入院日期：2024-08-01 出院日期：2024-08-05\n住院天数：5天\n离院方式：5 死亡\n出院诊断：急性心肌梗死\n死亡记录：患者于 2024-08-05 09:30 临床死亡。",
);
assert.ok(!rDeathOk.legality_conflicts.some((f) => f.code === "DEATH_METHOD_WITHOUT_DEATH_RECORD"));

const rObstetric = buildRecordQualityReport(
  "出院记录\n性别：男 年龄：34岁\n入院日期：2024-08-01 出院日期：2024-08-06\n住院天数：6天\n离院方式：1\n出院诊断：宫内妊娠 分娩",
);
assert.ok(rObstetric.legality_conflicts.some((f) => f.code === "OBSTETRIC_DIAGNOSIS_SEX_CONFLICT"));
assert.ok(!rObstetric.legality_conflicts.some((f) => f.code === "NEONATAL_DIAGNOSIS_AGE_CONFLICT"));

const rNeonatal = buildRecordQualityReport(
  "出院记录\n性别：男 年龄：67岁\n入院日期：2024-08-01 出院日期：2024-08-12\n住院天数：12天\n离院方式：1\n出院诊断：新生儿肺炎",
);
assert.ok(rNeonatal.legality_conflicts.some((f) => f.code === "NEONATAL_DIAGNOSIS_AGE_CONFLICT"));

// Chapter-prefix rule from resolved codes (no keyword needed)
const rCodePrefix = buildRecordQualityReport(
  "出院记录\n性别：男 年龄：34岁\n入院日期：2024-08-01 出院日期：2024-08-06\n住院天数：6天\n离院方式：1\n出院诊断：某某病",
  { diagnosis_codes: [{ code: "O80.000", kind: "diagnosis" }] },
);
assert.ok(rCodePrefix.legality_conflicts.some((f) => f.code === "OBSTETRIC_DIAGNOSIS_SEX_CONFLICT"));

// Discharge date before admission date
const rReversed = buildRecordQualityReport(
  "出院记录\n性别：女 年龄：30岁\n入院日期：2024-08-10 出院日期：2024-08-01\n住院天数：2天\n离院方式：1\n出院诊断：急性阑尾炎",
);
assert.ok(rReversed.legality_conflicts.some((f) => f.code === "DISCHARGE_BEFORE_ADMISSION"));

console.log("✓ Legality conflicts: value domain, death documentation, O/P chapter conflicts, date order");

// ----------------------------------------------------
// Part 5: Advisory hints (提示级，不构成判定)
// ----------------------------------------------------
console.log("\n[Part 5] Advisory hints: uncertain primary, tumor/pathology, external cause...");

const rUncertain = buildRecordQualityReport(
  "出院记录\n性别：男 年龄：50岁\n入院日期：2024-08-01 出院日期：2024-08-03\n住院天数：3天\n离院方式：1\n出院诊断：发热待查",
);
assert.ok(rUncertain.advisory_hints.some((f) => f.code === "UNCERTAIN_PRIMARY_DIAGNOSIS"));

const rTumor = buildRecordQualityReport(
  "出院记录\n性别：男 年龄：60岁\n入院日期：2024-08-01 出院日期：2024-08-09\n住院天数：9天\n离院方式：1\n出院诊断：胃恶性肿瘤",
);
assert.ok(rTumor.advisory_hints.some((f) => f.code === "TUMOR_PATHOLOGY_HINT"));

const rTrauma = buildRecordQualityReport(
  "出院记录\n性别：男 年龄：30岁\n入院日期：2024-08-01 出院日期：2024-08-05\n住院天数：5天\n离院方式：1\n出院诊断：胫骨骨折",
);
assert.ok(rTrauma.advisory_hints.some((f) => f.code === "EXTERNAL_CAUSE_HINT"));

console.log("✓ Advisory hints fired for uncertain/tumor/trauma cases");

// ----------------------------------------------------
// Part 6: Clean note passes and boundary flags hold
// ----------------------------------------------------
console.log("\n[Part 6] Clean note: check_status=pass, boundary never a grouper/coder/adjudicator...");

const clean = buildRecordQualityReport(qualityNote);
assert.equal(clean.check_status, "pass");
assert.equal(clean.element_gaps.length, 0);
assert.equal(clean.algebra_conflicts.length, 0);
assert.equal(clean.legality_conflicts.length, 0);
assert.equal(clean.boundary.is_drg_dip_grouper, false);
assert.equal(clean.boundary.outputs_coding_suggestions, false);
assert.equal(clean.boundary.adjudicates_reimbursement, false);
assert.equal(clean.boundary.affects_clinical_care, false);
assert.ok(clean.disclaimer.includes("不代表清单整体合格"));
console.log("✓ Clean synthetic note passes with all boundary flags false");

// ----------------------------------------------------
// Part 7: Fail-closed behavior
// ----------------------------------------------------
console.log("\n[Part 7] Fail-closed on empty/non-string input...");
assert.throws(() => buildRecordQualityReport(""), /RECORD_TEXT_REQUIRED/);
assert.throws(() => buildRecordQualityReport(null), /RECORD_TEXT_REQUIRED/);
console.log("✓ Empty input fails closed with RECORD_TEXT_REQUIRED");

// ----------------------------------------------------
// Part 8: Settlement integration (settlementFromNote carries record_quality)
// ----------------------------------------------------
console.log("\n[Part 8] Settlement integration: record_quality wired into settlement report...");
const { HANDLERS } = await import("../plugins/medcius/servers/china-codes/src/tools.mjs");
const sampleNote = readFileSync(join(PLUGIN, "skills/clinical-note-extract/assets/sample-note.md"), "utf8");
const settlement = settlementFromNote(sampleNote, HANDLERS);
assert.ok(settlement.record_quality);
assert.equal(settlement.record_quality.schema_version, "medcius.nhsa-record-quality-report.v1");
assert.ok(Array.isArray(settlement.record_quality.element_gaps));
assert.equal(settlement.record_quality.boundary.is_drg_dip_grouper, false);
console.log("✓ settlementFromNote output includes record_quality report");

// ----------------------------------------------------
// Part 9: MCP handlers (check_record_quality / check_catalog_restriction)
// ----------------------------------------------------
console.log("\n[Part 9] MCP tool handlers...");
const rqTool = HANDLERS.check_record_quality({ note_text: "出院记录\n性别：男 年龄：67岁\n入院日期：2024-08-01 出院日期：2024-08-10\n住院天数：3天\n离院方式：7\n出院诊断：新生儿肺炎" });
assert.ok(rqTool.legality_conflicts.some((f) => f.code === "DISCHARGE_METHOD_ILLEGAL"));
assert.ok(rqTool.legality_conflicts.some((f) => f.code === "NEONATAL_DIAGNOSIS_AGE_CONFLICT"));
assert.ok(rqTool.algebra_conflicts.some((f) => f.code === "STAY_DAYS_MISMATCH"));
const rqErr = HANDLERS.check_record_quality({});
assert.ok(rqErr.error);

// Ensure sample corpus is seeded for catalog restriction probes (deterministic offline)
import { spawnSync } from "node:child_process";
const catCount = (() => {
  try {
    return HANDLERS.search_drug_catalog({ query: "示例谈判药片", include_samples: true }).hit_count;
  } catch {
    return 0;
  }
})();
if (catCount === 0) {
  const r = spawnSync("node", [join(PLUGIN, "servers/china-codes/scripts/ingest.mjs"), "--sample"], { encoding: "utf8" });
  assert.equal(r.status, 0, "china-codes sample ingest failed");
}

const crReview = HANDLERS.check_catalog_restriction({ drug_name: "示例谈判药片", diagnosis_terms: ["高血压"], include_samples: true });
assert.equal(crReview.status, "restriction_review_needed");
assert.equal(crReview.matched_terms.length, 0);
assert.ok(crReview.code_version);
assert.ok(!/不能报销|医保违规/.test(JSON.stringify(crReview)));

const crMatch = HANDLERS.check_catalog_restriction({ drug_name: "示例谈判药片", diagnosis_terms: ["二线治疗"], include_samples: true });
assert.equal(crMatch.status, "restriction_keyword_match");
assert.deepEqual(crMatch.matched_terms, ["二线治疗"]);

const crMiss = HANDLERS.check_catalog_restriction({ drug_name: "不存在的药XYZ", diagnosis_terms: ["高血压"], include_samples: true });
assert.equal(crMiss.status, "not_in_catalog_corpus");
assert.ok(crMiss.coverage_note);

const crSampleExcluded = HANDLERS.check_catalog_restriction({ drug_name: "示例谈判药片", diagnosis_terms: ["高血压"] });
assert.equal(crSampleExcluded.status, "not_in_catalog_corpus");
console.log("✓ check_record_quality and check_catalog_restriction behave deterministically");

// ----------------------------------------------------
// Part 10: Contract schema shape
// ----------------------------------------------------
console.log("\n[Part 10] Contract schema registration and output shape...");
const schema = JSON.parse(readFileSync(join(PLUGIN, "contracts/china-record-quality-report.v1.schema.json"), "utf8"));
assert.equal(schema.$id, "https://medcius.local/schemas/china-record-quality-report.v1.schema.json");
assert.equal(schema.properties.boundary.properties.is_drg_dip_grouper.const, false);
const knownCodes = new Set(schema.$defs.finding.properties.code.enum);
const report = buildRecordQualityReport(
  "出院记录\n性别：女 年龄：30岁\n入院日期：2024-08-01 出院日期：2024-08-08\n住院天数：9天\n离院方式：7\n出院诊断：胃恶性肿瘤\n费用明细：总费用 5000 元，床位费 200 元",
);
for (const pool of ["element_gaps", "algebra_conflicts", "legality_conflicts", "advisory_hints"]) {
  for (const f of report[pool]) {
    assert.ok(knownCodes.has(f.code), `unknown finding code ${f.code}`);
    assert.ok(["HIGH", "MEDIUM", "LOW"].includes(f.severity));
    assert.ok(typeof f.message === "string" && f.message.length > 0);
    assert.ok("section" in f.evidence && "span" in f.evidence);
  }
}
console.log("✓ All emitted finding codes exist in the v1 contract schema");

console.log("\nALL NHSA RECORD QUALITY TESTS PASSED");
