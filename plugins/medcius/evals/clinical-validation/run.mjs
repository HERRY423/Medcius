#!/usr/bin/env node
// Retrospective clinical validation harness.
// Computes per-dimension sensitivity/specificity/PPV/NPV/F1 with Wilson Score 95% CIs
// and McNemar's test (exact binomial, two-sided) between an automated reviewer (predictions)
// and a blinded pharmacist gold standard.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

function readJsonl(p) {
  if (!p || !existsSync(p)) throw new Error(`file not found: ${p}`);
  return readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    const o = JSON.parse(l);
    if (!o.case_id || !o.dimension) throw new Error(`line ${i + 1}: missing case_id/dimension`);
    if (!["flag", "clear"].includes(o.predicted)) throw new Error(`line ${i + 1}: predicted must be flag|clear`);
    if (!["flag", "clear"].includes(o.gold)) throw new Error(`line ${i + 1}: gold must be flag|clear`);
    return o;
  });
}

function confusion(pred) {
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
  if (n === 0) return { point: null, low: null, high: null, str: "n/a" };
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
  const n = b + c;
  if (n === 0) return { stat_b: 0, stat_c: 0, p: 1 };
  const choose = (nn, k) => { let r = 1; for (let i = 0; i < k; i++) r = (r * (nn - i)) / (i + 1); return r; };
  const tail = Math.min(b, c);
  let cum = 0;
  for (let k = 0; k <= tail; k++) cum += choose(n, k) * Math.pow(0.5, n);
  return { stat_b: b, stat_c: c, p: Math.min(1, 2 * cum) };
}

const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);

function buildReport(rows, meta) {
  const dims = [...new Set(rows.map((r) => r.dimension))].sort();
  const lines = [];
  lines.push(`# 合成管线基准测试报告（Synthetic Pipeline Benchmark Report）`);
  lines.push("");
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 预测文件：\`${meta.pred}\`　金标准：\`${meta.gold}\`　配对样本总量：${rows.length}`);
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
    const interp = mc.p >= 0.05 ? "✓ 无显著系统性偏倚 (p ≥ 0.05)" : "⚠️ 存在系统性分歧 (p < 0.05，需归因)";
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
if (process.argv[1] && (process.argv[1].endsWith("run.mjs") || process.argv[1].includes("run.mjs"))) {
  let goldPath = argOf("--gold"), predPath = argOf("--pred"), out = argOf("--out");
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

  if (goldPath && predPath) {
    const gold = readJsonl(goldPath);
    const predRaw = readJsonl(predPath);

    const gmap = new Map(gold.map((r) => [`${r.case_id}|${r.dimension}`, r]));
    const rows = [];
    for (const p of predRaw) {
      const g = gmap.get(`${p.case_id}|${p.dimension}`);
      if (!g) continue;
      rows.push({ case_id: p.case_id, dimension: p.dimension, predicted: p.predicted, gold: g.gold });
    }
    const unpaired = predRaw.length - rows.length;

    const report = buildReport(rows, { gold: goldPath, pred: predPath })
      .replace("配对样本总量：" + rows.length, `配对样本总量：${rows.length}${unpaired ? `（另有 ${unpaired} 条预测无金标准配对，已剔除）` : ""}`);

    if (out) { writeFileSync(out, report, "utf8"); console.log(`report written: ${out}`); }
    console.log(report);
  }
}
