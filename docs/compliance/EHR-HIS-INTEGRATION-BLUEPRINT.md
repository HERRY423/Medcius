# EHR/HIS 真实接入 × 数据/AI 合规 × NMPA 准入 优化蓝图（v1.0）

> **用途**：把「从内存信封演示走向真实医院 EHR/HIS 接入」所需的三条线——**接入工程**、**数据/AI 合规**、**法规准入**——统一成一份可执行的优化蓝图。所有行动项已登记到 `REG-ACTION-TRACKER.md` §G（R26–R30）。
> **状态**：v1.0。工程线 PoC 已落地（P1 FHIR R4 / P2 CDA 只读连接器 + PHI 出口守卫 + 合成回放 fixture + 负向用例，见 `plugins/medcius/lib/connectors/` 与 `tests/test-real-connectors.mjs`）；产品化与运维基线成文于 `docs/ops/PRODUCTIZATION-OPERATIONS.md`。合规结论不构成法律意见，[待核] 项启动前须由注册顾问/法务逐条关闭。
> **关联**：`SAMD-PATHWAY.md`（分类路径与 D1–D6）、`REG-ACTION-TRACKER.md`、`PRIVACY-SECURITY.md`、`docs/ops/PRODUCTIZATION-OPERATIONS.md`、`integrations/hospital-agent/README.md`（只读桥契约）、`experimental/skills/hospital-info-systems/SKILL.md`（评级约束红线）。

## 1. 现状盘点与缺口（诚实基线）

### 1.1 已有资产（可直接复用）

| 资产 | 落点 | 对真实接入的意义 |
|---|---|---|
| 异构只读桥（capabilities 白名单、六字段信封、payload SHA-256、fail-closed） | `lib/read-only-hospital-data-bridge.mjs` | 真实连接器只需实现 `readPatient(context)` 即插入，安全契约现成 |
| 多源归一化（NIS/LIS/PACS/HIS 医嘱） | `lib/hospital-data-adapter.mjs` | 协议适配层与业务层解耦，新增协议不改下游 |
| 四级发布治理状态机 | `lib/governance-mode.mjs` | 真实接入后的每一级放量都有硬性门禁 |
| PHI Guard 前置管道 + 审计哈希链 | `servers/phiguard`、`servers/audit` | 数据不出院与留痕底座已就绪 |
| CDS Hooks 2.0 / REST / SMART Web Messaging 适配 | `servers/api/src/cds-hooks.mjs` 等 | 院内触发面已有标准形态 |

### 1.2 缺口（本蓝图要关闭的）

| # | 缺口 | 状态（v1.0） |
|---|---|---|
| 1 | **没有真实协议连接器**：当前桥接测试全部基于内存 fixture；FHIR server 为 experimental 且仅面向沙箱（`servers/fhir/README.md`）。国内 HIS 主流形态（HL7 v2 消息流、CDA 文档、集成平台/视图库中间表）均无适配器。 | **大部分关闭**：P1 FHIR R4（`lib/connectors/fhir-r4-connector.mjs`）、P2 CDA 文档通道（`lib/connectors/cda-document-connector.mjs`）、P3 视图库/中间库（`lib/connectors/viewdb-connector.mjs`，白名单标识符 + 强制参数化 SELECT + 租户/患者强制 WHERE）、P4 HL7 v2 消息订阅（`lib/connectors/hl7v2-connector.mjs`，ADT/ORU/RDE 确定性解析）四条路径 PoC 全部落地并通过合成回放 + 负向用例；真实院端联调待合作医院环境 |
| 2 | **院内部署拓扑未成文**：mTLS 双向认证、前置机/院内网关、密钥轮换仍停留在 `PRIVACY-SECURITY.md` 的「目标」列。 | **部分关闭**：部署拓扑、分区与密钥轮换基线已写入 `docs/ops/PRODUCTIZATION-OPERATIONS.md` §3；mTLS 证书体系落地待院方网络评审 |
| 3 | **R18/R19 未启动**：个保法 PIA 与医院合作协议数据条款模板均为 ⬜，而它们阻塞一切真实患者数据进入管线。 | 未关闭（阻塞不变） |
| 4 | **Shadow Mode 真实数据的注册证据链未定义**：静默试点产生的真实数据如何合法地支撑 Phase 3 临床评价（伦理、去标识化、与合成 batch01 的区隔）没有成文 SOP。 | 未关闭（R29 待启动） |
| 5 | **接口事实未归档进申报包**：分类界定论据链 A 第 1 条主张「处理对象是 HIS/病案系统的文本记录」，但仓库内没有任何真实接口字段清单可作为申请书附件。 | **部分关闭**：连接器的字段映射清单（FHIR→六字段信封、CDA→notes 记录）已成文于 `lib/connectors/` 源码注释与本文 §2.2，可作为 R30 归档骨架；脱敏报文样例需用真实通道回放后归档 |

## 2. 真实 EHR/HIS 接入优化（工程线）

### 2.1 四条只读接入路径（按优先级）

| 路径 | 适用场景 | 对接物 | 关键约束 | 优先级 |
|---|---|---|---|---|
| **P1 FHIR R4 只读** | 已建集成平台/互联网医院或评级 4 级以上院区 | 医院 FHIR 端点（SMART on FHIR / OIDC） | 沿用 `.mcp.json` 只读 FHIR server；禁止 write 工具指向生产 EHR | 高（标准最全） |
| **P2 CDA/文档通道** | 电子病历评级达标院区的出院记录、病历文档 | `doc-extract` 支持的 CDA/XML/PDF/DOCX | 文档原文 span 必须保留供 `clinical-note-extract` 绑定 | 高（覆盖面最广） |
| **P3 视图库/中间库** | 多数存量 HIS：信息科提供只读视图 | 集成平台视图库、中间库只读账号 | SQL 只读角色、白名单字段、行级租户过滤；禁止直连生产库 | 中（需信息科配合）——PoC 已落地（`viewdb-connector.mjs`，CI 第 39 步） |
| **P4 HL7 v2 消息订阅** | 有集成引擎（ADT/ORU/RDE^O11）的院区 | 消息队列/引擎旁路订阅 | 仅消费不回发 ACK 之外的任何报文；消息体先过 PHI Guard 再落盘 | 中低（解析成本高）——PoC 已落地（`hl7v2-connector.mjs`，CI 第 39 步） |

**统一规则**：无论哪条路径，连接器都只允许 `capabilities: ["read"]`；暴露 `create/update/delete/patch/write` 任一方法的连接器在初始化即被拒绝（现有负向用例已覆盖）。**Codex manifest 永不添加 `create_resource` / `update_resource`**（AGENTS.md 红线，不可为真实接入让步）。

### 2.2 连接器契约强化（在现有契约上增量）

> **v1.0 落点**：以下 1/3/4 已有对应实现与回归测试；2 需为每条真实路径补配置文件。

1. **出口即脱敏**：PHI Guard 从「模型上下文前」前移到「连接器出口」——原始姓名/证件号在离开连接器进程前完成假名化，院内网关层即时假名化（与 `evals/shadow-mode/shadow-protocol.md` 的承诺一致）。原文仅在院内进程内存中瞬时存在。**实现**：`lib/connectors/phi-exit-guard.mjs`（`withPhiExitGuard(connector, { salt })`，假名化 + assert 双模式，fail-closed）。
2. **来源必要性矩阵**：`requiredKinds` 按 workflow 显式声明（查房摘要 = patient/encounter/lis/his），必要来源失败整体 fail-closed，非必要来源降级为 `unavailable_sources` 并在输出中显式列出——此行为已有，需为每条真实路径补配置文件而非硬编码。
3. **快照与重放**：每次真实拉取的信封（含 payload SHA-256、source_version、fetched_at）落审计链事件，支持事后以同 hash 合成 fixture 回放回归——真实数据本身不进 git，只进院内审计库。**回放 fixture**：`fixtures/connectors/fhir-r4-replay.json` 与 `cda-replay.json`（全合成）。
4. **验收方式**：每条真实连接器必须附带①合成回放 fixture（结构与真实报文同构、内容全合成）②针对 `tests/test-clinical-closure.mjs` 风格的负向用例（写方法拒绝、上下文缺失 fail-closed、PHI 泄漏阻断）。**已验收**：`tests/test-real-connectors.mjs`（P1/P2）与 `tests/test-real-data-channels.mjs`（P3/P4，含 SQL 注入拒绝、报文级失败关闭、PHI 出口守卫）全绿，分别纳入 `run-all-checks.mjs` 第 27 / 39 步。

### 2.3 写回边界（不变式，重申）

写回仅存在于治理 Level 4「认证签核写回」，且必须经药师 ECDSA P-256 数字签名签核（`shared/digital-signature.mjs`）。分类界定答复到达前，任何环境下不得启用 Level 4（`SAMD-PATHWAY.md` §6 护栏）。

## 3. 数据/AI 合规优化（合规线）

### 3.1 部署拓扑三档（对应 R20 供应链核验）

| 档位 | LLM 位置 | 判定链是否出域 | 适用 |
|---|---|---|---|
| A 全本地 | 私有化模型在院内 | 否 | 目标态；等保三级最顺 |
| B 混合 | 托管 API，但 PASS/FLAG 判定由本地规则引擎产生，出域的仅是脱敏后抽取文本 | 判定不出域（D1 架构天然支持） | 过渡态；需核验服务商生成式 AI 备案 [待核：院内 B2B 场景适用性] |
| C 全托管 | 判定经外部服务 | 是 | **禁止**（违反 ARCH-02/D1 叙事） |

关键洞察：D1（LLM 无判定权）不只是监管降险设计，也是数据合规设计——它使 B 档「文本出域但判定不出域」成为合法过渡选项。

### 3.2 个保法 PIA 最小落地清单（R18 的骨架）

1. 处理目的与最小化清单：逐连接器列出字段 → 用途 → 是否可假名化后仍可用（目标：除签名签核外全部 `[PSN:*]`）。
2. 合法性基础：医疗机构履行法定职责处理 vs 单独同意的适用情形 [待核：合作医院法务确认]。
3. 角色划分：医院=处理者，Medcius=受托方；委托事项、期限、方式、保密义务写入 R19 协议模板。
4. 敏感个人信息（医疗健康）加重义务：影响评估报告留存三年、发生泄漏的补救与通知流程。
5. 出境评估：默认零出境；若 B 档托管 API 涉及跨境传输，须另行安全评估 [待核]。

### 3.3 其他法规映射

| 要求 | 来源 | 本仓库落点 | 缺口 |
|---|---|---|---|
| 等保三级 | 网络安全法/等级保护条例 | TLS、RBAC、多租户、AES-256-GCM 已实现 | 定级备案与测评本身（院方主导，我方配合提供材料） |
| 数据不出院 | 《健康医疗数据安全指南》 | 本地 MCP、审计链院内留存 | P3 视图库路径的字段白名单需逐院评审 |
| 生成式 AI 合规 | 《生成式人工智能服务管理暂行办法》 | 判定不经生成式服务（ARCH-04） | 若面向公众提供则涉备案；院内 B2B 适用性 [待核：R20] |
| 算法/模型变更治理 | VERSION-NAMING 重大更新定义 | 提示词改动必跑回归（MNT-02） | 把「更换底层 LLM」显式列入重大变更触发器 |

### 3.4 审计链 ↔ 上市后监测（PMS）

获证后审计链即 PMS 数据源（R25 已预填）。真实接入阶段就要保证：审计事件粒度足以回答「系统建议了什么、医生采纳了什么、override 理由是什么」——这是 Phase 5 哨点与 PMS 报告的原材料。

## 4. 法规准入（NMPA）优化（准入线）

### 4.1 真实接入对分类论证的三点影响

1. **论据链 A-1 需要实物证据**：「处理对象是 HIS 文本记录」目前只有架构叙述。每个真实连接器的接口字段清单、报文样例（脱敏）、信息科说明函，都要归档进 `classification-pack/` 作为界定申请书附件（R30）。
2. **写回能力是最大的分类风险敞口**：FLAG 影响处方流转是论据链 B-1 的核心攻击面。因此真实接入一期**只做读取与展示**，写回模块保持「存在门禁、默认关闭、无生产路径」——这既是 D6，也是把产品描述钉死在「辅助信息工具」上的手段。
3. **Shadow Mode 真实数据 ≠ 注册临床评价**：静默试点数据只能作为「支持证据」（同 batch01 定位），不可冒充临床试验（§6 护栏既有条款）。其合法使用前提：伦理批件、去标识化协议、双盲标注 SOP（R15 方案已定稿）三者齐备后才可入组真实病例（R29）。

### 4.2 分线进院策略（熔断分案的工程化落实）

| 产品线 | 分类主张 | 真实接入顺序 |
|---|---|---|
| 编码辅助 + 病历抽取 | 非辅助决策（数据处理/比对） | **先行**：P2 文档通道即可跑通，对 HIS 侵入最小 |
| 查房前变化摘要 | 临床参考信息整理 | 第二步：P1/P3 多源融合 |
| 处方审核 | 二类目标、三类悬崖 | 最后且仅在界定答复后放量；严格沿 D6 阶梯 |

这与 `classification-pack/README.md` §3 的Ⅲ类熔断分案完全一致：即使审方线退科研，编码+抽取两线仍可持证进院，真实接入投资不浪费。

### 4.3 时间线咬合（对 SAMD-PATHWAY §4 的增量说明）

- Phase 0（M0–M1）期间同步完成 R26 PoC 选型——连接器 PoC 不需要等待界定答复，因为它只读合成沙箱。
- Phase 3（M4–M10）临床评价窗口正好消化 R29 Shadow Mode 真实数据 SOP。
- R30 接口归档必须在 R04 材料包终审前完成，否则论据链 A-1 维持「待补」状态。

## 5. 度量与验证

- 工程检查：`node scripts/validate-json.mjs` + `node scripts/validate-skills.mjs` + plugin 校验（AGENTS.md 最低集）；每条新连接器附合成回放 + 负向用例（当前基线：`node tests/test-real-connectors.mjs` 9/9 PASS）。
- 全量门禁：`node scripts/run-all-checks.mjs`（含第 27 步连接器 PoC 与 PHI 出口守卫回归）。
- 合规检查：`plugins/medcius/scripts/compliance-lint.mjs` 全绿；措辞扫描无「审方系统」自称。
- 证据分层：工程 ✅ / 合成验证 ✅ / 临床证据 三态分开报告；真实接入上线本身不是临床证据。
