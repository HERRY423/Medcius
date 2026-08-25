---
name: china-clinical-trials
description: 用本地临床试验登记摘录库查询 CTR/药品/适应症。不是 chinadrugtrials.org.cn 全库。未命中则打开官网；打不开就停止，不得编造方案、终点或中心。当用户说"查中国的临床试验"、"CTR 登记号"、"这个药的临床试验在哪里做"时使用。
---

# 中国药物临床试验（本地摘录库）

本技能先查本地 `china-trials` MCP，再在需要时打开官方平台。没有 `search_trials` 远端托管连接器。法规背景（默示许可 60 个工作日、I 期 3 年未启动须重申）只能作为**注释**，不能代替一条登记记录。

## 流程

1. `corpus_status`。仅样例时，查询结论必须标 `data_class=sample`。
2. 用户给了 CTR：先 `validate_ctr_format`。格式失败（如 `CTR2025`）立即指出，不把残号当有效登记。
3. 格式通过：`get_trial`。`not_in_corpus` → 打开 https://www.chinadrugtrials.org.cn 检索；无法打开 → **停止**，不编造试验名称/分期/中心/终点。
4. 按药品或适应症：`search_trials`。零命中同样转官网或停止。
5. 输出必须带 `data_class`、`source_version`、本地或官网来源。样例禁止当作平台全库。

## 输出

```
【临床试验】
CTR：…（格式：ok|fail）
状态：本地命中 | not_in_corpus | 官网摘录 | INSUFFICIENT_DATA
title / 药品 / 适应症 / 分期 / 试验状态 / 申办者（仅证据字段）
data_class：official | sample
```

## 红线

1. 不把格式课或默示许可条文当成某 CTR 的登记内容。
2. `not_in_corpus` ≠ 全国未登记。
3. 官方登记包须自行 ingest；本仓库只带合成样例。
