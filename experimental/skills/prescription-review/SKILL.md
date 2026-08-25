---
name: prescription-review
description: 证据门控的处方审核（Evidence-Gated Prescription Review）——依据《处方管理办法》《医疗机构处方审核规范》审核处方，判定唯一结论 PASS / FLAG / INSUFFICIENT_DATA / REQUIRES_PHARMACIST_REVIEW。三道硬门控：缺关键患者信息不得PASS；无实时版本化药品证据不得给安全性确定结论；相互作用未实查不得输出"未发现相互作用"。当用户说"审核这个处方"、"处方点评"、"这个处方合理吗"、"用药合理性审核"时使用。
---

# 中国医院处方审核（Evidence-Gated Prescription Review）

**这是证据门控的审核协议，不是"凭经验点评"。** `corpus_status.production_ready` 为 false（无 official 说明书）时不得 PASS。先 `node scripts/doctor.mjs`。处方审核直接关系患者安全：

- **没有证据 → 不给确定结论**；**信息不全 → 不猜**。
- 审核依据《处方管理办法》（卫生部令第53号）与《医疗机构处方审核规范》（国卫办医发〔2018〕14号），由药师负责审核；本技能是**辅助与门控协议**，不替代药师。

## 监管定位（分类界定锚点，改动需过合规评审）

本技能的注册叙事（见 `docs/compliance/SAMD-PATHWAY.md` §3.3）依赖以下架构事实，任何改动都可能改变医疗器械分类判定：

1. **LLM 无判定权**：模型仅做实体抽取与条文引用定位；PASS/FLAG 由规则引擎（说明书条文匹配 + 剂量公式 + 相互作用核对结果）产生。禁止让模型生成结论句或治疗建议文本。
2. **输出封闭**：结论只有四选一状态码；所有非 PASS 强制进入药师 `signoff` 闭环。
3. **预期用途措辞**：「供药师复核参考的信息系统辅助工具，不出具用药建议，不替代药师审核」。对外文档不得表述为"审方系统/审方软件"。

## 判定输出（唯一结论，四选一）

| 判定 | 含义 |
|---|---|
| **PASS** | 三道门控全部满足、未发现可定性的问题、且无需要药师复核的项 |
| **FLAG** | 发现明确问题（有证据可定性：适应症不符、超说明书剂量、重复用药、配伍禁忌、相互作用、禁忌症等） |
| **INSUFFICIENT_DATA** | 因缺关键患者信息或实时药品证据而**无法判定** |
| **REQUIRES_PHARMACIST_REVIEW** | 存在需要药师专业判断的事项（特殊人群剂量调整、抗菌药物会诊、相互作用需人工核对、特殊管理药品、中药辨证等） |

结论必须且只能是一个，不可模糊输出"可能合理"。

## 三道硬性门控（Gate）

### G1 患者信息完整性门控
**缺关键患者信息 → 不得 PASS。** 不得假设缺失信息为"无异常"。

关键信息（按处方药品而定，至少含）：
- **年龄**（儿童/老年剂量调整）
- **体重**（按体重给药，尤其儿童）
- **肝、肾功能**（影响经肝肾代谢/排泄的药物）
- **妊娠/哺乳状态**（育龄女性）
- **过敏史**
- **明确的临床诊断**（核对适应症）

任一关键信息缺失且影响本处方判断 → 对应维度只能为 `INSUFFICIENT_DATA` 或 `REQUIRES_PHARMACIST_REVIEW`。

### G2 实时/版本化药品证据门控
**没有实时、版本化、可追溯的药品证据 → 不得给"安全性确定"结论。**

- 每个药品的 说明书/禁忌/相互作用 依据，必须来自**本次检索的当前版本**，按此优先级并记录**来源与版本/日期**（不调用托管 MCP）：
  1. 本地药品标签库 `本地药品标签库 (Local Drug Labels)` 的 `search_labels` → `get_label`（返回 `source_version/effective_date/snapshot_hash/ingested_at`；`data_class=sample` 禁止用于真实审核）
  2. 国家药品监督管理局官网或随药品包装的现行说明书原文（联网检索，标注出处与日期）
- 均不可用或均为样例/过期 → 该药品 G2 不满足，**不得**用于"安全性确定"判断 → 该维度为 `INSUFFICIENT_DATA` 或 `FLAG`；样例库命中必须标注 `data_class=sample，仅管线验证`
- 证据获取失败时如实标注，不硬凑

### G3 相互作用查询门控
**药物相互作用未实际查询 → 不得输出"未发现相互作用"。**

- 相互作用必须**逐对药品实际核对**，按此优先级：
  1. 说明书"相互作用"章节原文（来自 G2 已取到的版本化证据）
  2. 本地药品标签库 `check_interactions`（`mention_found` / `class_signal_found`（CYP 底物×抑制剂或分类标记，药名未互现）/ `no_mention_in_corpus` / `insufficient_data`；后两者不得断言无相互作用；`class_signal_found` → FLAG 或 REQUIRES_PHARMACIST_REVIEW）
  3. 现行说明书「相互作用」原文（官方网页）；无则不得断言无相互作用
- 返回 `insufficient_data` 或 `no_mention_in_corpus` 时，相互作用维度只能为 `REQUIRES_PHARMACIST_REVIEW`（或已发现明确相互作用时为 `FLAG`），**不得写"未发现相互作用"**；样例库结果需标注 `data_class=sample`
- 本地库覆盖有限，`no_mention_in_corpus` 必须保留原文摘录与覆盖免责声明一并呈现

## 审核流程

### 第一步：采集与盘点
- 处方信息：患者（性别/年龄/体重）、诊断、药品（通用名/剂型/规格/用法用量）、处方日期
- 逐药列出：通用名、剂型、规格、单次剂量、频次、途径、疗程
- **检查 G1**：哪些关键患者信息缺失？是否影响本处方判定？

### 第二步：逐药证据检索（G2）
- 对每个药品检索**当前版本说明书**：① 本地药品标签库 `search_labels`/`get_label`（先 `corpus_status`；`include_samples` 默认 false）→ ② NMPA 官网/现行说明书原文；逐条记录来源、版本/批准日期、检索时间、`data_class`/`snapshot_hash`
- 逐药核对：适应症与诊断、剂量（按说明书/体重/肾功能调整）、给药途径、禁忌症
- **检查 G2**：证据是否实时、版本化、可追溯且非样例？没有 → 该药安全性项不得定为"确定"；命中样例时输出必须标注 `data_class=sample` 并保持门控不通过

### 第三步：跨药检查（本地标签库闭环）

本地药品标签库 `Local Drug Labels` 已扩展为**完整安全闭环**（均支持 `include_samples` 显式控制，真实审核禁用样例）：

- **重复用药**：`check_duplicate_therapy`（`drugs=[...]`，同通用名命中 `duplicate_generic`，名称包含则 `possible_duplicate`；`no_duplicate_detected` 仅为字面比对，同类作用仍需药师判断）
- **相互作用（G3）**：`check_interactions`（`mention_found / no_mention_in_corpus / insufficient_data`；后两者不得断言"无"，必须转 REQUIRES_PHARMACIST_REVIEW；保留 `excerpts/coverage_disclaimer`）
- **过敏**：`check_allergy`（`allergies=[...], drugs=[...]`，命中禁忌/过敏/成分章节则 `hit`→FLAG；`no_mention_in_corpus / no_allergy_section` 需药师复核）
- **禁忌**：`check_contraindication`（`conditions=[...], drugs=[...]`，对"禁忌/注意事项/警告"章节筛查；`hit`→FLAG）
- **肾功能**：`check_renal_dosing`（`drugs + crcl/egfr`，结合 `calc_renal` 的 CrCl/eGFR 分桶比对标签"特殊人群/用法用量"中肾相关摘录；`renal_mentioned` vs `no_mention`）
- **特殊人群**：`check_special_population`（`population=pregnancy|lactation|children|elderly|hepatic`，筛查对应信号词）
- **计算器**：`calc_renal {age,weightKg,scrUmolL,sex}`（中国检验单默认 **μmol/L**；`scrMgDl` 仅当单位确实是 mg/dL 且 ≤15。把 88 当 88 mg/dL 必须拒绝）与 `calc_dose`
- **安全表一次筛**：`safety_screen {drugs, allergies, encounter, days_supply}` → ATC/成分、青霉素↔头孢交叉过敏、输液配伍、抗菌分级、麻精限量、十八反。表内命中 FLAG；未命中 ≠ 无风险。本工具是事后辅助，不是 HIS 开医嘱拦截。
- 病历中有血肌酐 μmol/L：先 `parseLabs` / 抽 `labs` 再 `calc_renal {scrUmolL}`，禁止把 88 当 mg/dL。

建议执行顺序：`corpus_status` → `safety_screen` → `calc_renal`（如有 Scr）→ `check_duplicate_therapy` → `check_interactions` → `check_allergy` → `check_contraindication` → `check_renal_dosing` → `check_special_population` → 汇总判定。

### 第四步：判定（四选一）
判定逻辑（按优先级）：
1. 任一 G 门控不满足 → 对应维度 `INSUFFICIENT_DATA` 或 `REQUIRES_PHARMACIST_REVIEW`
2. 存在可定性问题（有证据）→ `FLAG`
3. 有需药师判断的项 → `REQUIRES_PHARMACIST_REVIEW`
4. 全部满足且无问题 → `PASS`
5. **中药处方**：需辨证论治、十八反十九畏，通常至少 `REQUIRES_PHARMACIST_REVIEW`

## 输出格式

```
【判定】PASS | FLAG | INSUFFICIENT_DATA | REQUIRES_PHARMACIST_REVIEW

【处方信息】
患者：×××（男，45岁）｜ 诊断：2型糖尿病 ｜ 处方日期：××
药品：二甲双胍片 0.5g×60片，口服 0.5g bid

【门控状态】
G1 患者信息：完整 / 缺失（列出缺失项）→ 是否影响判定
G2 药品证据：各药 来源/版本/检索时间 → 是否实时版本化
G3 相互作用：已逐对核对（来源）/ 未核对 → 不得断言"无"

【审核发现】（每项：结论 + 证据来源/版本）
1. 适应症：...（依据：说明书版本/日期）
2. 用法用量：...（依据：说明书/体重计算）
3. 相互作用：核对结果，或"需药师核对"
4. 特殊人群：...
5. 特殊管理药品：...

【依据清单】
- 每项结论背后的说明书版本 / 指南 / 法规文号
```

> 输出纪律：判定唯一；每一维度给出结论来源；无法确定的维度如实写"无法判定/需药师核对"，不用模糊语言掩盖。

## 落档与隐私（不可跳过）

1. **隐私前置**：任何含患者信息的自由文本进入日志/审计/导出前，必须经 `PHI 卫士 (PHI Guard)` 的 `scan` → `redact` 或 `pseudonymize`；`subject_ref` 用假名（如 `[PSN:*]` 或机构 MRN 映射）。
2. **判定落档**：每次审核通过 `本地审计链 (Local Audit Chain)` 的 `record_event` 记录——`action="rx_review_verdict"`，payload 含：四选一判定、G1–G3 状态、每条证据的 `snapshot_hash/source_version/data_class`、所用工具清单。审计链会**自动拒绝**身份证/手机号原文。
3. **签核闭环**：`REQUIRES_PHARMACIST_REVIEW` 与 `FLAG` 项由药师在审计链 `signoff`（agree/override/reject + 理由）；未签核批次不得视为完成。
4. **完整性巡检**：定期 `verify_chain`；对外提供材料用 `export_batch`（附 head_hash 供独立复核）。

## 不可协商（医疗安全红线）

1. **缺关键患者信息 → 不得 PASS**（不假设缺失 = 正常）
2. **无实时版本化证据 → 不得"安全性确定"**
3. **相互作用未查 → 不得写"未发现相互作用"**
4. **结论唯一，四选一**（PASS / FLAG / INSUFFICIENT_DATA / REQUIRES_PHARMACIST_REVIEW）
5. **处方审核是药师法定职责**，本技能是辅助与门控协议；任何确定性结论都要能回答"依据是什么、版本是什么、何时取到"
6. **判定必落档、原文不落档**：无审计链环境时如实告知"本次判定未留痕"；PHI 原文（身份证/手机号/无脱敏姓名）永不进入日志或导出
