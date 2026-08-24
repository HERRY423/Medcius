#!/usr/bin/env node
// batch01 初始化与演示：生成可跑通的 120 例合成 gold+pred，产出报告并落审计链
// 用法：node plugins/medcius/evals/clinical-validation/scripts/init-batch01.mjs [--demo-120] [--full-300]
// 真实医院批次：把脱敏处方按 evals/clinical-validation/README.md 盲法 SOP 产出 gold/batch01.jsonl 与 pred/batch01.jsonl 后再跑 run.mjs

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const goldDir = join(root, "gold");
const predDir = join(root, "pred");
const reportsDir = join(root, "reports");
mkdirSync(goldDir, { recursive: true });
mkdirSync(predDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });

const args = process.argv.slice(2);
const want300 = args.includes("--full-300");

const DIMS = ["interaction", "allergy", "dose_renal", "contraindication", "special_population", "duplicate_therapy"];
const perDim = want300 ? 50 : 20; // 20*6=120 demo, 50*6=300 满足医院“≥300份病历预测试” EVIDENCE-PRIOR-ART.md:29
const total = DIMS.length * perDim;

// 确定性伪随机，便于复现与审计
let seed = 0x1234abcd;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; }

function makeCase(i, dim) {
  const case_id = `batch01-${String(i).padStart(4, "0")}`;
  // 让 gold 的 flag 比例 ~35%（符合真实处方问题率），pred 在 gold 基础上以 90% 灵敏度 / 92% 特异度 模拟
  const goldFlag = rnd() < 0.35;
  const gold = goldFlag ? "flag" : "clear";
  let pred;
  if (gold === "flag") pred = rnd() < 0.90 ? "flag" : "clear"; // 灵敏度 90%
  else pred = rnd() < 0.92 ? "clear" : "flag"; // 特异度 92%
  return { case_id, dimension: dim, gold, predicted: pred };
}

const goldRows = [];
const predRows = [];
let idx = 1;
for (const d of DIMS) {
  for (let k = 0; k < perDim; k++) {
    const c = makeCase(idx, d);
    goldRows.push({ case_id: c.case_id, dimension: c.dimension, predicted: c.gold, gold: c.gold }); // gold 文件的 predicted 字段写 gold 值占位，run.mjs 以 predicted+gold 配对
    // 实际 gold 文件只存 gold，pred 文件存 predicted；run.mjs 的 gold 参数读 gold.gold，pred 读 predicted
    // 为兼容 run.mjs 的 JSONL 格式，两文件都用 {case_id, dimension, predicted, gold}
    // 但 gold 侧 gold=真实，pred 侧 predicted=系统输出
    predRows.push({ case_id: c.case_id, dimension: c.dimension, predicted: c.predicted, gold: c.gold });
    idx++;
  }
}

// gold 文件：每行 {case_id, dimension, predicted: gold, gold}（gold 侧）
const goldPath = join(goldDir, "batch01.jsonl");
const predPath = join(predDir, "batch01.jsonl");

// 区分：gold 侧写入 predicted=gold 占位，方便 run.mjs 的 readJsonl 校验；真实金标准只需 gold 字段一致即可
writeFileSync(goldPath, goldRows.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
writeFileSync(predPath, predRows.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");

console.log(`gold: ${goldPath} (${goldRows.length} rows, ${DIMS.length} dims x ${perDim})`);
console.log(`pred: ${predPath} (${predRows.length} rows)`);
console.log(`分布: ${DIMS.join(", ")} 各 ${perDim} 例，total ${total}`);

// 计算 gold 文件哈希（审计用）
const goldHash = createHash("sha256").update(readFileSync(goldPath, "utf8")).digest("hex");
const predHash = createHash("sha256").update(readFileSync(predPath, "utf8")).digest("hex");
console.log(`gold sha256: ${goldHash}`);
console.log(`pred sha256: ${predHash}`);

// 跑报告
const outReport = join(reportsDir, "batch01.md");
const runScript = join(root, "run.mjs");
const r = spawnSync("node", [runScript, "--gold", goldPath, "--pred", predPath, "--out", outReport], { encoding: "utf8" });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
if (r.status !== 0) {
  console.error(`run.mjs 失败 exit ${r.status}`);
  process.exit(r.status ?? 1);
}
console.log(`\nreport: ${outReport}`);

// 审计链落档（隔离环境演示，不污染真实库的可选；此处直接写真实 audit 演示 batch 概念）
try {
  // 使用独立临时 DATA 演示链路完整性，避免与真实库冲突的演示在 run.mjs probe 中已做；此处演示真实库写入
  const { HANDLERS } = await import("../../../servers/audit/src/tools.mjs");
  const start = HANDLERS.record_event({
    actor: "clinical-validation",
    action: "validation_batch_start",
    subject_ref: "BATCH01-PSN",
    payload: { batch: "batch01", gold_rows: goldRows.length, gold_sha256: goldHash, pred_sha256: predHash, dims: DIMS, perDim, note: "合成演示批次，真实批次需药师盲标替换 gold" },
  });
  const end = HANDLERS.record_event({
    actor: "clinical-validation",
    action: "validation_batch_end",
    subject_ref: "BATCH01-PSN",
    payload: { batch: "batch01", report: "reports/batch01.md", gold_sha256: goldHash, start_seq: start.seq, start_chain: start.chain_hash },
  });
  const v = HANDLERS.verify_chain({});
  console.log(`\naudit: start seq=${start.seq} chain=${start.chain_hash.slice(0, 12)}...`);
  console.log(`audit: end   seq=${end.seq} chain=${end.chain_hash.slice(0, 12)}...`);
  console.log(`audit verify: ${v.ok ? "OK" : "FAIL"} checked=${v.checked} head=${v.head?.slice(0, 12)}...`);
  console.log(`\n解读: 真实医院批次需按 README 盲法 SOP 先跑系统得 pred，再药师独立标 gold，gold 文件哈希入审计链，保证“这份指标是用哪份金标准算出来的”可追溯。`);
} catch (e) {
  console.warn(`audit 落档跳过: ${e.message}`);
  console.warn(`提示：audit 依赖 node:sqlite，可在后续医院环境复跑审计。`);
}

console.log(`\n下一步（真实处方替换）:`);
console.log(`1. 把脱敏处方（已过 phiguard redact）按 6 维度产出 pred/batch01.jsonl`);
console.log(`2. 药师盲标 gold/batch01.jsonl（不见 pred），每维度 ≥100 真阳样本才有可信灵敏度`);
console.log(`3. 重跑: node plugins/medcius/evals/clinical-validation/run.mjs --gold gold/batch01.jsonl --pred pred/batch01.jsonl --out reports/batch01.md`);
console.log(`4. 报告 + gold_sha256 入审计链 + REG-ACTION-TRACKER R15/R16 关闭`);
