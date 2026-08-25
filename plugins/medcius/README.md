# Medcius（住院医生查房前“患者变化摘要”插件）

**边界定位：** 本插件专为住院医生查房前/晨交班设计。在医生打开患者病历或查房列表时，自动通过 SMART on FHIR 2.2 / EHR 侧边栏读取上下文，一屏式呈现过去 24/72 小时病情变化、异常检验趋势、用药方案变动、待办检查与关键资料缺口。不做诊断决策、不制定治疗方案、不自主写回病历。数据与 MCP 均在本地。

```
安装到 Codex / 其他支持 Agent Plugins 的 Agent：
  将本目录作为插件包，读取 plugin.json + mcp.json + skills/

安装到 Claude Code：
  /plugin marketplace add <repo>
  /plugin install medcius@medcius
```

## 核心旗舰生产技能

| 技能 (Skill) | 适用对象 | 功能边界 |
|---|---|---|
| `fhir` | 住院医生、临床信息科 | SMART on FHIR 2.2 连接器；自动预取当前患者就诊、检验、医嘱与病历上下文 |
| `clinical-note-extract` | 住院医生 | 从病程记录与出院记录中提取客观症状与体征（带原文精确 span，识别否定与时间性） |

> **注**：医保编码校验、临床试验检索、Agent 记忆库、管理驾驶舱及多 Agent 编排器等非旗舰实验性模块已移至 [`experimental/`](../../experimental/README.md)，不随生产插件默认启动。

## 生产 MCP 服务清单（仅本地 stdio）

`mcp.json` 与 `.mcp.json` 仅包含 4 个核心本地生产服务：
1. `FHIR`: SMART on FHIR 2.2 EHR 资源读取与连接
2. `Contracts Analyzer` (documents): 临床病历文档结构化提取
3. `PHI 卫士 (PHI Guard)`: 患者隐私敏感信息本地脱敏与扫描
4. `本地审计链 (Local Audit Chain)`: 本地 SHA-256 审计链记录与验签
