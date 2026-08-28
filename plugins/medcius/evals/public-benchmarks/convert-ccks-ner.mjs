#!/usr/bin/env node
// CCKS 2017 Clinical NER → china-skills case format converter.
//
// Contract (see README.md §3): reads data/raw/ccks2017-ner/, emits
// data/converted/ccks2017-ner.cases.json in the evals/china-skills schema.
// Gracefully exits 0 with setup instructions when the raw dataset is absent,
// so CI is never blocked by optional external data.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rawDir = join(__dirname, "data", "raw", "ccks2017-ner");
const outPath = join(__dirname, "data", "converted", "ccks2017-ner.cases.json");

if (!existsSync(rawDir)) {
  console.log("ccks2017-ner: raw dataset not found — skipping (non-blocking).");
  console.log("To enable:");
  console.log("  1. Download CCKS 2017 clinical NER task data from the official channel");
  console.log("     and place it under plugins/medcius/evals/public-benchmarks/data/raw/ccks2017-ner/");
  console.log("  2. Verify the license permits research use here, then record the");
  console.log("     conclusion in README.md §1 before converting.");
  process.exit(0);
}

// Official CCKS-2017 format: one record per line/blocked JSON with fields
// { "originalText": "...", "entities": [{ "label_type": "...", "start_pos": n, "end_pos": n }] }.
// The mapping below keeps verbatim spans intact so clinical-note-extract's
// span-binding discipline stays testable.
function convertRecord(record, index) {
  const entities = record.entities || [];
  const byType = {};
  for (const e of entities) {
    (byType[e.label_type] = byType[e.label_type] || []).push(record.originalText.slice(e.start_pos, e.end_pos));
  }
  return {
    id: `ccks17-${String(index + 1).padStart(4, "0")}`,
    skill: "clinical-note-extract",
    trap: "public_benchmark_ner",
    title: `CCKS2017 公开基准样例 #${index + 1}`,
    input: {
      schema: "china-inpatient",
      note: { inline_text: record.originalText },
      source: "ccks2017-ner",
    },
    must: Object.entries(byType).map(([type, spans]) =>
      `${type} 抽取结果须覆盖公开标注实体：${spans.map((s) => `「${s}」`).join("、")}`
    ),
    must_not: [
      "输出中不得出现原始文本之外的患者可识别信息",
      "不得虚构标注中不存在的实体类型",
    ],
  };
}

const files = ["train.json", "dev.json", "test.json", "data.json"].filter((f) => existsSync(join(rawDir, f)));
if (files.length === 0) {
  console.log(`ccks2017-ner: no recognized data files in ${rawDir} — expected train/dev/test/data .json. Skipping.`);
  process.exit(0);
}

let converted = [];
for (const file of files) {
  const records = JSON.parse(readFileSync(join(rawDir, file), "utf8"));
  const list = Array.isArray(records) ? records : Object.values(records);
  converted = converted.concat(list.map(convertRecord));
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(converted, null, 2), "utf8");

const typeCounts = {};
for (const c of converted) for (const m of c.must) typeCounts[m.split("：")[0]] = (typeCounts[m.split("：")[0]] || 0) + 1;
console.log(`ccks2017-ner: converted ${converted.length} records -> ${outPath}`);
console.log("entity-type coverage:", JSON.stringify(typeCounts, null, 2));
console.log("Reminder: manually inspect >=10 converted records before using in evals (README.md §4).");
