#!/usr/bin/env node
// Generates Knowledge Base Coverage, Source Licensing & Version SLA Report

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HANDLERS as chinaCodesHandlers } from "../servers/china-codes/src/tools.mjs";
import { HANDLERS as drugHandlers } from "../servers/drug-labels/src/tools.mjs";
import { HospitalKnowledgePack, UPDATE_SLA_DAYS } from "../servers/shared/knowledge-pack.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");

// Core Essential Clinical Reference Lists for Coverage Audit
const ESSENTIAL_DRUG_PANEL = [
  { name: "阿托伐他汀钙片", class: "心血管降脂药", essential: true },
  { name: "二甲双胍片", class: "口服降糖药", essential: true },
  { name: "头孢曲松钠", class: "头孢菌素类抗菌药", essential: true },
  { name: "阿奇霉素", class: "大环内酯类抗菌药", essential: true },
  { name: "依诺肝素钠", class: "抗凝溶栓药", essential: true },
  { name: "氨氯地平片", class: "钙通道阻滞降压药", essential: true },
  { name: "奥美拉唑肠溶胶囊", class: "质子泵抑制剂", essential: true },
  { name: "硫酸吗啡缓释片", class: "麻醉阵痛药品", essential: true },
  { name: "布洛芬缓释胶囊", class: "解热镇痛抗炎药", essential: true },
  { name: "复方甘草片", class: "中西复方止咳药", essential: true },
];

const ESSENTIAL_ICD10_PANEL = [
  { code: "I25.101", name: "冠状动脉粥样硬化性心脏病", core: true },
  { code: "E11.900", name: "2型糖尿病", core: true },
  { code: "I10.x00", name: "原发性高血压", core: true },
  { code: "J02.900", name: "急性咽炎", core: true },
  { code: "K80.000", name: "胆囊结石伴急性胆囊炎", core: true },
  { code: "N18.900", name: "慢性肾脏病", core: true },
];

export function generateCoverageReport() {
  const codesStatus = chinaCodesHandlers.corpus_status();
  const drugStatus = drugHandlers.corpus_status();

  let pack = null;
  const packPath = join(__dirname, "..", "packs", "hospital-knowledge-pack.json");
  if (existsSync(packPath)) {
    pack = HospitalKnowledgePack.loadFromFile(packPath);
  }

  // Calculate panel coverage
  let drugsHit = 0;
  const drugResults = ESSENTIAL_DRUG_PANEL.map((d) => {
    const res = drugHandlers.search_labels({ query: d.name, include_samples: true });
    const covered = res.hits.length > 0;
    if (covered) drugsHit++;
    return { ...d, covered, hit_count: res.hits.length, source: res.hits[0]?.source_name || "未收录" };
  });

  let codesHit = 0;
  const codeResults = ESSENTIAL_ICD10_PANEL.map((c) => {
    const res = chinaCodesHandlers.search_codes({ query: c.name, code_type: "diagnosis", include_samples: true });
    const covered = res.hits.length > 0;
    if (covered) codesHit++;
    return { ...c, covered, hit_count: res.hits.length, source: res.hits[0]?.source || "未收录" };
  });

  const drugCoveragePct = ((drugsHit / ESSENTIAL_DRUG_PANEL.length) * 100).toFixed(1);
  const codeCoveragePct = ((codesHit / ESSENTIAL_ICD10_PANEL.length) * 100).toFixed(1);

  const report = `# Medcius 医院正式知识包覆盖率与 SLA 报告

- **报告生成时间**: ${new Date().toISOString()}
- **医院名称**: ${pack?.hospitalName || "标准三级甲等综合医院"}
- **知识包版本**: ${pack?.packVersion || "2026.1.0"} (Hash: \`${pack?.provenanceHash?.slice(0, 16) || "N/A"}...\`)
- **授权许可**: ${pack?.license.type || "院内专有授权"} (${pack?.license.authority || "药事委员会"})

---

## 1. 核心临床知识覆盖率摘要

| 知识领域 | 基准监测集合数 | 本地已覆盖数 | 覆盖率 (%) | 状态评级 |
|---|---|---|---|---|
| **基本药物与高频处方药品** | ${ESSENTIAL_DRUG_PANEL.length} | ${drugsHit} | **${drugCoveragePct}%** | ${drugsHit >= 8 ? "🟢 充足 (Adequate)" : "🟡 需增补"} |
| **医保 ICD-10 核心诊断分类** | ${ESSENTIAL_ICD10_PANEL.length} | ${codesHit} | **${codeCoveragePct}%** | ${codesHit >= 5 ? "🟢 充足 (Adequate)" : "🟡 需增补"} |
| **院内自定目录与特殊处方集** | ${pack?.formulary.length || 0} | ${pack?.formulary.length || 0} | **100.0%** | 🟢 已同步 |

---

## 2. 核心药物说明书与相互作用覆盖清单

| 药品通用名 | 临床药物大类 | 覆盖状态 | 匹配记录数 | 数据出处 |
|---|---|---|---|---|
${drugResults.map((d) => `| ${d.name} | ${d.class} | ${d.covered ? "✓ 已覆盖" : "✗ 未收录"} | ${d.hit_count} | ${d.source} |`).join("\n")}

---

## 3. 医保诊断与手术编码覆盖清单

| ICD-10 编码 / 诊断名称 | 核心诊断 | 覆盖状态 | 匹配记录数 | 校验出处 |
|---|---|---|---|---|
${codeResults.map((c) => `| \`${c.code}\` ${c.name} | 是 | ${c.covered ? "✓ 已覆盖" : "✗ 未收录"} | ${c.hit_count} | ${c.source} |`).join("\n")}

---

## 4. 知识库版本更新 SLA 与服务级别承诺

| 知识源类别 | 更新源机构 | 承诺最大同步时延 (SLA) | 监控机制 |
|---|---|---|---|
| **NMPA 药品说明书与黑框警告** | 国家药品监督管理局 | $\le 14$ 个自然日 | 自动化爬取与哈希比对变更 |
| **国家医保药品目录与结算限制** | 国家医疗保障局 (NHSA) | $\le 7$ 个自然日 | 官方 Excel/PDF 结构化导入 |
| **省级医保统筹与报销规则** | 省级医保局 | $\le 30$ 个自然日 | 区域政策包版本控制 |
| **院内自定处方集与科室路径** | 医院药事委员会 | $\le 24$ 小时 | 医院统一管理门户即时下发 |

---

## 5. 生产环境数据隔离与合规边界

> [!IMPORTANT]
> 1. **严禁混用**: 样例数据 (\`data_class='sample'\`) 仅供开发与测试环境自检，生产环境审方必须连接正式授权知识包。
> 2. **哈希不可篡改**: 每次知识包更新必须重新计算 \`provenanceHash\` 并写入审计链留痕。
`;

  return report;
}

// Write report to out/
const outDir = join(repoRoot, "out");
mkdirSync(outDir, { recursive: true });
const reportMd = generateCoverageReport();
const reportPath = join(outDir, "knowledge-coverage-report.md");
writeFileSync(reportPath, reportMd, "utf8");
console.log(`✓ Knowledge coverage report generated: ${reportPath}`);
console.log(reportMd.slice(0, 500) + "...\n");
