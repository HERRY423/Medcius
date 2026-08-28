# 医院自建 Agent 适配指南 (Hospital Agent Integration)

Medcius 提供宿主无关的适配内核，支持医院自建的临床 Agent 平台（如 Dify、FastGPT、LangChain/LlamaIndex、自研临床工作台、CDS Hooks 2.0 消费端）无缝集成受约束的临床技能与只读工具。

## 架构关系

```text
[ 医院临床医生 ]
       │
       ▼
[ 医院自建 Agent (Dify / LangChain / CDS Hooks) ]
       │
       ▼ (标准上下文信封 & Token 鉴权)
[ HospitalAgentAdapter (Medcius 插件内核) ]
       │
       ├─► PatientEvolutionEngine (查房变化演变整理)
       ├─► HospitalDataAdapter (NIS/LIS/PACS/HIS 多源融合)
       ├─► HighRiskFollowupTracker (检查检验阶段闭环)
       ├─► SpecialtyRulePack (院内审核规则包)
       ├─► PatientAffordabilityContext (费用负担/覆盖/估算/援助转介状态)
       ├─► PHI Guard (院内脱敏与假名化校验)
       └─► Audit Chain (防篡改审计哈希链)
       │
       ▼
[ 医院只读数据底座 (FHIR R4 / LIS / PACS / NIS / HIS) ]
```

## 调用契约与示例

### 1. JavaScript / TypeScript SDK 接入

```javascript
import { HospitalAgentAdapter, HOST_TYPES } from "plugins/medcius/lib/hospital-agent-adapter.mjs";

const result = HospitalAgentAdapter.executePreRoundWorkflow({
  host: HOST_TYPES.HOSPITAL_CUSTOM_AGENT,
  context: {
    tenant_id: "hospital_pku_cardio",
    doctor_id: "DOC-8021",
    doctor_name: "林德明 (主任医师)",
    patient_id: "pat-cardio-001",
    encounter_id: "enc-cardio-001",
    time_window: "24h",
    specialty_rule_pack_id: "hospital-approved-cardiology-pack",
  },
  dataFeeds: {
    patient: { id: "pat-cardio-001", name: "张**", age: 68, bed_number: "01床" },
    notes: [...],
    nis: [...],
    lis: [...],
    pacs: [...],
    his_orders: [...],
  },
});

console.log(result.summary.blocks);
```

### 2. REST API / CDS Hooks 接入

医院 Agent 亦可通过本地/专网部署的 `plugins/medcius/servers/api` 接口：
- `GET /api/v1/patient/evolution-summary?time_window=24h&patient_id=pat-001&encounter_id=enc-001`
- `POST /api/v1/patient/progress-note-draft`
- `POST /cds-services/medcius-patient-evolution` (CDS Hooks 2.0 `patient-view` 钩子)

## 生产安全与合规要求

1. **只读保证**：严禁向自建 Agent 开放 `create_resource` 或 `update_resource`；
2. **Fail-Closed 机制**：若缺少患者、就诊或租户凭据，适配器立即阻断并抛出异常；
3. **不可替代医生决断**：生成的结构化摘要与病程草稿需由临床医生主动核对并确认。

### 异构接口只读桥

每个 NIS/LIS/PACS/HIS 连接器仅允许实现 `readPatient(context)` 并声明 `capabilities: ["read"]`。返回信封必须包含 `tenant_id`、`patient_id`、`encounter_id`、`fetched_at`、`source_version` 和 `records`。`ReadOnlyHospitalDataBridge` 对每个来源逐一校验上下文，保留记录来源与 payload SHA-256；必要来源失败时整个工作流失败关闭，非必要来源失败时以 `unavailable_sources` 返回。

桥接层不提供也不代理写回。若连接器暴露 `create`、`update`、`delete`、`patch` 或 `write`，初始化即拒绝。

费用与医疗可获得性来源使用 `kind: "financial_access"` 的只读连接器。记录必须符合 `contracts/patient-financial-access-record.v1.schema.json`，并绑定来源系统、记录 ID 和记录时间。`Coverage` 或医保目录命中不等于患者必然报销；患者特定价格估算必须保留币种与有效期，且仅作为来源系统提供的估算展示。经济障碍只能触发医生、药师、社工、医院医保办/财务咨询或支付方人工核实，不触发自动换药或出院裁决。
