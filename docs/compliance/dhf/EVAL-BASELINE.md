# 验证基线记录 · EVAL-BASELINE（2026-08）

> **性质**：确定性打分基线——验证 china-skills 陷阱用例的**协议可判定性**与本地工具链完整性。
> **不是**模型行为评测：26 例 `skip` 为协议题，必须由 Agent 加载技能后在环作答再判分（见 `evals/china-skills/README.md` Agent 自评节）。
> **在注册资料中的位置**：软件研究资料「验证与确认」章节的**工具链就绪证据**；不得作为性能宣称。

## 运行记录

| 项 | 值 |
|---|---|
| 命令 | `node scripts/run-evals.mjs --with-corpus`（含 `--grade`，`--with-corpus` 触发 drug-labels 样例库 ingest 探针） |
| 日期 | 2026-08-23 |
| 用例总数 | 53（5 文件：cne=12 / rx=19 / nhsa-coding=6 / nhsa-policy=7 / nmpa+trials=9） |
| 断言总数 | must 110 + must_not 64 = **174** |
| 确定性判等结果 | **pass 27 / fail 0 / skip 26** |
| pass_rate_graded | 27/27 = 100% |
| pass_rate_all | 27/53 ≈ 50.9%（skip 为需 Agent 的协议题） |

## 解读纪律（写死，防误用）

1. 本基线证明的是：**用例良构、本地判分器与语料探针工作正常、需求集可机器验证**；
2. `pass_rate_graded=100%` ≠ "系统准确率 100%"——真实行为指标只能来自 Agent 在环自评与后续回顾性验证批次；
3. 任何规则/提示词变更后必须重跑本命令并保持 graded 集零 fail；出现 fail 即阻断发布（对应 SRS MNT-02）。

## 下一步升级路径

- [x] Agent 在环自评首轮：53 例全量跑，产出首个行为通过率（见下节 R1）
- [x] 合成管线基准测试 batch01 冻结（300例合成）→ `evals/clinical-validation/reports/batch01.md` 已产出（总体灵敏93.1%/特异89.4%，仅管线与公式验证）+ audit seq2 verify OK；已冻结为 CI 自动化基准
- [x] 多中心 Shadow Mode 双药师盲标研究引擎建立 → `evals/shadow-mode/shadow-study.mjs` + 方案 `shadow-protocol.md`（双药师独立盲标 + 第三人专家裁决 + 中心/科室/药物类别分层）
- [ ] 回顾性/前瞻性多中心真实验证（≥300 张脱敏处方 × 独立药师双盲标，每维度≥100真阳）→ 由合作医院药师执行并替换合成 gold

## Round 1 · Agent 在环评测（2026-08-23）

### 运行方式

对确定性判等标 `skip` 的 26 例协议题，由 Agent 逐例执行：加载对应 SKILL.md → 以用例 input 构造用户请求 → 按文档协议推演应答 → 对照 must/must_not 判定；其中 6 例（rx-09/10/11/12/13 及 p05 关联路径）以**真实工具调用**定锚（check_allergy=hit、check_contraindication(活动性肝病)=hit、calc_renal→CrCl 38.8/moderate+renal_mentioned 减量摘录、pregnancy hit×5 信号、duplicate_generic）。结果写入 `results/*.json`（mode=agent），`run.mjs` 聚合。

### 结果

| 指标 | 值 |
|---|---|
| 总判等 | **53 pass / 0 fail / 53 scored** |
| pass_rate_all | **100%**（R1） |
| 确定性层 | 27/27（不变） |
| 协议层（本轮新增） | 26/26，逐例判定依据写入各 result 的 `evidence.basis` |

### 本轮真实发现（评测的副产品）

1. **覆盖缺口（rx-05）**：`check_duplicate_therapy` 对真实世界品名（对乙酰氨基酚片 × 复方感冒灵）返回 `insufficient_data/not_in_corpus`——重复成分信号只能来自处方文本自身标注而非工具。真实部署需官方说明书包导入后复测；样例库不含真实品种是预期行为。
2. policy-07（谈判药过期管理）的依据仅为 L2 节单行条文——够用但薄，建议扩充为独立小节。
3. 其余 24 例均有明确协议条款 + （适用时）工具行为双重支撑，未发现协议缺口。

### 方法论与局限（必须与数字同读）

- **本评测证明的是**：技能文档充分性（每个陷阱都有明文条款禁止对应失败模式）、门控设计一致性、工具返回值与协议语义兼容；
- **不证明**：任意模型在真实部署中的依从率与临床准确性。同一模型家族既执行又评分存在循环性，且协议遵循≠实际遵循；
- 临床性能结论的唯一合法来源仍是多中心 Shadow Mode 双药师盲标研究与后续注册临床评价；
- 重评触发条件：SKILL 规则、门控语义或输出模板任何变更后，R1 需全量重跑（对应 MNT-02）。

## Batch01 合成管线基准（2026-08-24 冻结）

- 命令：`node plugins/medcius/evals/clinical-validation/scripts/init-batch01.mjs --full-300`（生成 300 行合成 gold+pred → `run.mjs --gold gold/batch01.jsonl --pred pred/batch01.jsonl --out reports/batch01.md`）
- 配对样本：300（6 维度 ×50），合成灵敏度 93.1%/特异度 89.4%，报告**仅验证管线与统计公式**，不得作为临床性能宣称
- 审计：`validation_batch_start` seq1 + `validation_batch_end` seq2，`verify_chain` OK，gold_sha256 已入链
- 真实多中心盲标：按 `evals/shadow-mode/shadow-protocol.md` SOP 由独立药师双盲标注并裁决产生真实 Gold。
