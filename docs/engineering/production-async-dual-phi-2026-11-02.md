# 生产异步双轨脱敏接入记录

工程变更；仅使用合成病历和本地 CPU 模型。没有真实 HIS 访问、模型 API 外发、患者资料外传或生产部署。

## 已接通的边界

- HIS `executeHisEmbedPreRound` → `executePreRoundFromBridge` → `executePreRoundWorkflowAsync` → `analyzePatientEvolutionAsync`。
- 连接器出口先提取姓名/联系人/医师/地址到内存会话，再封装结构化身份；整个桥接快照返回前再次执行双轨检查。可选来源的 PHI 错误同样中止。
- `createPatientSourceSnapshotAsync` 在生成摘要、原文锚点和摘要哈希之前处理自由文本。
- `saveFrozenResearchRecordAsync`、`readFrozenResearchRecordAsync`、`replayFrozenResearchRecordAsync` 以及研究复核 HTTP 路由等待校验；新增残留会阻断归档或导出，不改写历史文件和证据坐标。
- LLM A/B 两种拓扑在生产都检查请求和响应，并要求与患者上下文绑定的实体会话。

`NODE_ENV=production`、`MEDCIUS_PROFILE=production`、生产上下文或真实院端开关要求真实 NER。请求提供 `profile: demo`、启发式选项、伪造回执或声明 `execution: local` 的空回调均不能覆盖此要求。生产同步快照、查房、直接计算引擎与归档接口显式报错。检测器来自加载并校验过固定模型资产的工厂，冻结实例；复制对象和已关闭实例不被认可。

服务器启动前加载 `MEDCIUS_CN_NER_MODEL_DIR` 指定的绝对本地目录。缺失、损坏、推理异常、超时、取消或未完成扫描均阻断；模型替换失败不会调用上一个缓存版本。运行时不下载资产，也不调用远程 NER。

## 内容与一致性

动态词典按租户、患者、就诊和会话隔离，在内存中保存，不进入回执或审计记录。自由文本先经词典和模型处理，再重复模型扫描，最多五轮；达到上限仍有残留即失败。重复字段仅在同一请求内复用已完成扫描的结果，并重新核对会话词典。

有严格字符约束的证据 ID/版本/时间坐标、闭集状态枚举保留原值，避免中文 NER 把孤立的 `unknown` 或版本标签误当作人名。未知值、非 ASCII 标识符内容和自由文本仍执行 NER。固定完整剂型药名仅抑制神经模型的 PERSON 误报，调用方不能扩展；会话姓名命中始终优先。新增测试同时覆盖药名保留与同名字典覆盖。

异常只暴露有限错误码，不回传连接器、推理服务或未处理 HTTP 异常中的原文。归档仍使用内容完整性校验与不可覆盖写入；任何保护步骤失败均不写入新的归档记录。

## 验证记录

环境：Windows x64，Node v24.13.0，ONNX Runtime 1.23.2，CPU provider，默认 2 个推理线程。模型为固定版本 `Xenova/bert-base-chinese-ner` 的 int8 权重；模型资产清单见运行时 `model-manifest.json`。这是通用中文 NER，不是已获临床验证的医疗 PHI 模型。

定向命令（配置实际模型目录后）：

```powershell
node --test --test-concurrency=1 tests/test-production-dual-phi.mjs tests/test-cn-assertion-dual-phi.mjs tests/test-cn-phi-onnx.mjs tests/test-cn-localization-hardening.mjs
node scripts/validate-json.mjs
node scripts/validate-skills.mjs
```

最终定向运行：46/46 通过、0 跳过，日志为 `output/production-dual-phi-verification-20261102-r2/focused-checks.log`。JSON 和技能检查通过。生产测试包括可选连接器通过 `error.code` 报告 NER 故障仍阻断、assert-only 出口发现变换即阻断。

完整回归使用两份独立目录和实际本地 Git 验证副本，未覆盖原工作区历史评测报告；固定来源清单含各文件 SHA-256。

- 首轮：`output/production-dual-phi-verification-20261102-r1/full-checks.log`，75/81 完成，6 项失败；原日志保留。
- 修复后完整重跑：`output/production-dual-phi-verification-20261102-r2/full-checks.log`，**82 项中 81 项完成、1 项性能失败**；退出码 1，完成时间 `2026-11-03T02:43:17.439Z`。该副本包含当时新增的江苏病案检查，故步骤数较首轮增加 1。完整机器回执在该目录的 `workspace/out/quality-gates-latest.json`，来源清单为 `source-manifest.json`。
- 运行器状态：`engineering_pass=true`，`synthetic_execution_pass=false`，`synthetic_validation_pass=NOT_ESTABLISHED`，`clinical_evidence_pass=BLOCKED`。部分成功步骤仅表示报告脚本执行完成，不表示临床或统计终点通过。整体质量门禁仍然失败。
- 完整回归现在必须通过实际 CPU NER 的生产测试；模型未配置会失败，不能靠跳过 ONNX 测试通过。
- 指定的 `<user-home>\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py` 不存在，状态为 `NOT_RUN`；没有以其他检查冒充该验证。

## 性能与证据边界

单独性能测量保留在 `output/production-dual-phi-performance-r1.md`：复杂合成查房路径 100 次平均 1611.846 ms。完整重跑中的同一指标为 **1762.516 ms / 100 次，旧门槛 80 ms，失败**；报告为 `output/production-dual-phi-verification-20261102-r2/workspace/plugins/medcius/evals/performance-baseline/reports/performance-baseline.md`。测试完成并返回失败，未超时。该旧脚本的异步 p50/p95 实际等于均值，并非分位数测量；只引用其均值。没有放宽 80 ms 门槛，没有通过移除 NER 恢复速度。完整运行器仅把该测试进程的执行超时从 120 秒延长到 300 秒，使 100 次真实推理能够完成；这不修改延迟门槛。

验证范围以冻结副本为准。运行期间工作区的 DRG/DIP、病案证据核对和对应测试另有并发变更，完整运行不能视为那些后续版本的全量验收；当前本任务脱敏实现与冻结副本一致。差异清单保存在同一验证目录的 `workspace-drift.json`。最终定向 PHI 测试另在当前工作区执行通过。

工程定向通过不代表完整质量门禁通过，也不证明零漏检、临床准确率、临床效用、跨平台运行验收或部署延迟达标。`complete_deidentification: NOT_ESTABLISHED` 保留。现有 NER 的临床域偏移、英文误报、罕见姓名与隐私召回需独立的授权验证；本次没有作这些临床主张。

本机已具备模型资产和锁定依赖。生产主机须预置同版本资产和适配平台的原生 CPU 运行时；当前通用容器配方不构成 Linux NER 验收。模型及原生依赖缺失时启动失败是预期行为。
