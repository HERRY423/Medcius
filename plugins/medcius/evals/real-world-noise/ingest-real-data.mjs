#!/usr/bin/env node
// Desensitized Real-Data Ingest Channel (真实脱敏病历接入通道 · 缺口二量具).
//
// 用途：当合作医院提供脱敏真实病历 + 人工标注 gold 时，用与噪声基准完全相同
// 的评分引擎测量解析/抽取层在真实世界数据上的表现。这是"真实数据回放基准"
// 的落点：本地 JSONL + 显式数据身份，真实数据另须声明清单；无需连接医院接口。
//
// Fail-closed gates（任何一道不满足即整体拒绝，exit 2）：
//   1. 每行必须 source_meta.desensitized === true（医院方显式声明）；
//   2. 全记录（含 gold/元数据）先经 PHI Guard；失败只报固定错误码/行号；
//   3. 数据身份、去重、非空 gold、患者划分、标注设计和输入哈希绑定。
// 声明及规则扫描不证明真实授权、完全脱敏或参考标注独立性。
//
// Usage:
//   node ingest-real-data.mjs <notes.jsonl> (--synthetic | --manifest intake.json) [--report out.md]
//
// JSONL line schema:
//   {"note_id":"...","note_text":"...","gold":{field specs 如 expected.json},
//    "source_meta":{"desensitized":true,"note_type":"discharge","dialect":"..."}}

import { readFileSync, writeFileSync } from "node:fs";
import { validateClinicalEvaluationIntake } from "../../lib/clinical-evaluation-intake.mjs";
import { scanStructuredValue } from "../../servers/phiguard/src/lib.mjs";
import { gradeNoteText } from "./grader.mjs";

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
      fail(`JSONL_PARSE_ERROR line ${index + 1}`);
    }
  });
  if (!cases.length) fail("JSONL_EMPTY");
  return cases;
}

/** PHI fail-closed gate. Returns ONLY the finding type — never the content. */
function assertDesensitized(testCase, index) {
  const where = `line ${index + 1}`;
  if (testCase?.source_meta?.desensitized !== true) {
    fail(`${where}: source_meta.desensitized !== true — 未经医院方脱敏声明的数据不得进入量具`);
  }
  if (typeof testCase.note_text !== "string" || !testCase.note_text.trim()) {
    fail(`${where}: note_text missing/empty`);
  }
  const scan = scanStructuredValue(testCase, { contextual: true });
  const hits = scan.findings ?? [];
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
    if (graded.fields_total === 0) fail(`line ${index + 1}: GOLD_NO_SCORED_FIELDS`);
    fieldsPassed += graded.fields_passed;
    fieldsTotal += graded.fields_total;
    if (graded.exact) notesExact += 1;
    perCase.push({ note_id: `case-${index + 1}`, subject_ref: testCase.source_meta?.subject_ref ?? null, exact: graded.exact, field_rate: graded.fields_total ? graded.fields_passed / graded.fields_total : 0, failure_count: graded.failures.length });
  });
  return {
    perCase,
    fields_passed: fieldsPassed,
    fields_total: fieldsTotal,
    notes_exact: notesExact,
    field_rate: fieldsTotal ? fieldsPassed / fieldsTotal : 0,
  };
}

function buildReport(result, intake) {
  const lines = [];
  lines.push(`# 本地病历抽取回放（${intake.data_kind}）`);
  lines.push("");
  lines.push(`> 样例：${result.perCase.length} 份（data_kind: ${intake.data_kind}）；由 ingest-real-data.mjs 生成，评分引擎与噪声鲁棒性基准一致。`);
  lines.push(`> note 全字段命中：${result.notes_exact}/${result.perCase.length}；仅描述本次输入，不假设多条病历相互独立。`);
  lines.push(`> 声明的不同患者标识数：${intake.declared_subject_count ?? "NOT_APPLICABLE_SYNTHETIC"}；参考标注独立性：${intake.reference_independence}。`);
  lines.push(`> 字段级保持率：${(result.field_rate * 100).toFixed(1)}%（${result.fields_passed}/${result.fields_total}）`);
  lines.push("> 数据身份按输入声明记录；入库检查不证明授权、完全脱敏或标注独立性，不构成临床有效性证据。");
  lines.push("");
  for (const item of result.perCase) {
    lines.push(`- ${item.exact ? "✓" : "✗"} ${item.note_id}: field_rate=${(item.field_rate * 100).toFixed(0)}% failure_count=${item.failure_count}`);
  }
  return lines.join("\n");
}

// ---- main ----
const args = process.argv.slice(2);
const options = {};
let file;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (['--synthetic', '--manifest', '--report'].includes(arg)) {
    if (Object.hasOwn(options, arg)) fail('INTAKE_DUPLICATE_OPTION');
    if (arg === '--synthetic') options[arg] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) fail('INTAKE_OPTION_VALUE_REQUIRED');
      options[arg] = args[++i];
    }
  } else if (arg.startsWith('--') || file) fail('INTAKE_ARGUMENT_INVALID');
  else file = arg;
}
const reportPath = options['--report'];
if (options['--synthetic'] && options['--manifest']) fail('INTAKE_DATA_MODE_CONFLICT');
if (!file) {
  process.stderr.write("usage: node ingest-real-data.mjs <notes.jsonl> (--synthetic | --manifest approved-intake.json) [--report out.md]\n");
  process.exit(2);
}
let raw;
try { raw = readFileSync(file, 'utf8'); }
catch { fail('INTAKE_INPUT_UNREADABLE'); }
const cases = parseJsonl(raw);
// Check PHI before metadata validation; errors never echo row IDs or content.
cases.forEach(assertDesensitized);
let manifest = null;
if (options['--manifest']) {
  try { manifest = JSON.parse(readFileSync(options['--manifest'], 'utf8')); }
  catch { fail('INTAKE_MANIFEST_UNREADABLE'); }
}
let intake;
try { intake = validateClinicalEvaluationIntake(cases, { synthetic: options['--synthetic'] === true, manifest }); }
catch (error) { fail(error.message); }
let result;
try { result = ingest(cases); }
catch { fail('INTAKE_SCORING_FAILED'); }
const report = buildReport(result, intake);
if (reportPath) {
  try { writeFileSync(reportPath, report, "utf8"); }
  catch { fail('INTAKE_REPORT_WRITE_FAILED'); }
  console.log('report written');
}
console.log(report);
console.log(`${intake.data_kind} INGEST OK: ${result.notes_exact}/${cases.length} notes exact, field ${(result.field_rate * 100).toFixed(1)}%`);
