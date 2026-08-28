---
name: medcius-shift-handover
description: 临床交接班整理技能（WorkBuddy/CodeBuddy 适配）。基于 SBAR 模型结构化整理病区患者现状、夜间监护极值、危急值、引流动态、待复查检验与应急预案。只读提取、不代做临床决策、不代开医嘱。
---

# Medcius Shift Handover (WorkBuddy / CodeBuddy Skill)

WorkBuddy / CodeBuddy 宿主专属适配技能。将交接班信息组织为 SBAR 结构化卡片与交班志草稿。

## WorkBuddy / CodeBuddy 宿主调用说明
- 遵循 `.rules/medcius.md` 与 `AGENTS.md` 中的安全契约与 fail-closed 原则；
- 缺少患者或就诊上下文时必须 fail-closed；
- 严禁代替值班医师做医疗决策或开立医嘱。
