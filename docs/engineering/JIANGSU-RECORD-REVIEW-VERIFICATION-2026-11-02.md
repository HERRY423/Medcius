# 江苏病案质控改进：执行与验收记录

日期为本地 2026-11-02；部分工具回执使用 UTC 2026-11-03。工作区 `C:\Medcius`。未使用真实患者数据，未调用真实医院分组器；本轮无付费服务调用。未提交 Git，保留进入本轮前已存在的改动及其他工作流的并行修改。

**判定：本轮实现的工程行为有测试支持，完整项目检查未全通过。** `claim_type=engineering`，`evidence_level=test_passed`，`scope=本地合成输入、版本化 SQLite 存储及受信本地适配器契约`。不外推为江苏医院验收、官方全量编码覆盖、临床诊断准确率、医保合规认定或管理收益。

| 项目 | 实际结果与证据 |
|---|---|
| 最终定向回归 | 59 tests / 59 pass / 0 fail / 0 skipped；其中新文件 54 项、既有语料边界 5 项；`out/jiangsu-record-quality-2026-11-02/focused-final.log` |
| 既有病案首页质量回归 | PASS；`record-quality-legacy-attempt-2.log` |
| 既有供应链/分组对账契约回归 | PASS；最终 `corpus-final.log` |
| JSON/配置校验 | PASS；`validate-json-final.log`。已有未映射 schema 仍明确记为 SYNTAX_ONLY，不冒充全部深度校验 |
| Skills/plugin manifests | PASS；`validate-skills-final.log` |
| 本地导入 CLI + 重启后工具表面核对 | PASS；`import-cli.log`、`tool-surface.log`；13 个声明工具都有 handler，没有 MCP 导入/写工具 |
| 合成工作流回放 | 已实际生成 `synthetic-review.json`；显示病程与首页待核对项、LIS 证据、未执行医嘱，分组接口状态 `REPLAY_ONLY`，样例码 `unverifiable` |
| 指定外部 Python plugin validator | **NOT_RUN_TOOL_MISSING**；实际命令退出 2，脚本不存在，见 `external-plugin-validator.log` |
| 最后一次完整流程 | 82 steps：69 项工程检查 PASSED、12 份报告执行完成且端点 NOT_ASSERTED、1 项性能报告 FAILED；完整流程退出 1 |
| 医院部署验收 / 临床证据 | NOT_ESTABLISHED / BLOCKED，未提高证据等级 |

**完整流程的原始回执。** 第一次 `6315df83-b14d-45ad-a6fb-a6a93c64251a`，UTC 02:38:22.452–02:38:52.487，73 completed / 9 failed；失败含本地 NER 模型路径未传入的 PHI 入口门控。原始日志与回执保存在 `full-attempt-1.log` / `full-attempt-1-receipt.json`。没有删除失败记录或关闭门控。

确认工作区已有本地模型后，仅对第二次测试进程设置 `MEDCIUS_CN_NER_MODEL_DIR=C:\Medcius\output\models\bert-base-chinese-ner-int8`。未重新下载模型、未改变全局环境配置。第二次回执为 `01f4acb1-eac3-4de5-b028-c3ddafd0c98e`，UTC 02:42:52.298–02:47:44.767，保存为 `full-attempt-2.log` / `full-attempt-2-receipt.json`。

第二次唯一失败来自既有 `preround_workflow` 性能门禁：100 次计时迭代，平均 **1709.442 ms/op**，现有预算 **80.00 ms/op**。这是查房桥接工作流，不是本次新增分组预审的计时结果；本轮未修改基准迭代数或性能预算。快照报告 `performance-baseline-from-full-attempt-2.md` 原样保留。该基准中 p50/p95 沿用平均值，不能解释为实际测量的延迟分位数。此失败意味着项目整体性能门禁仍未满足。

完整流程之后又补充了映射图的诊断/手术类别隔离、地域前缀与矛盾选择器防护，并完成最终 59 项定向回归、JSON、skills 与供应链复测；没有再次重复完整性能测量。因此完整回执和最终定向回执分别保留，各自只证明实际执行时的范围。

**反例与失败保留。** 定向第 4 次执行发现“排除低钾血症”尚未识别为诊断冲突，日志 `focused-attempt-4.log` 保留；修复后增加两侧原文锚点，并通过最终回归。另一次直接启动旧病案测试因默认数据库目录不可写失败，保存 `record-quality-legacy.log`；为该测试进程指定工作区内独立数据目录后通过。未修改原患者库或降低断言。

**已覆盖的实质行为。** 包版本并存、不可变导入、源字节摘要绑定、重启持久性、篡改拒绝、CCHI/ICD 反向不等价、一对多与条件映射；跨患者拒绝、住院时段限制、未知/部分来源覆盖、撤回/修订/冲突检验、样本类型与单位缺失、血气吸氧上下文、白蛋白不能代替营养评估、未签署及自我引用文书、否定/疑似/历史/家属、诊断先肯定后排除、医嘱退回与停止前真实执行；预审身份/版本/摘要绑定、未配置地域、错误编码、无关 MCC/CC、并发验收竞争、超时占用和敏感错误正文不回显。

**底线覆盖（本次工程任务）。** 质控：通过，来源、身份、时间、版本与缺失状态有正负用例。方法前提：通过本地契约检查，单位/样本/氧疗上下文不足时保持 unknown；临床阈值和真实 NLP 准确率未验证。阴性对照/基线：通过错误归属、否定、撤回、篡改与错返回用例，原失败保留。样本和批次结构、分析单位与重复设计、多重比较、训练测试泄漏四项不适用本轮工程结论：没有临床抽样统计、假设检验或模型训练；测试例数不是患者样本量。

**同上下文双向自查，非独立审查。** “本轮实现的工程行为有测试支持”仅覆盖实际本地回归，没有把适配器回放说成医院联调或支付正确性；“完整项目检查未全通过”点明实际性能失败，同时保留已通过的新模块检查，不把单项失败扩大为全部实现无效。

**交付与回滚定位。** 接入说明在 `JIANGSU-RECORD-REVIEW-2026-11-02.md`。`before.zip` / `before-manifest.json` 保存本轮开工时选定的 19 个文件，`git-status-before.txt` 标明原有工作区改动。最终任务文件与哈希见 `after-manifest.json` / `after.zip`，运行时依赖哈希另存 `runtime-manifest.json`。它们提供定位和一致性核对，不代替执行或临床证据。回滚应只针对该清单中本轮的具体差异，不覆盖同一工作区其他任务的修改。

后续验收的改判条件是：确定江苏具体统筹区、当期分组方案与编码版本、授权映射原件和本地适配器后，以获批脱敏病例逐例核对病案人员标注与医院分组器结果；一致才可将对应接口范围升级到 `host_accepted`，存在不一致则保留未验收状态并定位差异。真实管理收益或临床效用须另有研究证据，不能由本轮工程结果推断。
