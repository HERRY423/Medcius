#!/usr/bin/env node
// Retrospective clinical validation harness.
// Computes per-dimension sensitivity/specificity/PPV/NPV/F1 with Wilson Score 95% CIs
// and McNemar's test (exact binomial, two-sided) between an automated reviewer (predictions)
// and a blinded pharmacist gold standard.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

export function readJsonl(p, role = "gold") {
  if (!p || !existsSync(p)) throw new Error(`file not found: ${p}`);
  return readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    const o = JSON.parse(l);
    validateRecord(o, i, role);
    return o;
  });
}

function validateRecord(row, index, role) {
  if (!row || ![row.case_id, row.dimension].every((v) => typeof v === "string" && v.trim())) {
    throw new Error(`VALIDATION_RECORD_KEY_REQUIRED: ${role}, line ${index + 1}`);
  }
  const field = role === "gold" ? "gold" : "predicted";
  if (!["flag", "clear"].includes(row[field])) throw new Error(`VALIDATION_LABEL_INVALID: ${field}, line ${index + 1}`);
}

export function pairValidationRows(gold, predictions) {
  const indexed = (rows, role) => {
    if (!Array.isArray(rows) || !rows.length) throw new Error(`EMPTY_VALIDATION_DATASET: ${role}`);
    const map = new Map();
    rows.forEach((row, index) => {
      validateRecord(row, index, role);
      const key = JSON.stringify([row.case_id, row.dimension]);
      if (map.has(key)) throw new Error(`DUPLICATE_VALIDATION_KEY: ${role}, line ${index + 1}`);
      map.set(key, row);
    });
    return map;
  };
  const goldMap = indexed(gold, "gold");
  const predictionMap = indexed(predictions, "prediction");
  const missingPredictions = [...goldMap.keys()].filter((key) => !predictionMap.has(key)).length;
  const missingGold = [...predictionMap.keys()].filter((key) => !goldMap.has(key)).length;
  if (missingPredictions || missingGold) {
    throw new Error(`UNPAIRED_VALIDATION_RECORDS: missing_predictions=${missingPredictions}, missing_gold=${missingGold}`);
  }
  return [...goldMap].map(([key, row]) => ({
    case_id: row.case_id,
    dimension: row.dimension,
    gold: row.gold,
    predicted: predictionMap.get(key).predicted,
  }));
}

export function confusion(pred) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of pred) {
    const P = r.predicted === "flag", G = r.gold === "flag";
    if (P && G) tp++; else if (P && !G) fp++; else if (!P && G) fn++; else tn++;
  }
  return { tp, fp, fn, tn };
}

/**
 * Wilson score interval for binomial proportions (default 95% confidence level, z = 1.95996).
 */
export function wilsonScore(k, n, z = 1.95996) {
  if (!Number.isSafeInteger(k) || !Number.isSafeInteger(n) || k < 0 || n < 0 || k > n || !Number.isFinite(z) || z <= 0) throw new Error("INVALID_BINOMIAL_COUNTS");
  if (n === 0) return { point: null, low: null, high: null, str: "n/a", n: 0, computable: false };
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  const low = Math.max(0, center - halfWidth);
  const high = Math.min(1, center + halfWidth);
  return {
    point: p,
    low,
    high,
    n,
    computable: true,
    str: `${(p * 100).toFixed(1)}% [${(low * 100).toFixed(1)}%~${(high * 100).toFixed(1)}%]`,
  };
}

const div0 = (a, b) => (b === 0 ? null : a / b);

function metrics(c) {
  const sensW = wilsonScore(c.tp, c.tp + c.fn);
  const specW = wilsonScore(c.tn, c.tn + c.fp);
  const ppvW = wilsonScore(c.tp, c.tp + c.fp);
  const npvW = wilsonScore(c.tn, c.tn + c.fn);

  const sens = sensW.point;
  const ppv = ppvW.point;
  const f1 = sens !== null && ppv !== null && (sens + ppv > 0) ? div0(2 * sens * ppv, sens + ppv) : null;

  return {
    ...c,
    sensitivity: sensW,
    specificity: specW,
    ppv: ppvW,
    npv: npvW,
    f1,
    discordant: { b_predFlag_goldClear: c.fp, c_predClear_goldFlag: c.fn },
  };
}

/** Exact two-sided McNemar via binomial(n=b+c, p=.5), doubling the smaller tail. */
export function mcnemarExact(b, c) {
  if (!Number.isSafeInteger(b) || !Number.isSafeInteger(c) || b < 0 || c < 0) throw new Error("INVALID_MCNEMAR_COUNTS");
  const n = b + c;
  if (n === 0) return { stat_b: 0, stat_c: 0, p: 1 };
  const tail = Math.min(b, c);
  let logProbability = -n * Math.LN2;
  for (let k = 1; k <= tail; k++) logProbability += Math.log(n - k + 1) - Math.log(k);
  let probability = Math.exp(logProbability);
  let cum = probability;
  for (let k = tail; k > 0; k--) {
    probability *= k / (n - k + 1);
    cum += probability;
  }
  return { stat_b: b, stat_c: c, p: Math.min(1, 2 * cum) };
}

const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);

export function buildReport(rows, meta) {
  const dims = [...new Set(rows.map((r) => r.dimension))].sort();
  const lines = [];
  lines.push(`# 合成管线基准测试报告（Synthetic Pipeline Benchmark Report）`);
  lines.push("");
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 预测文件：\`${meta.pred}\`　金标准：\`${meta.gold}\`　配对样本总量：${rows.length}`);
  lines.push("- 数据完整性：两侧记录键唯一且一一配对；缺失或重复记录使本次评测失败，不剔除后继续报告。`clinical_evidence_pass: false`；数据来源未经独立核验。");
  lines.push("");
  lines.push("> **统计口径说明**：本报告为合成管线测试基准，`flag`＝系统判为存在用药问题；`clear`＝审核通过。灵敏度、特异度、PPV、NPV 均附带 **Wilson 95% 置信区间 (95% CI)**。真实多中心有效性以药师盲标为准。");
  lines.push("");
  lines.push("## 1. 核心临床效能指标表 (含 Wilson 95% CI)");
  lines.push("");
  lines.push("| 维度 / 分组 | 样本(N) | TP | FP | FN | TN | 灵敏度 (95% CI) | 特异度 (95% CI) | PPV (阳性预测值) | NPV (阴性预测值) | F1 分数 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");

  for (const d of [...dims, "__overall__"]) {
    const sub = d === "__overall__" ? rows : rows.filter((r) => r.dimension === d);
    const m = metrics(confusion(sub));
    const name = d === "__overall__" ? "**总体合计**" : d;
    lines.push(
      `| ${name} | ${sub.length} | ${m.tp} | ${m.fp} | ${m.fn} | ${m.tn} | ${m.sensitivity.str} | ${m.specificity.str} | ${m.ppv.str} | ${m.npv.str} | ${pct(m.f1)} |`
    );
  }

  lines.push("");
  lines.push("## 2. McNemar 配对卡方检验（系统 vs 药师金标准不一致性分析）");
  lines.push("");
  lines.push("| 维度 / 分组 | b（系统误报） | c（系统漏报） | 精确 p 值 (双侧) | 临床一致性判定 |");
  lines.push("|---|---|---|---|---|");

  for (const d of [...dims, "__overall__"]) {
    const sub = d === "__overall__" ? rows : rows.filter((r) => r.dimension === d);
    const m = metrics(confusion(sub));
    const mc = mcnemarExact(m.fp, m.fn);
    const name = d === "__overall__" ? "**总体合计**" : d;
    const interp = mc.p >= 0.05 ? "未拒绝边际对称假设；不证明一致性或非劣效性" : "检出边际不对称，需归因";
    lines.push(`| ${name} | ${mc.stat_b} | ${mc.stat_c} | ${mc.p.toFixed(4)} | ${interp} |`);
  }

  lines.push("");
  lines.push("## 3. 临床解读与质控纪律");
  lines.push("");
  lines.push("1. **灵敏度优先原则**：在临床前置审方与合理用药场景中，系统漏报 (c) 的临床风险显著高于误报 (b)；漏报真相互作用可致患者用药伤害，而误报仅增加药师人工复核动作。");
  lines.push("2. **置信区间宽度评估**：若某一维度的 95% CI 跨度 > 15%，表明该维度的真阳性机会样本量偏少，在正式申报注册前须扩大该专科维度的样本入组量（每维度 ≥ 100 例真阳性）。");
  lines.push("3. **合规边界声明**：本合成管线基准测试报告用于验证算法公式与流水线完整性，不可作为临床有效性宣称；真实多中心临床验证必须由独立执业药师盲标产生真实 Gold。");
  lines.push("");

  return lines.join("\n");
}

// ---- main ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let goldPath = argOf("--gold"), predPath = argOf("--pred"), out = argOf("--out");
  try {
  if (args.includes("--demo")) {
    goldPath = join(__dirname, "cases.sample.jsonl");
    predPath = join(__dirname, "pred.sample.jsonl");
    if (!existsSync(predPath)) {
      const rows = readJsonl(goldPath).map((r) => ({ ...r }));
      if (rows[0]) rows[0].predicted = rows[0].gold === "flag" ? "clear" : "flag";
      if (rows[2]) rows[2].predicted = rows[2].gold === "flag" ? "clear" : "flag";
      writeFileSync(predPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    }
  }

  if (!goldPath || !predPath) throw new Error("VALIDATION_INPUTS_REQUIRED: --gold and --pred");
    const gold = readJsonl(goldPath, "gold");
    const predRaw = readJsonl(predPath, "prediction");
    const rows = pairValidationRows(gold, predRaw);
    const report = buildReport(rows, { gold: goldPath, pred: predPath });

    if (out) { writeFileSync(out, report, "utf8"); console.log(`report written: ${out}`); }
    console.log(report);
  } catch (error) {
    // Replace the requested output on failure so an earlier green report cannot
    // be mistaken for the result of this invocation. Do not emit input contents.
    const reason = String(error.message).split(":")[0];
    if (out) writeFileSync(out, `# 评测失败 / INVALID\n\n- status: INVALID\n- clinical_evidence_pass: false\n- reason: ${reason}\n- 本次输入未通过完整性检查；此前输出已失效，不提供成功指标。\n`, "utf8");
    console.error(`Clinical validation failed: ${reason}`);
    process.exitCode = 1;
  }
}
