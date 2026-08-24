# 软件需求规格（SRS · 中国技能线）

> **状态**：骨架 v1——系统级需求（ARCH 层）已具文，技能行为层需求由 `TRACEABILITY.md`（53 条，自动生成）承载。
> **依据**：《医疗器械软件注册审查指导原则（2022 年修订版）》（器审中心通告 2022 年第 9 号）「软件需求规范文档」要求；GB/T 42062-2022 风险管理接口见同目录 `RISK-MANAGEMENT.md`。
> **编号规则**：`ARCH-nn` = 系统级架构需求；`REQ-<用例id>` = 技能行为层需求（见追溯矩阵）。每条需求的验证列指向可执行证据。

## 1. 引言

### 1.1 目的与范围

本文规定 Medcius 中国技能线（`nhsa-coding`、`nhsa-policy`、`prescription-review`、`clinical-note-extract`、`nmpa-drugs`、`china-clinical-trials`）及其本地 MCP 基础设施的需求。不含美国遗留技能（prior-auth、icd10-cm 等），其无连接器即停用。

### 1.2 预期用途边界（需求之上的约束）

供病案/编码/药学专业人员使用的**辅助工具**；不做诊断决策、不生成鉴别诊断、不出具用药建议；处方审核为药师法定职责（国卫办医发〔2018〕14 号第六条）。此边界是分类界定的前提，修改须过合规评审。

## 2. 系统级需求（ARCH 层）

| ID | 需求陈述 | 验证 | 来源 |
|---|---|---|---|
| ARCH-01 | **生产门闩**：本地语料 `official=0` 时，真实编码/审方流程必须停在样例模式并向用户明示 `production_ready=false`；不得静默降级 | `scripts/doctor.mjs` 输出；用例 `nhsa-coding-05-no-connector` | packs/README |
| ARCH-02 | **仅本地 MCP**：默认配置只加载本地 stdio 服务器；任何技能不得调用托管医疗 MCP（hcls/pubmed 等） | `validate-json.mjs` 对 mcp.json 的清单校验；用例 `nhsa-coding-05` must_not | CLAUDE.md |
| ARCH-03 | **语料版本化**：每条官方语料记录必须携带 `source_version`、`effective_date`、`snapshot_hash`、`ingested_at`；缺失时导入拒绝 | `import-official.mjs` 拒绝逻辑；用例 `nhsa-coding-04-version-unknown` | servers ingest |
| ARCH-04 | **判定确定性**：审方 PASS/FLAG 结论由规则引擎（条文匹配 + 剂量公式 + 相互作用核对）产生；LLM 仅承担实体抽取与条文引用定位，不得生成结论语句或治疗建议文本 | 人工代码评审 + SKILL「监管定位」节红线；行为层由 `prescription-review.json` 19 用例约束 | SAMD-PATHWAY D1 |
| ARCH-05 | **输出封闭性**：审方结论四选一状态码；所有非 PASS 强制进入药师 `signoff`（agree/override/reject）闭环，未签核批次不视为完成 | audit server `signoff` 工具；用例组 `rx-*` | SAMD-PATHWAY D2 |
| ARCH-06 | **PHI 前置管道**：含患者信息的自由文本进入日志、审计、导出或模型上下文前，必须经 phiguard `scan`→`redact/pseudonymize`；`subject_ref` 一律假名 | phiguard 单元语义（id 校验位等）；审计库内建正则拒绝；已知检测盲区见 PRIVACY-SECURITY §5 | PRIVACY-SECURITY 规则 1–3 |
| ARCH-07 | **审计不可篡改**：审计记录 append-only（触发器强制）+ 哈希链 + `verify_chain` 校验；导出附 head_hash | audit server 实现 + smoke | servers/audit |
| ARCH-08 | **覆盖诚实性**：`not_in_corpus` / `no_mention_in_corpus` 不得表述为"全国不存在/无相互作用"；输出必须携带覆盖免责声明与原文摘录 | 用例组 `rx-*` G3 分支、`nmpa-and-trials.json` | china-skills README |
| ARCH-09 | **样例隔离**：`data_class=sample` 的命中必须在输出中标注且不满足 G2；样例数据不计入任何注册资料 | 用例 `prescription-review.json` 样例陷阱 | packs/README |
| ARCH-10 | **可追溯输出**：编码/药品信息输出附六字段出处（code_system/code_version/effective_date/retrieved_at/source/validation_status），未知如实标 unknown，不得据此给 valid | 用例 `nhsa-coding-04`、`-01` | nhsa-coding SKILL |

## 3. 技能行为层需求

由 `TRACEABILITY.md` 全量承载（当前 53 条 REQ / 110 must / 64 must_not 断言），按技能分布：

| 技能 | REQ 数 | 行为层风险焦点 |
|---|---|---|
| clinical-note-extract | 12 | 断言极性（否定/家族史/拟行/排除）、跨时间混淆、参数知识泄漏 |
| prescription-review | 19 | G1/G2/G3 门控、样例误用、特殊人群、肾功能剂量 |
| nmpa-drugs + trials | 9 | 文号格式、无库不编造、默示许可不冒充登记 |
| nhsa-policy | 7 | 目录≠报销、L3/L4 出处纪律、省际差异 |
| nhsa-coding | 6 | 裸类目、特异性 .8/.9、体系混用、不确定诊断 |

维护纪律：用例增删必须重跑生成器并随同一提交更新矩阵；删用例 = 删需求，须单独走变更评审。

## 4. 接口需求

MCP 工具面以 `mcp.json` / `.mcp.json` 为契约源（7 个本地 stdio server）。技能文档中引用的工具名与 server 提供的 tool 名不一致视为缺陷（现有校验：`smoke-mcp.mjs` + validate 清单检查）。

## 5. 数据需求

- 导入模板列名及别名见 `packs/README.md`（codes/catalog/labels/trials 四类）；
- 官方行缺 `source_version` 或 `effective-date` 时导入拒绝（对应 ARCH-03）；
- 省级待遇（L3）仅随官方省包进入，无包则该维度输出"待核"，不得估算。

## 6. 维护与变更需求

| ID | 需求 | 状态 |
|---|---|---|
| MNT-01 | 软件版本命名规则区分发布版本/完整版本，能表达重大/轻微更新 | ◐ 文书已成稿：`dhf/VERSION-NAMING.md`（待 QRA 批准 + plugin.json 一致性 CI 校验待加） |
| MNT-02 | 规则/SKILL/提示词改动 → 必跑 `run-evals.mjs` 回归 + 追溯矩阵再生成 | ✅ 流程已成文（本文件 §3 + 生成器 + compliance-lint 同步检查） |
| MNT-03 | 每次发布将版本 tag 与语料 snapshot 哈希写入审计链 | ◐ 机制已有（audit record_event），发布流程待固化 |
| MNT-04 | 合规红线与 DHF 一致性由机器检查守护（边界措辞、结构锚点、追溯同步、交叉引用） | ✅ `plugins/medcius/scripts/compliance-lint.mjs`，已接入 plugin-validate CI |
| MNT-05 | 确定性评测基线可复现且零 fail 为发布前置条件 | ✅ 基线已记录：`dhf/EVAL-BASELINE.md`（2026-08-23，27 pass / 0 fail / 26 skip） |

## 7. 未决事项

- 正式测试计划/报告文书（验证与确认章节的申报格式）⬜
- 用户测试场景定义（药师/编码员各 ≥5 个真实工作流脚本）⬜
- ~~Agent 在环首轮行为评测~~ ✅ R1 完成（2026-08-23）：53 pass / 0 fail，方法论与局限见 `EVAL-BASELINE.md` Round 1；发现 rx-05 工具覆盖缺口（真实品名重复用药检测）待官方包导入后复测
