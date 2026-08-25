# Medcius 插件包

Medcius 是面向住院医生查房前预阅的“患者变化摘要”插件。当前版本为 **`0.2.0-pilot` 工程试点版**，不具备真实临床有效性或生产医院部署证明。

## 唯一旗舰工作流

医生在 EHR 中打开患者病历或查房列表后，插件读取当前患者在过去 24/72 小时内的病历、检验、用药医嘱、检查报告和待办事项，呈现：

- 发生了什么变化；
- 今天仍待处理什么；
- 哪些关键资料不足；
- 每条信息来自哪个原始记录。

插件不诊断、不推荐治疗、不自主写回病历。病程草稿只包含医生明确选择的条目。

完整的产品边界、安全说明、当前证据状态和实用化路线见仓库根目录 [README](../../README.md)。

## 生产插件面

| 组件 | 用途 |
|---|---|
| `lib/patient-evolution-engine.mjs` | 24/72 小时变化、检验趋势、用药变化、待办和资料缺口 |
| `servers/api` | EHR 侧边栏、REST API、CDS Hooks `patient-view` |
| `servers/fhir` | SMART on FHIR R4 只读连接 |
| `servers/documents` | 病历附件与文档提取 |
| `servers/phiguard` | 本地 PHI 扫描与处理 |
| `servers/audit` | 本地哈希链审计 |
| `skills/clinical-note-extract` | 带原文 span 的受约束事实抽取 |

`mcp.json` 与 `.mcp.json` 只启动 FHIR、documents、PHI Guard 和 Audit Chain 四个本地服务。医保编码、审方、临床试验、多 Agent、记忆和管理工作台不属于旗舰生产路径。部分模块已进入根目录 [`experimental/`](../../experimental/README.md)，但插件目录仍保留若干上游遗留技能；正式发布前必须将它们拆分或排除出生产包。

## 开发评估

Claude Code：

```text
/plugin marketplace add HERRY423/Medcius
/plugin install medcius@medcius
```

Codex 本地开发评估：

```powershell
codex plugin marketplace add "$PWD\.agents\plugins"
codex plugin add medcius@medcius-local
```

该仓库现在同时包含 Codex manifest。Codex 入口使用只读 FHIR MCP 适配器、
本地 documents、PHI Guard 和 Audit Chain；数据目录可通过 `MEDCIUS_DATA`
指定，稳定假名化可通过 `MEDCIUS_PHI_SALT` 指定。安装后建议新建 Codex
任务测试技能和工具加载。此入口仍只用于工程和获批沙箱验证，不构成医院
临床部署或合规批准。

Trae / WorkBuddy / CodeBuddy 的项目级适配位于仓库根目录：`.trae/mcp.json`
与 `.trae/skills/` 面向 Trae；`.mcp.json`、`.rules/` 与 `.codebuddy/skills/`
面向 WorkBuddy/CodeBuddy。它们复用同一个 host wrapper，并保持 FHIR 只读，
不要求这些宿主识别 `.codex-plugin/plugin.json`。

本机沙箱服务：

```powershell
$env:MEDCIUS_ALLOW_ANONYMOUS = "true"
$env:MEDCIUS_PROFILE = "demo"
node servers/api/src/server.mjs
```

上述命令只适用于演示数据和开发环境。当前 REST 摘要路由仍包含演示回退，且代码尚未强制仅限 `demo` 配置，尚未允许接入真实患者。

## 当前证据边界

- 自动化测试证明代码路径和契约可运行，不证明临床准确性；
- 合成病例证明评测管线，不证明真实病区表现；
- 尚无独立真实 EHR 验收、连续病例标注、医生 time-motion 或多中心证据；
- 真实部署必须重新评估模型会话的数据路径、医院身份体系、TLS、日志、CORS、租户隔离和写回权限。

生产准入前至少要删除 REST 演示回退、接入医院身份与 FHIR 上下文，并完成一个病区的静默验证。

## 许可

根目录 MIT 许可证只覆盖 Medcius 原创文件；上游派生内容的来源和许可边界见 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)。
