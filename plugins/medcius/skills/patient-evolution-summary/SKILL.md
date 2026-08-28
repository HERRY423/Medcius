---
name: patient-evolution-summary
description: 住院查房前患者病情演变与关键变化摘要技能。将过去 24/72 小时内的病程记录、LIS 检验动态、用药医嘱调整、PACS 影像检查与护理出入量整理为四区块结构化摘要（发生了什么变化、今天仍待处理什么、哪些资料不足、查看原始证据）。不做自主诊断决策、不修改医嘱、不执行未经医生确认的 EHR 写回。当用户提出"查房摘要"、"患者演变"、"24小时变化"、"pre-round summary"、"patient evolution"时使用。
---

# Inpatient Pre-Round Patient Evolution Summary (查房前患者变化摘要)

住院医生查房前“患者变化摘要”是 Medcius 的核心参考工作流。通用大模型“24/72小时文本摘要”已被主流 EHR（如 Epic Inpatient Insights）内嵌，不再构成独立插件的竞争壁垒。Medcius 的核心临床价值在于：**结构化多源数据优先（NIS/LIS/PACS/HIS）、确定性精确变化监测（体征极值/出入量平衡/电解质演变/抗菌药疗程）、未闭环事项与资料缺口拦截（未出病理/药敏/过敏缺失）以及不可篡改的逐条原始证据绑定**。

## 产品边界与责任划分 (Product Boundary & Responsibility)

- **产品定位**：本技能是宿主 Agent（Codex / Trae / WorkBuddy / 医院自建 Agent）的辅助能力插件，不是能够独立诊疗的“临床智能体”。
- **核心差异化价值**：
  1. **结构化数据优先 (Structured-Data-First)**：深度打通 NIS 生命体征与引流液、LIS 动态参考区间与危急值、PACS 影像印象及 HIS 医嘱变动；
  2. **确定性精确变化检测 (Exact Change Detection)**：精准计算 24h 出入量代数和、生命体征极值与抗菌药累计天数，不依赖 LLM 模糊估算；
  3. **未闭环事项与安全缺口 (Loop Closure & Safety Gaps)**：按院内批准规则追踪未执行、未出最终报告或未确认的检查检验，并显式呈现过敏史与基线数据缺口；
  4. **严格证据追踪 (Verbatim Provenance)**：所有条目均绑定原文 Span 或真实 FHIR 资源 ID 与 SHA-256 审计链，杜绝捏造证据。
- **医生责任**：医生必须核对原始病历与 FHIR resource 证据，决定选用哪些条目，并承担最终临床医疗责任。
- **禁止行为 (Prohibited Actions)**：
  - 严禁自主推断未在原始病历中确认的新诊断；
  - 严禁擅自生成或修改治疗方案与医嘱处方；
  - 严禁绕过医生签名执行 EHR / HIS 自动写回；
  - 严禁在缺失患者、就诊或时间上下文时凭空捏造事实。

## 四大核心临床区块 (4 Structured Core Blocks)

本技能提取并结构化输出以下四个标准区块：

### 1. 发生了什么变化 (What Changed)
- **临床症状与体征演变**：从最新查房病程记录中提取带原文 `span` 的症状改善、加重或新发体征；
- **检验指标动态与趋势**：结合医院 LIS `Observation.referenceRange` 动态判定异常（偏高 `↑` / 偏低 `↓`）；无参考区间时仅呈现数值趋势，严禁在缺少区间时武断判定异常；
- **用药方案与医嘱调整**：梳理新增（added）、停用（discontinued）及剂量调整（adjusted）药物，标注特殊级/限制级抗菌药物累计使用天数。

### 2. 今天仍待处理什么 (What's Pending)
- **未出结果的检查与化验**：未出具最终报告的影像、微生物培养（如血培养、药敏试验）；
- **今日待执行处置与会诊**：已开立尚未执行的专科床旁会诊、动态心电图、穿刺或介入排期。

### 3. 哪些关键资料不足 (Data Gaps)
- **过敏史缺失**：未记录明确药物过敏史或状态未知；
- **基线数据缺失**：如缺失入院基线血肌酐导致无法准确评估 AKI 发生；
- **检验参考区间缺失**：提示医生该指标需结合临床实际判断。

### 4. 原始证据与可追溯性 (Evidence & Provenance)
- 每一条提取的事实均绑定原始病程文本片段（Verbatim Note Span）或 FHIR Resource ID 与采样/记录时间戳；
- 严禁拼接或生成虚假的引用片段。

## 失败关闭契约 (Fail-Closed Contract)

当遇到以下情况时，技能必须立即**失败关闭 (Fail-Closed)** 并向医生明确提示，绝不利用大模型幻觉补全：
1. 缺失 `patient_id` 或无法检索到对应患者主体；
2. 缺失 `encounter_id` 或就诊处于非住院活跃状态；
3. 缺少明确的时间窗口（默认锁定 24h/72h，超出有效时限时警告）；
4. 租户隔离标识（Tenant ID）不匹配或身份鉴权失败。

## 高风险检查检验阶段性追踪

- 只表达可验证的生命周期事实：已开立、已安排/采集、初步结果、最终结果、医生已确认或明确关闭；
- 不把“已出结果”推断为“医生已查看”，`acknowledged_at` 缺失时保持 `PENDING_CLINICIAN_ACKNOWLEDGEMENT`；
- 不把接口不可用、未返回记录或规则包缺失解释为阴性结果；
- 阶段超时只依据当前医院批准的专科规则包，禁止内置静默通用时限；
- 跟踪器只提示未闭环状态，不给出处置、诊断或治疗建议。

## 专科病区规则包与异构只读桥

- 规则包必须绑定 `specialty + care_setting + hospital_scope + version + approved_by + effective_from`；
- 生产环境只接受 `data_class=official` 且 `status=approved` 的规则包；
- NIS/LIS/PACS/HIS/EMR 通过只读来源信封接入，每个来源都要绑定 tenant、patient、encounter、抓取时间、来源版本与 payload hash；
- 任何来源上下文不一致时失败关闭；非必要来源不可用时必须显式返回 `unavailable_sources`，不得静默当作空数据。

## 输出契约 (Output Schema)

```json
{
  "patient_id": "string",
  "time_window": "24h | 72h",
  "total_items_count": "number",
  "blocks": {
    "what_changed": {
      "clinical_symptoms": [{ "id": "string", "span": "string", "assertion": "present | absent | possible", "category": "FACT" }],
      "abnormal_labs": [{ "id": "string", "test_name": "string", "current_value": "number", "unit": "string", "trend_direction": "↑ | ↓ | →", "is_abnormal": "boolean", "status_label": "string", "has_reference_range": "boolean", "span": "string | null" }],
      "medication_diff": {
        "added": [{ "id": "string", "drug_name": "string", "dosage": "string", "route": "string" }],
        "discontinued": [{ "id": "string", "drug_name": "string", "stop_reason": "string | null" }],
        "adjusted": [{ "id": "string", "drug_name": "string", "previous_dosage": "string", "dosage": "string" }]
      }
    },
    "whats_pending": {
      "pending_reports": [{ "id": "string", "name": "string", "status": "preliminary | registered", "ordered_at": "string" }],
      "pending_orders": [{ "id": "string", "title": "string", "scheduled_time": "string" }],
      "scheduled_consults": [{ "id": "string", "department": "string", "purpose": "string" }]
    },
    "data_gaps": [{ "id": "string", "gap_type": "string", "description": "string", "severity": "HIGH | MEDIUM | LOW" }],
    "evidence": [{ "item_id": "string", "source_type": "note | observation | medication | order | diagnostic_report", "source_id": "string", "tag": "string", "timestamp": "string" }]
  }
}
```

## 医生确认与病程记录草稿生成 (Draft Generation)

医生在前端或宿主 Agent 中勾选确认的条目，可调用草稿生成逻辑汇总为规范的【日常查房记录 - 病情演变摘要】文本；草稿末尾自动附带医师签名与确认时间戳，供医生核对后手动复制至 EHR 系统中。
