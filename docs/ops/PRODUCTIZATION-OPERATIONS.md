# Medcius 产品化与运维手册（v1.0）

> **用途**：把 Medcius 从「插件工程仓库」推进为可在院内前置机稳定运行的产品所需的**产品化形态定义**与**运维基线**。与合规文档的关系：本手册是 `EHR-HIS-INTEGRATION-BLUEPRINT.md` §3 部署拓扑的运维落地，对应 `REG-ACTION-TRACKER.md` R27；不改变任何安全契约，不构成法律意见。
> **状态**：v1.0。文中引用的脚本、环境变量均以仓库当前代码为准；标注 [待落地] 的项需要院方配合或另行立项。
> **关联**：`AGENTS.md`（红线）、`docs/compliance/SAMD-PATHWAY.md` §6（护栏）、`docs/compliance/dhf/VERSION-NAMING.md`、`docs/compliance/PRIVACY-SECURITY.md`、`lib/governance-mode.mjs`、`docs/compliance/EHR-HIS-INTEGRATION-BLUEPRINT.md`。

## 1. 定位与边界（运维视角重申）

- Medcius 是安装到宿主 Agent 的受约束能力包，不是独立临床平台。运维对象是：插件包本体、本地 MCP servers、可选的院内 HTTP API/CDS Hooks 服务、只读数据连接器。
- 输出一律是「供专业人员复核的参考信息」；系统故障的默认表现必须是 fail-closed（拒绝输出），而不是降级输出。**任何为了可用性绕过 fail-closed 的变更是红线。**
- 证据分层纪律同样适用于运维指标：工程健康度（服务在线、测试通过）≠ 合成验证通过 ≠ 临床证据。监控面板不得把三者合并成单一"健康分"。

## 2. 产品化形态与部署单元

| 部署单元 | 内容 | 形态 | 说明 |
|---|---|---|---|
| 插件包 | `plugins/medcius/`（skills、lib、packs、rule-packs） | 宿主无关目录包 | 通过各宿主 marketplace / 目录分发；宿主适配见 `scripts/validate-host-adapters.mjs` 覆盖范围 |
| MCP servers | audit / phiguard / china-codes / drug-labels / documents 等 | 本地进程（stdio） | 只读工具面；manifest 永不含 `create_resource`/`update_resource` |
| API 服务 | `plugins/medcius/servers/api`（REST + CDS Hooks 2.0 + 医生端工作台） | `node scripts/serve.mjs --port 8080` | 院内 Agent 平台与医生工作站消费的标准触发面；工作台见 `integrations/doctor-workstation/README.md` |
| 连接器 PoC | `plugins/medcius/lib/connectors/`（P1 FHIR R4 / P2 CDA / P3 视图库 / P4 HL7 v2 + PHI 出口守卫） | 库模块，随工作流进程运行 | 只读；真实院端凭据由部署注入（P3 为白名单视图 + 参数化 SELECT，P4 为集成引擎旁路订阅，均无写路径） |
| 知识包 | `packs/hospital-knowledge-pack.json`、官方语料导入产物 | 版本化文件 + snapshot hash | 更新走 §5 变更管理 |

版本命名遵循 `docs/compliance/dhf/VERSION-NAMING.md`；发布物 tag 与语料 snapshot hash 必须能互相追溯（R11 冻结申报版本的同一机制）。

## 3. 部署拓扑（数据不出院）

### 3.1 物理分区

```text
[医院内网]                                [前置机区（DMZ 或信息科托管机房）]
 HIS/NIS/LIS/PACS ──只读视图/FHIR/CDA──►  [Medcius 前置服务]
                                          ├─ 连接器（capabilities:["read"]，出口即假名化）
                                          ├─ PHI Guard + 审计链（append-only，院内留存）
                                          ├─ LLM 推理（按 §3.2 档位 A/B）
                                          └─ HTTP API / CDS Hooks（仅内网可达，TLS）
[医生工作站] ──宿主 Agent──► 前置机区，零直连生产 HIS
```

硬性规则：

1. 生产 EHR/HIS 对 Medcius 只有**只读账号或只读视图**；连接器仅发 GET（FHIR 路径已在代码层强制）。
2. 前置机不落原文盘：信封原文仅在进程内存瞬时存在，离开连接器即 `[PSN:*]` 假名化（R28 已实现）；审计链存院内库。
3. 医生工作站到前置机走院内网 TLS（HTTPS）；跨网段访问经 mTLS 双向认证的前置网关 [待落地：证书体系由院方网络评审后建立]。

### 3.2 LLM 供应链三档（与蓝图 §3.1 一致）

| 档位 | LLM 位置 | 判定链出域 | 运维要点 |
|---|---|---|---|
| A 全本地 | 私有化模型在院内 | 否 | 目标态；GPU 资源与模型版本纳入配置管理 |
| B 混合 | 托管 API 仅处理脱敏文本；判定由本地规则引擎产生 | 否 | 出域前必须已过出口守卫；服务商备案核验（R20）留档 |
| C 全托管 | 判定经外部服务 | 是 | **禁止部署**（违反 ARCH-02/D1），运维发现即视为重大事件 |

## 4. 环境与配置基线

所有环境差异只允许通过环境变量与版本化文件表达，禁止改代码切环境：

| 变量 | 用途 | 生产要求 |
|---|---|---|
| `CLAUDE_MEDCIUS_PHI_SALT` | 假名化盐域（≥8 字符；同一租户一个盐域） | 从密钥管理系统注入，禁止写入代码/镜像/日志；轮换见 §7 |
| `CLAUDE_MEDCIUS_ENCRYPTION_KEY` | 安全存储 AES-256-GCM 密钥 | 同上 |

## 6. 监控、日志与审计

### 6.1 健康与冒烟检查

| 检查 | 命令 | 频率 |
|---|---|---|
| 配置与语料就绪 | `node scripts/doctor.mjs` | 每次部署后 + 每日 |
| MCP 工具面 | `node scripts/smoke-mcp.mjs` | 每次部署后 |
| 全量质量门禁 | `node scripts/run-all-checks.mjs`（30 步，含性能基线第 29 步与安全加固第 30 步） | 每次变更 + CI |
| 性能基线对比 | `plugins/medcius/evals/performance-baseline/reports/performance-baseline.md` 与上一发布版报告对比 | 每次发布 |

[待落地] 院内常驻探针：对 API `/health` 类端点与审计链 verify 的定时巡检，接入院方监控平台。传输边缘限流/锁定状态为进程内存态，多实例部署时上移至 mTLS 网关（`docs/compliance/SECURITY-ARCHITECTURE.md` §6）。

### 6.2 关键监控项与告警阈值

| 指标 | 来源 | 告警条件 |
|---|---|---|
| 必要数据源不可用 | bridge `unavailable_sources` / `BRIDGE_REQUIRED_SOURCE_UNAVAILABLE` 事件 | 连续 ≥3 个工作流周期出现 → P2 告警；持续 >30 分钟 → P1 |
| fail-closed 触发率 | 工作流异常事件 | 突增（相对基线 >3σ）→ 排查上游源而非放宽门禁 |
| 审计链 verify 失败 | audit server `verify_chain` | **任何一次失败即 P1**：链断裂意味着防篡改承诺失效，冻结写操作并启动 §8.2 |
| PHI Guard 拦截量 | phiguard 事件 | 突增可能是上游源脱敏失效 → 联动信息科排查 |
| 出口守卫 RAW_PHI 阻断 | `PHI_EXIT_GUARD_RAW_PHI_BLOCKED` | **P1**：说明某连接器出口绕过假名化，该连接器立即下线 |
| 知识包 SLA | knowledge-pack 覆盖率报告 | 语料过期超 SLA → 阻断相关技能并告警 |

### 6.3 日志纪律

- 自由文本进日志前必须已过 PHI Guard（AGENTS.md 红线）；日志默认只允许结构化字段（IDs、状态码、hash）。
- 审计链 append-only：**禁止**为修数据、过测试而删改历史记录；纠错以追加更正事件表达。

## 7. 备份恢复与密钥轮换

- 备份对象：审计库（append-only）、知识包与语料 snapshot、配置清单。**不备份原文病历数据**——系统内本就不应存在可落盘的原文。
- 审计库备份每日一次；恢复演练每半年一次 [待落地：纳入院方灾备体系]。
- 密钥轮换（`CLAUDE_MEDCIUS_PHI_SALT`）：轮换会切换假名化盐域，导致新旧 token 不可关联。因此轮换必须与治理委员会同步、选择无进行中标注研究的窗口，并在审计链记录新旧盐域指纹（`salt_fingerprint`）。加密密钥轮换按密钥管理系统的常规双信封流程执行。

## 8. 事件响应

### 8.1 分级

- **P1**：疑似 PHI 泄漏（日志/导出/出域文本发现原文标识符）、审计链断裂、Level 4 未授权启用、C 档 LLM 拓扑被检出。
- **P2**：必要数据源持续不可用、fail-closed 异常升高、知识包 SLA 超期。
- **P3**：非必要源降级、性能退化。

### 8.2 处置要点

1. PHI 泄漏：先隔离泄漏面（下线连接器/停用导出），再评估范围；48 小时内向院方数据安全负责人通报（受托方义务，对应 R18/R19 条款），补救与通知流程按个保法要求留痕。
2. 审计链断裂：冻结相关功能，用最近一次 verify OK 的备份比对定位断裂点；处置全程留新审计事件，不得修补历史。
3. fail-closed 频发：默认按上游故障排查；**不允许**的"修复"是放宽 requiredKinds 或跳过校验。

## 9. 上线前检查清单（每院区一份签署存档）

- [ ] 只读凭据/视图开通，权限最小化评审完成
- [ ] 三档 LLM 定位确认 ≠ C 档；B 档服务商备案核验留档（R20）
- [ ] `MEDCIUS_GOVERNANCE_STAGE` = 回顾性研究（首院区固定起点）
- [ ] 盐域/加密密钥经密钥系统注入并记录指纹
- [ ] `run-all-checks.mjs` 在目标机全绿
- [ ] 医院合作协议数据条款签署（R19 模板）；PIA 完成（R18）
- [ ] 本清单签署人：信息科 + 医学事务 + 运维负责人

## 10. 与合规证据的关系（重申）

本手册的运维指标是工程健康度。向监管提交的临床证据只能来自 R15/R16/R29 所定义的双盲标注与静默验证流程；运维绿灯不构成临床证据，合成验证不冒充真实世界数据（production-guard H01 门禁在 CI 中强制此分层）。

| `MEDCIUS_GOVERNANCE_STAGE` | 发布治理阶梯状态 | 由治理委员会决议后设置；禁止越级（见 §5.1） |
| `MEDCIUS_PROFILE` / `NODE_ENV` | 运行档位标识 | 生产显式设 production |
| `MEDCIUS_RULE_PACK_DIR` | 院内规则包目录 | 指向受控目录，文件带 source_version/effective_date 门控 |
| `PORT` / `HOST` | API 服务监听 | 仅绑定内网地址；公网监听视为事件 |
| `FHIR_BASE_URL` / `FHIR_BEARER_TOKEN` | P1 连接器目标端点与只读凭据 | token 只 attach 到同名 origin（代码已有绑定逻辑）；凭据从密钥系统注入 |

配置验收命令：`node scripts/validate-json.mjs`（结构）、`node scripts/doctor.mjs`（语料与生产就绪探测）、`node scripts/smoke-mcp.mjs`（MCP 工具面冒烟）。

## 5. 发布与变更管理

### 5.1 发布治理阶梯（硬门禁）

发布放量必须沿 `lib/governance-mode.mjs` 四级阶梯：回顾性研究 → 静默试点 → 建议模式 → 认证签核写回；禁止越级，写回需药师 ECDSA P-256 签核。分类界定答复到达前，Level 4 在任何环境都不得启用（SAMD-PATHWAY §6 护栏）。运维职责：确保 `MEDCIUS_GOVERNANCE_STAGE` 与治理委员会决议一致，并在每次变更单中记录该值。

### 5.2 标准发布流程

1. 变更单：写明技能/规则包/连接器/提示词四类改动点；提示词改动自动触发 MNT-02 回归义务。
2. 本地门禁：`node scripts/run-all-checks.mjs` 全绿（含第 27 步连接器回归）；AGENTS.md 最低三件套另行保留。
3. 版本：`python scripts/version_bump.py` + git tag；语料 snapshot hash 入审计链。
4. 分发：`.github/workflows/release.yml` 产物 + 各宿主 marketplace 更新。
5. 回滚：回滚 = 部署上一 tag + 将 `MEDCIUS_GOVERNANCE_STAGE` 退回原级；审计链只追加不修改，回滚本身记一条审计事件。

### 5.3 重大变更触发器（对齐 VERSION-NAMING）

更换底层 LLM、判定规则语义变化、新增数据来源类型、PHI Guard/审计实现变化——任一发生即构成重大变更：重新跑全量 evals 并更新 DHF 追溯矩阵，未完成前不得放量。
