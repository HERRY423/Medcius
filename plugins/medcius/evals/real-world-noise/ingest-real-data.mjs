#!/usr/bin/env node
// Desensitized Real-Data Ingest Channel (真实脱敏病历接入通道 · 缺口二量具).
//
// 用途：当合作医院提供脱敏真实病历 + 人工标注 gold 时，用与噪声基准完全相同
// 的评分引擎测量解析/抽取层在真实世界数据上的表现。这是"真实数据回放基准"
// 的落点：不需要接口、不需要部署，一份 JSONL 即可产出基线报告。
//
// Fail-closed gates（任何一道不满足即整体拒绝，exit 2）：
//   1. 每行必须 source_meta.desensitized === true（医院方显式声明）；
//   2. note_text 经 phiguard 扫描不得含未脱敏的原始 PHI（身份证/手机/标注姓名）；
//      拒绝时只报检出类型与行号，绝不回显 PHI 内容本身。
//
// Usage:
//   node ingest-real-data.mjs <notes.jsonl> [--report out.md]
//
// JSONL line schema:
//   {"note_id":"...","note_text":"...","gold":{field specs 如 expected.json},
//    "source_meta":{"desensitized":true,"note_type":"discharge","dialect":"..."}}

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanText } from "../../servers/phiguard/src/lib.mjs";
import { wilsonScore } from "../clinical-validation/run.mjs";
import { gradeNoteText } from "./grader.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  process.stderr.write(`HALT ${message}\n`);
  process.exit(2);
}

function parseJsonl(raw) {
  const cases = [];
  const lines = String(raw ?? "").split(/\r?\n/).filter((line) => line.trim());
  lines.forEach((line, index) => {
    try {
      cases.push(JSON.parse(line));
    } catch (error) {
      fail(`JSONL_PARSE_ERROR line ${index + 1}: ${error.message}`);
    }
  });
  if (!cases.length) fail("JSONL_EMPTY");
  return cases;
}

/** PHI fail-closed gate. Returns ONLY the finding type — never the content. */
function assertDesensitized(testCase, index) {
  const where = `line ${index + 1} (${testCase.note_id ?? "no-id"})`;
  if (testCase.source_meta?.desensitized !== true) {
    fail(`${where}: source_meta.desensitized !== true — 未经医院方脱敏声明的数据不得进入量具`);
  }
  if (typeof testCase.note_text !== "string" || !testCase.note_text.trim()) {
    fail(`${where}: note_text missing/empty`);
  }
  const scan = scanText(testCase.note_text);
  const hits = (scan.findings ?? []).filter((f) => ["id_card", "phone_cn_mobile", "name_label"].includes(f.type));
  if (hits.length) {
    fail(`${where}: RAW_PHI_DETECTED types=[${[...new Set(hits.map((f) => f.type))].join(",")}] — 请先完成脱敏（内容不回显）`);
  }
}

function ingest(cases) {
  const perCase = [];
  let fieldsPassed = 0;
  let fieldsTotal = 0;
  let notesExact = 0;
  cases.forEach((testCase, index) => {
    assertDesensitized(testCase, index);
    if (!testCase.gold || typeof testCase.gold !== "object") {
      fail(`line ${index + 1}: gold missing — 真实基线必须带人工标注`);
    }
    const graded = gradeNoteText(testCase.note_text, testCase.gold);
    fieldsPassed += graded.fields_passed;
    fieldsTotal += graded.fields_total;
    if (graded.exact) notesExact += 1;
    perCase.push({ note_id: testCase.note_id ?? `case-${index + 1}`, exact: graded.exact, field_rate: graded.fields_total ? graded.fields_passed / graded.fields_total : 0, failures: graded.failures.slice(0, 8) });
  });
  return {
    perCase,
    fields_passed: fieldsPassed,
    fields_total: fieldsTotal,
    notes_exact: notesExact,
    note_exact_rate: wilsonScore(notesExact, cases.length),
    field_rate: fieldsTotal ? fieldsPassed / fieldsTotal : 0,
  };
}

function buildReport(result, sourceMeta) {
  const lines = [];
  lines.push("# 真实脱敏病历抽取基线（Desensitized Real-Data Baseline）");
  lines.push("");
  lines.push(`> 样例：${result.perCase.length} 份（source_meta: ${sourceMeta}）；由 ingest-real-data.mjs 生成，评分引擎与噪声鲁棒性基准一致。`);
  lines.push(`> note 全字段命中率：${(result.note_exact_rate.point * 100).toFixed(1)}% [${(result.note_exact_rate.low * 100).toFixed(1)}%~${(result.note_exact_rate.high * 100).toFixed(1)}%]（Wilson 95% CI）`);
  lines.push(`> 字段级保持率：${(result.field_rate * 100).toFixed(1)}%（${result.fields_passed}/${result.fields_total}）`);
  lines.push("> 该数字是解析/抽取层的真实世界保持率基线；不构成临床有效性证据。");
  lines.push("");
  for (const item of result.perCase) {
    lines.push(`- ${item.exact ? "✓" : "✗"} ${item.note_id}: field_rate=${(item.field_rate * 100).toFixed(0)}%${item.failures.length ? ` failures: ${item.failures.join("; ")}` : ""}`);
  }
  return lines.join("\n");
}

// ---- main ----
const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--report");
const reportIdx = args.indexOf("--report");
const reportPath = reportIdx >= 0 ? args[reportIdx + 1] : null;
if (!file) {
  process.stderr.write("usage: node ingest-real-data.mjs <notes.jsonl> [--report out.md]\n");
  process.exit(2);
}
const cases = parseJsonl(readFileSync(file, "utf8"));
const result = ingest(cases);
const metaSummary = cases.every((c) => c.source_meta?.dialect === cases[0].source_meta?.dialect)
  ? `dialect=${cases[0].source_meta?.dialect ?? "unspecified"}`
  : "dialect=mixed";
const report = buildReport(result, metaSummary);
if (reportPath) {
  writeFileSync(reportPath, report, "utf8");
  console.log(`report written: ${reportPath}`);
}
console.log(report);
console.log(`REAL-DATA INGEST OK: ${result.notes_exact}/${cases.length} notes exact, field ${(result.field_rate * 100).toFixed(1)}%`);
