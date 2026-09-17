#!/usr/bin/env node
// Real-World Noise Robustness Benchmark (真实病历脏数据鲁棒性基准 · 缺口二).
//
// What this measures and what it does NOT:
//   - It measures the DETERMINISTIC parsing/extraction layer (parse-cn-note)
//     against structurally realistic note corruption: non-standard headings,
//     abbreviation dialects, section reordering, whitespace chaos, OCR
//     confusion and scan artifacts. This is the robustness floor of everything
//     downstream (编码、病案质量核对、结算清单、查房摘要都吃这一层).
//   - It does NOT measure clinical accuracy, LLM extraction behavior, or any
//     real-world deployment claim. Noise-simulated robustness ≠ real-world
//     evidence; the real-data instrument is ingest-real-data.mjs.
//
// CI gate: clean baseline must be perfect; the noisy floor must stay above
// NOISE_FLOOR (regression tripwire); the whole run must be deterministic
// (re-run produces byte-identical results).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../../servers/shared/crypto.mjs";
import { NOISE_MODELS, applyNoise } from "./noise-models.mjs";
import { gradeNoteText } from "./grader.mjs";
import { wilsonScore } from "../clinical-validation/run.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = join(__dirname, "../../skills/clinical-note-extract/assets/china-notes");
const GOLD = JSON.parse(readFileSync(join(NOTES_DIR, "expected.json"), "utf8"));
const REPORTS_DIR = join(__dirname, "reports");
const SEEDS = [1, 2, 3];
// Regression tripwire. Deterministic parser + deterministic noise => stable
// across machines; raise the floor as the parser gets more robust, never lower
// it to make a failing change pass. Baseline 2026-08-30: combined 70.0%.
const NOISE_FLOOR = 0.65;

function loadCases() {
  const cases = [];
  for (const file of readdirSync(NOTES_DIR).filter((f) => /^\d\d-.*\.md$/.test(f)).sort()) {
    const key = file.replace(/\.md$/, "");
    if (!GOLD[key]) continue; // notes 11-16 have dedicated checks in china-skills
    cases.push({ note_id: key, text: readFileSync(join(NOTES_DIR, file), "utf8"), gold: GOLD[key] });
  }
  if (!cases.length) throw new Error("NOISE_BENCHMARK_CASES_EMPTY");
  return cases;
}

function runMatrix(cases) {
  const results = {};
  const models = ["clean", ...Object.keys(NOISE_MODELS)];
  for (const model of models) {
    const perModel = { notes_exact: 0, fields_passed: 0, fields_total: 0, per_note: {} };
    for (const seed of SEEDS) {
      for (const testCase of cases) {
        const noisy = model === "clean" ? testCase.text : applyNoise(testCase.text, model, seed);
        const graded = gradeNoteText(noisy, testCase.gold);
        perModel.fields_total += graded.fields_total;
        perModel.fields_passed += graded.fields_passed;
        if (graded.exact) perModel.notes_exact += 1;
        const key = `${testCase.note_id}#s${seed}`;
        perModel.per_note[key] = { exact: graded.exact, field_rate: graded.fields_total ? graded.fields_passed / graded.fields_total : 0, failures: graded.failures.slice(0, 5) };
      }
    }
    const noteRuns = cases.length * SEEDS.length;
    perModel.note_exact_rate = wilsonScore(perModel.notes_exact, noteRuns);
    perModel.field_rate = perModel.fields_total ? perModel.fields_passed / perModel.fields_total : 0;
    results[model] = perModel;
  }
  return results;
}

function buildReport(results, cases) {
  const lines = [];
  lines.push("# 真实病历脏数据鲁棒性基准（Noise Robustness Baseline）");
  lines.push("");
  lines.push("> 自动生成：`plugins/medcius/evals/real-world-noise/run-noise-benchmark.mjs`；确定性输出，同 seed 同结果。");
  lines.push("> 衡量对象：`parse-cn-note` 确定性解析层在结构性脏数据（非标标题/缩写方言/乱序/空白混乱/OCR 混淆/扫描件伪影）下的字段抽取保持率。");
  lines.push("> **不是临床证据**：噪声模拟 ≠ 真实世界数据；真实脱敏数据走 `ingest-real-data.mjs` 同一量具。");
  lines.push(`> 样例：${cases.length} 份合成病历（gold 覆盖 cne-01..10）× ${SEEDS.length} 个 seed × ${Object.keys(NOISE_MODELS).length} 个噪声模型。`);
  lines.push("");
  lines.push("| 噪声模型 | note 全字段命中率 (95% CI) | 字段级保持率 |");
  lines.push("|---|---|---|");
  for (const [model, r] of Object.entries(results)) {
    lines.push(`| ${model} | ${(r.note_exact_rate.point * 100).toFixed(1)}% [${(r.note_exact_rate.low * 100).toFixed(1)}%~${(r.note_exact_rate.high * 100).toFixed(1)}%] | ${(r.field_rate * 100).toFixed(1)}% |`);
  }
  lines.push("");
  lines.push("## 解读纪律");
  lines.push("");
  lines.push(`1. clean 基线必须 100%——任何下降即解析层回归（china-skills 确定性评测同步把关）；`);
  lines.push(`2. combined 下限 ${NOISE_FLOOR ? (NOISE_FLOOR * 100).toFixed(0) + "%" : "—"} 为回归绊线：只有解析器更鲁棒时才允许上调，禁止为了让变更通过而下调；`);
  lines.push(`3. OCR 混淆维度的下降是确定性解析器的结构性边界——真实病历的最终抽取应依赖 LLM 抽取层（clinical-note-extract 技能）+ 人工复核，本基准为其提供对照下限；`);
  lines.push(`4. 每字段失败明细见 reports/noise-robustness-baseline.json（per_note.failures），优先修复 heading_variants 与 whitespace_chaos 可恢复的失败。`);
  return lines.join("\n");
}

// ---- main ----
const cases = loadCases();
const results = runMatrix(cases);

const clean = results.clean;
if (!clean || clean.note_exact_rate.point !== 1) {
  console.error(`[CRITICAL] clean baseline broken: ${clean ? clean.note_exact_rate.point : "n/a"} — parser regression on the untouched synthetic corpus.`);
  process.exit(1);
}
const combined = results.combined;
if (combined.note_exact_rate.point < NOISE_FLOOR) {
  console.error(`[CRITICAL] combined noise exact-rate ${combined.note_exact_rate.point} below floor ${NOISE_FLOOR}. Parser robustness regressed — fix or (only if genuinely more robust) raise the floor.`);
  process.exit(1);
}

mkdirSync(REPORTS_DIR, { recursive: true });
const reportMd = buildReport(results, cases);
const payload = { generated_at: "deterministic-replay", seeds: SEEDS, noise_floor: NOISE_FLOOR, case_count: cases.length, results };
const payloadJson = JSON.stringify(payload, null, 2);
const digest = sha256Hex(payloadJson);

// Determinism guard: a second full run must be byte-identical.
const rerun = runMatrix(cases);
if (JSON.stringify(rerun) !== JSON.stringify(results)) {
  console.error("[CRITICAL] benchmark is not deterministic — same seed produced different results.");
  process.exit(1);
}

if (process.argv.includes("--out")) {
  writeFileSync(join(REPORTS_DIR, "noise-robustness-baseline.md"), reportMd, "utf8");
  writeFileSync(join(REPORTS_DIR, "noise-robustness-baseline.json"), payloadJson, "utf8");
  console.log("reports written:", join(REPORTS_DIR, "noise-robustness-baseline.md"));
}
console.log(reportMd);
console.log(`digest: ${digest.slice(0, 16)}`);
console.log(`clean=${(clean.note_exact_rate.point * 100).toFixed(0)}% combined=${(combined.note_exact_rate.point * 100).toFixed(1)}% (floor ${NOISE_FLOOR * 100}%) — NOISE BENCHMARK PASSED`);
