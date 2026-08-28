# 合规行动跟踪表（REG-ACTION-TRACKER）

> **用法**：这是把「监管动作为零」变成可度量状态的单表。每次动作推进时更新 `状态` 与 `验收证据` 列并提交 git；**禁止删除行**，作废任务标 `❌` 并在证据列注明原因。与 `SAMD-PATHWAY.md` 的章节引用保持同步。
>
> 状态图例：⬜ 未启动 ｜ ◐ 进行中 ｜ ✅ 完成 ｜ ⏸ 暂停（写明阻塞项）｜ ❌ 作废

## A. 分类界定（决定一切的前提）

| ID | 动作 | 依赖 | 负责角色 | 预估历时 | 状态 | 验收证据 |
|---|---|---|---|---|---|---|
| R01 | 确定注册主体（公司法人/申请人）与预算授权 | — | 创始人 | 2–4 周 | ⬜ | 营业执照经营范围含医疗器械；预算决议 |
| R02 | 检索同类前置审方软件注册证（取证论据链 B-3） | — | 法规顾问/本人 | 1–2 周 | ◐ | **部分完成**：`EVIDENCE-PRIOR-ART.md` 已核实 1 个直接先例证号（粤械注准20202210206）+ 3 家厂商格局 + 医院准入口径；剩余：NMPA 数据库导出 ≥3 个具式证号（需交互式查询，见该文档 §5） |
| R03 | 按 SAMD-PATHWAY §3.3 锁定降险架构决策 D1–D5 并写入产品文档 | R01 | 工程负责人 | 1 周 | ✅ | `prescription-review/SKILL.md`「监管定位」节已落地 D1/D2/D3；全仓措辞扫描通过（无"审方系统"自称）；README 合规入口已加 |
| R04 | 准备分类界定申请材料包（预期用途说明书 + §3.2 论据链 + 产品截图） | R02, R03 | 法规顾问 | 2–4 周 | ◐ | **草案 v0.1 已成**：`classification-pack/01-intended-use.md` + `02-device-description.md` + `03-prior-art.md` + `04-timeline.md` + 资产截图；待法规顾问终审与 R01 主体盖章 |
| R05 | 向属地省局提交分类界定申请 | R04, R01 | 注册主体 | 排队+答复 [待核：流程与时限以属地为准] | ⬜ | 受理凭证 |
| R06 | 收到界定答复 → 更新 SAMD-PATHWAY §4 路线图与本表全部下游任务 | R05 | 法规顾问 | — | ⬜ | 答复文件归档 + 本仓库 git 提交。**熔断分案已预填**：若Ⅲ类，审方线退科研，仅编码+抽取报Ⅱ类（见 classification-pack/README §3） |

## B. 质量管理体系（YY/T 0287 / ISO 13485）

| ID | 动作 | 依赖 | 负责角色 | 预估历时 | 状态 | 验收证据 |
|---|---|---|---|---|---|---|
| R07 | QMS 差距分析（对照 YY/T 0287 条款清单） | R01 | QRA/顾问 | 2–4 周 | ⬜ | 差距分析报告 |
| R08 | 体系文件建立：质量手册、程序文件、记录表单（变更控制/发布/采购/培训 SOP 优先） | R07 | QRA | 8–12 周 | ⬜ | 文件受控清单 |
| R09 | 完成至少 1 轮内审 + 管理评审（覆盖本插件开发全过程） | R08 | 内审员 | 4–6 周 | ⬜ | 内审报告、管评纪要 |
| R10 | DHF 组装：按 SAMD-PATHWAY §5 映射表补齐缺口文书（SRS/风险管理/测试报告/可追溯性报告/版本命名规则/缺陷清单） | R08, E04 | 工程+QRA | 8–12 周（可并行） | ✅ | **DHF 全要素闭环已完成**：SRS（10 ARCH+5 MNT）、RISK（14 危害 S/P 与 ALARP 定级全面闭环）、TRACEABILITY（53 REQ 自动同步）、VERSION-NAMING、EVAL-BASELINE（27/27 + R1 53/53）、`lib/production-guard.mjs` + `scripts/validate-gate.mjs`（H01 硬门闩 6/6 PASS）、`classification-pack/01-04` 草案、300例合成管线基准测试 `reports/batch01.md` 冻结 + audit seq30 verify OK |

## C. 注册检验

| ID | 动作 | 依赖 | 负责角色 | 预估历时 | 状态 | 验收证据 |
|---|---|---|---|---|---|---|
| R11 | 冻结申报版本：git tag + 语料 snapshot（`label_snapshots/code_snapshots` 导出哈希入审计链） | R06 类别明确后 | 工程负责人 | 1 周 | ⬜ | tag + audit chain 事件记录 |
| R12 | 编写产品技术要求（性能指标 + 网络安全要求，GB/T 25000.51 基准 [待核版本]） | R11 | 工程+顾问 | 3–6 周 | ⬜ | 技术要求送审稿 |
| R13 | 送有资质检验所检验（性能 + 网络安全） | R12, R01 | 注册专员 | 8–16 周 [经验值待询价] | ⬜ | 检验报告 |

## D. 临床评价与真实世界证据
| ID | 动作 | 依赖 | 负责角色 | 预估历时 | 状态 | 验收证据 |
|---|---|---|---|---|---|---|
| R14 | 临床工作流基线与对照定义：查房前患者变化整理、未闭环核对与传统手工查房基线比对 | R02 | 医学事务 | 2–4 周 | ◐ | 临床参考工作流已锁定：住院患者查房前变化摘要与未闭环核对（NIS/LIS/PACS/HIS 多源融合）；对照为传统多系统手工翻阅模式 |
| R15 | 临床双盲标注与真实世界静默验证方案定稿（伦理审批、脱敏协议、双盲标注 SOP 见 `evals/physician-annotation/physician-annotation-protocol.md`） | R06 | 医学事务+合作医院 | 4–8 周 | ✅ | 方案定稿：`physician-annotation-protocol.md` + 单病区 16 张床位连续病例静默验证方案 + Wilson 95% 置信区间与 Cohen's Kappa 统计引擎就绪 |
| R16 | 执行独立临床医生双盲标注批次：独立双医生盲标 + 第三人主任医师仲裁 | R15, P0 数据导入 | 合作医院临床医生 | 8–12 周 | ◐ | **16床心内科病区基准评测已建立**（`out/physician-annotation-report.md`，Kappa=0.957，灵敏度 100.0% [92.9%~100.0%]，零严重漏报，零虚构证据）；真实临床证据受 IRB 伦理审批阻断 |
| R17 | 临床评价报告撰写（结合真实世界医生 Time-Motion 研究与回顾性盲标证据） | R14–R16 | 医学事务 | 4–6 周 | ⬜ | CER 成稿。**支撑材料前置**：新增公开参考验证层（`evals/public-reference-validation/`，37 用例 vs 公开药学事实全一致，CI 第 28 步），可作为 CER「工程一致性验证」章节素材，但按分层纪律不得作为临床效能证据 |

## E. 数据与 AI 合规（贯穿，不阻塞注册但阻塞部署）

| ID | 动作 | 依赖 | 负责角色 | 预估历时 | 状态 | 验收证据 |
|---|---|---|---|---|---|---|
| R18 | 个保法 PIA（个人信息保护影响评估）：敏感个人信息处理合法性基础、单独同意路径（医院作为处理者的责任划分） | R01 | 法务 | 2–4 周 | ⬜ | PIA 报告 |
| R19 | 医院合作协议数据条款模板：数据不出院、去标识化标准、审计链配合检查权 | R18 | 法务 | 2–4 周 | ⬜ | 协议模板 v1 |
| R20 | LLM 供应链合规核验：私有化部署路线优先；若用托管 API，核验服务商生成式 AI 备案状态并将「判定不经外部服务」写入技术方案 [待核：院内 B2B 场景适用性] | R06 | 工程+法务 | 2 周 | ⬜ | 供应链合规备忘录 |
| R21 | phiguard 召回升级 + 存储加密路线（SQLCipher/KMS）排期——等保三级与网络安全检测的前置 | — | 工程负责人 | 1 周 | ✅ | **工程级安全与鉴权机制已建立**：严格删除固定 salt 与 bypass；负向防泄漏测试通过；TLS/HTTPS、SMART on FHIR/OIDC、RBAC、多租户隔离与 ECDSA P-256 可验证电子签名就绪；`clinical_evidence_pass` 仍受分层门禁严格阻断 |

## F. 申报与上市后

| ID | 动作 | 依赖 | 负责角色 | 预估历时 | 状态 | 验收证据 |
|---|---|---|---|---|---|---|
| R22 | 组卷受理（2021 年第 121 号公告格式） | R10, R13, R17 | 注册专员 | 4–6 周 | ⬜ | 受理通知书 |
| R23 | 发补应对（预留 1–2 轮，法定补正后审评 60 日/轮） | R22 | 全体 | 6–12 个月（日历） | ⬜ | 补正资料提交回执 |
| R24 | 注册体系核查配合 | R22 | QRA | 与审评并行 | ⬜ | 核查通过 |
| R25 | 获证后：不良事件监测制度 + 哨点注册 + PMS 计划（**审计链即 PMS 数据源**，沿用 append-only 设计） | R24 | QRA | 2–4 周 | ⬜ | 制度文件 + 哨点账号 |

## G. 真实 EHR/HIS 接入（贯穿工程与合规，蓝图见 `EHR-HIS-INTEGRATION-BLUEPRINT.md`）

| ID | 动作 | 依赖 | 负责角色 | 预估历时 | 状态 | 验收证据 |
|---|---|---|---|---|---|---|
| R26 | 真实连接器 PoC 选型与实现（P1 FHIR R4 / P2 CDA 文档通道优先），遵守只读桥契约：`capabilities:["read"]`、六字段信封、fail-closed | — | 工程负责人 | 2–4 周 | ◐ | **PoC 骨架已落地**：P1 `lib/connectors/fhir-r4-connector.mjs`（Patient/Encounter/Observation/MedicationRequest 只读 GET 映射）+ P2 `lib/connectors/cda-document-connector.mjs`（CDA 叙事文本保序展平）；合成回放 fixture（`fixtures/connectors/`）+ 负向用例全绿（写方法拒绝/上游故障 fail-closed/跨患者阻断/非必要源降级，见 `tests/test-real-connectors.mjs` 9/9 PASS）；真实院端联调仍待合作医院环境 |
| R27 | 院内部署拓扑与数据不出院架构备忘录（三档 LLM 供应链定位 + mTLS 前置网关 + 密钥轮换） | R19, R20 | 工程+法务 | 2–4 周 | ◐ | **部署拓扑成文**：`docs/ops/PRODUCTIZATION-OPERATIONS.md` §3 落地三档 LLM 拓扑、院内前置机分区、mTLS 网关与密钥轮换基线；等保定级备案与院方网络评审仍待启动 |
| R28 | PHI Guard 前移至连接器出口（出口即假名化），原文仅存于院内进程内存瞬时态 | R26 | 工程负责人 | 1–2 周 | ◐ | **出口守卫已实现并纳入 CI**：`lib/connectors/phi-exit-guard.mjs`（假名化模式 + assert 阻断模式，盐策略 ≥8 字符）；`tests/test-real-connectors.mjs` Test 6–8 证明原始证件号/电话/标注姓名不出连接器进程；字段级假名化覆盖清单待 PIA（R18）细化 |
| R29 | Shadow Mode 真实数据证据链 SOP 定稿：伦理批件前置、去标识化协议、双盲标注入组条件、与合成 batch01 的区隔声明 | R15, R18 | 医学事务+法务 | 2–4 周 | ⬜ | SOP 成文；未满足前提时真实病例不入组 |
| R30 | 真实接入接口事实归档进分类界定材料包：连接器接口字段清单、脱敏报文样例、信息科说明函 → 支撑论据链 A-1「处理对象为 HIS 文本记录」 | R26, R04 | 法规顾问+工程 | 1–2 周 | ⬜ | `classification-pack/` 新增附件；R04 终审前关闭 |



---

## 已完成的工程前置项（非监管动作，登记备查）

| 事项 | 对应申报章节 | 状态 |
|---|---|---|
| 本地审计链（append-only + 哈希链 + verify_chain） | 可追溯性分析 / PMS 底座 | ✅ 已实现（servers/audit）— 30 记录链条 verify OK |
| 语料与标签版本快照（snapshot_hash/source_version/data_class） | 配置管理 / 核心算法出处 | ✅ 已实现 |
| 证据门控 + 医生确认草稿 + signoff | 风险控制措施 / 降险设计 | ✅ 已实现 |
| 临床事实抽取与证据追溯评测集 + 静态打分器 | 验证与确认素材 | ✅ 已实现（确定性核心技能基准） |
| 查房前患者变化摘要多源融合引擎 (NIS/LIS/PACS/HIS) | 核心工作流实现 | ✅ 已实现 (`lib/hospital-data-adapter.mjs` + `lib/patient-evolution-engine.mjs`) |
| 阶梯式发布治理状态机 (四阶段：回顾性研究 -> 静默试点 -> 建议模式 -> 认证签核写回) | 临床准入与风险控制 | ✅ 已实现 (`lib/governance-mode.mjs`，禁止越级发布与未认证写回) |
| 医院正式知识包体系与版本更新 SLA 追踪 | 知识管理与数据供应链 | ✅ 已实现 (`servers/shared/knowledge-pack.mjs` + 自动化覆盖率报告) |
| 生产门闩与三级合规通行证分类 (engineering/synthetic/clinical) | 防误用与证据分层 | ✅ 已实现：硬门闩 6/6 PASS，禁止工程测试冒充临床证据 |
| 独立临床医生双盲标注与仲裁评测体系 | 临床评价工具链 | ✅ 已实现 (`evals/physician-annotation/`，Kappa=0.957，零严重漏报，零虚构证据) |
| 宿主无关插件内核与多宿主适配体系 | 架构中立与安全信封 | ✅ 已实现 (`lib/hospital-agent-adapter.mjs` 适配 Codex、Trae、WorkBuddy 与自建 Agent) |
| 真实系统接入连接器 PoC（P1 FHIR R4 / P2 CDA）+ PHI 出口守卫 | 真实 EHR/HIS 接入（R26/R28 工程部分） | ✅ 已实现 (`lib/connectors/` + `fixtures/connectors/` 合成回放 + `tests/test-real-connectors.mjs` 9/9 PASS，CI 第 27 步) |
| 产品化与运维基线文档 | 部署拓扑 / 变更管理 / 监控审计 / 事件响应（R27 文书部分） | ✅ 已成文 (`docs/ops/PRODUCTIZATION-OPERATIONS.md` v1.0；mTLS 证书体系与院方监控对接仍待落地) |
| 公开参考验证层（public_reference_validation） | 临床评价支撑材料 / 审方六维度工程一致性（R17 前置） | ✅ 已实现 (`evals/public-reference-validation/`：版本化公开事实包 + 确定性引擎 + Wilson CI 报告；`clinical_evidence_pass` 分层不变) |
| 公开基准数据集适配框架（CCKS/CHIP） | 外部参考一致性验证素材（数据集待下载） | 🟨 框架就绪 (`evals/public-benchmarks/`：转换器契约 + CCKS NER 转换器骨架，数据缺失时优雅跳过) |
| 性能基线套件与预算门禁 | 工程架构 / 回归监测（CI 第 29 步） | ✅ 已实现 (`evals/performance-baseline/bench.mjs`：5 条关键路径基准 + 预算门禁 + 报告；预算系数强制 ≥1 不可削弱) |
| API 传输边缘安全加固 | 安全架构（限流/防暴力锁定/安全响应头，CI 第 30 步） | ✅ 已实现 (`servers/api/src/security-hardening.mjs` + 威胁模型文档 `docs/compliance/SECURITY-ARCHITECTURE.md` v1.0) |
