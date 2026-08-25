# 处方前置审方 Agent 工作流 (Prescription Review Workflow Recipe)

## 1. 触发条件 (Trigger Context)
- 医生在 HIS/EMR 下达门诊/住院电子处方；
- 药房药师发起前置审方或人工复核；
- HL7 FHIR CDS Hooks `medication-prescribe` 钩子请求到达。

---

## 2. 拓扑与工具调用序列 (Execution Topology)

```
[原始处方上下文]
       │
       ▼
[Step 1: PHI 脱敏与守卫] ───► phiguard:scan + phiguard:pseudonymize
       │
       ▼
[Step 2: Gate 1 患者要素完备性校验]
       │
   [要素完备?] ──── NO ───► 输出 INSUFFICIENT_DATA ──► audit:record_event ──► 结束
       │ YES
       ▼
[Step 3: Gate 2 药品标签检索与版本锁定] ───► drug-labels:search_labels + get_label
       │
   [全在库?] ──── NO ───► 标记 no_label_in_corpus ──► 输出 REQUIRES_PHARMACIST_REVIEW
       │ YES
       ▼
[Step 4: Gate 3 全维度安全性矩阵筛查] ───► drug-labels:safety_screen
       │
   ├─► 过敏筛查 (check_allergy, 重点青霉素-头孢交叉)
   ├─► 相互作用 (check_interactions, CYP3A4 + 中药十八反十九畏)
   ├─► 禁忌证 (check_contraindication)
   ├─► 肾功能给药 (calc_renal [Cockcroft-Gault / CKD-EPI, 严格 μmol/L] + check_renal_dosing)
   ├─► 重复用药 (check_duplicate_therapy, 含对乙酰氨基酚复方感冒药)
   └─► 特殊人群 (check_special_population, 儿童缺体重/妊娠/哺乳/高龄)
       │
       ▼
[Step 5: 结构化判定裁决与证据生成]
       │
   ├─► 无任何风险 ──► 裁决 PASS
   └─► 触发任一风险 ──► 裁决 FLAG (汇总所有理由与条文引用)
       │
       ▼
[Step 6: 不可篡改审计存证] ───► audit:record_event (携带 trace_ref) + audit:signoff 待签
```

---

## 3. 分步执行指令与参数规范

### Step 1: PHI 脱敏 (Privacy First)
- **调用工具**: `phiguard:scan`, `phiguard:pseudonymize`
- **输入**: 包含患者姓名、身份证、电话、病历号、床号等自由文本或对象。
- **输出**: `anonymized_payload`，患者标识符转换为 `[PSN:hash]` 假名形式。
- **纪律**: 严禁将含有明文个人身份信息 (PII/PHI) 的上下文传递给后续工具或大模型上下文。

### Step 2: Gate 1 患者参数完备性门控
- **检查逻辑**:
  - `age_years` / `age_months` 必须存在；
  - 若 `age_years < 14` 或 `age_months < 168`（儿科）：**`weight_kg` 必须非空且 > 0**；
  - 若处方包含肾毒性/肾排泄药物（如万古霉素、氨基糖苷类、甲氨蝶呤、新型口服抗凝药）：**`creatinine_umol_l` 必须非空**；
  - `diagnoses` 诊断列表必须存在；
  - `allergies` 过敏史列表必须明确（若无过敏史需显式标为 `["无已知药物过敏"]`，不得为 `null`/`undefined`）。
- **缺项处理**: 任何必要参数缺失，直接中断后续药理比对，输出 `INSUFFICIENT_DATA`，并在 `missing_fields` 中逐项罗列。

### Step 3: Gate 2 药品标签检索与版本锁定
- **调用工具**: `drug-labels:search_labels`, `drug-labels:get_label`
- **参数**: 药品通用名、批准文号或商品名。
- **记录要素**: 必须提取并记录 `label_id`, `version`, `effective_date`, `snapshot_hash`。
- **纪律**: 若本地库未收录该药品，必须记录为 `no_mention_in_corpus`，**绝对不可断言该药无不良反应或安全**；该处方直接归入 `REQUIRES_PHARMACIST_REVIEW`。

### Step 4: Gate 3 全维度安全性矩阵筛查
- **调用工具**: `drug-labels:safety_screen` (或组合工具 `check_interactions`, `check_allergy`, `check_contraindication`, `check_renal_dosing`, `check_duplicate_therapy`, `check_special_population`)。
- **关键陷阱防线**:
  1. **肌酐单位转换**: 中国医院化验单统一为 $\mu\text{mol/L}$。若输入为 $\text{mg/dL}$，必须先乘以 88.4 换算为 $\mu\text{mol/L}$ 再调用 `calc_renal`。
  2. **头孢-青霉素交叉过敏**: 识别侧链相同的第 1/2 代头孢菌素交叉过敏风险。
  3. **OTC 复方成分累加**: 识别泰诺、日夜百服宁、白加黑中含有的对乙酰氨基酚与单方退热药的剂量重叠（日极量 $\le 2000\text{mg}$）。
  4. **中药十八反十九畏**: 识别附子与半夏、乌头与贝母等传统配伍禁忌。

### Step 5: 最终结论与输出规范
系统输出必须且仅能为以下四种封闭状态码之一：
- `PASS`: 证据链完整，全部维度未检出临床风险。
- `FLAG`: 检出明确用药禁忌、严重相互作用、过量或特殊人群用药不当。
- `INSUFFICIENT_DATA`: 缺少关键临床参数（如儿童缺体重、肾功能缺肌酐）。
- `REQUIRES_PHARMACIST_REVIEW`: 包含未收录药品或需要专科药师综合裁决的边缘情境。

### Step 6: 审计链存证
- **调用工具**: `audit:record_event`
- **参数**:
  ```json
  {
    "actor": "agent-prescription-reviewer",
    "action": "rx_review_verdict",
    "subject_ref": "[PSN:patient_hash]",
    "payload": {
      "verdict": "FLAG",
      "flags_count": 2,
      "issues": [...],
      "trace_ref": "trace-uuid-1234"
    }
  }
  ```
