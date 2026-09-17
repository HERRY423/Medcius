# 05 医院系统接入接口规范与报文样例（分类界定附件）

> **归档编号**：MED-CLS-ATT-05 (2026-08)  
> **论证目标**：向监管机构证明本产品的数据处理对象为医院信息系统已产生的客观记录，接口均为只读访问，不具备自动写回和设备控制能力。

---

## 1. 只读数据桥连接器规范 (ReadOnlyHospitalDataBridge)

Medcius 仅向医院系统注册并请求只读权限，核心支持两种医院常用接口通道：

```text
┌─────────────────────────────────────────────────────────────┐
│               医院信息系统接口 (EHR / LIS / PACS)            │
└──────────────────────────────┬──────────────────────────────┘
                                │
             ┌──────────────────┼──────────────────┐
             ▼                  ▼                  ▼
┌────────────────────────┐ ┌──────────────┐ ┌────────────────────────┐
│ P1 通道: SMART on FHIR │ │ P2 通道: CDA │ │ P3 通道: 只读视图库    │
│ (Patient/Observation/  │ │ /HL7 文档    │ │ (v_medcius_* 视图,    │
│  MedicationRequest/    │ │ (病程/出院   │ │  NIS/LIS/HIS/PACS)    │
│  DiagnosticReport)     │ │  记录文本流) │ │ P4 通道: HL7v2 订阅   │
└───────────┬────────────┘ └──────┬───────┘ │ (ADT/ORU/RDE 只消费)  │
            │                     │         └───────────┬────────────┘
            └─────────────┬───────┴─────────────────────┘
                          ▼
        ┌─────────────────────────────────────────────┐
        │ 六字段只读信封: source_system, tenant_id,    │
        │ patient_id, encounter_id, fetched_at, records│
        │ + 出口即假名化 (PHI Guard) + payload SHA-256 │
        └─────────────────────────────────────────────┘
```

四条通道统一约束：只发 GET（P4 只消费不回发 ACK 之外任何报文）、视图名/报文类型白名单、明文 http 拒绝（非 loopback）、瞬时 5xx 最多重试一次、站点激活（IRB + 协议哈希 + 只读账号）缺一即 fail-closed。

---

## 2. 标准输入报文样例

### 2.1 FHIR R4 只读生化检验报文样例 (`Observation`)
```json
{
  "resourceType": "Observation",
  "id": "obs-lab-creatinine-001",
  "status": "final",
  "category": [
    {
      "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": "laboratory" }]
    }
  ],
  "code": {
    "coding": [{ "system": "http://loinc.org", "code": "2160-0", "display": "Creatinine [Mass/volume] in Serum or Plasma" }],
    "text": "血肌酐"
  },
  "subject": { "reference": "Patient/P-CARD-001" },
  "encounter": { "reference": "Encounter/ENC-CARD-001" },
  "effectiveDateTime": "2026-08-27T08:30:00Z",
  "valueQuantity": {
    "value": 145.0,
    "unit": "umol/L",
    "system": "http://unitsofmeasure.org",
    "code": "umol/L"
  },
  "interpretation": [
    {
      "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", "code": "H", "display": "High" }]
    }
  ],
  "referenceRange": [
    {
      "low": { "value": 57.0, "unit": "umol/L" },
      "high": { "value": 111.0, "unit": "umol/L" }
    }
  ]
}
```

### 2.2 CDA/HL7 文档段落报文样例 (`ClinicalDocument`)
```xml
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <title>住院日常病程记录</title>
  <effectiveTime value="20260827080000"/>
  <component>
    <structuredBody>
      <component>
        <section>
          <code code="10154-3" displayName="主诉与查体"/>
          <title>查房经过</title>
          <text>
            <paragraph>今晨查房：患者诉轻度胸闷，无夜间阵发性呼吸困难。查体：双肺呼吸音清，心率 78 次/分，律齐，双下肢轻度可凹性水肿。复查血肌酐较昨日升高。</paragraph>
          </text>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>
```

---

## 4. P3 视图库字段清单（只读视图，只列最小必要字段）

| 视图 | 映射目标 | 字段 |
|---|---|---|
| `v_medcius_patient` | patient | id / name / gender / age / birth_date / bed_number |
| `v_medcius_encounter` | encounter | id / status / class / period_start / period_end |
| `v_medcius_nis_vitals` | nis | temperature / systolic_bp / diastolic_bp / heart_rate / spo2 / oral_intake_ml / iv_intake_ml / urine_output_ml / drain_output_ml / timestamp |
| `v_medcius_lis_results` | lis | test_code / test_name / result_value / unit / status / sample_time / ref_low / ref_high / interpretation / is_critical |
| `v_medcius_his_orders` | his | drug_name / dosage / route / frequency / authored_on / status / change_type |
| `v_medcius_pacs_reports`（可选） | pacs | name / modality / status(final/preliminary) / ordered_at / impression |
| `v_medcius_notes`（可选） | notes | title / content_type / text |

视图名必须匹配 `v_medcius_[a-z0-9_]+`，未知列在连接器内按字段白名单剥离后才进入信封。

## 5. P4 HL7v2 订阅报文样例（只消费：ADT/ORU/RDE）

```text
MSH|^~\&|HIS|HOSP-001|MEDCIUS|HOSP-001|20260825060000||ADT^A01|MSG-SYNTH-001|P|2.5
PID|1||patient-synthetic-1^^^HOSP-001||合成张三^测试||19580512|M
PV1|1|I|CARDIO^02^01||||||||||||||||encounter-synthetic-1

MSH|^~\&|LIS|HOSP-001|MEDCIUS|HOSP-001|20260825060000||ORU^R01|MSG-SYNTH-002|P|2.5
OBR|1|ord-k-synth-1||2823-3^血钾测定
OBX|1|NM|2823-3^血钾测定||2.4|mmol/L|3.5-5.3|LL|||F|||20260825060000

MSH|^~\&|HIS|HOSP-001|MEDCIUS|HOSP-001|20260820093000||RDE^O11|MSG-SYNTH-003|P|2.5
RXO|1|^注射用头孢曲松钠^||2^g||||静脉滴注
```

OBX 判读 `LL/HH/CR` 映射 `is_critical=true`；PID 与上下文患者不一致即 fail-closed；非 ADT/ORU/RDE 类型拒绝消费；连接器不产生 ACK，不持有 socket 写路径。

---

## 3. 标准结构化输出契约 (Causal Evolution Report)

输出严格符合 JSON Schema 契约，每一条事实均包含原文 Span 或 LIS 资源引用：

```json
{
  "schema_version": "causal-evolution-report.v1",
  "patient_id": "P-CARD-001",
  "encounter_id": "ENC-CARD-001",
  "generated_at": "2026-08-27T09:00:00Z",
  "blocks": {
    "what_changed": {
      "abnormal_labs": [
        {
          "code": "血肌酐",
          "current_value": 145.0,
          "unit": "umol/L",
          "baseline_value": 102.0,
          "delta": 43.0,
          "is_abnormal": true,
          "reference_range": "57.0 - 111.0 umol/L",
          "evidence_resource_id": "Observation/obs-lab-creatinine-001"
        }
      ],
      "clinical_symptoms": [
        {
          "symptom": "双下肢轻度可凹性水肿",
          "assertion": "positive",
          "span": "双下肢轻度可凹性水肿",
          "note_id": "N-PROGRESS-20260827"
        }
      ]
    },
    "whats_pending": {
      "pending_reports": [],
      "pending_orders": []
    },
    "data_gaps": [
      {
        "gap_type": "missing_allergy_history",
        "description": "病历未记录明确过敏史（显式提示主管医师核实）"
      }
    ]
  }
}
```
