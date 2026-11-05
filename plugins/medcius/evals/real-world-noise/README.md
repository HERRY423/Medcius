# 真实世界鲁棒性评测（Real-World Robustness Evals）· 缺口二量具

> 目标：在真实脱敏病历到位**之前**，先给解析/抽取层一个可复现的脏数据下限；真实数据到位后，用**同一把量具**直接测真实基线。工程/合成/真实三层证据纪律不变——本目录的数字是鲁棒性保持率，不是临床证据。

## 组成

```
plugins/medcius/evals/real-world-noise/
  noise-models.mjs             # 7 个确定性、带种子的噪声模型（见下表）
  grader.mjs                   # 与 china-skills gold 语义一致的现场评分器
  run-noise-benchmark.mjs      # CI 门（第 40 步）：clean=100% + combined ≥ 下限绊线 + 字节级确定性
  ingest-real-data.mjs         # 显式合成/真实身份；真实输入另须 manifest、患者划分与标注设计声明
  reports/noise-robustness-baseline.md|.json   # 自动生成基线（--out 重生成）
  README.md
```

## 噪声模型（模拟真实病历的六类失败模式）

| 模型 | 模拟的现实失败模式 | 基线保持率（2026-08-30） |
|---|---|---|
| heading_variants | 非标标题：`【出院诊断】`/`出院诊断:`/`出院时诊断:`/`手术/操作:`/`查体:` | 100% |
| whitespace_chaos | 换行丢失、全角空格、段落粘连 | 96.7% |
| section_reorder | 段落乱序（导出/粘贴） | 100% |
| ocr_confusion | 扫描件 OCR 字符混淆（己/已、末/未、0/O…） | 100% |
| abbreviation_dialect | 临床缩写方言（COPD/AECOPD/房颤/LC术）与日期性别书写 | 73.3% |
| scan_artifacts | 页码、分隔线、水印等扫描伪影 | 100% |
| combined | 全部叠加 | **70.0%**（下限绊线 65%） |

## 本基准已经产出并修复的解析层缺口（parser hardening）

1. 非标标题归一表（`SECTION_ALIASES`）+ `【】`括号标题 + 行内标题切分——heading_variants 7% → 100%；
2. 手术栏"无/未"前缀判定容忍扫描伪影——scan_artifacts 90% → 100%；
3. **结构性边界（不修）**：缩写方言（LC术=腹腔镜胆囊切除术）需要术语词典或 LLM 抽取层，确定性解析器不凭词典推断临床同义，避免极性翻转风险——这正是 `clinical-note-extract` 技能（LLM 抽取 + 人工复核）存在的意义，也是真实数据量测的必要性所在。

## 真实数据到位后怎么用（合作医院流程）

```bash
# 仅在另行批准的院端数据处理边界内运行；此处是模板，不表示研究已启动
node plugins/medcius/evals/real-world-noise/ingest-real-data.mjs real-notes.jsonl --manifest reviewed-intake.json --report reports/real-baseline.md

# 合成探针须明确身份，不得将其输出标为真实临床证据
node plugins/medcius/evals/real-world-noise/ingest-real-data.mjs synthetic-notes.jsonl --synthetic --report reports/synthetic-replay.md
```

fail-closed 门：缺脱敏声明、全记录 PHI 扫描命中、重复记录、空或不可评分 gold 均拒绝；真实数据还核对 manifest 与数据集哈希绑定、患者开发/评测划分、source-first 双标注设计声明。`--synthetic` 与 `--manifest` 不可同时使用。错误不回显原始病历、gold、用户 note_id 或解析器异常片段。

清单引用与脱敏声明不证明真实授权、完全去标识化或医师标注独立性。真实回放输出采用 `DECLARED_RETROSPECTIVE` / `DECLARED_PROSPECTIVE_SHADOW`，不把多份病历计为独立患者，不自动生成伪独立的准确率区间。完整字段与迁移说明见[本地化修复报告](../../../../docs/engineering/CHINA-LOCALIZATION-HARDENING-2026-11-02.md)。

## 解读纪律

- 数字是"字段抽取保持率"，衡量解析层鲁棒性；不衡量临床准确性，不构成注册证据；
- combined 下限绊线只能随解析器鲁棒性提升而**上调**，禁止为了让变更通过而下调；
- `clean=100%` 是硬门：任何下降即解析层回归（china-skills 确定性评测同步把关）。
