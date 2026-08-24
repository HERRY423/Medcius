#!/usr/bin/env node
/** 默认医院路径：一份病历 → 结算清单栏 + 六字段出处 + 清单机检。不做分组器。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { settlementFromNote } from "../lib/settlement-from-note.mjs";
import { checkProduction } from "../lib/production-guard.mjs";

const args = process.argv.slice(2);
const allowSample = args.includes("--allow-sample");
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : "";
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out" && a !== "--allow-sample");
if (!file) {
  process.stderr.write("usage: node settlement-from-note.mjs <出院记录.md> [--out dir] [--allow-sample]\n  默认拒绝样例库：official=0 时退出2，需显式 --allow-sample 才放行（管线自检）\n");
  process.exit(2);
}
// 硬门闩：official=0 时默认阻断，防 H01 静默降级
const gate = await checkProduction({ requireCodes: true, requireLabels: false });
if (!gate.codingReady && !allowSample) {
  process.stderr.write(`HALT production.coding=false (official codes=${gate.official.codes}). ${gate.halt}\n`);
  process.stderr.write(`提示：医院需导入官方编码包；自检请加 --allow-sample\n`);
  process.exit(2);
}
const { HANDLERS } = await import("../servers/china-codes/src/tools.mjs");
const report = settlementFromNote(readFileSync(resolve(file), "utf8"), HANDLERS);
report.gate = { checked: true, allowSample, ...gate, at: new Date().toISOString() };
report.note_id = basename(file);
const json = JSON.stringify(report, null, 2);
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  const p = join(outDir, "settlement-list.json");
  writeFileSync(p, json, "utf8");
  process.stdout.write(`${p}\n`);
} else process.stdout.write(`${json}\n`);
