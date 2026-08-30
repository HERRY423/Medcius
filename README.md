# Medcius

**面向一线临床医生的 Agent 插件**

Medcius 为 Codex、Trae、WorkBuddy/CodeBuddy 或医院自建 Agent 增加受约束的临床工作流能力。医生继续在熟悉的 Agent 中提出任务、查看来源并作出决定；Medcius 提供临床技能、只读数据工具、隐私保护、证据追溯和评测契约。

Medcius 不是一套独立临床软件或平台，也不是一个能够自主诊疗的“临床智能体”。它不负责替代宿主 Agent 的对话与编排，不拥有患者主数据，不独立决定下一步临床行动，也不绕过医生执行 EHR 写回。

当前版本为 **`0.5.0-pilot` 工程试点版**。已有代码和合成验证不能替代真实 EHR 验收、临床事实准确性、人因效率、安全性或监管证据。

## 定位

> Medcius = 可安装到宿主 Agent 的临床工作流技能 + 只读临床数据工具 + 隐私/证据/审计契约。

产品关系如下：

| 角色 | 负责什么 | 不负责什么 |
|---|---|---|
| 一线临床医生 | 提出任务、核对证据、确认或拒绝结果、承担临床决定 | 不需要学习新的独立工作台 |
| 宿主 Agent | 对话、任务编排、权限提示、调用插件技能与工具 | 不因安装 Medcius 自动获得诊疗自主权 |
| Medcius 插件 | 提供临床技能、MCP 工具、安全规则、结构化输出和评测 | 不充当独立临床 Agent 或医院信息平台 |
| EHR/FHIR/LIS/PACS/文档系统 | 提供经授权的原始数据与患者上下文 | 不由 Medcius 替代或复制为新的数据平台 |

医学生可以在合成或脱敏场景中参与模板、术语、标注与可用性共创；真实患者访问和临床使用必须遵循医院授权、教学权限和数据处理边界。

## 核心定位与竞争壁垒重构 (Moat & Strategic Positioning)

通用大模型“24/72 小时文本摘要”已被主流 EHR 内嵌（如 Epic Inpatient Insights 提供 Patient Story、Recent Notes 与事件摘要，512 名试点用户每日使用超 1,000 次，见 JAMIA 真实部署研究）。因此，Medcius **绝不仅靠通用的“自动文本摘要”竞争**。

Medcius 的核心壁垒与临床机会在于：
1. **结构化数据优先 (Structured-Data-First)**：跨院内多系统（NIS 护理体征与引流液、LIS 检验动态与危急值、PACS 影像检查与 HIS 医嘱变动），打破数据孤岛；
2. **确定性精确变化检测 (Exact Change Detection)**：精准计算 24h 出入量代数和、体温/血氧极值波动、电解质演变与抗菌药累计天数，不依赖 LLM 模糊泛化；
3. **未闭环事项与安全缺口追踪 (Diagnostic Loop Closure & Safety Gaps)**：按院内批准规则追踪尚未完成、未出最终报告或未确认的检查检验，并把过敏史与基线资料缺失显式呈现给医生；
4. **证据追踪与防篡改审计 (Verbatim Provenance & Immutable Audit)**：事实严格绑定病历原文 Span 或 FHIR 资源 ID，通过 SHA-256 哈希链保留完整不可篡改轨迹。

## 插件能提供什么

### 基础能力层

- 通过 FHIR R4/SMART on FHIR 读取经授权的患者与就诊资料；
- 从临床文档中抽取带原文 `span`、断言状态和来源标识的结构化事实；
- 区分“阴性”“未提及”“未评估”和“无法判断”；
- 在信息不足时输出 `null`、`unknown` 或 abstention，不补造患者和临床事实；
- 在自由文本进入日志、审计、导出或模型上下文前调用 PHI Guard；
- 通过本地哈希链保留工具调用、证据引用与人工确认的审计记录；
- 为不同宿主提供一致的技能、MCP 和安全规则入口。

### 生产核心参考工作流 (Production Core Reference Workflow)

“查房前患者变化与未闭环核对摘要”是 Medcius 生产核心的首个参考工作流。它将过去 24/72 小时的病历、检验、用药医嘱和检查状态整理为：

1. **发生了什么变化 (What Changed)**：体征极值、检验动态、医嘱调整与引流动态；
2. **今天仍待处理什么 (What's Pending)**：未回报病理/药敏、待执行会诊与处置；
3. **哪些关键资料不足 (Data Gaps)**：过敏史缺失、基线检验缺失；
4. **每条信息来自哪里 (Evidence)**：原文 span、FHIR resource ID 与时间戳。

### 分阶段模块化工作流技能包 (Staged Modular Skill Packs)

Medcius 以“小而可验证的独立技能包”分步扩展，每个技能包必须独立声明用户、触发时点、权限、失败行为与验证方案后，在医院获批试点中按需启用，不稀释核心采用目标：
- **`shift-handover`（临床交接班准备）**：基于 SBAR 模型整理夜间重点关注患者、监护极值、危急值与待办预案；
- **`consult-preparation`（专科会诊前资料整理）**：紧扣会诊诉求整合专科病程、检验时间轴与未出检查；
- **`discharge-readiness-check`（出院资料完整性核对）**：核查关键检查检验闭环、出院带药衔接及安全缺口。

诊断推断、治疗推荐、处方裁决、自动下医嘱、无人工确认的病历写回、自主多 Agent 行动和在线自学习严格禁止进入核心能力。

## 架构

```text
一线临床医生
  │  提出任务 / 授权 / 核对证据 / 最终确认
  ▼
宿主 Agent
  Codex · Trae · WorkBuddy/CodeBuddy · 医院自建 Agent
  │  按需加载技能并调用工具
  ▼
Medcius Agent Plugin
  ├─ Skills：临床工作流说明、输入输出与禁止行为
  ├─ MCP：FHIR 只读、Documents、PHI Guard、Audit Chain
  ├─ Contracts：患者/就诊/租户/时间/来源绑定与失败关闭
  ├─ Evidence：原文 span、FHIR resource ID、时间戳与显式不确定性
  └─ Evals：工程、合成、真实 EHR、临床与人因证据分层
  │
  ▼
经医院批准的数据边界
  EHR / FHIR / 临床文档 / LIS / PACS
```

宿主 Agent 是交互和编排层，Medcius 是能力与约束层，医院系统是事实来源，医生是最终责任主体。可选侧边栏只是宿主适配形式之一。

“本地 MCP”只说明连接器的运行位置，不自动等于数据绝不离院。工具结果是否进入云端模型、日志或遥测，取决于宿主 Agent 和部署方案；真实临床接入必须明确模型、网络、日志、身份、租户和数据处理边界。

## 当前插件组成

| 组件 | 当前作用 |
|---|---|
| `skills/patient-evolution-summary` | 住院查房前患者变化摘要技能（首个参考工作流） |
| `skills/shift-handover` | 临床交接班与夜间值班重点整理技能（SBAR / I-PASS 模型） |
| `skills/consult-preparation` | 专科会诊与多学科协作 (MDT) 会诊前资料整理技能 |
| `skills/discharge-readiness-check` | 出院资料核对与完整性检查技能（闭环/带药/缺口/费用负担与可获得性） |
| `skills/fhir` | 受约束的 FHIR 读取与来源绑定 |
| `skills/clinical-note-extract` | 带原文 span 和断言状态的病历事实抽取 |
| `skills/doc-extract` | 文档与附件提取 |
| `lib/hospital-agent-adapter.mjs` | 面向 Codex、Trae、WorkBuddy 与医院自建 Agent 的宿主无关适配内核 |
| `lib/clinician-directory-auth.mjs` | 医院目录身份适配（LDAP/AD/统一身份插槽 + 确定性角色映射 + 失败锁定 + 会话吊销，无隐式特权） |
| `lib/ca-signature-adapter.mjs` | CA 电子签名适配层（内置 ECDSA P-256 + 医院 CA SDK 插槽；签名记录可验签、防篡改、零 PHI） |
| `lib/patient-evolution-engine.mjs` | 查房前患者变化整理引擎 |
| `lib/shift-handover-engine.mjs` | 临床交接班 SBAR 结构化整理引擎 |
| `lib/consult-preparation-engine.mjs` | 专科会诊前资料包整理引擎 |
| `lib/discharge-readiness-engine.mjs` | 出院准备度与资料完整性核对引擎 |
| `lib/patient-affordability-context.mjs` | 来源绑定的患者费用负担、覆盖/估算与援助转介状态；不计算自付额或自动改药 |
| `lib/nhsa-record-quality-engine.mjs` | 病案首页/医保结算清单要素质量确定性核对：必填要素缺口、住院天数与费用代数一致性、离院方式值域、性别/年龄-诊断章节冲突；不做 DRG/DIP 分组、不改编码、不判定医保违规 |
| `lib/settlement-from-note.mjs` | 出院记录 → 结算清单栏 + 编码六字段出处 + 清单机检 + 病案要素质量核对；不做分组器 |
| `contracts/patient-financial-access-record.v1.schema.json` | 费用负担与可获得性输入记录的机器可检查契约 |
| `contracts/china-record-quality-report.v1.schema.json` | 病案要素质量核对报告的机器可检查契约 |
| `lib/idp-jwks-verifier.mjs` | 企业级 IdP / OIDC / JWKS 动态公钥验签与多租户隔离中间件 |
| `lib/mtls-gateway-guard.mjs` | 院内前置机 mTLS 双向认证守卫与零信任只读安全信封 |
| `lib/clinical-skill-catalog.mjs` + `rule-packs/catalogs/` | 临床技能目录全生命周期治理引擎（专家审批、哈希签名、一键熔断与回滚） |
| `contracts/clinical-skill-catalog.v1.schema.json` | 临床技能目录机器可检查契约 |
| `lib/hospital-data-adapter.mjs` | NIS/LIS/PACS/HIS 医院多源数据融合与危急值/抗菌药监控 |
| `lib/high-risk-followup-tracker.mjs` | 高风险检查检验从开立、采集、结果到医生确认的阶段追踪；不自动处置 |
| `lib/specialty-rule-pack.mjs` + `rule-packs/` | 专科病区规则包加载、版本哈希、审批元数据与生产环境失败关闭 |
| `lib/read-only-hospital-data-bridge.mjs` | 院内异构接口只读桥；逐源绑定租户、患者、就诊和来源哈希 |
| `lib/connectors/` | 真实系统四条只读接入路径连接器（P1 FHIR R4、P2 CDA 文档、P3 视图库/中间库、P4 HL7 v2 消息订阅）及 PHI 出口守卫 |
| `evals/shadow-mode/` | 真实世界多病区连续病例影子研究（Shadow Study）协议引擎与 Wilson CI 统计 |
| `evals/real-world-noise/` | 真实病历脏数据鲁棒性基准（噪声模型 + 确定性下限）与真实脱敏病历接入量具（fail-closed） |
| `evals/time-motion/` | 临床医生 Time-Motion 与人因认知负荷（NASA-TLX）自动化统计分析器 |
| `evals/physician-annotation/` | 独立医生双盲标注、Kappa 一致性评测与仲裁体系 |
| `servers/fhir` | SMART on FHIR R4 连接器；Codex、Trae、WorkBuddy 适配入口强制只读 |
| `servers/documents` | 本地文档提取与来源处理 |
| `servers/phiguard` | PHI 扫描、脱敏与假名化支持 |
| `servers/audit` | 本地防篡改检测用哈希链审计 |
| `servers/api` | 参考侧边栏、医生端内网工作台（`/workstation`，治理阶梯感知）、REST 与 CDS Hooks 适配 |

部分上游遗留能力仍需从正式插件包中继续拆分。处方、编码、临床试验、管理驾驶舱和多 Agent 模块不得因为存在于仓库中就被视为 Medcius 核心能力。

### 临床闭环深化边界

- 高风险检查检验只跟踪 `ordered → scheduled/collected → preliminary/final → acknowledged` 阶段，显式区分待执行、待最终结果、待医生确认、取消/录入错误；
- “未识别到高风险项”只表示当前规则包和可用数据源没有识别，不等于临床上不存在风险；
- 检验危急值、液体平衡、eGFR 关注边界、抗菌药复核时间点和阶段时限必须来自具名、版本化的院内规则包；缺少规则包时仅保留 LIS/PACS/HIS 自身明确上报的高风险标志；
- `sample`/`candidate` 规则包在生产配置下失败关闭，正式包必须具备医院范围、具名审批人、生效日期和可审计哈希；
- 异构桥接连接器只能声明和实现 `readPatient`，任何 create/update/delete/write 能力都会在注册时被拒绝；原始医院数据在 PHI Guard 与输出策略完成前不得进入模型上下文。

## 安全契约

- 缺少患者、就诊、用户、租户、时间、来源或必要参考范围时失败关闭；
- 自由文本事实必须绑定可验证的原文 span，结构化事实必须绑定真实资源标识和时间；
- 无可靠来源时保持 `null`，不得拼接或生成虚假证据；
- 检验判断优先使用医院 LIS/FHIR `Observation.referenceRange` 和正式危急值配置；
- 生产 Agent 适配默认只读，不暴露 `create_resource` 或 `update_resource`；
- 草稿必须由医生主动选择、核对和确认，不代表完成电子签名或 EHR 写回；
- 工程测试、合成病例和演示回放不得被描述为临床有效性证据。

## 当前成熟度

| 层级 | 状态 | 可支持的结论 |
|---|---|---|
| 插件工程 | 已有 Codex、Trae、WorkBuddy/CodeBuddy 适配与自动化检查 | 可安装、可发现、工具边界可测试 |
| 合成验证 | 已有合成病例和参考工作流评测 | 可验证软件契约和失败路径 |
| 真实 EHR 接入 | 具备真实连接器 PoC (FHIR/CDA) 与 mTLS 网关，待院端现场联调 | 不能声称已在真实生产医院完成上线验收 |
| 临床事实准确性 | 方案已定稿 (IRB/影子研究/双盲标注)，待真实入组数据 | 不能声称减少遗漏或提高准确率 |
| 医生效率与人因 | 已建立 Time-Motion 与 NASA-TLX 测量引擎与基准 | 不能声称已在真实对照组中验证 |
| 临床安全、泛化与监管 | 门禁严格阻断 (`clinical_evidence_pass: 🔒 BLOCKED`) | 不能声称临床就绪或规模化可用 |

任何 `engineering_pass` 或 `synthetic_validation_pass` 都不能升级为 `clinical_evidence_pass`。

## 插件扩展准入

新增工作流必须同时提供：

1. 明确的一线临床用户和触发场景；
2. 宿主 Agent 如何调用、何时征求医生确认；
3. 最小数据和工具权限；
4. 可回看原始来源的输出结构；
5. 缺失、冲突、超时和权限不足时的失败行为；
6. 禁止行为和人工责任边界；
7. 工程、合成、真实 EHR、临床和人因分层验证计划；
8. 可独立禁用、回滚和审计的版本。

## 安装与开发评估

Codex 本地开发评估：

```powershell
codex plugin marketplace add "$PWD\.agents\plugins"
codex plugin add medcius@medcius-local
```

Trae 使用 `.trae/mcp.json`、`.trae/rules/` 和 `.trae/skills/`；WorkBuddy/CodeBuddy 使用根目录 `.mcp.json`、`.rules/` 和 `.codebuddy/skills/`。企业宿主仍需在管理后台配置身份、凭据、规则和 MCP，并完成 Test Run。

这些入口用于工程、合成回放和获批沙箱验证，不构成真实医院部署或合规批准。真实患者数据不得进入未经批准的通用 Agent 会话。

运行项目检查：

```powershell
node scripts/run-all-checks.mjs
```

## 仓库结构

```text
plugins/medcius/
  .codex-plugin/                    # Codex 插件清单
  skills/                           # 临床工作流与数据技能
  servers/{fhir,documents,...}/     # MCP 工具服务
  lib/                              # 参考工作流实现
  evals/                            # 工程与分层评测
.trae/                              # Trae 项目适配
.codebuddy/                         # WorkBuddy/CodeBuddy 技能适配
.rules/                             # 项目级宿主规则
integrations/                       # 宿主接入说明
experimental/                       # 非核心或未批准模块
docs/compliance/                    # 合规与证据材料
tests/                              # 自动化测试
```

## 共创

欢迎一线医生、医学生、临床信息科、医学信息学研究者、人因工程师和软件工程师共同参与。最有价值的贡献不是简单增加功能，而是提供一个真实、边界清楚、可验证的临床任务：谁在什么时点需要什么信息，来源在哪里，哪些错误不可接受，插件失败时应该怎样安全退出。

贡献请优先使用合成或充分脱敏的数据，并同时提交预期输出、来源证据、失败案例和安全边界。不要在公开 Issue、PR 或通用 Agent 会话中上传真实患者隐私。

## 许可与来源

Medcius 来源于 `anthropics/healthcare` 的扩展分支。根目录 [LICENSE](LICENSE) 的 MIT 授权仅覆盖 Medcius 原创文件；上游派生文件的来源、许可和商业再分发边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。公开商业发布前，应取得所需授权或完成可审计的独立重写。
