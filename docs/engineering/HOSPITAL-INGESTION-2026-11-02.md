# 院内数据接入改进：CDA / 只读视图 / 实际执行 / PACS

日期：2026-11-02。范围：Medcius 本地工程与合成回放。非独立代码自查；没有真实医院部署、临床研究或厂商验收结果。

## 已实现的行为

| 链路 | 本轮改变 | 仍需现场确认 |
|---|---|---|
| CDA 文档 | 默认结构化解析 CDA R2 命名空间；同时核对目录与正文的患者、就诊、文档、版本；保留章节 XML 位置、原 XML 摘要、标识域和类型映射引用 | 医院实际 `codeSystem`、类型码、标识域；原始标准 XSD / Schematron 与模板约束；真实文档覆盖率 |
| 院内视图 | 数据配置映射到原有 bridge；参数化 SELECT；固定租户、字段投影、显式时间格式、未知状态降级、映射摘要；可组合 CDA / HL7v2 / 视图通道 | 信息科只读账号、实际驱动、视图列与状态字典、来源完整性和院内性能 |
| 医嘱与护理 | 长期/临时、开立/核对/审方/发药/退回/执行/停止/作废分开；独立 MAR 记录可按医嘱 ID 关联；计划或未核对记录不计实际出入量 | 医嘱与执行事件唯一键、修订/撤销语义、分次执行及护理记录去重策略、时区、数据覆盖区间 |
| PACS | 所见和印象分别保留；仅有明确分区标题时解析合并文本；未分区原文保留未知；所见单独也可展示在查房卡片 | 医院分区字段、报告状态、StudyInstanceUID 绑定、PACS 用户权限与只读配置 |

入口：`plugins/medcius/lib/connectors/site-connector-factory.mjs`。新增核心实现：`bounded-xml.mjs`、`cn-cda-r2.mjs`、`site-view-mapping.mjs`、`lib/order-execution.mjs`、`lib/imaging-report.mjs`。参考工作台与侧栏展示影像分区和可选调图链接；核心仍是宿主中立的插件。

### 标准编号不能替代文档类型字典

国家卫健委发布的 WS/T 500 目录列出：34 入院记录、37 首次病程记录、38 日常病程记录、40 疑难病例讨论记录、41 交接班记录、49 出院记录、53 出院小结。[官方发布目录](https://www.nhc.gov.cn/mohwsbwstjxxzx/s8553/201609/ff0fc151b2d94b7ca74ebaadedfaf52d.shtml)

这是标准的部分编号，不能据此把截图中的 `C0034/C0037/C0040/C0049` 自动解释为国家统一 CDA 类型码。本次有限检索未核实这些 C 码的全国统一含义，也没有证明某院本地 C 码错误。实现使用 `code + codeSystem + wst_part + mapping_ref` 的显式配置；未配置保持 `document_kind: unknown`。支持的七类映射共用叙述章节解析器，并不代表七类结构化医学条目或全部标准模板均通过符合性验证。

身份从 `recordTarget/patientRole/id` 和 `componentOf/encompassingEncounter/id` 读取；有多个候选标识须指定 root，多个 recordTarget 及章节 subject 覆盖拒绝进入单患者工作流。语义参考 [HL7 CDA 规范](https://www.hl7.org/cda/stds/online-navigation/2024May/infrastructure/cda/cda.htm)。保留 `conformance_status: NOT_XSD_OR_SCHEMATRON_VALIDATED`。

解析器是无依赖的、有边界的 XML 1.0 子集，不下载或执行外部内容。DTD、实体声明、外部实体、处理指令、XInclude、错误嵌套和超限输入拒绝；仅解码预定义与合法数字实体。支持 UTF-8 声明及 Unicode 字符串；不自行解码 GBK 字节、PDF、任意 XML 附件。限制默认 2 MiB、20,000 节点、64 层、60,000 字符叙述；超限拒绝而非静默截断。

## 接入配置

### 1. 只读视图映射

模板：`plugins/medcius/config/site-mappings/synthetic-cn-views.v1.json`；契约：`plugins/medcius/contracts/site-view-mapping.v1.schema.json`。模板涵盖患者、就诊、医嘱、MAR 执行、护理、LIS、PACS、病历叙述八个视图。

`V_HIS_INPATIENT_ORDER / V_LIS_CRITICAL_VALUE / V_NIS_VITAL_SIGNS` 等均为合成示例名称；列名与状态值也为示例，不宣称适用于卫宁、东软、创业慧康或嘉和的任何版本。对接时从院方提供的视图定义和枚举表建立独立的版本化配置，不能把示例改一个厂商名就视为完成适配。

配置采用 JSON，也是 YAML 1.2 的合法子集；当前加载器只接收对象或 JSON 文本，不支持通用缩进式 YAML、标签、别名或表达式。字段转换限 `string/number/boolean/enum/datetime`；状态枚举必须明确映射，不能执行代码或拼接 SQL；无效可选值变为 `null/unknown` 并记录字段缺口、降低完整性，缺失必需身份拒绝读取。原始未知列不进入输出。

本地无时区时间须指定 `timezone_offset`；`iso8601` 必须自带时区。不用采集时间代替发生时间，不接受驱动未经说明的本地 `Date` 转换。这里不做隐式药量或检验单位换算，源视图应提供约定单位的字段并由映射复核确认。

SQL 生成支持 `sqlite/mysql/postgresql/sqlserver/oracle/dameng/oceanbase-mysql/oceanbase-oracle`。OceanBase 模式必须显式选择；达梦使用问号绑定和 FETCH FIRST 形状。依据：[达梦查询语法](https://eco.dameng.com/document/dm/zh-cn/pm/check-phrases.html)、[达梦 JDBC 参数化接口](https://eco.dameng.com/document/dm/zh-cn/pm/jdbc-rogramming-guide.html)、[OceanBase 兼容模式](https://www.oceanbase.com/docs/common-oceanbase-database-cn-1000000005283144)、[OceanBase 行数限制](https://en.oceanbase.com/docs/enterprise-oceanbase-database-en-10000000000867053)。这些是生成语句的测试依据，**没有实际连接这些数据库验证驱动、版本或执行计划**。驱动适配通过院内注入的 `query(sql, params, {signal, readOnly, dialect, sqlDialect})` 完成；数据库侧必须配置只读账号。

实时模式下，映射要求 `data_class: site`、`review_ref`，并由部署注入的 `mappingApprovalVerifier({mapping,sha256})` 核对完整摘要；请求 JSON 中的批准标记无效。验收器必须查询真实受控登记，不能直接返回常量 `true`。固定租户、患者与就诊过滤仍由连接器强制加入；完整 LIMIT 页只能证明“可能还有记录”，不会标成完整。超时后的并发槽保持占用至实际查询结束。

### 2. 同时启用视图与 CDA

```js
const { bridge } = createSiteBridge(siteActivation, {
  channel: 'hybrid',
  salt: deploymentSecretStore.phiSalt,
  // requiredKinds 默认保留查房核心 patient/encounter/nis/lis/his。
  sources: [
    { channel: 'viewdb', bindings: {
      mapping: reviewedSiteMapping,
      dialect: 'sqlserver',
      query: readOnlyQuery,
      mappingApprovalVerifier: verifyApprovedMappingDigest,
    } },
    { channel: 'cda', bindings: {
      listDocuments, loadDocument,
      cdaOptions: {
        patientIdRoot: patientIdentifierRoot,
        encounterIdRoot: encounterIdentifierRoot,
        timezoneOffset: '+08:00',
        profiles: reviewedDocumentProfiles,
      },
    } },
  ],
});
const snapshot = await bridge.readPatientSnapshot(authorizedContext);
```

此代码为部署绑定示例，不包含真实账号、连接地址或厂商字段。每个来源均包裹 PHI Exit Guard；重复连接器 ID、递归组合和未覆盖的必需 kind 被拒绝。可把现有 `hl7v2` 通道加入 `sources`；其范围仍是当前解析器支持的消息，不宣称已完成通用 SOAP、ESB、消息确认或 CDC 协议适配。

`listDocuments(context,{signal,readOnly})` 应返回 `{documents,complete,truncated,synchronized_through}`；旧数组返回仍可读，但完整性为未知。`loadDocument(context,document,{signal,readOnly})` 仅返回本地 XML 字符串；目录 metadata 与正文身份有任何显式冲突均拒绝。默认 200 文档、10 秒超时、4 个未结束读取；超时后不继续加载后续文档，不泄漏回调错误正文。实时 CDA 必须配置两个身份标识域且不能选择 `legacy_narrative`。

旧片段文本测试必须显式配置 `mode: legacy_narrative`，目录必须有患者与就诊 ID，状态标记 `LEGACY_NARRATIVE_ONLY`。旧不完整 CDA fixture 已改成有头部身份、正确闭合的合成文档；原版保存在本轮修改前归档中。

## 医嘱与实际执行的边界

- `order_kind` 为 `long_term/temporary/unknown`；`execution_status` 表示来源显式流程状态。两个轴与医嘱 `status` 独立；数值本地码不会自动被解释。状态转移只校验已提供的前后状态，不补造中间事件。模型不是所有医院流程的通用状态机，非药物/特殊流程须另行映射。
- 护士未核对、药房退回、计划输液、未知执行状态均不计入护理实际液体量。`administration` 行还需医嘱引用、事件标识与完整时间。未标注 `record_kind` 的旧 NIS 契约仍按“护理测量行”处理；部署不能把医嘱视图误绑成旧 NIS 测量视图。
- 实际执行可来自医嘱下的 `administrations` 数组，或 HIS feed 内 `record_kind: administration` 的独立 MAR 行；必须明确绑定医嘱，不能把给药记录填到另一医嘱。孤立执行记录保留在 `administration_history_records` 并计数，不据此推算药物疗程。
- 同一来源事件按版本处理，完全重复去重、更正替换、撤销排除、冲突保持未知。实际量字段不从医嘱计划剂量回填；护理出入量不再把正数计划量当实际量，零量与缺失量保持区分。
- `observed_administration_days` 仅在指定时区后按有来源的执行日去重，范围是已收到记录，不能推断完整疗程；始终保留 `administration_coverage: unknown` 与 `treatment_duration_days: null`。停止医嘱不抹去此前实际执行记录。
- 既有抗菌药提示仍是医嘱开立时间复核钟，`duration_basis: elapsed_since_order_authored_not_administration`；没有改造成自动用药建议。已知未核对/退回/作废状态不进入该提示。查房新增项明确写“新增医嘱”及其执行状态。

不同系统为同一真实执行分配不同事件 ID 时，现有实现无法自行证明它们是同一事件；上线前必须确定唯一权威护理计量来源或院内统一执行 ID，不能把两个系统重复计量的数据直接相加。

## PACS 与调图

优先使用明确的 `findings` 和 `impression` 字段；合并文本只按段首的明确标题切分。原文无标题则保留 `unclassified_text`；字段与合并文本相冲突时保留原文，不静默消除矛盾。报告更正、撤回和检查时间继续经过统一版本/时间解析，所见变化不能被相同印象掩盖。

`createPacsViewerLink(report,context,profile)` 要求患者/就诊/院区绑定和格式受限的 StudyInstanceUID。部署配置仅含 `tenant_id,mapping_ref,origin,path,study_parameter`；只接受 HTTPS，无用户名、密码、查询模板、任意来源 URL 或自定义执行协议。宿主可传 `pacsViewerProfile`；参考工作台通过部署函数 `setWorkstationPacsViewerProfile()` 注入，患者请求无法设置它。链接不携带患者姓名、证件号、访问令牌；新页启用 `noopener/noreferrer/no-referrer`。

`mode=readonly` 仅表达只读请求，**不是 PACS 权限证明**；PACS 仍须使用医生现有登录会话核对检查访问权限，并在服务端禁止写操作。未配置或标识不足不显示可用链接。未进行真实 PACS 登录、影像加载、只读权限或浏览器人工验收。

## 验证记录与迁移

新增测试在 `tests/test-inpatient-ingestion.mjs`，先以五个缺陷用例运行旧代码，五个均失败，再补正例与异常路径。最终新增 32 个聚焦测试全部通过，包括跨患者 CDA、实体声明、文档更正、错误分区、执行重复/撤销、未知状态、映射漂移、组合读取和固定快照回放。

首轮完整回归执行 80 步，77 完成、3 失败。工作区并行出现 PHI 会话加强代码后暴露：旧测试把 `enc-cardio-3` 写成 `enc-cardio-003`，以及两处只接受旧错误文案。仅修正 fixture 引用与预期拒绝码，未放宽患者身份校验；三项定向重跑通过。失败日志和不可变执行 receipt 均保留。

最终完整回归 **80 步完成、0 失败：67 个检查通过，13 个报告脚本执行完成**；报告脚本完成不表示其研究终点达标。执行 ID：`76e5705b-1592-4cba-8785-283646ab1d46`，UTC `2026-11-03T02:04:55.856Z` 至 `2026-11-03T02:05:27.014Z`（本地日期 11 月 2 日）。详见本轮 `out/hospital-ingestion-2026-11-02/verification.json` 与归档 receipt。`validate-json` 与 `validate-skills` 已通过。要求的外部 `<user-home>\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py` 实际调用失败，因为脚本不存在，状态为 `NOT_RUN_TOOL_MISSING`，不能计为已通过。

工程通过、合成脚本执行、协议终点达标、真实院端验收和临床证据分别记录。没有真实医院数据、厂商账号、临床效用、NMPA 符合性或 CDC 压测结果。本轮未新增依赖或模型下载、未购买外部服务、未部署或写回医院系统。

迁移时先固定该院映射与身份域，再用授权本地回放核对身份错配、临时医嘱、退回/部分执行/更正撤销、PACS 分区和权限；通过后才能据实记录院端验收。回滚使用本轮 `before-ingestion-changes.zip` 与 manifest 对照恢复本次改动，不能覆盖工作区内并行的其他修改，也不能通过退回旧宽松解析器掩盖身份错误。
