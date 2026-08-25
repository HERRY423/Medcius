# WorkBuddy / CodeBuddy 适配

本仓库采用 WorkBuddy/CodeBuddy 的项目级能力入口，不把 Codex 的 `.codex-plugin/plugin.json` 当作可直接安装包。

## 本地项目模式

- MCP：读取仓库根目录 [`.mcp.json`](../../.mcp.json)。四个服务都通过 `plugins/medcius/scripts/codex-mcp-server.mjs` 启动；FHIR 由启动器强制隐藏 `create_resource` 和 `update_resource`。
- 规则：读取 [`.rules/medcius.md`](../../.rules/medcius.md)。
- 技能：读取 [`.codebuddy/skills/medcius/SKILL.md`](../../.codebuddy/skills/medcius/SKILL.md)。

打开项目后，在 WorkBuddy/CodeBuddy 的 MCP 设置中启用项目级配置；如客户端版本不自动加载 `.mcp.json`，将同一文件的 `mcpServers` 内容通过“原始配置（JSON）”导入。

## WorkBuddy Enterprise

企业 Agent 需要在管理后台分别挂载规则、技能和 MCP，并在 Test Run 中验证。当前仓库只提供本地项目适配，不伪造企业租户的 `MCPConfig`、凭据或远程运行时配置；真实 FHIR/PHI 接入必须先获得医院与企业部署边界批准。

## 安全边界

这套适配只支持工程、合成数据回放、集成测试和获批沙箱审查。它不构成临床部署、诊断/治疗工具或 EHR 写回授权。
