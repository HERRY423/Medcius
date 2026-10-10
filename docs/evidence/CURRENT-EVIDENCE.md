# 当前评测证据索引

由 scripts/build-evidence-index.mjs 从原始报告读取。各条目有独立身份、输入范围与文件哈希；不同分母不可相互替代。旧 out/ 报告仅在此索引引用时才是当前产物。所有结果均不支持临床获益或部署准入。

| 评测身份 | 状态 / 范围 | 原始报告与指标 |
|---|---|---|
| cross-evaluation-negative-controls-v1 | SYNTHETIC_ONLY；六个现有评分器的错误输出与无效输入检测；不建立金标准独立性 | [报告](../../out/evaluation-negative-controls.json)：6 类评测 / 38 项负对照；未检出 0 |
| label-statistics-fixture-v1 | SYNTHETIC_ONLY；生成标签行；不运行摘要引擎 | [报告](../../out/shadow-mode-multicenter-summary.json)：1188 行；独立性 NOT_ESTABLISHED; 终点通过 false |
| engine-anchor-replay-v2 | SYNTHETIC_ONLY；固定时间的合成患者回放 | [报告](../../plugins/medcius/evals/shadow-mode/reports/real-world-shadow-study-summary.json)：18 例 / 211 候选；锚点分类 {"text":4,"verbatim_verified":4,"text_unverified":0,"structured":151,"resource_linked":151,"structured_unverified":0,"derived":21,"sources_linked":21,"derived_unverified":0,"gap":35} |
| engine-policy-challenge-v1 | SYNTHETIC_ONLY；软件契约预期；非独立医师金标准 | [报告](../../plugins/medcius/evals/shadow-mode/reports/engine-challenge-summary.json)：8 例；不匹配 0；负对照 4 |
| time-motion-assumptions-v1 | SYNTHETIC_ONLY；预设工作流时间模型 | [报告](../../plugins/medcius/evals/time-motion/reports/time-motion-assumptions-summary.json)：假设节省 78.8% |
| time-motion-four-row-simulation-v1 | SYNTHETIC_ONLY；另一个四行合成输入；不与预设模型合并 | [报告](../../plugins/medcius/evals/time-motion/reports/time-motion-statistical-summary.json)：4 行；描述性节省 79.4% |
| noise-fixture-v1 | SYNTHETIC_ONLY；固定噪声夹具；非真实临床泛化 | [报告](../../plugins/medcius/evals/real-world-noise/reports/noise-robustness-baseline.json)：clean: 100.0% [88.6%~100.0%]；heading_variants: 100.0% [88.6%~100.0%]；whitespace_chaos: 96.7% [83.3%~99.4%]；section_reorder: 100.0% [88.6%~100.0%]；ocr_confusion: 100.0% [88.6%~100.0%]；abbreviation_dialect: 73.3% [55.6%~85.8%]；scan_artifacts: 100.0% [88.6%~100.0%]；combined: 66.7% [48.8%~80.8%] |
| benefit-negative-control-v1 | SYNTHETIC_ONLY；反向计时与缺失测量负对照 | [报告](../../plugins/medcius/evals/clinical-benefit/reports/synthetic-measurement-summary.json)：描述性节省 -10 秒；缺失 1；获益 null |
| public-benchmark | NOT_RUN；未运行公开数据集评测；转换器不计为评测结果 | [报告](../../plugins/medcius/evals/public-benchmarks/README.md)：未测量 |

机器索引 current-evidence.json 保存报告 SHA-256。公开基准尚缺批准的数据与独立预测；生产规则包仍为 0 个院方审批产物。
