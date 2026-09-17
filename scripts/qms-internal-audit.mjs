#!/usr/bin/env node
/**
 * Executable QMS Internal Audit (可执行内审工具 · R09 落地, 缺口五).
 *
 * The QMS-INTERNAL-AUDIT-CHECKLIST was a template; a template is not an
 * executed audit. This runner executes every machine-checkable audit item
 * against the repo (real commands, real evidence lines), and separates them
 * from human-attested items (management review, training) which require
 * explicit --attest arguments. Every run writes a dated audit record under
 * docs/compliance/qms/audit-records/ — that record, not the template, is the
 * QMS evidence.
 *
 *   node scripts/qms-internal-audit.mjs                    # machine checks only
 *   node scripts/qms-internal-audit.mjs --only m01,m06     # subset (fast)
 *   node scripts/qms-internal-audit.mjs --attest-item a01 "张三:管理者代表:首轮管理评审已召开"
 *   node scripts/qms-internal-audit.mjs --strict           # exit 2 unless attested items complete
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const RECORDS_DIR = join(REPO, "docs", "compliance", "qms", "audit-records");

function run(cmd, args, { expectExit = 0, evidenceLine } = {}) {
  const res = spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const pass = res.status === expectExit;
  let evidence = evidenceLine ? (evidenceLine.exec ? (out.match(evidenceLine) ?? [null])[0] : evidenceLine) : out.split("\n").find((l) => l.trim()) ?? "";
  return { pass, evidence: String(evidence ?? "").slice(0, 160), exit_code: res.status };
}

/** Machine-checkable audit items. Each maps to a QMS checklist clause. */
export const MACHINE_ITEMS = [
  { id: "m01", clause: "IEC 62304 §5.2 / 需求分析", description: "SRS 存在且含 ARCH 层需求", check: () => {
    const srs = join(REPO, "docs/compliance/dhf/SRS-CN-SKILLS.md");
    const text = existsSync(srs) ? readFileSync(srs, "utf8") : "";
    const arch = (text.match(/^\|\s*ARCH-\d{2}\s*\|/gm) ?? []).length;
    return { pass: arch >= 10, evidence: `SRS-CN-SKILLS.md ARCH 行数=${arch}（要求 ≥10）` };
  } },
  { id: "m02", clause: "ISO 14971 / 风险管理", description: "风险文档存在且危害条目齐全", check: () => {
    const risk = join(REPO, "docs/compliance/dhf/RISK-MANAGEMENT.md");
    const text = existsSync(risk) ? readFileSync(risk, "utf8") : "";
    const cited = new Set(text.match(/ARCH-\d{2}/g) ?? []);
    return { pass: cited.size >= 5, evidence: `RISK-MANAGEMENT.md 引用 ARCH 需求 ${cited.size} 项（要求 ≥5）` };
  } },
  { id: "m03", clause: "IEC 62304 §5.5-5.7 / 验证", description: "全量质量门通过（run-all-checks）", check: () => run("node", ["scripts/run-all-checks.mjs"], { evidenceLine: /Quality Gate Summary: \d+ Passed, \d+ Failed[^\n]*/ }) },
  { id: "m04", clause: "IEC 62304 §5.2.6 / 追溯", description: "追溯矩阵与评测用例同步", check: () => run("node", ["plugins/medcius/scripts/compliance-lint.mjs"], { evidenceLine: /COMPLIANCE LINT (PASSED|FAILED)/ }) },
  { id: "m05", clause: "YY/T 0287 §4.2.4 / 记录控制", description: "审计链完整可验证", check: () => run("node", ["plugins/medcius/scripts/doctor.mjs"], { evidenceLine: /"ready"/ }) },
  { id: "m06", clause: "配置管理 / 版本一致", description: "三份插件清单版本一致", check: () => {
    const files = ["plugins/medcius/.claude-plugin/plugin.json", "plugins/medcius/plugin.json", "plugins/medcius/.codex-plugin/plugin.json"];
    const versions = files.map((f) => JSON.parse(readFileSync(join(REPO, f), "utf8")).version);
    const unique = new Set(versions);
    return { pass: unique.size === 1, evidence: `versions=${[...unique].join(",")}（要求一致）` };
  } },
  { id: "m07", clause: "H01 生产门闩", description: "样例库阻断有效", check: () => run("node", ["scripts/validate-gate.mjs"], { evidenceLine: /GATE VALIDATION (PASSED|FAILED)/ }) },
  { id: "m08", clause: "需求可验证性", description: "确定性评测零 fail", check: () => run("node", ["scripts/run-evals.mjs"], { evidenceLine: /results\/: \d+ pass \/ \d+ fail[^\n]*/ }) },
  { id: "m09", clause: "边界措辞红线", description: "产品文档无违禁自称", check: () => {
    const res = spawnSync("node", ["plugins/medcius/scripts/compliance-lint.mjs"], { cwd: REPO, encoding: "utf8" });
    const out = `${res.stdout ?? ""}`;
    return { pass: /boundary wording clean/.test(out), evidence: (out.match(/boundary wording clean[^\n]*/) ?? ["lint output missing"])[0] };
  } },
  { id: "m10", clause: "知识供应链（缺口四）", description: "官方语料来源登记表有效", check: () => run("node", ["scripts/fetch-official-corpus.mjs", "--list"], { evidenceLine: /official sources registry: \d+ entries[^\n]*/ }) },
  { id: "m11", clause: "就绪门（缺口五）", description: "分类界定材料包结构完整", check: () => run("node", ["plugins/medcius/scripts/gen-classification-pack.mjs"], { evidenceLine: /ready_for_r05=\w+/ }) },
];

const ATTESTATION_ITEMS = [
  { id: "a01", clause: "YY/T 0287 §5.6 / 管理评审", description: "管理评审会议已召开并有决议纪要" },
  { id: "a02", clause: "YY/T 0287 §6.2 / 培训", description: "相关岗位培训已完成并留档" },
  { id: "a03", clause: "YY/T 0287 §7.4 / 采购", description: "外部供方（含 LLM 供应链）评价已完成" },
];

function runAudit({ only = null, attestations = [], now = new Date() } = {}) {
  const machine = [];
  for (const item of MACHINE_ITEMS) {
    if (only && !only.includes(item.id)) continue;
    let result;
    try {
      result = item.check();
    } catch (e) {
      result = { pass: false, evidence: `check threw: ${e.message}` };
    }
    machine.push({ id: item.id, clause: item.clause, description: item.description, ...result });
  }
  const attestationRecords = ATTESTATION_ITEMS.map((item) => {
    const provided = attestations.find((a) => a.item === item.id);
    return {
      id: item.id,
      clause: item.clause,
      description: item.description,
      attested_by: provided ? provided.name : null,
      attested_role: provided ? provided.role : null,
      attested_note: provided ? provided.note : null,
      status: provided ? "attested" : "pending_signature",
    };
  });
  const machinePassed = machine.every((m) => m.pass);
  const allAttested = attestationRecords.every((a) => a.status === "attested");
  const record = {
    audit_id: `qms-audit-${now.toISOString().slice(0, 10)}-${createHash("sha256").update(JSON.stringify(machine.map((m) => [m.id, m.pass]))).digest("hex").slice(0, 8)}`,
    executed_at: now.toISOString(),
    executed_by: "scripts/qms-internal-audit.mjs（机器可复算）",
    machine_checks: machine,
    machine_summary: { total: machine.length, passed: machine.filter((m) => m.pass).length, failed: machine.filter((m) => !m.pass).length },
    attestations: attestationRecords,
    overall: machinePassed && allAttested ? "pass" : machinePassed ? "pass_with_pending_attestation" : "fail",
    discipline: "本记录为可复算的内审证据；替代不了注册体系核查，其价值在于把 R09 从模板变成可重复执行的动作。",
  };
  return record;
}

export { runAudit };

function auditMarkdown(record) {
  const lines = [];
  lines.push(`# QMS 内部审核记录（${record.audit_id}）`);
  lines.push("");
  lines.push(`> 执行时间：${record.executed_at} · ${record.executed_by}`);
  lines.push(`> 机器检查：${record.machine_summary.passed}/${record.machine_summary.total} 通过 · 总体判定：**${record.overall}**`);
  lines.push(`> ${record.discipline}`);
  lines.push("");
  lines.push("## 一、机器可核查项");
  lines.push("");
  lines.push("| ID | 标准条款 | 核查项 | 结果 | 证据 |");
  lines.push("|---|---|---|---|---|");
  for (const m of record.machine_checks) {
    lines.push(`| ${m.id} | ${m.clause} | ${m.description} | ${m.pass ? "🟢 符合" : "🔴 不符合"} | ${m.evidence.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  lines.push("## 二、需人工签认项");
  lines.push("");
  lines.push("| ID | 标准条款 | 签认项 | 状态 | 签认人/角色 | 说明 |");
  lines.push("|---|---|---|---|---|---|");
  for (const a of record.attestations) {
    lines.push(`| ${a.id} | ${a.clause} | ${a.description} | ${a.status === "attested" ? "✅ 已签认" : "⬜ 待签认"} | ${a.attested_by ? `${a.attested_by}（${a.attested_role}）` : "—"} | ${a.attested_note ?? "—"} |`);
  }
  return lines.join("\n");
}

// ---- main ----
const args = process.argv.slice(2);
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1].split(",").map((s) => s.trim()) : null;
const attestations = [];
// 签认格式：--attest-item <id> "签认人:角色:说明"   （例：--attest-item a01 "张三:管理者代表:首轮管理评审已召开"）
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--attest-item") {
    const item = args[i + 1];
    const parsed = String(args[i + 2] ?? "").split(":");
    if (item && parsed[0] && parsed[1]) {
      attestations.push({ item, name: parsed[0], role: parsed[1], note: parsed[2] ?? null });
    } else {
      process.stderr.write("usage: --attest-item <id> \"name:role[:note]\"\n");
      process.exit(2);
    }
  }
}
const strict = args.includes("--strict");

const record = runAudit({ only, attestations, now: new Date() });
const markdown = auditMarkdown(record);

if (!args.includes("--no-write")) {
  mkdirSync(RECORDS_DIR, { recursive: true });
  writeFileSync(join(RECORDS_DIR, `${record.audit_id}.md`), markdown, "utf8");
  writeFileSync(join(RECORDS_DIR, `${record.audit_id}.json`), JSON.stringify(record, null, 2), "utf8");
  process.stdout.write(`audit record written: docs/compliance/qms/audit-records/${record.audit_id}.md\n`);
}
process.stdout.write(`${markdown}\n`);
if (record.machine_summary.failed > 0) {
  process.stderr.write(`AUDIT_MACHINE_FAILURES: ${record.machine_summary.failed}\n`);
  process.exit(2);
}
if (strict && record.overall !== "pass") {
  process.stderr.write(`AUDIT_PENDING_ATTESTATION（--strict）。\n`);
  process.exit(2);
}
process.exit(0);
