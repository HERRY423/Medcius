# batch01 合成管线基准测试批次 — 使用说明（Synthetic Pipeline Benchmark）

> **状态**：已冻结为**合成管线基准测试**（300例合成数据，报告 `reports/batch01.md`，审计 seq 1-2 已落库）。**真实临床 Gold 必须由独立执业药师盲标产生，严禁使用合成数据进行临床效能宣称**。

## 1. 定位与合规边界

- **合成管线测试（已冻结）**：用于在开发与持续集成阶段验证 Wilson 95% 置信区间算法、McNemar 假设检验及审计哈希链的完整性与稳定性。
- **真实临床评价（独立药师盲标）**：真实医院前瞻性/回顾性研究必须严格遵循盲法 SOP，由 2 名具备资质的独立药师进行双盲标注，遇分歧由第 3 人专家裁决。

## 2. 目录架构

```
evals/clinical-validation/
  gold/batch01.jsonl      # 合成管线基准占位数据（真实研究需替换为药师盲标数据）
  pred/batch01.jsonl      # 系统预测结果
  reports/batch01.md      # 合成管线基准测试报告（灵敏度/特异度/Wilson CI/McNemar）
  scripts/init-batch01.mjs # 初始化与审计落档脚本
  batch01-README.md       # 本说明文档
```

## 3. 独立药师双盲 SOP（真实临床必须遵守）

1. **系统盲法运行**：对脱敏处方集运行审方流水线（G1-G3 门控），输出写入 `pred/batch01.jsonl`；此阶段任何人不得向药师泄露预测结果。
2. **独立药师盲标**：2 位独立药师仅查阅脱敏处方原文（不看 AI 输出），按 `dimension` 词表（interaction/allergy/dose_renal/contraindication/special_population/duplicate_therapy）独立给出 Gold。
3. **分歧专家裁决**：当 2 位药师判定不一致时，由主任药师裁决终审 Gold，写入 `gold/batch01.jsonl`。
4. **统计分析**：`node plugins/medcius/evals/clinical-validation/run.mjs --gold gold/batch01.jsonl --pred pred/batch01.jsonl --out reports/batch01.md`
5. **样本量要求**：每维度 $\ge 100$ 例真阳性机会，总样本量 $\ge 300\sim 500$ 例。

脱敏要求：处方文本必须经过 `phiguard` 假名化，`subject_ref` 统一使用假名，审计链严格阻断任何身份证号、手机号、银行卡号等明文 PHI。

## 4. 运行基准测试

```bash
# 运行 300 例合成管线基准测试
node plugins/medcius/evals/clinical-validation/scripts/init-batch01.mjs --full-300

# 重新生成报告
node plugins/medcius/evals/clinical-validation/run.mjs --gold gold/batch01.jsonl --pred pred/batch01.jsonl --out reports/batch01.md
```

## 5. 审计追溯

每次批次执行均向本地审计链写入 `validation_batch_start` 与 `validation_batch_end` 事件，payload 中包含 `gold_sha256` 与 `pred_sha256`，确保指标与金标准数据文件的强关联与不可篡改可追溯性。
