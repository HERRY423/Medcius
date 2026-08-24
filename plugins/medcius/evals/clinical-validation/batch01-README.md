# batch01 回顾性验证批次 — 使用说明（P0 阻塞解法）

> **状态**：演示批次已跑通（120例合成，报告 `reports/batch01.md`，审计 seq 1-2 已落库）。真实医院批次需按本说明替换 gold。

## 1. 解决什么 P0

- **无 batch01 → 无采购验收/注册临床评价依据**：医院 AI 准入要求 ≥300份历史病历预测试（`EVIDENCE-PRIOR-ART.md:29`），本批次提供“即插即算”的框架与盲法 SOP。
- **合成演示仅为管线验证**，不可作为性能宣称；真实结论以药师盲标为准。

## 2. 目录（真实批次与演示共用）

```
evals/clinical-validation/
  gold/batch01.jsonl      # 药师盲标金标准（真实）— 当前为合成占位，需替换
  pred/batch01.jsonl      # 系统预测（先跑系统得，再给药师标金标准）
  reports/batch01.md      # 灵敏度/特异度/McNemar 报告
  scripts/init-batch01.mjs # 初始化与审计落档脚本
  batch01-README.md       # 本文件
```

## 3. 盲法 SOP（必须遵守，防循环论证）

1. **先跑系统**：对脱敏处方集运行 `prescription-review`（G1-G3 门控），每维度输出写 `pred/batch01.jsonl`；此阶段任何人不得查看 gold。
2. **药师独立标注**：药师只看处方原文（不看 pred），按 `dimension` 词表（interaction/allergy/dose_renal/contraindication/special_population/duplicate_therapy）给出 gold，写入 `gold/batch01.jsonl`。
3. **分析期合体**：`node plugins/medcius/evals/clinical-validation/run.mjs --gold gold/batch01.jsonl --pred pred/batch01.jsonl --out reports/batch01.md`
4. **样本量**：每维度 ≥100 真阳性机会（否则灵敏度置信区间无意义）；总量 300-500 为宜，`--full-300` 已预设 6×50=300。

脱敏：处方文本先过 `phiguard redact/pseudonymize`，`subject_ref` 用假名，审计链拒绝身份证/手机号原文。

## 4. 演示批次（已就绪）

```bash
# 120例演示（当前已生成）
node plugins/medcius/evals/clinical-validation/scripts/init-batch01.mjs

# 300例预测试（满足医院准入）
node plugins/medcius/evals/clinical-validation/scripts/init-batch01.mjs --full-300

# 仅算报告（真实金标准替换后）
node plugins/medcius/evals/clinical-validation/run.mjs --gold gold/batch01.jsonl --pred pred/batch01.jsonl --out reports/batch01.md
```

演示报告已产出：灵敏度 92.1% / 特异度 93.9%（合成数据，仅验证公式与审计链）。

## 5. 审计追溯

每次批次开始/结束各记一条 `audit.record_event`（action=validation_batch_start/end），payload 含 gold_sha256，确保“哪份指标用哪份金标准”可追溯。演示已落 seq 1-2，verify_chain OK。

## 6. 替换为真实处方

- 保留 `gold/batch01.jsonl` 与 `pred/batch01.jsonl` 的 `{case_id, dimension, predicted, gold}` 结构；
- 真实 `gold` 的 `gold` 字段为药师判定，`pred` 的 `predicted` 为系统判定；
- 替换后重跑 `run.mjs`，报告自动更新，审计链追加新批次事件。
