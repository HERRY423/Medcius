# 当前评测证据索引

由 scripts/build-evidence-index.mjs 从原始报告读取。各条目有独立身份、输入范围与文件哈希；不同分母不可相互替代。本地 out/ 中的两份具名合成摘要按原字节复制到 docs/evidence/reports/，使仓库内链接可直接读取；source_path 保留生成位置。所有结果均不支持临床获益或部署准入。

| 评测身份 | 状态 / 范围 | 原始报告与指标 |
|---|---|---|
| phi-development-v6-A | SYNTHETIC_ONLY；已转为开发回归的 v5 挑战 | [报告](../../docs/engineering/verification/phi-v6/after-A.json)：姓名完整遮盖 60/60，临床段保留 144/144 |
| phi-development-v6-B | SYNTHETIC_ONLY；已转为开发回归的 v5 挑战 | [报告](../../docs/engineering/verification/phi-v6/after-B.json)：姓名完整遮盖 36/36，临床段保留 108/108 |
| phi-fresh-challenge-v6 | SYNTHETIC_ONLY；实现冻结后构造的 36 个姓名、12 种语境及临床负对照 | [报告](../../docs/engineering/verification/phi-v6/fresh/challenge-results.json)：before 完整遮盖 57/72，临床保留 166/168 / after 完整遮盖 63/72，临床保留 166/168 |
| phi-balanced-burst-v6 | SYNTHETIC_ONLY；64 并发补查负载，每版 12 轮 | [报告](../../docs/engineering/verification/phi-v6/crop-burst.json)：v4 拒绝 0，p95 均值 596.5 ms / v5 拒绝 0，p95 均值 407.4 ms / v6 拒绝 0，p95 均值 420.8 ms |
| phi-development-repair-v5 | SYNTHETIC_ONLY；原 120 条挑战已转为开发回归，含 12 条已知反例 | [报告](../../docs/engineering/verification/phi-v5/development-120.json)：实体完整遮盖 66/66，临床段保留 168/168 |
| phi-fresh-challenge-v5 | SYNTHETIC_ONLY；最终实现冻结后首次评估的 72 条同作者合成样例 | [报告](../../docs/engineering/verification/phi-v5/final-holdout/challenge-results.json)：before 遮盖 31/36，保留 104/108，阻断 0 / after 遮盖 31/36，保留 108/108，阻断 0 |
| phi-balanced-burst-v5 | SYNTHETIC_ONLY；本机 64 请求补查密集负载，三版本轮换顺序 | [报告](../../docs/engineering/verification/phi-v5/three-way-final.json)：v3 p95 均值 662.2 ms，拒绝 0 / v4 p95 均值 628.7 ms，拒绝 0 / v5 p95 均值 435.6 ms，拒绝 0 |
| phi-unseen-challenge-v4 | SYNTHETIC_ONLY；120 条实现冻结后一次性评估的新合成样例；同作者、非独立盲审；保留漏检和误删 | [报告](../../docs/engineering/verification/2026-11-19-phi-v4/challenge-results.json)：before: 实体完整遮盖 61/66；临床段保留 161/168；阻断 0；after: 实体完整遮盖 61/66；临床段保留 161/168；阻断 0 |
| phi-burst-legacy-v4 | SYNTHETIC_ONLY；同机六轮交替前后对照；64 请求完成量与拒绝分列；非完整查房 80 ms 门槛 | [报告](../../docs/engineering/verification/2026-11-19-phi-v4/paired-legacy.json)：before: 完成 384/384；拒绝 0；p95 均值 1996.9 ms；after: 完成 384/384；拒绝 0；p95 均值 2021.1 ms |
| phi-burst-crop-heavy-v4 | SYNTHETIC_ONLY；同机六轮交替前后对照；64 请求完成量与拒绝分列；非完整查房 80 ms 门槛 | [报告](../../docs/engineering/verification/2026-11-19-phi-v4/paired-crop-heavy.json)：before: 完成 384/384；拒绝 0；p95 均值 466.5 ms；after: 完成 384/384；拒绝 0；p95 均值 445.4 ms |
| phi-crop-component-v4 | SYNTHETIC_ONLY；旧开发文本的片段推理；12 轮交替对照；不等于端到端性能 | [报告](../../docs/engineering/verification/2026-11-19-phi-v4/paired-component.json)：before: 8 片段均值 21.61 ms；after: 8 片段均值 14.15 ms |
| cross-evaluation-negative-controls-v1 | SYNTHETIC_ONLY；六个现有评分器的错误输出与无效输入检测；不建立金标准独立性 | [报告](../../docs/evidence/reports/cross-evaluation-negative-controls-v1.json)：6 类评测 / 38 项负对照；未检出 0 |
| label-statistics-fixture-v1 | SYNTHETIC_ONLY；生成标签行；不运行摘要引擎 | [报告](../../docs/evidence/reports/label-statistics-fixture-v1.json)：1188 行；独立性 NOT_ESTABLISHED; 终点通过 false |
| engine-anchor-replay-v2 | SYNTHETIC_ONLY；固定时间的合成患者回放 | [报告](../../plugins/medcius/evals/shadow-mode/reports/real-world-shadow-study-summary.json)：18 例 / 215 候选；锚点分类 {"text":8,"verbatim_verified":8,"text_unverified":0,"structured":151,"resource_linked":151,"structured_unverified":0,"derived":21,"sources_linked":21,"derived_unverified":0,"gap":35} |
| engine-policy-challenge-v1 | SYNTHETIC_ONLY；软件契约预期；非独立医师金标准 | [报告](../../plugins/medcius/evals/shadow-mode/reports/engine-challenge-summary.json)：8 例；不匹配 0；负对照 4 |
| time-motion-assumptions-v1 | SYNTHETIC_ONLY；预设工作流时间模型 | [报告](../../plugins/medcius/evals/time-motion/reports/time-motion-assumptions-summary.json)：假设节省 78.8% |
| time-motion-four-row-simulation-v1 | SYNTHETIC_ONLY；另一个四行合成输入；不与预设模型合并 | [报告](../../plugins/medcius/evals/time-motion/reports/time-motion-statistical-summary.json)：4 行；描述性节省 79.4% |
| noise-fixture-v1 | SYNTHETIC_ONLY；历史原文匹配基线；10 份病历的 seed 变体不独立，原报告区间不代表患者总体不确定性 | [报告](../../plugins/medcius/evals/real-world-noise/reports/noise-robustness-baseline.json)：clean: 100.0% [88.6%~100.0%]；heading_variants: 100.0% [88.6%~100.0%]；whitespace_chaos: 96.7% [83.3%~99.4%]；section_reorder: 100.0% [88.6%~100.0%]；ocr_confusion: 100.0% [88.6%~100.0%]；abbreviation_dialect: 73.3% [55.6%~85.8%]；scan_artifacts: 100.0% [88.6%~100.0%]；combined: 70.0% [52.1%~83.3%] |
| noise-diagnostics-v2 | SYNTHETIC_ONLY；当前开发诊断；原文匹配与词法别名匹配分列，非临床召回率 | [报告](../../plugins/medcius/evals/real-world-noise/reports/noise-diagnostics-v2.json)：clean: 原文 30/30；别名 30/30；heading_variants: 原文 30/30；别名 30/30；whitespace_chaos: 原文 30/30；别名 30/30；section_reorder: 原文 30/30；别名 30/30；ocr_confusion: 原文 30/30；别名 30/30；abbreviation_dialect: 原文 22/30；别名 30/30；scan_artifacts: 原文 30/30；别名 30/30；combined: 原文 21/30；别名 29/30 |
| phi-clinical-development-v1 | SYNTHETIC_ONLY；人工编写的开发样例，非独立临床召回率；保留罕见裸姓名漏检 | [报告](../../docs/engineering/verification/2026-11-15-phi-cpu/coverage-final.json)：24 条；实体完整遮盖 17/19；临床文字保留 28/28；阻断 0 |
| phi-peak-process-pool-v1 | SYNTHETIC_ONLY；本机合成 PHI 入口突发负载；非完整查房流程，不替代 80 ms 门槛；完成与拒绝分列 | [报告](../../docs/engineering/verification/2026-11-15-phi-cpu/peak-final.json)：legacy_single_queue: 32 并发三轮 p95 均值 3353.1 ms；process_pool_2: 32 并发三轮 p95 均值 2718.5 ms；process_pool_2_budget8: 32 并发三轮 p95 均值 1782.5 ms |
| phi-subject-development-v2 | SYNTHETIC_ONLY；原样例与新增开发挑战分列；非独立临床召回率，保留新发现的裸姓名漏检 | [报告](../../docs/engineering/verification/2026-11-15-phi-v2/subjects-final.json)：original: 实体完整遮盖 19/19；临床文字保留 28/28；阻断 0；challenge: 实体完整遮盖 34/36；临床文字保留 150/150；阻断 0 |
| phi-subject-development-v3 | SYNTHETIC_ONLY；原 24 条、80 条挑战与新增 125 条开发样例分列；临床文字按原文位置计分，非独立临床验证 | [报告](../../docs/engineering/verification/2026-11-15-phi-v3/coverage-final.json)：original: 实体完整遮盖 19/19；临床文字保留 28/28；阻断 0；challenge: 实体完整遮盖 36/36；临床文字保留 150/150；阻断 0；context: 实体完整遮盖 34/34；临床文字保留 139/139；阻断 0 |
| phi-context-burst-v3 | SYNTHETIC_ONLY；修改前冻结源码与 v3 在同机相同负载下六轮交替对照；非正式等效检验或医院总体性能 | [报告](../../docs/engineering/verification/2026-11-15-phi-v3/paired-final.json)：before: 完成 384/384；拒绝 0；p95 均值 1941.6 ms；after: 完成 384/384；拒绝 0；p95 均值 1987.9 ms |
| phi-burst-microbatch-v2 | SYNTHETIC_ONLY；相同本机输入和 CPU 预算；普通队列与扩大队列对照；仅合成 PHI 入口负载，非医院总体效果 | [报告](../../docs/engineering/verification/2026-11-15-phi-v2/burst-final.json)：fifo_pending32: 64 请求三轮完成 102/192；拒绝 90；p95 均值 1449.8 ms；fifo_pending96: 64 请求三轮完成 192/192；拒绝 0；p95 均值 2486.9 ms；microbatch8_pending32: 64 请求三轮完成 192/192；拒绝 0；p95 均值 1947.2 ms |
| benefit-negative-control-v1 | SYNTHETIC_ONLY；反向计时与缺失测量负对照 | [报告](../../plugins/medcius/evals/clinical-benefit/reports/synthetic-measurement-summary.json)：描述性节省 -10 秒；缺失 1；获益 null |
| public-benchmark | NOT_RUN；未运行公开数据集评测；转换器不计为评测结果 | [报告](../../plugins/medcius/evals/public-benchmarks/README.md)：未测量 |

机器索引 current-evidence.json 保存报告 SHA-256。公开基准尚缺批准的数据与独立预测；生产规则包仍为 0 个院方审批产物。
