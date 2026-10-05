#!/usr/bin/env node
// Medcius Multi-Center Shadow-Mode Study Engine
// Implements: Double-blind independent pharmacist annotation, 3rd person adjudication,
// multi-center/department/drug stratification, and pre-registered endpoint verification.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wilsonScore, mcnemarExact } from "../clinical-validation/run.mjs";
import { canonicalJson, sha256Hex } from "../../servers/shared/crypto.mjs";
import { inspectEvaluationKeys, resolveCallerEvidenceStatus } from "../evidence-status.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..", "..");
const isBinaryRating = (value) => value === "flag" || value === "clear";

/**
 * Compute Cohen's Kappa between two independent annotators.
 */
export function computeCohensKappa(raterA, raterB) {
  let a1_b1 = 0, a1_b0 = 0, a0_b1 = 0, a0_b0 = 0;
  if (!Array.isArray(raterA) || !Array.isArray(raterB)) return null;
  const n = raterA.length;
  if (n === 0 || raterB.length !== n) return null;
  if (!raterA.every(isBinaryRating) || !raterB.every(isBinaryRating)) return null;

  for (let i = 0; i < n; i++) {
    const a = raterA[i] === "flag";
    const b = raterB[i] === "flag";
    if (a && b) a1_b1++;
    else if (a && !b) a1_b0++;
    else if (!a && b) a0_b1++;
    else a0_b0++;
  }

  const po = (a1_b1 + a0_b0) / n;
  const pA_flag = (a1_b1 + a1_b0) / n;
  const pA_clear = (a0_b1 + a0_b0) / n;
  const pB_flag = (a1_b1 + a0_b1) / n;
  const pB_clear = (a1_b0 + a0_b0) / n;

  const pe = pA_flag * pB_flag + pA_clear * pB_clear;
  if (pe === 1) return null;
  return (po - pe) / (1 - pe);
}

/**
 * Evaluate shadow study records and produce stratified statistics.
 */
export function evaluateShadowStudy(records, options = {}) {
  const isDemo = options.isDemo ?? true;
  const studyMetadata = options.metadata ?? null;
  if (!Array.isArray(records) || records.length === 0) throw new Error("EMPTY_SHADOW_DATASET");
  if (records.some((record) => !record || typeof record !== "object")) throw new Error("INVALID_SHADOW_RECORD");
  const keyIntegrity = inspectEvaluationKeys(records);
  if (keyIntegrity.duplicate_keys) throw new Error("DUPLICATE_SHADOW_KEY");

  // Resolve Final Gold via Double-Blind + Adjudication
  let unadjudicatedCount = 0;
  const resolved = records.map((r) => {
    const agreed = isBinaryRating(r.pharmacist_a) && r.pharmacist_a === r.pharmacist_b;
    let gold = null;
    let unadjudicated = false;
    if (!isBinaryRating(r.pharmacist_a) || !isBinaryRating(r.pharmacist_b)) {
      unadjudicated = true;
    } else if (agreed) {
      gold = r.pharmacist_a;
    } else if (isBinaryRating(r.adjudicator)) {
      gold = r.adjudicator;
    } else {
      unadjudicated = true;
    }
    if (unadjudicated) unadjudicatedCount++;
    return {
      ...r,
      pharmacists_agreed: agreed,
      gold,
      unadjudicated,
    };
  });

  // Calculate Inter-annotator agreement (Cohen's Kappa)
  const kappa = computeCohensKappa(
    resolved.map((r) => r.pharmacist_a),
    resolved.map((r) => r.pharmacist_b),
  );

  const calculateGroup = (subset) => {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    let abstentions = 0;
    let negativeAbstentions = 0;
    let pending = 0;
    for (const r of subset) {
      const abstain = !isBinaryRating(r.predicted);
      if (abstain) abstentions++;
      if (r.unadjudicated || r.gold == null) {
        pending++;
        continue;
      }
      const gold = r.gold === "flag";
      if (abstain) {
        if (gold) fn++;
        else negativeAbstentions++;
        continue;
      }
      const pred = r.predicted === "flag";
      if (pred && gold) tp++;
      else if (pred && !gold) fp++;
      else if (!pred && gold) fn++;
      else tn++;
    }

    const sens = wilsonScore(tp, tp + fn);
    const spec = wilsonScore(tn, tn + fp + negativeAbstentions);
    const ppv = wilsonScore(tp, tp + fp);
    const negativePredictions = subset.filter((r) => !r.unadjudicated && r.gold != null && r.predicted === "clear").length;
    const npv = wilsonScore(tn, negativePredictions);
    const mc = abstentions || pending ? { stat_b: null, stat_c: null, p: null } : mcnemarExact(fp, fn);
    const f1 = 2 * tp + fp + fn > 0 ? 2 * tp / (2 * tp + fp + fn) : null;

    return {
      n: subset.length,
      scored_n: subset.length - pending,
      pending,
      abstentions,
      negative_abstentions: negativeAbstentions,
      tp, fp, fn, tn,
      sensitivity: sens,
      specificity: spec,
      ppv, npv,
      f1: f1 == null ? "n/a" : (f1 * 100).toFixed(1) + "%",
      mcnemar: mc,
    };
  };

  // Groupings
  const overall = calculateGroup(resolved);
  const byCenter = {};
  const byDept = {};
  const byDrugClass = {};

  for (const r of resolved) {
    byCenter[r.hospital_center] = byCenter[r.hospital_center] || [];
    byCenter[r.hospital_center].push(r);

    byDept[r.department] = byDept[r.department] || [];
    byDept[r.department].push(r);

    byDrugClass[r.drug_class] = byDrugClass[r.drug_class] || [];
    byDrugClass[r.drug_class].push(r);
  }

  const centerStats = Object.fromEntries(Object.entries(byCenter).map(([k, v]) => [k, calculateGroup(v)]));
  const deptStats = Object.fromEntries(Object.entries(byDept).map(([k, v]) => [k, calculateGroup(v)]));
  const drugStats = Object.fromEntries(Object.entries(byDrugClass).map(([k, v]) => [k, calculateGroup(v)]));

  // Verify Pre-registered Endpoints
  const endpoints = {
    sensitivity_target_met: (overall.sensitivity.point ?? 0) >= 0.95,
    sensitivity_ci_lower_met: (overall.sensitivity.low ?? 0) >= 0.90,
    specificity_target_met: (overall.specificity.point ?? 0) >= 0.90,
    specificity_ci_lower_met: (overall.specificity.low ?? 0) >= 0.85,
    zero_critical_escape_met: overall.fn === 0 && unadjudicatedCount === 0,
    inter_annotator_kappa_met: typeof kappa === "number" && kappa >= 0.80,
    all_disagreements_adjudicated: unadjudicatedCount === 0,
    no_abstentions: overall.abstentions === 0,
    record_keys_complete: keyIntegrity.complete,
  };

  const allPrimaryMet =
    endpoints.sensitivity_target_met &&
    endpoints.sensitivity_ci_lower_met &&
    endpoints.specificity_target_met &&
    endpoints.specificity_ci_lower_met &&
    endpoints.zero_critical_escape_met &&
    endpoints.inter_annotator_kappa_met &&
    endpoints.all_disagreements_adjudicated &&
    endpoints.no_abstentions &&
    endpoints.record_keys_complete;

  return {
    isDemo,
    studyMetadata,
    total_cases: resolved.length,
    key_integrity: keyIntegrity,
    unadjudicated_cases_count: unadjudicatedCount,
    cohens_kappa: typeof kappa === "number" ? kappa.toFixed(3) : null,
    overall,
    centerStats,
    deptStats,
    drugStats,
    endpoints,
    allPrimaryMet,
    passClassification: resolveCallerEvidenceStatus({ isDemo, metadata: studyMetadata, allPrimaryMet }),
    resolved,
  };
}

/**
 * Validate Real Clinical Study Dataset against mandatory governance & ethics rules.
 * Prohibits synthetic generation; requires signed institutional audit trail.
 */
export function validateRealStudyRequirements(studyData) {
  const errors = [];
  if (!studyData || typeof studyData !== "object") {
    throw new Error("REAL_CLINICAL_STUDY_GATE_ERROR: Empty study payload");
  }

  const meta = studyData.metadata;
  if (!meta) {
    errors.push("Missing study metadata");
  } else {
    if (!meta.ethics_approval_number || !meta.ethics_approval_number.startsWith("IRB-")) {
      errors.push("Missing or invalid IRB ethics approval number (ethics_approval_number must start with 'IRB-')");
    }
    if (!meta.governance_registration_id) {
      errors.push("Missing clinical trial pre-registration ID (governance_registration_id)");
    }
    if (!meta.time_window?.start_date || !meta.time_window?.end_date) {
      errors.push("Missing continuous clinical case time window (time_window.start_date / end_date)");
    }
    if (!Array.isArray(meta.hospital_signoffs) || meta.hospital_signoffs.length < 3) {
      errors.push("Multi-center real study requires signoffs from at least 3 participating hospitals (hospital_signoffs)");
    } else {
      for (const h of meta.hospital_signoffs) {
        if (!h.hospital_code || !h.chief_investigator || !h.digital_signature) {
          errors.push(`Hospital ${h.hospital_code || 'unknown'} missing chief_investigator or digital_signature`);
        }
      }
    }
    if (!Array.isArray(meta.expert_annotators) || meta.expert_annotators.length < 3) {
      errors.push("Multi-center study requires registered expert annotators (Pharmacist A, Pharmacist B, Adjudicator)");
    } else {
      for (const exp of meta.expert_annotators) {
        if (!exp.license_number || !exp.name) {
          errors.push(`Annotator ${exp.name || 'unnamed'} missing pharmacist license number (license_number)`);
        }
      }
    }
    if (!meta.dataset_sha256) {
      errors.push("Missing dataset immutable SHA-256 hash (dataset_sha256)");
    }
  }

  if (!Array.isArray(studyData.records) || studyData.records.length === 0) {
    errors.push("Study dataset contains zero records");
  }

  if (errors.length > 0) {
    const err = new Error(`REAL_CLINICAL_STUDY_GATE_ERROR: ${errors.join("; ")}`);
    err.details = errors;
    throw err;
  }

  return true;
}

/**
 * Generate Representative Multi-Center Shadow Study Dataset for Demo & Pipeline Testing ONLY.
 */
export function generateSampleShadowCases() {
  const centers = ["中心1 (北方综合三甲-DEMO)", "中心2 (华东专科医院-DEMO)", "中心3 (华南综合医院-DEMO)"];
  const depts = ["心血管内科", "儿科", "肾内科", "普通外科", "重症医学科 (ICU)", "急诊科"];
  const drugClasses = ["抗菌药物", "抗凝溶栓药", "心血管用药", "口服降糖药", "中成药复方", "特殊管制药品"];

  const cases = [];
  let caseId = 1;

  for (const center of centers) {
    for (const dept of depts) {
      for (const drugClass of drugClasses) {
        // High concordance baseline (5 clear, 5 flag, 1 edge discrepancy with adjudicator agreement)
        for (let i = 0; i < 5; i++) {
          cases.push({
            case_id: `DEMO-SHADOW-${String(caseId++).padStart(4, "0")}`,
            hospital_center: center,
            department: dept,
            drug_class: drugClass,
            pharmacist_a: "clear",
            pharmacist_b: "clear",
            adjudicator: null,
            predicted: "clear",
            is_synthetic_demo: true,
          });
        }
        for (let i = 0; i < 5; i++) {
          cases.push({
            case_id: `DEMO-SHADOW-${String(caseId++).padStart(4, "0")}`,
            hospital_center: center,
            department: dept,
            drug_class: drugClass,
            pharmacist_a: "flag",
            pharmacist_b: "flag",
            adjudicator: null,
            predicted: "flag",
            is_synthetic_demo: true,
          });
        }
        // Discrepancy Case with Adjudicator (A != B)
        cases.push({
          case_id: `DEMO-SHADOW-${String(caseId++).padStart(4, "0")}`,
          hospital_center: center,
          department: dept,
          drug_class: drugClass,
          pharmacist_a: "flag",
          pharmacist_b: "clear",
          adjudicator: "flag",
          predicted: "flag",
          is_synthetic_demo: true,
        });
      }
    }
  }

  return cases;
}

/**
 * Generate Markdown Report for Multi-Center Shadow Study
 */
export function buildShadowReport(evalRes) {
  const lines = [];
  lines.push(`# Medcius 静默评测统计报告（来源未独立核验）`);
  lines.push("");

  {
    lines.push("> [!CAUTION]");
    lines.push("> **【NOT CLINICAL EVIDENCE】调用参数及伦理编号不能核验数据来源或授予临床证据通过。**");
    lines.push("> **本报告仅为输入数据的描述性评测；DEMO 数据属于合成模拟，严禁作为临床有效性或准入依据。**");
    lines.push("> **真实临床效能通行证必须基于三甲医院伦理审批、真实执业药师双盲标注及数字签名审计链产生。**");
    lines.push("");
  }

  lines.push(`- **研究时间**: ${new Date().toISOString()}`);
  lines.push(`- **调用者声明的性质**: ${evalRes.isDemo ? "合成管线基准模拟 (DEMO BENCHMARK)" : "非演示数据声明（尚未独立核验）"}`);
  lines.push(`- **输入记录总量**: ${evalRes.total_cases} 项；中心 ${Object.keys(evalRes.centerStats).length} 个，科室 ${Object.keys(evalRes.deptStats).length} 个，药物分组 ${Object.keys(evalRes.drugStats).length} 个（分组标签未经核验）`);
  lines.push(`- **统计完整性**: 已解析金标准 ${evalRes.overall.scored_n}，未仲裁/无效评分 ${evalRes.overall.pending}，弃答/无效预测 ${evalRes.overall.abstentions}，缺失记录键 ${evalRes.key_integrity.missing_keys}。上述项目全部保留在输入总数中，并阻止终点通过。`);
  lines.push(`- **双药师一致性 (Cohen's Kappa)**: $\\kappa = ${evalRes.cohens_kappa}$ (${evalRes.endpoints.inter_annotator_kappa_met ? "达成预注册指标 ≥0.80" : "🔴 低于预设指标 0.80"})`);
  lines.push(`- **主要终点总体达成**: ${evalRes.allPrimaryMet ? "🟢 全部达标 (Passed)" : "🔴 未达标 (Deficient)"}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 0. 三级合规通行证分类认定 (Three-Tier Pass Classification)");
  lines.push("");
  lines.push(`| 通行证评级 | 评级状态 | 评定说明 |`);
  lines.push(`|---|---|---|`);
  lines.push(`| **1. 工程验证评级 (engineering_pass)** | ${evalRes.passClassification.engineering_pass ? "🟢 通过 (PASS)" : "🔴 未通过"} | 算法公式、分层统计引擎与置信区间运算无误 |`);
  lines.push(`| **2. 合成管线评级 (synthetic_validation_pass)** | ${evalRes.passClassification.synthetic_validation_pass ? "🟢 通过 (PASS)" : "🔴 未通过"} | 合成模拟数据满足预设测试终点 |`);
  lines.push(`| **3. 临床证据评级 (clinical_evidence_pass)** | ${evalRes.passClassification.clinical_evidence_pass ? "🟢 准入通过 (CLINICAL PASS)" : "🔒 严格阻断 (BLOCKED: 演示数据严禁作为临床证据)"} | 真实医院 IRB 批件、双药师执业资格与独立盲标裁决 |`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 1. 预注册主要终点核验表 (Pre-registered Endpoints)");
  lines.push("");
  lines.push("| 临床效能终点 | 预注册合格门槛 | 实际观测值 (95% CI) | 达标判定 |");
  lines.push("|---|---|---|---|");
  lines.push(`| **总体灵敏度 (Sensitivity)** | $\\ge 95.0\\%$ (CI下限 $\\ge 90.0\\%$) | ${evalRes.overall.sensitivity.str} | ${evalRes.endpoints.sensitivity_target_met && evalRes.endpoints.sensitivity_ci_lower_met ? "✓ 达标" : "✗ 不达标"} |`);
  lines.push(`| **总体特异度 (Specificity)** | $\\ge 90.0\\%$ (CI下限 $\\ge 85.0\\%$) | ${evalRes.overall.specificity.str} | ${evalRes.endpoints.specificity_target_met && evalRes.endpoints.specificity_ci_lower_met ? "✓ 达标" : "✗ 不达标"} |`);
  lines.push(`| **严重禁忌漏报数 (FN)** | $= 0$ 例 (零漏报) | ${evalRes.overall.fn} 例 | ${evalRes.endpoints.zero_critical_escape_met ? "✓ 达标 (0漏报)" : "✗ 存在漏报"} |`);
  lines.push(`| **双药师盲标一致性 (Kappa)** | $\\ge 0.80$ | $\\kappa = ${evalRes.cohens_kappa}$ | ${evalRes.endpoints.inter_annotator_kappa_met ? "✓ 达标" : "✗ 偏低 (需专家仲裁)"} |`);
  lines.push(`| **阳性预测值 (PPV)** | $\\ge 85.0\\%$ | ${evalRes.overall.ppv.str} | ${(evalRes.overall.ppv.point ?? -1) >= 0.85 ? "✓ 达标" : "✗ 未达标或不可计算"} |`);
  lines.push(`| **阴性预测值 (NPV)** | $\\ge 95.0\\%$ | ${evalRes.overall.npv.str} | ${(evalRes.overall.npv.point ?? -1) >= 0.95 ? "✓ 达标" : "✗ 未达标或不可计算"} |`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 2. 医疗机构中心分层效能表 (Hospital Center Stratification)");
  lines.push("");
  lines.push("| 医疗中心名称 | 样本量 (N) | TP | FP | FN | TN | 灵敏度 (95% CI) | 特异度 (95% CI) | PPV | F1 分数 | McNemar p值 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [c, s] of Object.entries(evalRes.centerStats)) {
    lines.push(`| ${c} | ${s.n} | ${s.tp} | ${s.fp} | ${s.fn} | ${s.tn} | ${s.sensitivity.str} | ${s.specificity.str} | ${s.ppv.str} | ${s.f1} | ${s.mcnemar.p == null ? "n/a" : s.mcnemar.p.toFixed(4)} |`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 3. 临床专科科室分层效能表 (Department Stratification)");
  lines.push("");
  lines.push("| 临床科室 | 样本量 (N) | TP | FP | FN | TN | 灵敏度 (95% CI) | 特异度 (95% CI) | F1 分数 |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const [d, s] of Object.entries(evalRes.deptStats)) {
    lines.push(`| ${d} | ${s.n} | ${s.tp} | ${s.fp} | ${s.fn} | ${s.tn} | ${s.sensitivity.str} | ${s.specificity.str} | ${s.f1} |`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 4. 药物大类分层效能表 (Drug Class Stratification)");
  lines.push("");
  lines.push("| 药物大类 | 样本量 (N) | TP | FP | FN | TN | 灵敏度 (95% CI) | 特异度 (95% CI) | F1 分数 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const [dc, s] of Object.entries(evalRes.drugStats)) {
    lines.push(`| ${dc} | ${s.n} | ${s.tp} | ${s.fp} | ${s.fn} | ${s.tn} | ${s.sensitivity.str} | ${s.specificity.str} | ${s.f1} |`);
  }
  lines.push("");

  return lines.join("\n");
}

// Main CLI Execution
if (process.argv[1] && (process.argv[1].endsWith("shadow-study.mjs") || process.argv[1].includes("shadow-study.mjs"))) {
  const args = process.argv.slice(2);
  if (args.includes("--run-demo") || args.includes("--generate-report")) {
    const outDir = join(repoRoot, "out");
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, "shadow-mode-multicenter-report.md");
    const summaryPath = join(outDir, "shadow-mode-multicenter-summary.json");
    writeFileSync(outPath, "# 合成评测未完成 / INVALID\n\nstatus: INVALID\nclinical_evidence_pass: false\n", "utf8");
    writeFileSync(summaryPath, JSON.stringify({ schema_version: "medcius.eval-summary.v1", execution_status: "INCOMPLETE", clinical_evidence_pass: false }, null, 2) + "\n", "utf8");
    const cases = generateSampleShadowCases();
    const res = evaluateShadowStudy(cases, { isDemo: true });
    const reportMd = buildShadowReport(res);

    writeFileSync(outPath, reportMd, "utf8");
    writeFileSync(summaryPath, JSON.stringify({
      schema_version: "medcius.eval-summary.v1", execution_status: "COMPLETED",
      input_sha256: sha256Hex(canonicalJson(cases)), data_source_verified: false,
      total_cases: res.total_cases, overall: res.overall, endpoints: res.endpoints,
      pass_classification: res.passClassification,
    }, null, 2) + "\n", "utf8");

    console.log(`✓ Multi-center shadow-mode study report generated (DEMO MODE): ${outPath}`);
    console.log(`Total Cases: ${res.total_cases} | Kappa: ${res.cohens_kappa} | Kappa Met: ${res.endpoints.inter_annotator_kappa_met} | All Primary Met: ${res.allPrimaryMet}`);
    console.log(`Pass Tiers: engineering=${res.passClassification.engineering_pass}, synthetic=${res.passClassification.synthetic_validation_pass}, clinical_evidence=${res.passClassification.clinical_evidence_pass}`);
  }
}
