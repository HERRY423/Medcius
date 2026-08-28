# 公开基准数据集适配层（Public Benchmarks Adapter）

> **用途**：为 CCKS/CHIP 等公开中文医疗评测数据集接入 Medcius 评测体系提供**统一适配契约与转换器骨架**。数据集本身不进 git（许可与体积原因），下载后由本目录转换器映射为 `evals/china-skills` 用例格式。
> **证据层级**：公开基准数据集来自真实标注语料，但其**许可条款通常仅限研究用途**，且与本院工作流分布不同。因此本层结果记为 \`public_benchmark_pass\`（外部参考一致性），**同样不属于临床证据**，不得写入注册申报的临床评价章节。
> **状态**：框架就绪；各数据集待下载后逐个启用。

## 1. 目标数据集清单

| 数据集 | 任务 | 对接技能 | 许可要点 [待核] | 状态 |
|---|---|---|---|---|
| CCKS 2017 临床命名实体识别 | 病历文本 NER（解剖部位/手术/药物/实验室检查） | clinical-note-extract | 需确认研究用途许可与引用要求 | 框架就绪，待下载 |
| CHIP-CDN 临床术语标准化 | 诊断原词 → ICD-10 标准词 | nhsa-coding / china-codes | 同上 | 框架就绪，待下载 |
| Yidu-N7K（如有需要） | 电子病历NER | clinical-note-extract | 商用限制需逐条核查 [待核] | 未启动 |

## 2. 目录约定

```text
public-benchmarks/
  README.md               # 本文件
  convert-ccks-ner.mjs    # CCKS NER → china-skills 用例转换器（数据缺失时优雅退出）
  data/
    raw/                  # 手动放置的原始下载数据（.gitignore，禁止提交）
    converted/            # 转换产物（同样不入 git，含派生数据）
```

**红线**：原始数据与其派生转换产物一律不入 git。若任何数据样本可能包含可识别个人信息，必须先通过 PHI Guard 审查并记录审查结论。

## 3. 转换器契约

每个 `convert-*.mjs` 必须：

1. 输入：`data/raw/<dataset>/` 下官方发布格式文件；
2. 输出：`data/converted/<dataset>.cases.json`，条目结构与 `evals/china-skills/cases/clinical-note-extract.json` 一致（id/skill/trap/title/input/must/must_not），其中：
   - `must` 由数据集 gold 标注自动生成（如「抽取出的药物实体须包含 X」）；
   - `must_not` 固定加入防泄漏项：「输出中不得出现原始标注 span 之外的患者可识别信息」；
3. 数据文件缺失时打印启用指引并以退出码 0 结束（不阻塞 CI）；
4. 转换完成后打印统计（样例数、实体类型分布）供人工抽检。

## 4. 启用流程（每个数据集）

1. 从官方渠道下载并解压至 `data/raw/<dataset>/`；
2. 核对许可条款，把结论写回 §1 表格的许可要点列；
3. 运行对应转换器，人工抽查 ≥10 条转换产物；
4. 在本地运行 `node scripts/run-evals.mjs --cases data/converted/<dataset>.cases.json` 验证打分链路；
5. 结果报告归档至本目录 `reports/`，并在 `REG-ACTION-TRACKER.md` 登记为工程级外部参考验证。
