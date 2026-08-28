# Trae 适配指南

Medcius 为 Trae 提供原生项目级技能与只读 MCP 配置。

## 项目级配置结构

- **MCP 服务配置**: `.trae/mcp.json`
  - 挂载 `fhir`、`documents`、`phiguard`、`audit` 4 个 stdio 服务；
  - 启动器为 `plugins/medcius/scripts/codex-mcp-server.mjs`，确保只读与数据隔离。
- **项目规则**: `.trae/rules/project_rules.md`
  - 规定 fail-closed 安全契约、禁止自主诊断/处方及证据保真度要求。
- **Trae 技能包**: `.trae/skills/`
  - `medcius-patient-evolution-summary/SKILL.md` (查房前患者变化摘要)
  - `medcius-clinical-note-extract/SKILL.md` (病历抽取)
  - `medcius-fhir/SKILL.md` (FHIR 访问)
  - `medcius-discharge-readiness-check/SKILL.md` (出院准备度与费用负担/医疗可获得性核对)

## 本地开发与测试

在 Trae 中打开工作区后，Trae 会自动加载 `.trae/mcp.json` 和 `.trae/skills/`。开发者或医生可通过自然语言对话触发查房摘要与病历结构化抽取。
