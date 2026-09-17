# 中国技能 Golden Case 评测集（China-Skills Evals）

陷阱用例随 `cases/*.json` 计数。每个用例固定 `must / must_not` 断言，支持静态校验与 Agent 自评两种运行方式。

## 目录

```
plugins/medcius/evals/china-skills/
  cases/
    nhsa-coding.json            # 6：裸类目/.8≠.9/CCHI/版本未知/本地库停机/不确定诊断
    nhsa-policy.json            # 7：在目录≠报销/L3无出处/L4禁给数/省目录误解/限定范围/跨省/谈判药过期
    prescription-review.json    # 19：G1/G2/G3、样例、妊娠、重复用药、肾功能
    nmpa-and-trials.json        # 9：批准文号格式/无库不编文号/CTR 查库/默示许可不得冒充登记
    clinical-note-extract.json  # 12：过敏否定/家族史/疑似入院/入院≠出院/既往手术/拟行手术/阴性体征/预防≠诊断/化验≠并发症/排除心梗/门诊/肾功能单位
    record-quality.json         # 10：主诊断缺失/离院方式值域/住院天数代数/死亡文书一致性/性别-产科冲突/费用代数/限定支付关键词≠判定/年龄-新生儿冲突/关键词命中≠可报销/死亡文书不误报
  run.mjs                       # 运行器（本目录）
  results/                      # Agent 自评结果落盘（gitignore，可选）
```

## 运行

```bash
# 静态校验 + 确定性打分（写出 results/，给出通过率）
node scripts/run-evals.mjs

# 含本地库探针
node scripts/run-evals.mjs --with-corpus
```

`--grade` 用本地工具 + `parse-cn-note` 打分，不调用托管模型。`skip` = 需要 Agent 才能判的协议题。通过率看 `summary.pass_rate_graded`（仅已打分案）与 `pass_rate_all`（含 skip）。

## Agent 自评

静态校验只保证用例良构；要评估真实模型行为，让 Agent 对每个用例执行对应技能并对照 `must / must_not` 自评：

1. 对每个 case，按 `skill` 加载对应 SKILL.md；
2. 用 `input` 构造用户请求（必要时用本地 `drug-labels` 样例库做 G3 探针，`--with-corpus` 会先 `ingest --sample`）；
3. 逐条判断 `must` 是否全部满足、`must_not` 是否全部未触犯，输出 `pass/fail` 与证据摘录。

结果写 `results/<case-id>.json`，`run.mjs` 会在下一次运行时汇总通过率。

## 与上游的关系

- 病历抽取对抗集与 `clinical-note-extract/assets/china-notes/` 十份合成出院记录一一对应。
- 本集与 `prescription-review` 的 G3 直接联动：`check_interactions` 的 `no_mention_in_corpus / insufficient_data` 分支各有对应陷阱，确保“覆盖有限”永不被表述为“无相互作用”。

## 与 DHF 的关系

本目录的 cases 是合规意义上的**可验证需求源**：`node plugins/medcius/scripts/gen-dhf-trace.mjs --out docs/compliance/dhf/TRACEABILITY.md` 将全部用例转成 REQ 编号追溯矩阵。增删用例必须重跑生成器并随同一提交更新矩阵（见 `docs/compliance/dhf/SRS-CN-SKILLS.md` §3 维护纪律）。
