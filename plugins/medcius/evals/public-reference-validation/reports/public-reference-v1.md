# 公开参考验证报告（Public-Reference Validation v1）

> **证据层级**：`public_reference_validation` —— 工程级公开参考一致性层。用例为围绕**可公开核实药学事实**（说明书公开文本等，来源见 fact pack `source_version=public-ref-v1-2026-08-25`）构造的工程场景。**本层不是临床效能证据，不解锁 `clinical_evidence_pass`**；真实临床结论仍须由独立药师盲标研究（R15/R16/R29）产生。

- 用例总数：37（flag/clear 计分 36 + fail-closed 单列 1）
- 阳性（flag）：24；阴性（clear）：12
- 混淆矩阵：TP=24 FP=0 FN=0 TN=12

| 指标 | 点估计（Wilson 95% CI） |
|---|---|
| 灵敏度 | 100.0% [86.2%, 100.0%] |
| 特异度 | 100.0% [75.8%, 100.0%] |
| PPV | 100.0% [86.2%, 100.0%] |
| NPV | 100.0% [75.8%, 100.0%] |

## 分维度明细

| 维度 | TP | FP | FN | TN | 灵敏度 | 特异度 |
|---|---|---|---|---|---|---|
| interaction | 12 | 0 | 0 | 6 | 100.0% [75.8%, 100.0%] | 100.0% [61.0%, 100.0%] |
| allergy | 2 | 0 | 0 | 1 | 100.0% [34.2%, 100.0%] | 100.0% [20.7%, 100.0%] |
| dose_renal | 2 | 0 | 0 | 1 | 100.0% [34.2%, 100.0%] | 100.0% [20.7%, 100.0%] |
| contraindication | 4 | 0 | 0 | 1 | 100.0% [51.0%, 100.0%] | 100.0% [20.7%, 100.0%] |
| special_population | 2 | 0 | 0 | 1 | 100.0% [34.2%, 100.0%] | 100.0% [20.7%, 100.0%] |
| duplicate_therapy | 2 | 0 | 0 | 2 | 100.0% [34.2%, 100.0%] | 100.0% [34.2%, 100.0%] |

## Fail-closed 抽查（G1 纪律）

- PRV-I001：预期 insufficient_data → 实际 **insufficient_data** ✅（处方含肾剂量规则药物但未提供 CrCl/eGFR）

## 整改记录（深度整改留痕）

1. 引擎对『阴性结论』一律给出 consulted-basis（如「interaction_pairs 全表未命中该组合」），禁止输出无限定的「未发现相互作用」（G3 整改）。
2. 肾剂量维度在处方含规则药物但缺 CrCl 时返回 insufficient_data 而非 clear（G1 fail-closed 整改）。
3. 过敏维度区分直接匹配（flag）与交叉过敏（转药师，不自动放行），阴性对照 PRV-N010 验证该路径。
4. 所有 flag 均绑定 fact_id 与公开来源文本，满足 D4 可解释纪律。
5. fact 命中校验：flag 用例不仅要求 overall=flag，还要求在对应维度命中 expected_fact_ids，防止『碰巧因其他维度 flag 而蒙对』（run.mjs FACT-MISS 检查）。

- 门禁结果：✅ ALL CONSISTENT
