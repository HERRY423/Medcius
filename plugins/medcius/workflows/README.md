# Medcius 临床 Agent 声明式工作流 (Agentic Workflow Recipes)

本目录定义了面向 AI Agent（如 Claude、DeepSeek、Antigravity、ChatGPT 等）的**声明式临床工作流配方 (Workflow Recipes)**。

每个工作流定义了在特定临床或信息化场景下，Agent 应如何组织推理链、按何种拓扑顺序调用 7 个本地 MCP Server（68 个工具）、如何执行安全门控以及如何处理异常分支。

## 📋 工作流清单

| 工作流文件 | 触发场景 | 涉及 MCP Server | 关键门控与合规红线 |
|---|---|---|---|
| [`prescription-review.workflow.md`](./prescription-review.workflow.md) | 处方下达、前置审方、CDS Hooks 拦截 | `phiguard`, `drug-labels`, `audit`, `fhir` | G1-G3 门控、四选一结论、严格阻断无依据放行 |
| [`admission-coding.workflow.md`](./admission-coding.workflow.md) | 入出院病历抽取、国家医保结算编码对照 | `phiguard`, `china-codes`, `documents`, `audit` | 永不凭记忆产码、6 字段出处溯源、结算自检清单 |
| [`quality-improvement.workflow.md`](./quality-improvement.workflow.md) | 医生处方质量画像、薄弱点归因、CME 推送 | `audit`, `memory`, `api` (analytics) | 统计学显著性归因、国家权威指南映射、学习追踪 |
| [`phi-compliance-audit.workflow.md`](./phi-compliance-audit.workflow.md) | 隐私合规巡检、等保三级自查、脱敏覆盖率 | `phiguard`, `audit`, `shared` (crypto) | 个人信息保护法 (PIPL)、Luhn 银行卡、假名盐一致性 |

## 🛠️ Agent 执行原则

1. **Local-First & Zero Hosted Cloud**: 严禁将自由文本或未脱敏数据传输至任何外部云端；全部计算与检索均在本地 MCP Server 执行。
2. **Deterministic Gating Prior to LLM Synthesis**: 必须优先调用 MCP 工具获取版本化确定性证据，严禁由 LLM 直接依据内部权重推断药物相互作用或医保编码。
3. **Mandatory Audit Logging**: 判定性动作必须调用 `audit:record_event` 并关联 `trace_ref` 推理追踪。
