# 江苏病案质控、版本化编码与地方预审

本轮范围是 Medcius 的次级病案/医保复核工作流。已实现版本化映射、住院周期内证据核查及受信本地分组器适配接口；不自动补诊断、改编码、判定违规或计算支付金额。江苏已选定，具体统筹区和医院当期分组器尚未指定。

**证据口径：** `claim_type=engineering`，`evidence_level=test_passed`，`scope=本地合成回归及适配契约`。医院接口验收、官方全量映射覆盖和临床有效性均未建立。以下示例不冒充江苏正式分组规则。

**版本依据。** [国家医保局 2024 年通知](https://www.nhsa.gov.cn/art/2024/7/23/art_104_13313.html)的 2.0 指 DRG 分组方案/DIP 病种库，不能据此把编码库版本默认填成 2.0；[国家卫健委 2022 年解读](https://www.nhc.gov.cn/yzygj/c100067/202204/c335364a5309434cb31a27b1c45dea77.shtml)分别提到疾病分类国家临床版 2.0 与手术操作国家临床版 3.0。[盐城市医保局 2025 年材料](https://ylbzj.yancheng.gov.cn/art/2025/6/3/art_21567_4327202.html)说明当地 JS-DRG 2.0 的细分组与核心要素协商工作；它不能替代江苏其他统筹区的当期文件。另已查到[国家医保局 2026 年 3.0 调整情况介绍](https://www.nhsa.gov.cn/art/2026/4/2/art_14_20105.html)，因此本实现支持明确指定历史版本，不宣称 2.0 是当前最新版本或对江苏所有地区均适用。未取得官方全量 CCHI↔ICD-9-CM-3 映射，未写入臆造对应关系。

**版本化编码库。** `terminology-crosswalk.mjs` 与 `servers/china-codes/src/crosswalk-store.mjs` 保存不可变 pack：编码体系、版本、地域、有效期、原始文件 SHA-256、来源、复核标识、节点与映射边。临床书写词、国临版、医保版、地方码可构成最多三跳的可追溯路径；CCHI/ICD-9 双向查询分别核对。保留一对多、宽窄关系、条件映射和未命中状态，不按相同数字或相似名称自动等同。

SQLite 从 v1/v2 加法升级至 v3，保留旧表与记录。新包按 `pack_id` 固定，不能同 ID 覆盖不同内容。`official` 导入还须提供与来源摘要匹配的原始字节；摘要核对证明文件一致性，不认证发布者或人工转换的语义正确性。已有旧导入表仍只保存单版本；需要并存版本时必须使用新包，不把旧表伪称历史库。

新增只读工具 `crosswalk_status`、`query_code_mappings`、`check_code_pair`；既有 `search_codes/get_code/validate_code` 增加 `pack_id/code_version/region/as_of`，新包查询要求明确版本、地域、日期，名称精确匹配。`settlementFromNote` 通过 `codePackId/diagnosisVersion/procedureVersion/asOf/region` 选择包，另列映射候选，不自动替换医生选定编码。旧的无版本性别规则不会套用到显式指定的新版本编码。

导入入口（本地运维操作，不是 MCP 写工具）：

```powershell
node scripts/import-terminology-crosswalk.mjs <mapping.json> <canonical-pack-sha256> <local-review-id> <original-source-file>
```

包摘要使用 `terminologyDigest(pack)` 的 canonical JSON SHA-256，来源摘要是原始文件字节 SHA-256；二者用途不同。单次输入文件和来源文件各限 32 MiB，不自动下载。结构示例在 `tests/fixtures/jiangsu-record-review.mjs` 的 `crosswalk()`，全部为 `DEMO-*` 合成码，不能导成医院真实编码依据。完整系统/版本/地域隔离必须保留。

**跨源核查。** `record-evidence-reconciliation.mjs` 只接受 `createPatientSourceSnapshot` / `createPatientSourceSnapshotAsync` 生成的不可变 PHI-guarded 快照。真实环境仍遵守项目异步双轨 PHI 门控。首页必须是唯一的最终版本；就诊必须提供带时区的 `admission_time/discharge_time`，出院时点不得晚于快照。拒绝跨患者/就诊、伪造快照和错首页挂接。

每个来源须在 `sourceAvailability` 中给出 `kind/source_system/status/from/to/watermark/context`。完整性声明必须覆盖整个住院周期、具有相同租户/患者/就诊上下文且无未解决的来源冲突。没有完整性声明时输出 `SOURCE_COVERAGE_UNKNOWN`；`DATA_GAP` 只描述在已声明覆盖的院内来源中未关联到配置的资料，不能证明医院确实未做检查。外院/既往证据未接入、同义词漏配和缺失文书仍须人工核对。

| 发现 | 处理与边界 |
|---|---|
| 病程有肯定现症记载，首页未匹配 | `DOCUMENTED_DIAGNOSIS_NOT_ON_FRONT_SHEET`，供医生核对诊断纳入条件与同义词；不补写诊断 |
| 只有结构化异常线索 | `ABNORMAL_EVIDENCE_REVIEW`，不能从异常值直接推断确诊、漏编或 MCC/CC |
| 肯定记载与否定/疑似记载并存 | `DIAGNOSIS_ASSERTION_CONFLICT`，保留双方原文 span，取消自动漏项提示 |
| 首页有诊断，配置的病程/检查依据未关联 | 完整来源下 `DATA_GAP`，否则 `SOURCE_COVERAGE_UNKNOWN`；均非高编/飞检违规判定 |
| 治疗未关联到执行记录 | `TREATMENT_CONTEXT_REVIEW`；开立、退回、实际执行分别展示，未治疗不等于诊断不成立 |

证据保存检验/医嘱 ID、版本、事件时间、来源和内容摘要；病程保存 UTF-16 原文 span 与快照摘要。撤回、冲突、未完成、时间不明和住院周期外结果不作为确定支持。已停止医嘱仍保留本次住院中真实发生的先前执行记录。新模块不计算抗菌药天数或摄入量。

`config/record-review/jiangsu-reference.v1.json` 只是一份可审阅工程配置，覆盖低钾、呼衰、心衰、低白蛋白与重度营养不良的资料关联。它使用院内适配器明确映射后的 `concept_code`、单位与 `measurement_context`：血气区分动静脉并要求 FiO2/氧疗上下文，血钾区分血液与尿液；单位或上下文缺失保持 unknown。默认不内置 I/II 型呼衰确诊阈值，不把白蛋白数值代替营养评估，不把 BNP 单指标等同心衰。关于 BNP 等标志物需综合判断的依据可见[中华医学会心力衰竭指南 2024](https://csc.cma.org.cn/art/2024/4/18/art_619_56220.html)。该配置不是江苏医保诊断标准、临床规则验证或官方 MCC/CC 表。

**地方预审接口。** `local-grouper-precheck.mjs` 分开绑定江苏统筹区、方案类型、分组版本、规则摘要和诊断/手术编码版本。`jiangsu-unconfigured.v1.json` 保留未知字段，当前返回 `NOT_CONFIGURED`。具体城市没有擅自选择；测试中的盐城行政区码仅用于合成接口回放。

请求仅含来自同一首页快照的编码、白名单分组字段、一次性就诊 token 和请求摘要，不发送自由病程。分组必需字段、主诊断唯一性、重复编码、版本有效期和官方编码包核验不通过时不调用适配器。真实本地模式须由受信宿主提供站点验收回调与版本化代码校验器；一个自报 `site_reviewed` 字段不能放行。适配器是受信的院内代码，`transport=local` 不是网络隔离证明，实际网络权限仍由部署环境限制。

返回结果必须绑定请求 ID、请求摘要、profile 摘要、地域、规则摘要和版本；MCC/CC 分类必须对应本次输入中的诊断。拒绝串请求、旧版本或无关诊断，忽略供应商自由文本及权重字段。并发占用覆盖异步验收和验证阶段；超时后非协作调用仍占用槽位，防止重复请求堆积。`REPLAY_ONLY` 只代表合成回放；`LOCAL_RESPONSE_BOUND` 只代表本地返回与输入绑定，不表示医院验收或结算成功。

**工作流串联。** `reviewSettlementSnapshot` 将证据核查接入 `settlementFromNote` 和病案质量报告，可选调用同一个已配置的本地 precheck 实例。`nhsa-record-quality-engine` 挂接证据时要求首页文本摘要相同。旧 `drg-dip-reconciliation` 纳入提示项与跨源发现，并把实际 `grouping_affected` 改为 `null`：质量缺陷本身不能证明实际分组或支付改变。调用方须接受 nullable 字段。原有生产 MCP manifest 未增加 FHIR 写操作，也未激活医保次级工作流为临床查房核心。

在院内部署代码中准备已授权、已脱敏的 `snapshot`、审核后的 `policy`、编码包与本地适配器，再调用：

```javascript
const precheck = createLocalGrouperPrecheck({
  profile: siteProfile, adapter: localAdapter, mode: 'local',
  authorize: verifySiteAcceptance,
  validateCode: args => codes.validate_code({ ...args,
    pack_id: selectedPackId, region: siteProfile.region }),
});
const result = await reviewSettlementSnapshot({
  snapshot, front_sheet_id: frontSheetId, policy, codes, precheck,
  code_options: { codePackId: selectedPackId, region: siteProfile.region,
    diagnosisSystem: siteProfile.code_releases.diagnosis.system,
    diagnosisVersion: siteProfile.code_releases.diagnosis.version,
    procedureSystem: siteProfile.code_releases.procedure.system,
    procedureVersion: siteProfile.code_releases.procedure.version,
    asOf: dischargeDate },
});
```

当前适配请求白名单包含年龄、性别、住院天数、离院方式、出生/入院体重和通气时长；具体分组器还需要的字段必须先扩展和验收契约，不能凭缺省值补足。本轮未对接真实医院分组器，未导入官方全量跨版本映射，未验证江苏各地的所有规则。

**验证与后续边界。** 本轮执行记录、失败记录及最终状态见本目录配套验证报告；定向命令为 `node --test --test-concurrency=1 tests/test-jiangsu-record-review.mjs tests/test-versioned-coding-store.mjs tests/test-cn-corpus-boundaries.mjs`。下一次院内验收须取得具体统筹区、当期 DRG/DIP 版本、官方/院方授权映射原件、源数据完整性回执及本地只读接口，使用获批脱敏病例与人工病案复核对照。任何真实接口或临床证据结果都另行登记，不能沿用本轮合成通过状态。
