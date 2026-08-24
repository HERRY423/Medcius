# mcp-server-drug-labels — 本地药品标签库（Medcius-original）

本地 SQLite 药品说明书库：**版本化快照 + 逐对相互作用核对**。为 `prescription-review` 的 G2/G3 提供可追溯的离线证据面。

## 数据主权

- 默认：本库（`search_labels` / `get_label` / `check_interactions`）。
- 补充：NMPA 官网或用户导入的官方说明书 JSON。不调用托管 MCP。
- 真实审核仅可用 `data_class=official`；样例 `data_class=sample` 仅用于管线验证，G2/G3 必须拒判并显式标注。

## 工具

| 工具 | 用途 |
|---|---|
| `search_labels` | 按通用名/商品名/批准文号关键词检索 |
| `get_label` | 取单条完整 sections + provenance（`source_version/effective_date/snapshot_hash/ingested_at`） |
| `check_interactions` | 逐对：`mention_found` / `class_signal_found`（CYP 或分类）/ `no_mention_in_corpus` / `insufficient_data`，永不输出“无相互作用” |
| `validate_approval_format` | 只验国药准字格式，不证明在册 |
| `calc_renal` | 默认 `scrUmolL`（μmol/L）；`scrMgDl=88` 拒绝 |
| `list_snapshots` | 某批准文号的版本审计轨迹 |
| `corpus_status` | 语料库健康度（计数、sources、interaction_mentions） |

## 导入

本仓库不附带可再分发的 NMPA 说明书。官方包契约见 `assets/PACK.md` 与 `assets/official-pack.template.json`。

```bash
# 校验医院自有包（不写库）
node plugins/medcius/servers/drug-labels/scripts/validate-pack.mjs path/to/labels.json

# 导入医院自有 official 包
node plugins/medcius/servers/drug-labels/scripts/ingest.mjs path/to/labels.json

# 管线自检：合成样例（data_class=sample，禁止真实审核）
node plugins/medcius/servers/drug-labels/scripts/ingest.mjs --sample

# 查询验证
node --input-type=module -e "
import { HANDLERS } from './plugins/medcius/servers/drug-labels/src/tools.mjs';
console.log(HANDLERS.corpus_status({}));
"
```

`labels.json` 契约见 `scripts/ingest.mjs` 顶部注释与 `assets/sample-labels.json`。

## 存储

`$CLAUDE_MEDCIUS_DATA/drug-labels/data.sqlite`（默认 `~/.claude/data/medcius/drug-labels/data.sqlite`），WAL，`PRAGMA foreign_keys=ON`，`user_version=1`。重复导入按 `approval_number` 去重并追加快照；相互作用提及在每次导入后全量重算。

## 安全红线

- `no_mention_in_corpus ≠ 无相互作用`；`insufficient_data` 时必须转 `REQUIRES_PHARMACIST_REVIEW`。
- 样例库命中必须在输出中显式标注 `data_class=sample`。
- 未检索不得断言“未发现相互作用”（与 `prescription-review` G3 一致）。
