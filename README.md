# Medcius for Agents

**产品边界：** Medcius 做三件事——**医保编码**、**处方审核辅助**、**病历结构化抽取**。不做诊断决策、不生成鉴别诊断、不替代医师/药师/编码员。

提供两种**独立**安装格式：**Agent Plugins 1.0.0 便携格式**（`plugin.json` + `mcp.json`）与 **Claude Code 原生插件格式**（`.claude-plugin/`）。技能按需加载。MCP **仅本地 stdio**，不连接任何 Claude/Anthropic 托管服务。

## 生产门闩 / Production gate

真实编码/审方需要医院自有官方包（`official > 0`）。仓库只带 sample。

```bash
node scripts/doctor.mjs
node scripts/import-official.mjs --kind codes --file codes.csv --source 医保办 --version 2024 --effective-date 2024-01-01
node scripts/intake-discharge.mjs path/to/出院记录.md --code --out out/intake
node scripts/settlement-from-note.mjs path/to/出院记录.md --out out/settle
node scripts/serve.mjs --port 8080   # 启动 RESTful API 与 HL7 FHIR CDS Hooks 服务
node scripts/run-evals.mjs --with-corpus
```

详见 `plugins/medcius/packs/README.md`。

## 临床接口与多 Agent 服务 / Clinical API & Multi-Agent

- **HL7 FHIR CDS Hooks**：`GET /cds-services` 发现端点，`POST /cds-services/medcius-prescription-review`（开药前审方）与 `POST /cds-services/medcius-order-sign`（签署前医保核对）。
- **RESTful API**：`/api/v1/prescription/review`、`/api/v1/coding/resolve`、`/api/v1/note/extract`、`/api/v1/encounter/process`、`/health`。
- **Supervisor-Worker 多 Agent 调度**：`plugins/medcius/orchestrator/supervisor.mjs` 统一调度 `ExtractWorker`、`CodingWorker`、`PharmaWorker` 与 `AuditWorker`。
- **数据安全与加密**：增强型中文临床脱敏（`phiguard`）与 AES-256-GCM 密文存储（`servers/shared/secure-store.mjs`）。

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
| `nmpa-drugs` | 药师 | 本地说明书库核对批文格式与摘录；无注册全库，未命中即停 |
| `china-clinical-trials` | 研究 | 本地 CTR 摘录库 + 官网；未命中不得编造 |
| `hospital-info-systems` | 医保办、信息科 | 结算清单字段对照 + 电子病历评级约束（不推荐厂商） |
| `prescription-review` | 医院药师 | 处方审核辅助：适应症、用法用量、相互作用、配伍禁忌（G2/G3 接入本地药品标签库，`no_mention_in_corpus ≠ 无相互作用`） |
| `clinical-note-extract` | 编码员、病案、研究 | 病历抽取（中国住院 schema：入院/出院诊断、手术、过敏史、体格检查）；不诊断、不编码 |

### 通用医疗技能 / Core Healthcare Skills（保留）

| Skill | Audience | What it does |
|---|---|---|
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

两个清单（Agent Plugins `mcp.json` 与 Claude Code `.mcp.json`）只加载**本地 stdio** 服务器。没有 `hcls.mcp.claude.com` / `pubmed.mcp.claude.com`。

| Server | URL |
|--------|-----|
| 本地编码与目录库 (Local China Codes) | bundled（stdio，`china-codes`）— 医保版 ICD-10 / 手术操作 / 药品目录 |
| 本地药品标签库 (Local Drug Labels) | bundled（stdio，`drug-labels`）— 说明书摘录；非 NMPA 注册全库；CYP/分类信号；肌酐默认 μmol/L |
| 本地临床试验登记库 (Local China Trials) | bundled（stdio，`china-trials`）— CTR 摘录，未命中不得编造 |
| Contracts Analyzer | bundled（stdio，`documents`） |
| FHIR | bundled（stdio，`fhir`）— 用户自配医院端点，只读默认 |

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
│   ├── servers/              #   本地 MCP 服务器源码（documents/fhir/drug-labels）
│   ├── evals/china-skills/   #   中国技能 golden case（编码/政策/审方/抽取 43 陷阱）+ 运行器
│   └── workflows/            #   管道作业（settlement-check：编码→DRG/DIP 探针）
├── servers/                  # 客户自托管 MCP 服务器源码（占位）
├── managed-agents/           # Managed Agents API 模板（占位）
└── scripts/                  # 构建/版本脚本（validate-*, smoke-mcp, run-evals）
```

## 从 v1 迁移 / Migrating from v1

v1 的按技能/按服务器插件（`prior-auth-review`、`fhir-developer`、`clinical-trial-protocol`、`cms-coverage`、`icd10-codes`、`npi-registry`、`pubmed`）仍可作为已弃用别名安装，解析到单一 `medcius` 插件。切换到 `medcius@medcius`；别名将在未来版本中移除。

## 合规声明 / Compliance

本插件提供的医保、药品、法规信息仅供参考，最终以国家医疗保障局、国家药品监督管理局、国家卫生健康委及各省官方发布为准。医保政策具有地区差异，请以参保地医保局最新文件为准。处方审核为药师法定职责；病历抽取不是诊断。本插件仅作辅助，**不替代临床决策**。

SaMD 分类路径与法规依据：`docs/compliance/SAMD-PATHWAY.md`；监管动作跟踪：`docs/compliance/REG-ACTION-TRACKER.md`（分类界定答复到达前，本插件不得宣称可用于院内正式审方流程）。

## 许可证 / License

MIT License 覆盖 **Medcius 原创文件**（详见仓库根目录 `LICENSE`，Copyright © 2026 HERRY423）。上游 `anthropics/healthcare` 派生文件的再分发受 Anthropic 条款约束，逐文件的来源与许可姿态见 **`THIRD_PARTY_NOTICES.md`**。