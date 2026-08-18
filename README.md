# 中国医疗智能助手 / Medcius for Agents

一个面向**中国医生与医疗环境**的医疗插件。提供两种**独立**安装格式：**Agent Plugins 1.0.0 便携格式**（`plugin.json` + `mcp.json`，可在 Codex、Cursor、ChatGPT、GitHub Copilot、VS Code、Qwen Code 等支持 Agent Plugins 的客户端安装使用）与 **Claude Code 原生插件格式**（`.claude-plugin/`）。技能按需加载，保持轻量——安装一次，按需使用。

## 快速开始 / Quick Start

**安装到 Codex / 其他支持 Agent Plugins 的 Agent：**

将 `plugins/medcius/` 目录作为 Agent Plugin 包安装。该目录包含 Agent Plugins 1.0.0 标准的 `plugin.json`（清单）、`mcp.json`（MCP 服务器配置）和 `skills/`（Agent Skills 格式的技能）。

**安装到 Claude Code：**

```bash
/plugin marketplace add HERRY423/Medcius
/plugin install medcius@medcius
```

## 插件内容 / What's inside

### 中国医疗技能 / China Healthcare Skills（新增）

| Skill | 面向对象 | 功能 |
|---|---|---|
| `nhsa-coding` | 医保、医院 | 国家医保编码：医保版ICD-10诊断编码、医保版手术操作分类编码（查询+校验协议，编码附带版本与出处） |
| `nhsa-policy` | 医保、医院 | 国家及地方医保政策：药品目录、报销比例、DRG/DIP支付、异地就医 |
| `nmpa-drugs` | 药企、药师、医院 | NMPA药品注册查询：批准文号、说明书、处方药/OTC分类 |
| `china-clinical-trials` | 药企、CRO、研究者 | 中国药物临床试验登记查询（chinadrugtrials.org.cn） |
| `hospital-info-systems` | 医院信息科、厂商 | 中国医院信息系统（HIS/EMR/LIS/PACS）对接指南 |
| `prescription-review` | 医院药师 | 处方审核：适应症、用法用量、相互作用、配伍禁忌 |

### 通用医疗技能 / Core Healthcare Skills（保留）

| Skill | Audience | What it does |
|---|---|---|
| `clinical-note-extract` | provider, research | Extract structured data from clinical notes with span-level provenance |
| `clinical-trial-protocol` | pharma | Generate FDA/NIH-compliant clinical trial protocols for medical devices or drugs |
| `contracts` | payer, provider | Answer a question across a corpus of contract documents with verified citations |
| `doc-extract` | general | Extract plain text from a document file - PDF, DOCX, XLSX, PPTX, RTF, or plain text/markdown/HTML |
| `fhir` | provider | Connect to a hospital's FHIR R4 server, pull a patient's clinical data and notes |
| `fhir-developer` | general | FHIR API development guide for building healthcare endpoints |
| `fraud-detection` | payer | Screen a Medicare/Medicaid claims corpus for fraud, waste, and abuse |
| `icd10-cm` | payer, provider | Extract billable ICD-10-CM diagnosis codes from a clinical note |
| `prior-auth` | payer, provider | Automate payer review of prior authorization (PA) requests |
| `procedure-coding` | payer, provider | Assign CPT and HCPCS Level II procedure codes from clinical documentation |

## 连接的 MCP 服务器 / Connected MCP servers

两个清单（Agent Plugins `mcp.json` 与 Claude Code `.mcp.json`）加载**同一组服务器**，仅在传输语法上不同（Agent Plugins 用 `streamable-http`/`stdio`，Claude Code 用 `http`）。

| Server | URL |
|--------|-----|
| 国家医保编码 (NHSA Codes) | https://hcls.mcp.claude.com/nhsa_codes/mcp |
| 国家医保药品目录 (NHSA Drug Catalog) | https://hcls.mcp.claude.com/nhsa_drug_catalog/mcp |
| NMPA 药品注册 (NMPA Drug Registry) | https://hcls.mcp.claude.com/nmpa_drugs/mcp |
| 中国临床试验 (China Clinical Trials) | https://hcls.mcp.claude.com/china_clinical_trials/mcp |
| CMS Coverage | https://hcls.mcp.claude.com/cms_coverage/mcp |
| ICD10 Codes | https://hcls.mcp.claude.com/icd10_codes/mcp |
| NPI Registry | https://hcls.mcp.claude.com/npi_registry/mcp |
| Clinical Trials | https://hcls.mcp.claude.com/clinical_trials/mcp |
| PubMed | https://pubmed.mcp.claude.com/mcp |
| Contracts Analyzer | bundled with the plugin (local stdio) |
| FHIR | bundled with the plugin (local stdio) |

## 目录结构 / Layout

```
medcius/
├── README.md                 # 本文件
├── .claude-plugin/           # Claude Code 市场清单（marketplace.json）
├── plugins/medcius/       # 插件本体
│   ├── plugin.json           #   Agent Plugins 1.0.0 便携清单（Codex 等）
│   ├── mcp.json              #   Agent Plugins 便携 MCP 配置
│   ├── .claude-plugin/       #   Claude Code 插件格式（plugin.json）
│   ├── .mcp.json             #   Claude Code MCP 配置
│   ├── CLAUDE.md             #   Claude Code 约定
│   ├── skills/               #   技能（SKILL.md，Agent Skills 标准）
│   ├── agents/               #   子代理（Claude Code）
│   ├── servers/              #   本地 MCP 服务器源码（documents/fhir）
│   └── workflows/            #   管道作业（Claude Code）
├── servers/                  # 客户自托管 MCP 服务器源码（占位）
├── managed-agents/           # Managed Agents API 模板（占位）
└── scripts/                  # 构建/版本脚本
```

## 从 v1 迁移 / Migrating from v1

v1 的按技能/按服务器插件（`prior-auth-review`、`fhir-developer`、`clinical-trial-protocol`、`cms-coverage`、`icd10-codes`、`npi-registry`、`pubmed`）仍可作为已弃用别名安装，解析到单一 `medcius` 插件。切换到 `medcius@medcius`；别名将在未来版本中移除。

## 合规声明 / Compliance

本插件提供的医保、药品、法规信息仅供参考，最终以国家医疗保障局、国家药品监督管理局、国家卫生健康委及各省官方发布为准。医保政策具有地区差异，请以参保地医保局最新文件为准。处方审核为药师法定职责，本插件仅作辅助。

## 许可证 / License

MIT License 覆盖 **Medcius 原创文件**（详见仓库根目录 `LICENSE`，Copyright © 2026 HERRY423）。上游 `anthropics/healthcare` 派生文件的再分发受 Anthropic 条款约束，逐文件的来源与许可姿态见 **`THIRD_PARTY_NOTICES.md`**。