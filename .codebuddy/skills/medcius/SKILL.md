---
name: medcius
description: Medcius 住院查房前患者变化摘要的工程、合成回放和获批沙箱协作技能；涉及 FHIR 读取、病历事实抽取、来源追踪、PHI Guard 或审计时使用。
---

# Medcius WorkBuddy/CodeBuddy skill

开始前读取根目录 `AGENTS.md` 和相关规范：

- FHIR / EHR：`plugins/medcius/skills/fhir/SKILL.md`
- 病历抽取：`plugins/medcius/skills/clinical-note-extract/SKILL.md`

只做查房前患者变化摘要的工程与获批沙箱工作。FHIR 使用项目级 `.mcp.json` 中的 `Medcius FHIR (read-only)`；先 `status`，再显式连接。缺少患者、就诊、租户、时间、来源或参考范围时 fail-closed。事实必须绑定原文 span、FHIR resource ID 或明确 null；阴性、未提及、未评估分开。自由文本进入模型上下文、日志、审计或导出前先过 PHI Guard。禁止诊断、治疗建议、处方判断、试验检索、自动多 Agent 和 EHR 写回；禁止 `create_resource` / `update_resource`。
