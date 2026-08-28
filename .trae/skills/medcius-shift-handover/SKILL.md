---
name: medcius-shift-handover
description: 临床交接班整理技能（Trae 适配）。基于 SBAR 模型结构化整理病区患者现状、夜间监护极值、危急值、引流动态、待复查检验与应急预案。只读提取、不代做临床决策、不代开医嘱。
---

# Medcius Shift Handover (Trae Skill)

Trae 宿主专属适配技能。将病区患者交接班信息梳理为 SBAR（现状、背景、评估、建议与预案）结构化卡片。

## Trae 宿主调用说明
- 遵循 `.trae/rules/project_rules.md` 中的安全契约与 fail-closed 原则；
- 缺少患者或就诊上下文时必须 fail-closed；
- 事实必须绑定原始病历或监护记录，不代写决策。
