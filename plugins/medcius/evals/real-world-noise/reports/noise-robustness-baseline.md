# 真实病历脏数据鲁棒性基准（Noise Robustness Baseline）

> 自动生成：`plugins/medcius/evals/real-world-noise/run-noise-benchmark.mjs`；确定性输出，同 seed 同结果。
> 衡量对象：`parse-cn-note` 确定性解析层在结构性脏数据（非标标题/缩写方言/乱序/空白混乱/OCR 混淆/扫描件伪影）下的字段抽取保持率。
> **不是临床证据**：噪声模拟 ≠ 真实世界数据；真实脱敏数据走 `ingest-real-data.mjs` 同一量具。
> 样例：10 份合成病历（gold 覆盖 cne-01..10）× 3 个 seed × 7 个噪声模型。

| 噪声模型 | note 全字段命中率 (95% CI) | 字段级保持率 |
|---|---|---|
| clean | 100.0% [88.6%~100.0%] | 100.0% |
| heading_variants | 100.0% [88.6%~100.0%] | 100.0% |
| whitespace_chaos | 96.7% [83.3%~99.4%] | 98.6% |
| section_reorder | 100.0% [88.6%~100.0%] | 100.0% |
| ocr_confusion | 100.0% [88.6%~100.0%] | 100.0% |
| abbreviation_dialect | 73.3% [55.6%~85.8%] | 88.9% |
| scan_artifacts | 100.0% [88.6%~100.0%] | 100.0% |
| combined | 66.7% [48.8%~80.8%] | 81.9% |

## 解读纪律

1. clean 基线必须 100%——任何下降即解析层回归（china-skills 确定性评测同步把关）；
2. combined 下限 65% 为回归绊线：只有解析器更鲁棒时才允许上调，禁止为了让变更通过而下调；
3. OCR 混淆维度的下降是确定性解析器的结构性边界——真实病历的最终抽取应依赖 LLM 抽取层（clinical-note-extract 技能）+ 人工复核，本基准为其提供对照下限；
4. 每字段失败明细见 reports/noise-robustness-baseline.json（per_note.failures），优先修复 heading_variants 与 whitespace_chaos 可恢复的失败。