---
name: medcius
description: Medcius 面向一线临床医生的 Agent 插件协作技能；涉及受约束的临床工作流、FHIR 读取、病历事实抽取、来源追踪、PHI Guard 或审计时使用。
---

# Medcius WorkBuddy/CodeBuddy skill

开始前读取根目录 `AGENTS.md` 和相关规范：

- FHIR / EHR：`plugins/medcius/skills/fhir/SKILL.md`
- 病历抽取：`plugins/medcius/skills/clinical-note-extract/SKILL.md`
- 查房前患者变化摘要：`plugins/medcius/skills/patient-evolution-summary/SKILL.md`
- 临床交接班整理：`plugins/medcius/skills/shift-handover/SKILL.md`
- 专科会诊前资料整理：`plugins/medcius/skills/consult-preparation/SKILL.md`
- 出院资料完整性核对：`plugins/medcius/skills/discharge-readiness-check/SKILL.md`

Medcius 是安装到宿主 Agent 的受约束能力包，不是独立临床平台或自主诊疗 Agent。查房前患者变化摘要是首个参考工作流；新增工作流必须独立声明用户、触发时点、权限、输出、失败行为和验证方案。FHIR 使用项目级 `.mcp.json` 中的 `Medcius FHIR (read-only)`；先 `status`，再显式连接。缺少患者、就诊、租户、时间、来源或参考范围时 fail-closed。事实必须绑定原文 span、FHIR resource ID 或明确 null；阴性、未提及、未评估分开。自由文本进入模型上下文、日志、审计或导出前先过 PHI Guard。禁止诊断、治疗建议、处方判断、试验检索、自动多 Agent 和 EHR 写回；禁止 `create_resource` / `update_resource`。
