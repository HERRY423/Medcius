#!/usr/bin/env node
/**
 * Production intake: structured 出院记录 file(s) → china-inpatient fields → optional NHSA code lookup.
 * Does not diagnose. Coding lookup uses local china-codes only.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseCnNote } from "../lib/parse-cn-note.mjs";
import { settlementFromNote } from "../lib/settlement-from-note.mjs";

const args = process.argv.slice(2);
const wantCode = args.includes("--code");
const allowSample = args.includes("--allow-sample");
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : "";
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out" && a !== "--allow-sample");
const input = positional[0];

if (!input || args.includes("-h") || args.includes("--help")) {
  process.stderr.write("usage: node intake-discharge.mjs <file-or-dir> [--out dir] [--code] [--allow-sample]\n  --code 焊死抽取→结算清单六字段+机检（非 DRG）\n  --allow-sample 仅管线自检时显式放行样例库（默认 official=0 阻断）\n");
  process.exit(input ? 0 : 2);
}
if (wantCode) {
  const { checkProduction } = await import("../lib/production-guard.mjs");
  const gate = await checkProduction({ requireCodes: true, requireLabels: false });
  if (!gate.codingReady && !allowSample) {
    process.stderr.write(`HALT production.coding=false (official codes=${gate.official.codes}). ${gate.halt}\n提示：导入官方编码包或加 --allow-sample 自检\n`);
    process.exit(2);
  }
}

function listNotes(p) {
  const abs = resolve(p);
  const st = statSync(abs);
  if (st.isFile()) return [abs];
  return readdirSync(abs)
    .filter((f) => /\.(txt|md|json)$/i.test(f))
    .map((f) => join(abs, f));
}

const files = listNotes(input);
const records = files.map((f) => {
  const text = readFileSync(f, "utf8");
  const rec = parseCnNote(text);
  return { id: basename(f), path: f, ...rec };
});

let coding = null;
if (wantCode) {
  const { HANDLERS } = await import("../servers/china-codes/src/tools.mjs");
  coding = files.map((f, i) => {
    const s = settlementFromNote(readFileSync(f, "utf8"), HANDLERS);
    s.note_id = records[i].id;
    return s;
  });
}

const report = {
  parser: "parse-cn-note",
  notes: records.length,
  records,
  coding,
  disclaimer: "抽取不等于诊断；编码须本地 official 库且人复核。",
};

const json = JSON.stringify(report, null, 2);
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "intake-report.json"), json, "utf8");
  writeFileSync(join(outDir, "records.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  process.stdout.write(`${join(outDir, "intake-report.json")}\n`);
} else {
  process.stdout.write(`${json}\n`);
}
