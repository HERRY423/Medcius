---
name: nmpa-drugs
description: 用本地药品标签库核对批准文号格式与说明书摘录。本地没有 NMPA 注册全库，也没有 search_drugs/get_drug_label/validate_drug 连接器。无本地命中且无官网原文时停止，不得用记忆填写批准文号或 OTC 分类。当用户说"这个药有批文吗"、"查说明书"、"处方药还是OTC"、"药品批准文号"时使用。
---

# NMPA 药品信息（本地说明书库，不是注册全库）

本技能**不是**国家药品监督管理局注册数据库客户端。插件未提供 `search_drugs` / `get_drug_label` / `validate_drug` 等远端工具；宣称这些工具可用会导致模型在连接失败后用记忆填批准文号（审方 G2 事故）。

本地 `drug-labels` 只存**已 ingest 的说明书摘录**。未收录 ≠ 全国无此批准文号。

## 第一步：盘点能用的证据

1. 调 `corpus_status`。`official=0` 时真实查询只能停或转官网，样例库命中必须标 `data_class=sample`。
2. `search_labels` / `get_label` 按通用名、商品名、批准文号检索。
3. `validate_approval_format` **只验格式**（国药准字 + H/Z/S/J + 8 位）。`exists` 恒为未验证，不得把格式正确说成「在册」。
4. 本地未命中 → 打开 https://www.nmpa.gov.cn 数据查询/说明书原文，摘录并标注检索日期。
5. 本地与官网都拿不到 → **停止**。输出 `INSUFFICIENT_DATA`。禁止凭记忆写批准文号、生产企业、OTC/处方药分类、适应症。

## 第二步：查询要点

- 通用名为主，商品名为辅。
- 国产：`国药准字` + H/Z/S/B + 8 位数字。进口分装：`国药准字J` + 8 位。进口注册证号与国产文号不得混校验。
- 批准文号有效期 5 年、再注册、召回：无当前官网/标签日期则标待核，不默认长期有效。

## 输出

```
【药品信息】（仅证据中出现的字段）
通用名：…
批准文号：…（来源：本地 label_id=… / NMPA 页面日期；格式校验：ok|fail）
分类：rx|otc|unknown（来源同上；无来源则不写）
data_class：official | sample | not_in_corpus
source_version / effective_date：…

【说明书摘录】有则摘，无则写未收录
【结论】命中 | 仅格式 | 未收录须官网 | INSUFFICIENT_DATA
```

无证据字段留空，不编造。样例命中必须写「仅管线验证，不得用于真实审核」。

## 红线

1. 不调用、不假设存在 NMPA 托管 MCP。
2. 格式正确 ≠ 国家局在册。
3. 未检索不得给批准文号。
4. 官方包须医院自有 ingest（见 `servers/drug-labels/assets/PACK.md`），本仓库不附说明书全文。
