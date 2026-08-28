# Codex 插件适配指南

Medcius 作为 Codex 的 Agent 插件，为临床开发者和医生提供受约束的临床工作流技能与只读数据工具。

## 本地安装与开发接入

```powershell
# 1. 注册本地插件市场
codex plugin marketplace add "$PWD\.agents\plugins"

# 2. 从本地市场安装 Medcius
codex plugin add medcius@medcius-local
```

## 核心配置与架构边界

- **清单路径**: `plugins/medcius/.codex-plugin/plugin.json`
- **MCP 包装入口**: `plugins/medcius/scripts/codex-mcp-server.mjs`
  - 提供 `fhir` (强制只读，隐藏 write 工具)、`documents`、`phiguard`、`audit` 服务。
- **技能入口**: `plugins/medcius/skills/`
  - `patient-evolution-summary`: 查房前患者变化摘要（首个参考工作流）；
  - `clinical-note-extract`: 结构化病历字段抽取；
  - `fhir`: SMART on FHIR R4 只读数据工具；
  - `doc-extract`: 本地医学文档抽取。
  - `discharge-readiness-check`: 出院闭环、带药、资料缺口及来源绑定的费用负担/医疗可获得性核对；不计算患者自付额。

## 安全与验证门禁

运行 Codex 插件标准验证脚本：

```powershell
node scripts/validate-skills.mjs
node scripts/validate-host-adapters.mjs
python C:\Users\13264\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py plugins\medcius
```
