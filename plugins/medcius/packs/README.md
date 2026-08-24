# 官方语料导入（医院自有，不随仓库分发）

P0 阻塞：样例库不能用于真实编码/审方。本目录只提供 **CSV 表头模板**。编码表、药品目录、说明书须由医院医保办/药学部从国家医保局公布文件或本院存档导入。

## 一次性检查

```bash
node scripts/doctor.mjs
```

`production.coding` 要 `china-codes.official > 0`；`production.review` 要 `drug-labels.official > 0`。全 0 时医生/编码员流程必须停在样例，不得当生产。

## 导入

把国家医保局或本院导出的表另存为 CSV（UTF-8），列名对齐 `templates/`，然后：

```bash
# 医保版诊断/手术编码
node plugins/medcius/scripts/import-official.mjs --kind codes --file codes.csv --source "国家医保局编码" --version "2024" --effective-date 2024-01-01

# 医保药品目录
node plugins/medcius/scripts/import-official.mjs --kind catalog --file catalog.csv --source "国家医保药品目录" --version "2024" --effective-date 2024-01-01

# 本院说明书摘录（见 servers/drug-labels/assets/PACK.md）
node plugins/medcius/scripts/import-official.mjs --kind labels --file labels.csv --source "本院药学部" --version "2024-01" --effective-date 2024-01-15

# 临床试验摘录（可选）
node plugins/medcius/scripts/import-official.mjs --kind trials --file trials.csv --source "chinadrugtrials 摘录" --version "2024" --effective-date 2024-01-01
```

省级待遇（L3）放进编码 JSON 的 `benefits` 数组，或与 codes 包一并 ingest。无官方省包则 L3 待核。

JSON 包同样可用：`--file pack.json`（形状与各 server 的 ingest 契约一致）。

病历焊死编码：`node scripts/settlement-from-note.mjs 出院记录.md --out out/`

官方行缺少 `source_version` / `effective-date` 时导入拒绝。不要把真实说明书提交进 git。

## 列名别名（Excel 导出可直接用）

**codes.csv：** `诊断编码|编码|code`，`诊断名称|名称|name`，`code_type`（diagnosis/procedure，默认 diagnosis），`code_system`（默认 医保版ICD-10；手术用 医保版手术操作分类）

**catalog.csv：** `通用名|药品名称|generic_name`，`甲乙类|类别|category`（甲类/乙类/谈判），`限定支付范围|payment_restriction`

**labels.csv：** `通用名|generic_name`，`批准文号|approval_number`，`适应症`，`用法用量`，`禁忌`，`药物相互作用`，`source_version`，`effective_date`
