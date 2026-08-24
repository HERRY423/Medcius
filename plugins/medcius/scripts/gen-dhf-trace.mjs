// Generate the DHF requirements-traceability matrix from china-skills eval cases.
//   node plugins/medcius/scripts/gen-dhf-trace.mjs                     # write to stdout
//   node plugins/medcius/scripts/gen-dhf-trace.mjs --out <file.md>     # write to file
// Source of truth: plugins/medcius/evals/china-skills/cases/*.json
// Every case id becomes REQ-<case-id>; verification ref is the same case id.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = join(here, "..", "evals", "china-skills", "cases");

const outIdx = process.argv.indexOf("--out");
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null;

const files = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
const rows = [];
const summary = [];

for (const f of files) {
  const cases = JSON.parse(readFileSync(join(casesDir, f), "utf8"));
  let must = 0;
  let mustNot = 0;
  for (const c of cases) {
    must += c.must.length;
    mustNot += c.must_not.length;
    rows.push({
      req: `REQ-${c.id}`,
      skill: c.skill,
      trap: c.trap,
      title: c.title,
      must: c.must.length,
      mustNot: c.must_not.length,
      verify: `\`${c.id}\``,
    });
  }
  const skill = cases[0]?.skill ?? f;
  summary.push({ skill, file: f, cases: cases.length, must, mustNot });
}

const total = (k) => summary.reduce((a, s) => a + s[k], 0);

let md = `# 需求 ↔ 测试追溯矩阵（自动生成，勿手改）

> 生成器：\`plugins/medcius/scripts/gen-dhf-trace.mjs\`；数据源：\`plugins/medcius/evals/china-skills/cases/*.json\`。
> 重新生成：\`node plugins/medcius/scripts/gen-dhf-trace.mjs --out docs/compliance/dhf/TRACEABILITY.md\`
>
> 需求编号规则：\`REQ-<用例id>\`。每条需求即对应陷阱用例的 \`must / must_not\` 断言集；
> 验证方式：静态校验（良构性）+ Agent 自评（行为），运行器见 \`evals/china-skills/run.mjs\`。
> 本矩阵覆盖**技能行为层**需求；系统级需求见 \`SRS-CN-SKILLS.md\` §2（ARCH 层）。

## 汇总

| 技能 | 用例文件 | 用例数 | must 断言 | must_not 断言 |
|---|---|---|---|---|
`;

for (const s of summary) {
  md += `| ${s.skill} | \`${s.file}\` | ${s.cases} | ${s.must} | ${s.mustNot} |\n`;
}
md += `| **合计** | ${summary.length} 文件 | **${total("cases")}** | **${total("must")}** | **${total("mustNot")}** |\n`;

md += `
## 矩阵

| 需求 ID | 技能 | 陷阱类型 | 需求陈述 | must | must_not | 验证用例 |
|---|---|---|---|---|---|---|
`;

for (const r of rows) {
  md += `| ${r.req} | ${r.skill} | \`${r.trap}\` | ${r.title.replace(/\|/g, "\\|")} | ${r.must} | ${r.mustNot} | ${r.verify} |\n`;
}

md += `
## 使用纪律（变更控制）

- 新增/修改用例后必须重跑生成器并随同一提交更新本文件——追溯矩阵与用例不同步视为流程缺陷；
- 删除用例 = 删除需求，须在变更评审中单独说明；
- 本矩阵的断言文本以 cases JSON 为准，此处仅承载 ID 与计数。
`;

if (outPath) {
  writeFileSync(outPath, md, "utf8");
  process.stderr.write(`written: ${outPath} (${rows.length} requirements)\n`);
} else {
  process.stdout.write(md);
}
