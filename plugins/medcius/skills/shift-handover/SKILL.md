---
name: shift-handover
description: 临床交接班与夜间值班重点整理技能。基于 SBAR (Situation-Background-Assessment-Recommendation) 模型，将病区患者现状、夜间监护极值、危急值报警、引流异常、待复查检验与应急预案整理为结构化交接班卡片。只读整理、不做自主医疗决策、不代开医嘱。当用户提出"交接班"、"交班记录"、"夜间交班"、"shift handover"、"patient handoff"时使用。
---

# Clinical Shift Handover (临床交接班准备技能)

临床交接班准备技能是 Medcius 面向住院总医师、值班医师与病区护理人员的结构化工作流技能包。它利用 SBAR 与 I-PASS 临床模型，自动梳理患者关键现状、背景历程、夜间重点评估项目及待办预案，防止交接班信息断层。

## 产品边界与责任划分 (Product Boundary & Responsibility)

- **产品定位**：本技能仅对现有病历、监护及检验医嘱数据进行只读聚合与结构化呈现，不替代值班医师床旁巡视与即时决断；
- **禁止行为**：
  - 严禁替接班医生做出自主诊疗决定；
  - 严禁未经医生审核直接下达夜间医嘱；
  - 严禁在无明确患者主体或时间窗口时虚构交班事实。

## SBAR 核心区块 (SBAR Structured Sections)

1. **S (Situation 现状)**：床位、患者基本信息、主要诊断、护理分级与重症交班状态；
2. **B (Background 背景)**：入院天数、近期有创操作/介入/手术历程、药物过敏情况；
3. **A (Assessment 评估)**：夜间体温/SpO2/血压极值、危急值报警、引流量与性状、维持静脉泵入药物；
4. **R (Recommendation 建议与预案)**：夜间待复查化验（如血钾/血常规）、专科急症（胸痛/心衰/电解质紊乱）应急处置预案。

## 失败关闭契约 (Fail-Closed Contract)

缺失 `patient_id`、缺失活跃就诊或租户鉴权失败时，立即 fail-closed 退出。
