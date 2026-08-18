# 中国医疗智能助手 / Medcius for Agents

> **实验性 / Experimental.** 本插件处于积极开发中，按原样提供，仅用于测试/沙盒系统评估。未经临床验证，不是医疗设备，未经合格人员审查不应驱动患者诊疗或医保决策。The FHIR connector ships read-only by default; write tools require an explicit opt-in scope at login — do not point them at a production EHR.

一个面向**中国医生与医疗环境**的医疗插件。提供两种**独立**安装格式：**Agent Plugins 1.0.0 便携格式**（`plugin.json` + `mcp.json`，可在 Codex、Cursor、ChatGPT、GitHub Copilot、VS Code、Qwen Code 等支持 Agent Plugins 的客户端安装使用）与 **Claude Code 原生插件格式**（`.claude-plugin/`）。技能按需加载，保持轻量——安装一次，按需使用。

```
安装到 Codex / 其他支持 Agent Plugins 的 Agent：
  将本目录（plugins/medcius）作为插件包，读取 plugin.json + mcp.json + skills/

安装到 Claude Code：
  /plugin marketplace add <repo>
  /plugin install medcius@medcius
```

## 插件内容 / What's inside

### 中国医疗技能 / China Healthcare Skills（新增）

| Skill | 面向对象 | 功能 |
|---|---|---|
| `skills/nhsa-coding` | 医保、医院 | 国家医保编码：医保版ICD-10诊断编码、CCHI手术操作编码、医保药品编码 |
| `skills/nhsa-policy` | 医保、医院 | 国家及地方医保政策：药品目录、报销比例、DRG/DIP支付、异地就医 |
| `skills/nmpa-drugs` | 药企、药师、医院 | NMPA药品注册查询：批准文号、说明书、处方药/OTC分类 |
| `skills/china-clinical-trials` | 药企、CRO、研究者 | 中国药物临床试验登记查询（chinadrugtrials.org.cn） |
| `skills/hospital-info-systems` | 医院信息科、厂商 | 中国医院信息系统（HIS/EMR/LIS/PACS）对接指南 |
| `skills/prescription-review` | 医院药师 | 处方审核：适应症、用法用量、相互作用、配伍禁忌 |

### 通用医疗技能 / Core Healthcare Skills（保留）

| Skill | Audience | What it does |
|---|---|---|
| `skills/prior-auth` | payer, provider | Review prior authorization requests with clinical documentation synthesis |
| `skills/icd10-cm` | payer, provider | Turn clinical notes into claim-ready ICD-10-CM diagnosis codes via the ICD-10 connector |
| `skills/clinical-trial-protocol` | pharma | Generate FDA/NIH-compliant clinical trial protocols for devices or drugs |
| `skills/fhir-developer` | general | FHIR API development — R4 resources, SMART authorization, endpoint patterns |
| `skills/fraud-detection` | payer | FWA detection: 22-detector deterministic sweep + LLM adjudication + investigator packets |
| `skills/contracts` | payer, provider | Answer questions across a corpus of contract documents with verified citations |
| `skills/clinical-note-extract` | provider, research | Extract structured data from clinical notes with span-level provenance |
| `skills/fhir` | provider | Connect to an EHR's FHIR R4 endpoint (SMART on FHIR), pull a patient's chart and notes |

## 连接的 MCP 服务器 / Connected MCP servers

两个清单（`mcp.json` 与 `.mcp.json`）加载**同一组服务器**：国家医保编码、国家医保药品目录、NMPA药品注册、中国临床试验、CMS Coverage、ICD-10 Codes、NPI Registry、Clinical Trials、PubMed，以及两个本地捆绑服务器（Contracts Analyzer、FHIR）。仅传输语法不同（Agent Plugins 用 `streamable-http`/`stdio`，Claude Code 用 `http`）。

## 目录结构 / Layout

```
plugins/medcius/
├── plugin.json               # Agent Plugins 1.0.0 便携清单（Codex 等）
├── mcp.json                  # Agent Plugins 便携 MCP 配置
├── .claude-plugin/           # Claude Code 插件格式（plugin.json）
├── .mcp.json                 # Claude Code MCP 配置
├── CLAUDE.md                 # Claude Code 约定
├── .cursor/rules/            # Cursor 规则（.mdc，触发关键词）
├── skills/                   # 技能（SKILL.md，Agent Skills 标准）
│   ├── nhsa-coding/          #   国家医保编码（新）
│   ├── nhsa-policy/          #   医保政策（新）
│   ├── nmpa-drugs/           #   NMPA 药品注册（新）
│   ├── china-clinical-trials/#   中国临床试验（新）
│   ├── hospital-info-systems/#   医院信息系统（新）
│   ├── prescription-review/  #   处方审核（新）
│   ├── clinical-note-extract/ … # 原有技能
│   └── …
├── agents/                   # 子代理（Claude Code）
├── servers/                  # 本地 MCP 服务器源码（documents/fhir）
└── workflows/                # 管道作业（Claude Code）
```

## 合规声明 / Compliance

本插件提供的医保、药品、法规信息仅供参考，最终以国家医疗保障局、国家药品监督管理局、国家卫生健康委及各省官方发布为准。医保政策具有地区差异，请以参保地医保局最新文件为准。处方审核为药师法定职责，本插件仅作辅助。