# 02 产品描述与降险架构（对应 2022-9号 核心功能/核心算法）

## 1. 系统架构（本地 stdio，无托管 MCP）

```
处方/病历文本 → phiguard.scan/redact → 技能门控判定 → audit.record_event (hash链) → signoff
                     ↑                         ↑
              production-guard (official>0)   本地语料库 (china-codes/drug-labels)
```

- MCP 仅本地 stdio：`china-codes` / `drug-labels` / `china-trials` / `documents` / `fhir` / `phiguard` / `audit`（`CLAUDE.md:4`）
- 不调用 `hcls.mcp.claude.com` / `pubmed.mcp.claude.com`（`validate-json.mjs` 校验）
- 数据落盘：`~/.claude/data/medcius/<component>/`，audit 库 `PRAGMA synchronous=FULL` + append-only 触发器

## 2. 核心功能分解

| 模块 | 输入 | 处理 | 输出 | 分类相关性 |
|---|---|---|---|---|
| 抽取 | 病历自由文本 | `parse-cn-note.mjs` + worker 抽取 + span校验 | 结构化字段（原文+span） | 不诊断，仅定位 |
| 编码 | 诊断/手术术语 | `search_codes` → `validate_code` → 六字段出处 | code/system/version/date/validation_status | 版本缺失则 unverifiable |
| 审方 | 处方 + 患者要素 + 官方标签 | G1(信息完整) G2(版本化证据) G3(逐对核对) 规则引擎 | 四态之一 + 证据清单 | LLM不生成结论句 |

## 3. 降险架构 D1-D5（`SAMD-PATHWAY.md:63-71` 已锁进代码）

| 决策 | 内容 | 代码/文档落点 | 验证 |
|---|---|---|---|
| D1 判定确定性 | PASS/FLAG 由规则引擎产生；LLM仅实体抽取与条文定位，不生成结论句 | `prescription-review/SKILL.md:17` | 人工评审 + 19 rx用例 |
| D2 输出封闭性 | 四态封闭；非PASS强制 signoff | `audit/src/tools.mjs:63-70` signoff | 审计链强制 |
| D3 预期用途措辞 | “供药师复核参考…不出具用药建议” | README 合规声明 + 02措辞 | `compliance-lint.mjs` 禁止“审方系统”自称 |
| D4 算法可解释 | 每条判定附六字段 + snapshot_hash | `drug-labels/src/tools.mjs:67-88` labelToHit | 抽取/编码均附 |
| D5 生成式隔离 | 审方意见自动起草独立模块、默认关闭、不进判定链 | 预留，不在本版本 | 新功能准入红线 |

## 4. 关键算法与公式

- 肾功能：Cockcroft-Gault（需 weightKg）+ CKD-EPI 2021（`drug-labels/src/calculators.mjs`），单位强制 μmol/L（88≠88mg/dL 拒绝，`check_interactions` 探针验证）
- 相互作用：`check_interactions` 三态 `mention_found / class_signal_found / no_mention_in_corpus`，后者永不转“无相互作用”（`prescription-review/SKILL.md:60-64`）
- 过敏/禁忌：`check_allergy` / `check_contraindication` 章节级筛查（禁忌/过敏/成分）
- 编码校验：`validate_code` 裸类目→pending，版本缺失→unverifiable

## 5. 版本与追溯

- 语料版本化：每条官方行携带 source_version/effective_date/snapshot_hash/ingested_at，缺失导入拒绝（`import-official.mjs:37-42`）
- 软件版本：`VERSION-NAMING.md` 发布版本/完整版本区分重大/轻微更新
- 需求追溯：53 REQ 自动生成 `TRACEABILITY.md`，compliance-lint 同步检查（`gen-dhf-trace.mjs`）

## 6. 已知局限（诚实披露）

- phiguard 不检测无标签裸姓名/住址等（`PRIVACY-SECURITY.md:39`）
- SQLite 非 SQLCipher 全库加密（字段级 AES-GCM 已提供 `shared/crypto.mjs`）
- 样例库仅 13 codes + 8 labels + 2 trials，覆盖极低，仅用于管线验证（`doctor.mjs` sample_counts）
