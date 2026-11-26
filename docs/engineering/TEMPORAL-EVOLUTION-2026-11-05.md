[L0]

# 干预前后时间关联与 Delta Check 工程升级

本次落实截图中的时间对齐与变化检测建议。范围是确定性引擎、医院适配器、来源版本处理、合成回归与静默研究输出。新增结果位于 `summary.blocks.temporal_analysis`；临床展示准入保持原状。本记录是工程实现说明与自查，未执行独立临床评审，也没有部署到医院。

## 已实现的行为

| 截图建议 | 当前实现 | 判读边界 |
|---|---|---|
| 医嘱事件与指标斜率对齐 | 节点绑定医嘱/实际执行和测量记录，边明确为 `observed_after`、`baseline_before` 或 `coincident`；计算差值、相对变化与每小时斜率 | 时间关联不提供因果识别；同时给药列在 `overlapping_interventions` |
| 利尿/液体干预后的 6h 尿量 | 必须有绑定医嘱的 `administered` 执行事件；比较前后各 6h 的实测区间总量 | 开立时间和计划剂量不代替执行；不将缺失尿量记为零，不把累计表读数直接相加 |
| 次晨血钾/肌酐 | 按临床来源时区，取执行次日 04:00–12:00 的测量序列及最后一个无歧义点，与执行前 24h 内最近测量比较 | 时间窗是版本化工程设定；时区、配对记录或单位不足时返回未知 |
| 抗菌药开立/升级与体温、WBC/PCT/CRP 对齐 | 开立和执行分别建锚点；仅当来源明确 `change_type=escalated` 且提供 `changed_at` 才建立升级事件；输出最多 72h 曲线及自锚点起每 24h 的采样体温峰值 | 不根据药名推断升级，不从开立日数构造 D3，不声称连续监测或感染已经控制 |
| 未达到绝对危急值的变化 | 独立计算 48h 肌酐绝对上升、相邻 NEWS2 增加、相邻完整 SOFA 增加；命中时立即形成 `RULE_ALERT` 候选 | 候选仅在静默研究块内，`clinical_alerts_enabled=false`；不加入医生卡片、可选事实或病历草稿 |

药理字典为版本化、可追溯的有限集合：呋塞米、布美他尼、托拉塞米、美罗培南、厄他培南、比阿培南及其登记的通用名/ATC。未知名称返回 `DRUG_CLASS_UNMAPPED`；已识别通用名与 ATC 冲突时拒绝建链。它不替代医院药品主数据、给药规则或完整抗菌药目录。液体复苏需要来源显式标记 `intervention_kind=fluid_resuscitation`，不从“盐水”或输液医嘱猜测目的。

## 数据契约与失败行为

- `patient_id`、`encounter_id`、`tenant_id`、资源 ID 和 `source_system` 必须齐全。显式归属不一致拒绝整次分析；缺失来源归属进入 `DATA_GAP`。嵌套给药仅可从已核对的父医嘱继承归属，并显式记录 `identity_basis=source_bound_parent_order`。
- 时间须为带时区的 ISO 时间戳，不能使用未来值、无日期、无时区或无效日期。使用采样/测量时间，不拿报告到达时间代替；晚于复核时点的来源版本不可用。
- 先做来源版本裁决。撤回、录入错误、冲突和未定稿测量不支持新轨迹计算；同一资源/版本的重复内容不重复计数。区间、实际剂量、氧疗状态和评分元数据已纳入版本冲突比较。
- 尿量需 `period_start`、`period_end`、`volume_basis=interval_total`、非负 `urine_output_ml`。六小时区间必须无重叠、无缺口地覆盖，才输出 `total_ml`。未覆盖完整时，只在可计算情况下提供 `observed_partial_ml`，完整总量仍为 `null`。跨边界区间不按比例切分，重叠不择优丢弃。
- 检验使用登记的指标代码和单位换算；不同来源、标本类型或方法的点不能配对。若标本/方法未提供，两侧保留未知元数据，数值对照不证明测量等价性。新模块不根据缺失的 LIS 参考区间宣称正常/异常。
- NEWS2 从每条完整 NIS 测量独立计算，要求成人、明确非妊娠和显式 Scale 1；不拼接不同时间的体征。缺项、Scale 2、适用性未知时不生成可比较总分。
- SOFA 只接收来源提供的 `SOFA-1996`：六个 0–4 分分项齐全，且总分与分项之和相符。没有实施从原始器官指标计算 SOFA，也不把缺失基线补成零，不与 SOFA-2 或 qSOFA 混用。
- 图和候选保留每个来源的 ID、系统、版本、时间与规范化记录摘要。摘要只绑定输入内容，不证明临床真实性。

医院适配器已传递 `context.timezone` / `timezone_offset` 和实际给药剂量、单位、途径、来源版本；受认可的时区字符串按机器字段处理，任意字符串仍经过 PHI Guard。视图映射白名单已支持新增标量字段；嵌套 SOFA 需要提供上述结构的来源适配。FHIR 的 Codex 接口仍然只读。

为了计算 48h 变化或执行前基线，输入需要包含窗口外的历史测量。引擎可使用已提供的历史记录，但没有自动增加医院读取范围；缺失历史返回 `not_evaluable`。时区使用临床输入，不使用运行主机或用户电脑时区。

## 规则依据与版本

2026-11-05 使用原生网页检索核对下列公开来源。AgentMuxer 只进行了免费能力发现，未调用收费服务，未上传项目代码、患者资料或研究材料。

1. [KDIGO 2012 AKI Guideline](https://kdigo.org/wp-content/uploads/2019/01/KDIGO-2012-AKI-Guideline-English.pdf)，Recommendation 2.1.1，印刷第 8 页：采用 48h 内 SCr 绝对增加 ≥26.5 μmol/L 的分支；原始单位两侧均为 mg/dL 时按 ≥0.3 mg/dL 比较，计算前不四舍五入。未实现完整 AKI 诊断、分期、7 天相对变化或体重校正尿量判定；未触发此分支不能排除 AKI。[KDIGO 更新页](https://kdigo.org/guidelines/acute-kidney-injury/)当时仍将 2026 版列为公开征求意见后准备发表，故未把草案替换为已生效依据。
2. [RCP NEWS2 Chart 2](https://www.rcp.ac.uk/media/2acdezkd/news2-chart-2_news-thresholds-and-triggers_0.pdf)：官方绝对评分触发值与“增加 2 分”是不同规则。此处 `news2_rise` 为 24h 内相邻完整测量增加 ≥2 的工程候选，尚无医院批准或临床性能证据。
3. [Sepsis-3 原文](https://jamanetwork.com/journals/jama/fullarticle/2492881)，Box 3 与 SOFA 讨论：SOFA 变化需要感染及器官功能障碍背景。此处 `sofa_rise` 的 24h 内相邻总分增加 ≥1 只是来源评分变化候选，不能写成 Sepsis-3、脓毒症或器官衰竭诊断。
4. [WHO ATC C03CA](https://atcddd.fhi.no/atc_ddd_index/?code=C03CA&showdescription=no)及 [J01DH](https://atcddd.fhi.no/atc_ddd_index/?code=J01DH&showdescription=no)：核对通用名与分类码，不采用 DDD 作为患者剂量建议。

规则、窗口和字典位于 `plugins/medcius/rule-packs/temporal-reference.v1.json`，输出包含版本和文件摘要。六小时、次晨及 72h 窗口用于记录对齐，不是对所有药品药效时程的验证。

## 复现与回退

```powershell
node --test tests/test-temporal-evolution.mjs
node scripts/demo-temporal-evolution.mjs
node scripts/validate-json.mjs
node scripts/validate-skills.mjs
node scripts/validate-plugin.mjs
node scripts/run-all-checks.mjs
```

示例写入 `out/temporal-evolution/synthetic-demo.md` 和 `synthetic-demo.json`。直接引擎调用传 `temporalAnalysis:false` 可停用新增计算；其余摘要投影保持一致。生产主入口仍须异步 PHI 处理；此开关不改变展示权限。

## 本轮验证记录

新增定向用例已覆盖 30 个测试，包含执行与计划分离、6h 区间、次晨时区、肌酐边界与缓慢累积、缺失/重复/修订/冲突、完整评分、归属隔离、医院适配器、输出契约和静默边界。它们使用合成记录，只支持限定的工程行为。

开发中保留两次测试失败的事实：第一版示例断言把“自执行起每 24h”误写成日历日峰值；另一断言修改了共享引用的两侧，不能构成来源不一致负对照。分别修正了期望的时间分箱和单侧替换方式，未放宽运行时规则。

首次全量运行遇到 Windows 临时目录清理权限错误与本机回环健康检查失败，运行已中止，日志保存在 `out/temporal-evolution/full-checks.log`，不视为全量完成。改用工作区内临时目录后，发布包测试通过；允许本机回环访问后，原健康测试通过。用户约定的外部 `plugin-creator/scripts/validate_plugin.py` 路径不存在，使用仓库内固定来源、先核验完整性的 `scripts/validate-plugin.mjs`，不声称运行了缺失的文件。

最终完整运行执行了 93 项：92 项通过/完成，部署回归 1 项因测试目录落在源码树内触发 `DEPLOY_TARGET_OVERLAPS_SOURCE`。将该项的临时目录改到源码树外，保持源码不变，单独复测通过；没有修改部署器限制。合并覆盖为 **80 项工程检查通过，13 项评测/报告脚本完成**，不宣称存在“单次 93/93 全量通过”的运行。

| 验证 | 本轮观察 | 证据 |
|---|---|---|
| 新增时序定向测试 | 30/30，通过 | [完整测试日志](verification/2026-11-05-temporal/temporal-tests.log) |
| 完整执行 | 92 完成，1 失败，0 跳过；保留失败状态 | [原始回执](verification/2026-11-05-temporal/full-suite-receipt.json) |
| 唯一失败项复测 | 源码外临时目录下，原部署测试退出 0 | [复测日志](verification/2026-11-05-temporal/deployment-retest.log) |
| 原有查房性能门槛 | 本机合成基准均值 66.113 ms，p95 94.223 ms；固定的平均 80 ms 门槛通过 | [性能报告](verification/2026-11-05-temporal/performance.md) |
| JSON、skills、固定来源插件校验器 | 均通过，包含校验器负对照 | 原始回执对应步骤 |
| PHI、只读权限、静默展示与冻结回放 | 原有相关检查通过，含实际 CPU NER 路径 | 原始回执对应步骤 |
| 源码绑定 | 17 个本次修改/新增的代码与配置文件在完整运行和复测期间摘要一致 | [合并验证回执](verification/2026-11-05-temporal/verification.json) |

性能数字对应原有固定 fixture，并未单独测量全量新轨迹输入的医院负载；平均门槛通过不表示每次请求低于 80 ms。旧的已提交性能报告保留原版，本轮测量另存于上述日期目录。真实临床获益、漏检率、报警负担、医院验收与部署均未验证。
