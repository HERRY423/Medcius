---
name: medcius-patient-evolution-summary
description: 住院查房前患者病情演变与关键变化摘要技能（WorkBuddy/CodeBuddy 适配）。将过去 24/72 小时的病程记录、LIS 检验动态、用药医嘱调整与影像状态整理为 4 区块结构化摘要。只读提取、证据绑定、严禁自主诊疗决策与未经医生确认的 EHR 写回。
---

# Medcius Inpatient Pre-Round Patient Evolution Summary (WorkBuddy / CodeBuddy Skill)

WorkBuddy / CodeBuddy 宿主专属适配技能。将住院患者过去 24/72 小时内的临床演变整理为 4 个结构化区块，供住院医师查房前快速核对与生成草稿。

## WorkBuddy / CodeBuddy 宿主调用说明

- 宿主通过项目根目录 `.mcp.json` 调用只读 FHIR、Documents、PHI Guard 与 Audit MCP 服务；
- 遵循 `.rules/medcius.md` 与 `AGENTS.md` 中的安全契约与 fail-closed 原则；
- 缺少患者或就诊上下文时必须 fail-closed；
- 每一条事实绑定原始病历 span 或 FHIR 资源 ID，阴性、未提及、未评估严格分开。
