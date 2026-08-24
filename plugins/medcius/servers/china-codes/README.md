# mcp-server-china-codes — 本地 NHSA 编码与目录库（Medcius-original）

**数据主权层**：本地 SQLite 编码库，版本化快照，显式出处。不依赖任何托管 MCP。核心中国编码工作流在 ingest 之后完全离线运行。

## 覆盖

- **医保版 ICD-10 诊断**（`code_system=医保版ICD-10`）
- **医保版手术操作**（`code_system=医保版手术操作分类`，ICD-9-CM-3 基础，不是 CCHI）
- **医保药品目录**（`code_system=医保药品目录`，甲/乙/谈判分类与限定支付范围）

## 工具

| 工具 | 对标远端 | 用途 |
|---|---|---|
| `search_codes` | `nhsa_codes/search_codes` | 按关键词检索诊断/手术编码 |
| `get_code` | `nhsa_codes/lookup_code` | 取单条完整编码 + provenance 六字段 |
| `validate_code` | `nhsa_codes/validate_code` | 校验编码完整性与版本可结算性 |
| `search_drug_catalog` | `nhsa_drug_catalog/get_drug_catalog` | 检索药品目录（类别、支付限制） |
| `corpus_status` | — | 库健康度、来源、版本快照审计 |

所有返回均含 `code_system/code_version/effective_date/retrieved_at/source/validation_status` 六字段；版本缺失时 `validation_status` 永远不为 `valid`。

## 导入

```bash
# 样例自检（约 60 条编码 + 20 条药品目录，data_class=sample）
node plugins/medcius/servers/china-codes/scripts/ingest.mjs --sample

# 官方数据（见 assets/README.md 的来源说明与 JSON 契约）
node plugins/medcius/servers/china-codes/scripts/ingest.mjs data/nhsa-codes.json
node plugins/medcius/servers/china-codes/scripts/ingest.mjs data/nhsa-drug-catalog.json
```

## 存储

`$CLAUDE_MEDCIUS_DATA/china-codes/data.sqlite`（默认 `~/.claude/data/medcius/china-codes/data.sqlite`），WAL，`user_version=1`。`unknown` 版本永远标 `pending/unverifiable`。

## 主权策略

- 技能层：仅本地 `china-codes` → 未命中则停止（不凭记忆编，不调用托管 MCP）。`validate_code` 的版本纪律由本地库强制执行。
- `search_codes` 返回本地命中与 `coverage_note`；未命中不代表全国无此码。
