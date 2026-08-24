# Medcius（插件本体）

**边界：** 医保编码、处方审核辅助、病历抽取。不做诊断决策。MCP 仅本地。

```
安装到 Codex / 其他支持 Agent Plugins 的 Agent：
  将本目录作为插件包，读取 plugin.json + mcp.json + skills/

安装到 Claude Code：
  /plugin marketplace add <repo>
  /plugin install medcius@medcius
```

## 核心技能

| Skill | 对象 | 功能 |
|---|---|---|
| `nhsa-coding` | 编码员、医保办 | 医保版 ICD-10 / 手术操作：查询+校验，六字段出处 |
| `prescription-review` | 药师 | 证据门控审方辅助（G1/G2/G3）；不替代药师 |
| `clinical-note-extract` | 病案/编码 | 中国住院 schema：入院/出院诊断、手术、过敏史、体格检查 |
| `nhsa-policy` | 医保办 | 四层政策：目录 ≠ 报销比例 |
| `nmpa-drugs` | 药师 | 本地说明书库；无 NMPA 注册连接器，未命中即停 |
| `china-clinical-trials` | 研究 | 本地 CTR 摘录；未命中转官网或停止 |
| `hospital-info-systems` | 信息科/医保办 | 结算清单字段对照 + 电子病历评级约束 |

生产：`node scripts/doctor.mjs`（official=0 不得当生产）。导入：`packs/README.md`。病历入口：`node scripts/intake-discharge.mjs <出院记录> --code`。

其余技能为上游美国 payer/FHIR 遗产：无用户自备连接器则停止，不调用托管 MCP。

## MCP（仅本地 stdio）

`mcp.json` 与 `.mcp.json` 同一组服务器：`china-codes`、`drug-labels`、`documents`、`fhir`。
