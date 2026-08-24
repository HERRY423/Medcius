# 官方说明书包（hospital-owned ingest）

本仓库**不附带、不可再分发** NMPA 说明书全文。G2 要用 `data_class=official`，必须由医院药学/信息科提供自有语料。

## 合法来源（须医院有权使用）

1. 医院药品目录对应的现行说明书（药学部门存档 PDF/Word，自行抽章节）
2. 国家药品监督管理局数据查询栏目，按本院品种手工导出后填入 JSON
3. 医院合理用药系统导出（合同允许的院内使用）

不要爬取 NMPA 网站批量入库，不要把官方说明书提交进本 git 仓库。

## 契约

见 `official-pack.template.json`。每条 **official** 记录必须有：

| 字段 | 要求 |
|---|---|
| `generic_name` | 通用名 |
| `approval_number` | 国药准字… |
| `sections` | 至少含 适应症、用法用量、禁忌、药物相互作用 之一 |
| `source_version` | 说明书修订日期或版本 |
| `effective_date` | ISO 日期 |
| `data_class` | `official` |
| `source.name` / `source.url` | 包级来源（医院内部编号或 NMPA 查询页） |

缺 `source_version` 或 `effective_date` 的 official 记录 **ingest 拒绝**。

## 命令

```bash
# 校验契约（不写库）
node plugins/medcius/servers/drug-labels/scripts/validate-pack.mjs path/to/labels.json

# 导入（写入 $CLAUDE_MEDCIUS_DATA/drug-labels）
node plugins/medcius/servers/drug-labels/scripts/ingest.mjs path/to/labels.json

# 仅样例（禁止真实审核）
node plugins/medcius/servers/drug-labels/scripts/ingest.mjs --sample
```

导入后 `corpus_status` 的 `official` 须 >0，审方 G2 才可对命中品种给安全性结论。未命中品种仍是 `INSUFFICIENT_DATA`，不得用记忆补批准文号。
