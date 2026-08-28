---
name: medcius-patient-evolution-summary
description: 住院查房前患者变化摘要技能（Trae 适配）。将过去 24/72 小时的病程记录、LIS 检验动态、用药医嘱调整与影像状态整理为 4 区块结构化摘要。只读提取、证据绑定、严禁自主诊疗决策与未经医生确认的 EHR 写回。
---

# Medcius Inpatient Pre-Round Patient Evolution Summary (Trae Skill)

Trae 宿主专属适配技能。将病区患者过去 24/72 小时内的临床演变提取为 4 个结构化区块，供住院医师查房前快速核对。

## Trae 宿主调用说明

- 宿主通过项目根目录 `.trae/mcp.json` 调用只读 FHIR 与 Documents MCP 服务；
- 遵循 `.trae/rules/project_rules.md` 中的安全契约与 fail-closed 原则；
- 缺少患者或就诊上下文时必须 fail-closed；
- 每一条事实绑定原始病历 span 或 FHIR 资源 ID，阴性、未提及、未评估严格分开。
