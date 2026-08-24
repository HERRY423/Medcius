# 回顾性临床验证框架（Retrospective Clinical Validation）

**目的**：在接触任何真实部署前，用脱敏历史处方量化 Medcius 审方判定 vs 药师金标准的一致性——产出灵敏度/特异度/PPV/NPV/F1 与 McNemar 不一致性检验。这是后续院内试点、器械注册资料、以及一切“落地”叙事的入场券。

## 目录

```
evals/clinical-validation/
  run.mjs                 # 指标计算 + 报告生成（本文件同目录执行）
  cases.sample.jsonl      # 合成演示金标准（8 例，仅演示格式）
  pred.sample.jsonl       # --demo 自动生成的预测（首次运行时创建）
  gold/                   # 真实项目放这里：药师盲法标注（gitignore）
  pred/                   # 系统对同一 case_id 集的自动判定输出
```

## 数据格式（JSONL，逐行一个维度判定）

```json
{"case_id":"rx-001","dimension":"interaction","predicted":"flag","gold":"flag"}
```

- `dimension` 自由字符串，建议统一词表：`interaction | allergy | dose_renal | contraindication | special_population | duplicate_therapy`
- `predicted/gold` 仅 `flag|clear` 二元；多级严重度先按“是否需干预”折算为二元
- 一张处方 → 多行（每个维度一行）；配对键是 `case_id+dimension`，与文件顺序无关

## 盲法 SOP（必须遵守）

1. **先跑系统**：对脱敏处方集运行 prescription-review，把每维度结论写入 `pred/*.jsonl`；此阶段任何人不得查看 gold 文件。
2. **药师独立标注**：药师只看处方原文（不看系统输出），按同一维度词表给出 gold。
3. **分析期才合体**：`run.mjs` 以 `case_id+dimension` 内连接配对；未配对预测被剔除并计数披露。
4. **样本量建议**：每维度 ≥100 例真阳性机会（否则灵敏度置信区间宽到无用）；报告应附 Wilson 区间（后续版本可加）。

## 运行

```bash
node plugins/medcius/evals/clinical-validation/run.mjs \
  --gold evals/clinical-validation/gold/batch01.jsonl \
  --pred evals/clinical-validation/pred/batch01.jsonl \
  --out  evals/clinical-validation/reports/batch01.md

# 自检（合成数据，验证管线本身）
node plugins/medcius/evals/clinical-validation/run.mjs --demo
```

## 输出解读纪律（写死在报告里）

- 审方场景**灵敏度优先**：漏报（c）比误报（b）危险；特异度低只增加药师复核负荷。
- McNemar `p<0.05` ⇒ 系统与药师存在系统性分歧，必须逐例归因：规则缺陷 / 本地语料覆盖缺口 / 标签版本过期。
- 回顾性、单中心结果**不构成**注册临床评价；器械路径见 `docs/compliance/SAMD-PATHWAY.md`。

## 与审计链的关系

验证批次本身也是事件：批次开始/结束各记一条 `record_event`（action=`validation_batch_start/end`），gold 文件的 sha256 写进 payload，保证“这份指标是用哪份金标准算出来的”可追溯、防篡改。
