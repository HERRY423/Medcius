#!/usr/bin/env node
/**
 * Classification-Pack Submission Readiness Gate (分类界定材料包就绪门 · R04→R05).
 *
 * Machine-checks the classification submission pack in
 * docs/compliance/classification-pack/ so "ready to file R05" becomes a
 * reproducible engineering statement instead of an opinion:
 *   1. required documents exist and are non-trivial;
 *   2. argument-chain anchors present (论据链 A/B in 01, D1–D5 in 02, prior-art
 *      certificate evidence in 03, interface records in 05);
 *   3. every unresolved [待核] item is enumerated (submission blockers list);
 *   4. version + governance facts injected into the readiness report.
 *
 * Modes:
 *   default     -- structural check, report printed, exit 0 unless structure broken
 *   --strict    -- exit 2 while any [待核] item remains (use at the moment of filing)
 *   --out <md>  -- also write readiness report
 */
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACK_DIR = join(__dirname, "..", "..", "..", "docs", "compliance", "classification-pack");

const REQUIRED_DOCS = [
  { file: "README.md", minChars: 200 },
  { file: "01-intended-use.md", minChars: 200, anchors: ["论据链 A", "论据链 B"] },
  { file: "02-device-description.md", minChars: 200, anchors: ["D1", "D2", "D3", "D4"] },
  { file: "03-prior-art.md", minChars: 200, anchors: ["粤械注准"] },
  { file: "04-timeline.md", minChars: 100 },
  { file: "05-hospital-interface-records.md", minChars: 200, anchors: ["连接器", "接口"] },
];

export function assessClassificationPack(packDir = PACK_DIR, { version = null, governanceStage = null } = {}) {
  const checks = [];
  const openItems = [];
  let structuralOk = true;

  for (const doc of REQUIRED_DOCS) {
    const path = join(packDir, doc.file);
    if (!existsSync(path)) {
      checks.push({ item: `document:${doc.file}`, pass: false, evidence: "missing" });
      structuralOk = false;
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (text.length < doc.minChars) {
      checks.push({ item: `document:${doc.file}`, pass: false, evidence: `too short (${text.length} chars)` });
      structuralOk = false;
      continue;
    }
    const missingAnchors = (doc.anchors ?? []).filter((anchor) => !text.includes(anchor));
    if (missingAnchors.length) {
      checks.push({ item: `anchors:${doc.file}`, pass: false, evidence: `missing ${missingAnchors.join(", ")}` });
      structuralOk = false;
    } else {
      checks.push({ item: `anchors:${doc.file}`, pass: true, evidence: `${doc.anchors?.length ?? 0} anchors present` });
    }
    // enumerate unresolved items (submission blockers when --strict)
    const pending = [...text.matchAll(/\[待核[^\]]*\]/g)].map((m) => m[0]);
    if (pending.length) {
      openItems.push({ document: doc.file, items: [...new Set(pending)] });
    }
  }

  const openItemCount = openItems.reduce((sum, entry) => sum + entry.items.length, 0);
  return {
    pack_dir: packDir,
    ready_for_r05: structuralOk && openItemCount === 0,
    structural_ok: structuralOk,
    open_item_count: openItemCount,
    open_items: openItems,
    checks,
    facts: {
      plugin_version: version,
      governance_stage: governanceStage,
      note: "提交前须注册主体（R01）成立并由法规顾问终审；本门只保证材料结构就绪。",
    },
  };
}

function readinessMarkdown(report) {
  const lines = [];
  lines.push("# 分类界定材料包就绪报告（R04→R05）");
  lines.push("");
  lines.push(`> 自动生成：\`node plugins/medcius/scripts/gen-classification-pack.mjs\`；结构检查 ${report.structural_ok ? "✅" : "❌"}，未关闭 [待核] 项 **${report.open_item_count}** 条，ready_for_r05=${report.ready_for_r05}。`);
  lines.push(`> 插件版本：${report.facts.plugin_version ?? "—"} · 治理阶段：${report.facts.governance_stage ?? "—"} · ${report.facts.note}`);
  lines.push("");
  lines.push("| 检查项 | 结果 | 证据 |");
  lines.push("|---|---|---|");
  for (const check of report.checks) {
    lines.push(`| ${check.item} | ${check.pass ? "✅" : "❌"} | ${check.evidence} |`);
  }
  if (report.open_items.length) {
    lines.push("");
    lines.push("## 未关闭 [待核] 项（提交前必须逐条由法规顾问关闭）");
    for (const entry of report.open_items) {
      lines.push(`- **${entry.document}**：${entry.items.join("；")}`);
    }
  }
  return lines.join("\n");
}

// ---- main ----
const args = process.argv.slice(2);
const strict = args.includes("--strict");
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;

let version = null;
try {
  version = JSON.parse(readFileSync(join(__dirname, "..", "plugins", "medcius", ".claude-plugin", "plugin.json"), "utf8")).version;
} catch { /* report without version */ }

const report = assessClassificationPack(PACK_DIR, {
  version,
  governanceStage: process.env.MEDCIUS_GOVERNANCE_STAGE ?? "retrospective_study(default)",
});
const markdown = readinessMarkdown(report);
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, "utf8");
  process.stdout.write(`written: ${outPath}\n`);
}
process.stdout.write(`${markdown}\n`);
if (!report.structural_ok) {
  process.stderr.write("CLASSIFICATION_PACK_STRUCTURE_BROKEN\n");
  process.exit(2);
}
if (strict && !report.ready_for_r05) {
  process.stderr.write(`NOT_READY_FOR_R05: ${report.open_item_count} 个 [待核] 项未关闭（--strict）。\n`);
  process.exit(2);
}
process.exit(0);
