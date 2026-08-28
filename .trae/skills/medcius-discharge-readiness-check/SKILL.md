---
name: medcius-discharge-readiness-check
description: 出院资料核对与完整性检查技能（Trae 适配）。核对关键检查闭环、出院带药衔接、资料缺口及来源绑定的费用负担/医疗可获得性状态。只读核对、不替代医生做出院决策、不猜测自付额或自动改药。
---

# Medcius Discharge Readiness Check (Trae Skill)

Trae 宿主专属适配技能。辅助医生核查出院前检查闭环与用药衔接，保障出院安全。

## Trae 宿主调用说明
- 遵循 `.trae/rules/project_rules.md` 中的安全契约与 fail-closed 原则；
- 患者非住院状态或缺少就诊记录时必须 fail-closed；
- 缺少来源绑定的费用筛查、覆盖核验或价格估算时标记 `unknown`，不得写成“无经济障碍”；
- 严禁擅自下达出院医嘱、代替医生签字、计算患者自付额或推荐替代治疗。
