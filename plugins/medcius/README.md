# Medcius（插件本体）

**边界：** 住院医生查房前“患者变化摘要”插件。医生打开患者病历时自动通过 SMART on FHIR 2.2 / EHR 侧边栏读取上下文，一屏式呈现过去 24/72 小时变化、异常检验趋势、用药方案变动、待办检查与关键资料缺口。不做诊断决策、不制定治疗方案、不自主写回病历。数据与 MCP 均在本地。

```
安装到 Codex / 其他支持 Agent Plugins 的 Agent：
  将本目录作为插件包，读取 plugin.json + mcp.json + skills/

安装到 Claude Code：
  /plugin marketplace add <repo>
  /plugin install medcius@medcius
```

## 核心旗舰与支撑技能

| Skill | 对象 | 功能 |
|---|---|---|
| `fhir` | 住院医生、临床信息科 | SMART on FHIR 2.2 连接器；自动预取当前患者就诊、检验、医嘱与病历 |
| `clinical-note-extract` | 住院医生 | 从病程与出院记录中提取客观症状与体征（带原文精确 span，识别否定与时间性） |
| `nhsa-coding` | 辅助支撑 | 本地医保版 ICD-10 诊断与手术编码库查询 |
| `drug-labels` | 辅助支撑 | 本地药品版本化说明书库与极量查询 |
| `china-clinical-trials` | 辅助支撑 | 本地临床试验与伦理登记查询 |

生产准入：`node scripts/doctor.mjs`（official=0 不得当生产）。导入：`packs/README.md`。

## MCP（仅本地 stdio）

`mcp.json` 与 `.mcp.json` 包含核心本地服务：`fhir`、`documents`、`phiguard`、`audit`、`china-codes`、`drug-labels`。
