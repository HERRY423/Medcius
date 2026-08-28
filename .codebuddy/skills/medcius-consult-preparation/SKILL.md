---
name: medcius-consult-preparation
description: 专科会诊前资料整理技能（WorkBuddy/CodeBuddy 适配）。围绕会诊核心诉求，结构化整合患者专科诊疗历程、检验时间轴、已出/未出影像报告及主要用药。只读整理、不代写会诊意见。
---

# Medcius Consult Preparation (WorkBuddy / CodeBuddy Skill)

WorkBuddy / CodeBuddy 宿主专属适配技能。围绕会诊诉求快速生成高密度专科资料包。

## WorkBuddy / CodeBuddy 宿主调用说明
- 遵循 `.rules/medcius.md` 与 `AGENTS.md` 中的安全契约与 fail-closed 原则；
- 缺少会诊科室或患者上下文时必须 fail-closed；
- 严禁代替专科医师出具诊断或处置意见。
