# 本土临床专科与药学接口（2026-11-02）

本次改动提供来源可追溯的计算、患者级记录核查和本地药学目录接口。它不是完整医院评审系统，不作诊疗、处方、药物替换或医保待遇裁定。工程回归与临床验证分别记录；合成数据测试不能证明临床有效性。

## 已实现的范围

- `calculation-reference.mjs` 新增 `calculateChineseMdrd` 和 `classifyChineseAdultBmi`。保留既有 CKD-EPI 字段，单独输出 `patient.chinese_mdrd`、`patient.china_adult_bmi`，不以索引化 eGFR 代替 CrCl。
- 中国 MDRD 明确选用 **175 系数版本**：`175 × Scr(mg/dL)^(-1.234) × age^(-0.179) × 0.79（女性）`。不混用其他中国重拟合公式。需成人年龄、性别、明确肌酐单位、CKD/稳态确认、非妊娠及非透析条件。查房已识别到肌酐明显变化时进一步阻断计算。
- BMI 使用 WS/T 428-2013 的 18.5 / 24 / 28 分界，对未取整数值分级；孕产妇、运动员及未成年人不套用该成人分类。只计算提供明确 kg/cm 单位的结构化记录，不从无单位文本猜测。
- 7 个公开参考规则包：核心制度记录核查、STEMI、HF、成人 CAP、脑梗死、围术期抗菌药、VTE。四个单病种包各有 4 个选定节点，核心制度包有 4 个患者级节点。**不是这些国家文件的全部条目或统计口径**。
- Padua/Caprini 核查量表人群、版本、完整因素记录、评估时间、出血风险、预防决策与病情变化后再评估；不计算不完整风险分数，不用中国普通成人 BMI 阈值替换原量表的风险因素阈值。
- 术前预防静脉用药核查 30–60 分钟窗口及麻醉开始时给药的记录；万古霉素/氟喹诺酮按 60–120 分钟，并核对切皮前完成输注。清洁 I 类切口核查 24 小时，具备来源记录的心脏手术延期按 48 小时；治疗性用药不套用预防停药规则。电子持续时间采用**首剂预防输注开始至停药/观察时点**，明确显示此计算口径，输出复核提醒，不判定违规、不自动停药。
- 抗菌分级以有效的省级/院内目录为准，支持非限制、限制、特殊三级；美罗培南等药名仅用作未配置目录时的核对候选，不冒充全国统一分类。特殊使用级核查实际首剂给药、关联培养标本采集、院内指定且具备资格的会诊同意和处方权限。高级职称查房单列；不能替代授权会诊。急救越级使用保留人工核查状态。
- 中西药联用支持受审校的成分字段及同义成分归一化；复方感冒灵与对乙酰氨基酚有有限公开参考提醒。中药注射剂必须按**批准文号、厂家、剂型、规格**绑定说明书，分开核对复溶/输注溶媒、浓度、容量；混合输注单列待复核。没有标签参数时显示 `unknown`，不采用通用“糖水/盐水”规则。
- 出院与标记为 `therapy_horizon: long_term` 的治疗记录支持医保 A/B 类、国谈属性、地方双通道、VBP 中选批次及限定支付范围。它们保持独立字段；目录命中不意味着当前患者符合支付条件。未知、未中选/未纳入和过期记录分开处理。不存储保密支付价格、不计算个人自付额。

## 接入路径与输入约定

查房输入使用 `dataFeeds.chinaClinical = { region, records }`，或启用只读 view-library 的 `extraViews: ["clinical_quality"]`（默认视图 `v_medcius_clinical_quality`）。也可以在经过院内审批的既有 specialty pack 中设置 `clinical_rules.china_reference_checks: true`，启用当前医嘱的药学核查。未配置该扩展时保留现有查房行为；取得 clinical_quality 数据后自动启用。不新增 FHIR 写入权限。

每条临床记录必须含 `id`、`kind`、`patient_id`、`encounter_id`、`tenant_id`、带时区的 `recorded_at`、有效终态 `status` 以及 `source_reference: { source_system, resource_id }`。药品记录另支持 `active`。跨患者/就诊/机构直接拒绝；缺失归属、来源、有效时间、取消状态、未知类型或冲突版本进入资料不足，不选择其中一个版本放行。连接器须先完成版本归并；存在同 ID 的多条记录时本模块拒绝该组。

支持的 `kind` 与关键字段：

| kind | 业务字段 |
| --- | --- |
| `renal_assessment` | `creatinine`, `creatinine_unit`, `stable_renal_function`, `adult_ckd`, `pregnant`, `dialysis` |
| `anthropometry` | `weight_kg`, `height_cm`, `pregnant_or_postpartum`, `athlete` |
| `disease_enrollment` | `pack_id`, `eligible`, `criteria_version: NHC-2020`, `eligibility_source_id`；必须由来源系统确认入组，不从关键词推断 |
| `core_quality_scope` | 明确请求患者级核心制度核对；不构成医院统计分母 |
| `quality_node` | `enrollment_id`, `node_id`, `performed`，或 `not_applicable` 与 `reason_code` |
| `vte_requirement` | 建立应核查风险评估的来源记录 |
| `vte_assessment` | `requirement_id`, `population: medical/surgical`, `tool: Padua/Caprini`, `tool_version`, `score`, `factors_complete`, `assessed_at`, `last_clinical_change_at`, `bleeding_risk_assessed`, `prevention_decision_documented` |
| `perioperative_antibiotic` | `purpose: prophylaxis/treatment`, `route: IV`, `agent_class: standard/vancomycin/fluoroquinolone`, `incision_class: I`、切皮/输注起止/停药时间；必要时 `prophylaxis_ongoing`, `cardiac_surgery`, `extension_reviewed`, `extension_source_id` |
| `medication` | `drug_name`、批准文号/厂家/剂型/规格、`tcm_injection`, `diluents`, `mixed_with_other_drugs`, `therapy_horizon` |
| `antibiotic_administration` | `medication_id`, `first_dose: true`, `administered_at`（不能用医嘱开立时间替代） |
| `microbiology` | `medication_id`, `test_type: culture`, `specimen_collected`, `collected_at` |
| `antibiotic_authorization` | `medication_id`, `consent`, `consented_at`, `institution_authorized`, `qualified_senior_expert`, `prescriber_authorized`, `emergency_override` |
| `senior_round` | `medication_id`, `senior_qualification` |

记录经过既有异步双轨 PHI Guard，未增加生产 NER 豁免。`check_cn_clinical` MCP 工具也在计算前调用同一边界；模型缺失、失效或伪装的 detector 均阻断。患者级结果进 `blocks.china_clinical_checks`，核查项进入统一 `rule_reminders/data_gaps/selectable_items/evidence`，卡片显示计算值及对应分级。回放资料只保存当前患者相关产品的药学目录条目、版本与摘要，不带无关产品，也不以之后更新的文件替代。

## 离线药学目录

`servers/drug-labels` 增加 `calc_cn_reference`、`china_pharmacy_lookup`、`check_cn_clinical`；原有 `check_duplicate_therapy` 同时返回成分核查结果。

目录格式为 `medcius.china-pharmacy-catalog.v1`，包含 `version` 和 `records`。记录种类为 `product / antimicrobial_grade / reimbursement / dual_channel / vbp`。每条记录必须含四项产品键、`id`、`data_class`、`region`、闭合的生效区间 `effective_from/effective_to`，以及 `source` 中的 `organization/url/version/locator/document_sha256/reviewed_by/review_status: approved`。这些字段是导入者的审校声明，不是独立临床审批证明。

`product` 存 `ingredients`，中药注射剂另存 `tcm_injection: true` 及 `diluents`：每条包括 `phase`、`solvent`、`concentration_percent`、`min_ml/max_ml`。抗菌级别记录须含 `hospital_id/grade`。医保记录须含 `category: A/B/not_listed`、`negotiated`、`catalog_code`、完整 `payment_scope`。双通道与 VBP 必须指定地方 `region` 和 `selected` 布尔值；VBP 另有 `procurement_batch`。冲突命中、地区不符、过期和产品身份不完整都不匹配。

通过 `node scripts/import-cn-pharmacy-catalog.mjs --input <目录JSON> --output <新版本JSON> --source-dir <已审校原文目录>` 导入。命令核对所有引用原文的字节 SHA-256，不联网，拒绝覆盖已有版本；默认拒绝合成目录。`--synthetic` 仅可用于非生产测试，不能覆盖 production 配置。启用路径为 `MEDCIUS_CN_PHARMACY_CATALOG`，缺失或损坏的显式配置会报错。默认未配置时返回空目录和明确资料不足；**本次未安装完整 NMPA 产品说明书、地方抗菌分级、地方双通道或 VBP 正式目录**。这不会降级或绕过 NER。

## 官方与原始资料

- [WS/T 428-2013 成人体重判定](https://www.nhc.gov.cn/ewebeditor/uploadfile/2013/08/20130808135715967.pdf)；实现绑定此版本，不将征求意见稿当成已生效标准。
- [中国人群 eGFR 方程的原始比较研究](https://pmc.ncbi.nlm.nih.gov/articles/PMC3720580/)：区分公式变体；本模块只实现指定的 175 系数版本。
- [三级医院评审标准（2025年版）发布通知](https://www.nhc.gov.cn/yzygj/c100068/202506/25229edc80d34694b7debf54ddef9f9f.shtml)、[2025核心制度监测指标官方解读](https://www.nhc.gov.cn/yzygj/c100067/202506/bd3ff04a2a2e463eaf680902c1a49894.shtml)。仅选择相关记录核对节点，不计算全院合格率。
- [单病种质量监测信息项（2020年版）](https://www.nhc.gov.cn/wjw/c100175/202007/4833bc2402ab4705984d0de4831e630e/files/1643270847648_15839.pdf)，STEMI/HF/STK/CAP 相应条目。
- [抗菌药物临床应用指导原则（2015年版）](https://www.nhc.gov.cn/ewebeditor/uploadfile/2015/09/20150928170007470.pdf)，围术期及分级管理部分。
- [2024年国家医疗质量安全改进目标](https://www.nhc.gov.cn/yzygj/c100068/202402/0359e2adda284e69b676e94c24426b0d/files/1733999813027_60751.pdf)，VTE 规范预防要求。
- [2025医保目录通知（2026-01-01起实施）](https://www.nhsa.gov.cn/art/2025/12/7/art_104_18970.html)，不把国谈属性直接当作地方双通道属性。
- [香港药物办公室转发 NMPA 2024年第81号说明书修订警示](https://www.drugoffice.gov.hk/gb/unigb/www.drugoffice.gov.hk/eps/news/showNews/%E5%9C%8B%E5%AE%B6%E8%97%A5%E7%9B%A3%E5%B1%80/pharmaceutical_trade/2024-07-03/tc/53737.html)：用于复方感冒灵含西药成分的有限提示；未把其他产品或剂型的剂量当作通用知识。

## 验证记录

专项测试：`tests/test-china-specialty-pharmacy.mjs`、`tests/test-china-clinical-production.mjs`。覆盖计算边界、特殊用药节点、时间与归属冲突、空值/否定值差异、药学目录导入、只读 HIS、回放及真实 CPU NER。完整验证在隔离副本执行，日志与最终状态见本节后续记录；临床有效性、真实医院验收和正式医保支付命中验证未执行。

最终冻结副本：`output/china-specialty-verification-20261102-r2/workspace`，运行 ID `8ebdd125-7002-4064-942c-6ab83ad05ae7`；2026-11-03 03:27:01–03:31:27 UTC，Node v24.13.0，Windows x64，真实本地 CPU NER。

| 验证 | 实际结果 |
| --- | --- |
| 本次专项测试 | 24 tests，24 pass，0 fail，0 skipped |
| 全量工程检查 | 70/70 check 通过，含 JSON、skills、生产 PHI、HIS、查房、出院、权限、安全与部署回归 |
| 报告/基准流程 | 13 项中 12 项完成；1 项性能基准失败。执行成功不等于临床或研究终点成立 |
| 完整运行退出状态 | 83 项合计 82 completed / 1 failed；退出码 1，未宣称全绿 |
| 性能失败 | `preround_workflow`，100 次，平均 1583.034 ms/op，原门槛 80 ms；未放宽门槛、未绕过 NER。不据此比较临床收益或宣称优化效果 |
| 指定 Python 插件校验器 | `NOT_RUN_MISSING_TOOL`：`<user-home>/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py` 不存在；没有以其他校验冒充该步骤 |
| 临床/医院验收 | `NOT_RUN`；无真实患者、外部模型出站或医保支付裁定验证 |

证据：[专项日志](../../output/china-specialty-verification-20261102-r2/focused-checks.log)、[完整日志](../../output/china-specialty-verification-20261102-r2/full-checks.log)、[机器回执](../../output/china-specialty-verification-20261102-r2/workspace/out/quality-gates-latest.json)、[冻结源码清单](../../output/china-specialty-verification-20261102-r2/source-manifest.json)。最终回归后核对源码与冻结副本无差异；随后仅追加本段说明。r1 的原始日志和失败结果仍保留。

生产验收仍受性能门槛、正式产品/地方政策目录及院内审校约束。NER 执行和失败阻断已在工程测试中核验；真实病历上的实体识别召回率和完整脱敏保证没有在本次建立。
