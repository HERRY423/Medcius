# 回顾性验证报告（Retrospective Validation）

- 生成时间：2026-08-24T09:17:56.304Z
- 预测文件：`C:\Users\13264\Desktop\Medcius\plugins\medcius\evals\clinical-validation\pred\batch01.jsonl`　金标准：`C:\Users\13264\Desktop\Medcius\plugins\medcius\evals\clinical-validation\gold\batch01.jsonl`　配对样本：120

> 口径：`flag`＝系统/药师判为存在问题；指标按维度分层。回顾性、单数据集结果不构成注册临床评价，也不支持任何“等效”结论。

| 维度 | TP | FP | FN | TN | 灵敏度 | 特异度 | PPV | NPV | F1 |
|---|---|---|---|---|---|---|---|---|---|
| allergy | 5 | 2 | 0 | 13 | 100.0% | 86.7% | 71.4% | 100.0% | 83.3% |
| contraindication | 6 | 0 | 0 | 14 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| dose_renal | 7 | 2 | 0 | 11 | 100.0% | 84.6% | 77.8% | 100.0% | 87.5% |
| duplicate_therapy | 3 | 0 | 2 | 15 | 60.0% | 100.0% | 100.0% | 88.2% | 75.0% |
| interaction | 6 | 1 | 0 | 13 | 100.0% | 92.9% | 85.7% | 100.0% | 92.3% |
| special_population | 8 | 0 | 1 | 11 | 88.9% | 100.0% | 100.0% | 91.7% | 94.1% |
| **总体** | 35 | 5 | 3 | 77 | 92.1% | 93.9% | 87.5% | 96.3% | 89.7% |

## McNemar 检验（系统 vs 金标准不一致性）

| 维度 | b（误报） | c（漏报） | 精确 p（双侧） |
|---|---|---|---|
| allergy | 2 | 0 | 0.5000 |
| contraindication | 0 | 0 | 1.0000 |
| dose_renal | 2 | 0 | 0.5000 |
| duplicate_therapy | 0 | 2 | 0.5000 |
| interaction | 1 | 0 | 1.0000 |
| special_population | 0 | 1 | 1.0000 |
| **总体** | 5 | 3 | 0.7266 |

## 解读纪律

1. 审方场景**优先看灵敏度与漏报（c）**：漏掉一个真相互作用比多报更危险；特异度低只增加药师负荷。
2. `p<0.05` 表示系统与药师判定存在系统性分歧，需逐例归因（规则缺陷/证据缺失/标签覆盖）。
3. 本报告不替代《医疗器械临床评价》；注册路径见 docs/compliance/SAMD-PATHWAY.md。
