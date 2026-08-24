#!/usr/bin/env node
// Validate a labels JSON pack without writing the DB.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateApprovalFormat } from "../src/mechanisms.mjs";

const path = process.argv[2];
if (!path || path === "-h" || path === "--help") {
  process.stderr.write("usage: node scripts/validate-pack.mjs <labels.json>\n");
  process.exit(path ? 0 : 2);
}

const payload = JSON.parse(readFileSync(resolve(path), "utf8"));
const source = payload.source ?? {};
const records = payload.records ?? payload;
if (!Array.isArray(records)) {
  process.stderr.write("JSON must be { source, records: [] }\n");
  process.exit(2);
}

const errors = [];
const warnings = [];
if (!source.name) warnings.push("source.name 缺失");
let official = 0;
let sample = 0;
records.forEach((r, i) => {
  const where = `records[${i}]`;
  if (!r?.generic_name) errors.push(`${where}: missing generic_name`);
  if (!r?.approval_number) errors.push(`${where}: missing approval_number`);
  else {
    const fmt = validateApprovalFormat(r.approval_number);
    if (!fmt.ok) warnings.push(`${where}: 批准文号格式 ${fmt.reason}（${r.approval_number}）`);
  }
  if (!r?.sections || typeof r.sections !== "object" || Array.isArray(r.sections))
    errors.push(`${where}: sections must be an object`);
  const dc = r.data_class === "sample" ? "sample" : "official";
  if (dc === "sample") sample++;
  else {
    official++;
    if (!r.source_version) errors.push(`${where}: official 缺少 source_version`);
    if (!r.effective_date) errors.push(`${where}: official 缺少 effective_date`);
  }
});

const out = {
  path: resolve(path),
  source: source.name ?? null,
  counts: { records: records.length, official, sample },
  errors,
  warnings,
  ok: errors.length === 0,
  note:
    official === 0
      ? "无 official 记录：导入后仍不能用于真实 G2。请按 assets/PACK.md 填本院说明书。"
      : "契约通过。ingest 后核对 corpus_status.official。",
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(errors.length ? 1 : 0);
