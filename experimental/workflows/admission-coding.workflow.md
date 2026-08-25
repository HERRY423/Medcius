# 住院结算病历抽取与医保编码 Agent 工作流 (Admission & NHSA Coding Workflow)

## 1. 触发条件
- 归档出院小结、出院记录、入院记录；
- 医保结算清单生成、DRG/DIP 分组前入组校验；
- 临床病历结构化质控抽检。

---

## 2. 拓扑与工具调用序列

```
[原始出院病历文本]
       │
       ▼
[Step 1: PHI 守卫与隐私脱敏] ───► phiguard:scan + phiguard:pseudonymize
       │
       ▼
[Step 2: 病历实体结构化抽取] ───► ExtractWorker (无外部工具沙箱隔离)
       │ (提取: 主要诊断、次要诊断、手术操作、出入院日期、检验结果)
       │ (严格绑定原文 Span: start_offset, end_offset, text)
       │
       ▼
[Step 3: 国家医保版代码精准解析] ───► china-codes:search_codes + get_code
       │ (严禁 LLM 凭记忆编造编码；严格带 6 字段溯源)
       │
       ▼
[Step 4: 医保结算清单规则自检] ───► china-codes:check_settlement_list
       │ (主诊断合法性、性别限制、肿瘤形态学编码配对、手术主次逻辑)
       │
       ▼
[Step 5: 审计存证与自检报告输出] ───► audit:record_event
```

---

## 3. 分步执行指令与合规纪律

### Step 1: 隐私脱敏
- 抽取前必须执行 `phiguard`，隐藏患者姓名、联系电话、详细门牌住址及管床医生签名。

### Step 2: 实体抽取 (Span-Verified Extraction)
- **断言分类体系**: 诊断断言必须严格区分：
  - `confirmed`（确诊）
  - `differential`（待查/疑似）
  - `negated`（已排除/无）
  - `family_history`（家族史）
  - `planned`（拟行）
- **核心纪律**: `differential` / `negated` / `family_history` 绝对不得作为主要诊断编码！

### Step 3: 国家医保版代码解析 (NHSA Coding)
- **调用工具**: `china-codes:search_codes`
- **解析对象**:
  - 主要诊断 $\to$ 国家医保版 ICD-10 诊断代码（如 `I25.102` 冠状动脉粥样硬化性心脏病）；
  - 次要诊断 $\to$ 医保版 ICD-10 诊断代码；
  - 手术与操作 $\to$ 医保版手术操作分类代码（如 `36.0601` 冠状动脉药物洗脱支架置入术）。
- **6 字段法定溯源要求**: 每个代码项必须输出：
  1. `code_system`: 编码体系（如 `NHSA_ICD10` / `NHSA_PROCEDURE`）
  2. `code_version`: 目录版本号（如 `2.0`）
  3. `effective_date`: 生效日期（如 `2024-01-01`）
  4. `retrieved_at`: 查询时间戳
  5. `source`: 数据来源（如 `nhsa_official_pack`）
  6. `validation_status`: 校验状态（如 `VALIDATED`）

### Step 4: 医保结算合规自检
- **调用工具**: `china-codes:check_settlement_list`
- **检查项**:
  - 主诊断是否为 R 组未明确体征或 Z 组辅助代码；
  - 性别与诊断/手术是否冲突（如男性患者开立卵巢囊肿切除术）；
  - 年龄与诊断限制（如成人患者开立新生儿呼吸窘迫综合征）；
  - 伴随手术操作与主诊断的 DRG/DIP 入组有效性。

### Step 5: 存证与输出
- 记录 `admission_coding_verdict` 事件至审计链。
