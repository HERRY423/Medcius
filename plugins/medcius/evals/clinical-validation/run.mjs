#!/usr/bin/env node
// Retrospective clinical validation harness.
// Computes per-dimension sensitivity/specificity/PPV/NPV/F1 and McNemar's test
// (exact binomial, two-sided) between an automated reviewer (predictions) and
// a blinded pharmacist gold standard.
//
// Usage:
//   node run.mjs --gold gold.jsonl --pred pred.jsonl [--out report.md]
//   node run.mjs --demo            # self-test using cases.sample.jsonl as both sides
//
// Line format (both files, JSONL):
//   {"case_id":"...","dimension":"interaction","predicted":"flag|clear","gold":"flag|clear"}
// Dimensions are free-form strings; metrics are computed per dimension + overall.

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

function confusion(pred, gold) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of pred) {
    const P = r.predicted === "flag", G = r.gold === "flag";
    if (P && G) tp++; else if (P && !G) fp++; else if (!P && G) fn++; else tn++;
  }
  return { tp, fp, fn, tn };
}
const div0 = (a, b) => (b === 0 ? null : a / b);
function metrics(c) {
  const sens = div0(c.tp, c.tp + c.fn), spec = div0(c.tn, c.tn + c.fp);
  const ppv = div0(c.tp, c.tp + c.fp), npv = div0(c.tn, c.tn + c.fn);
  const f1 = sens !== null && ppv !== null ? div0(2 * sens * ppv, sens + ppv) : null;
  return {
    ...c,
    sensitivity: sens, specificity: spec, ppv, npv, f1,
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
  lines.push(`# 回顾性验证报告（Retrospective Validation）`);
  lines.push("");
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 预测文件：\`${meta.pred}\`　金标准：\`${meta.gold}\`　配对样本：${rows.length}`);
  lines.push("");
  lines.push("> 口径：`flag`＝系统/药师判为存在问题；指标按维度分层。回顾性、单数据集结果不构成注册临床评价，也不支持任何“等效”结论。");
  lines.push("");
  lines.push("| 维度 | TP | FP | FN | TN | 灵敏度 | 特异度 | PPV | NPV | F1 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const d of [...dims, "__overall__"]) {
    const sub = d === "__overall__" ? rows : rows.filter((r) => r.dimension === d);
    const m = metrics(confusion(sub));
    const name = d === "__overall__" ? "**总体**" : d;
    lines.push(`| ${name} | ${m.tp} | ${m.fp} | ${m.fn} | ${m.tn} | ${pct(m.sensitivity)} | ${pct(m.specificity)} | ${pct(m.ppv)} | ${pct(m.npv)} | ${pct(m.f1)} |`);
  }
  lines.push("");
  lines.push("## McNemar 检验（系统 vs 金标准不一致性）");
  lines.push("");
  lines.push("| 维度 | b（误报） | c（漏报） | 精确 p（双侧） |");
  lines.push("|---|---|---|---|");
  for (const d of [...dims, "__overall__"]) {
    const sub = d === "__overall__" ? rows : rows.filter((r) => r.dimension === d);
    const m = metrics(confusion(sub));
    const mc = mcnemarExact(m.fp, m.fn);
    const name = d === "__overall__" ? "**总体**" : d;
    lines.push(`| ${name} | ${mc.stat_b} | ${mc.stat_c} | ${mc.p.toFixed(4)} |`);
  }
  lines.push("");
  lines.push("## 解读纪律");
  lines.push("");
  lines.push("1. 审方场景**优先看灵敏度与漏报（c）**：漏掉一个真相互作用比多报更危险；特异度低只增加药师负荷。");
  lines.push("2. `p<0.05` 表示系统与药师判定存在系统性分歧，需逐例归因（规则缺陷/证据缺失/标签覆盖）。");
  lines.push("3. 本报告不替代《医疗器械临床评价》；注册路径见 docs/compliance/SAMD-PATHWAY.md。");
  lines.push("");
  return lines.join("\n");
}

// ---- main ----
let goldPath = argOf("--gold"), predPath = argOf("--pred"), out = argOf("--out");
if (args.includes("--demo")) {
  goldPath = join(__dirname, "cases.sample.jsonl");
  predPath = join(__dirname, "pred.sample.jsonl");
  if (!existsSync(predPath)) {
    // derive demo predictions by flipping one row to exercise FP/FN paths
    const rows = readJsonl(goldPath).map((r) => ({ ...r }));
    if (rows[0]) rows[0].predicted = rows[0].gold === "flag" ? "clear" : "flag";
    if (rows[2]) rows[2].predicted = rows[2].gold === "flag" ? "clear" : "flag";
    writeFileSync(predPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
}
const gold = readJsonl(goldPath);
const predRaw = readJsonl(predPath);
// Join on case_id+dimension so ordering can't skew pairing (blinded analysis).
const gmap = new Map(gold.map((r) => [`${r.case_id}|${r.dimension}`, r]));
const rows = [];
for (const p of predRaw) {
  const g = gmap.get(`${p.case_id}|${p.dimension}`);
  if (!g) continue; // unpaired predictions excluded and counted below
  rows.push({ case_id: p.case_id, dimension: p.dimension, predicted: p.predicted, gold: g.gold });
}
const unpaired = predRaw.length - rows.length;

const report = buildReport(rows, { gold: goldPath, pred: predPath })
  .replace("配对样本：" + rows.length, `配对样本：${rows.length}${unpaired ? `（另有 ${unpaired} 条预测无金标准配对，已剔除）` : ""}`);
if (out) { writeFileSync(out, report, "utf8"); console.log(`report written: ${out}`); }
console.log(report);
