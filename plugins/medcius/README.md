# Medcius 插件包

Medcius 是面向一线临床医生的 **Agent 插件**。它安装到 Codex、Trae、WorkBuddy/CodeBuddy 或医院自建 Agent 中，为宿主提供临床工作流技能、只读数据工具、PHI 防护、证据追溯和审计能力。

Medcius 不是独立临床软件或医院信息平台，也不是自主诊疗的临床 Agent。宿主 Agent 负责对话和任务编排，Medcius 负责受约束的能力与工具，医院系统提供原始事实，医生核对证据并作出最终决定。

当前版本为 **`0.2.0-pilot` 工程试点版**，不具备真实临床有效性或生产医院部署证明。

## 插件生产面

| 组件 | 用途 |
|---|---|
| `skills/fhir` | 受约束的 FHIR 读取、患者上下文与来源绑定 |
| `skills/clinical-note-extract` | 带原文 span、断言状态和显式 null 的事实抽取 |
| `skills/doc-extract` | 临床文档与附件提取 |
| `servers/fhir` | SMART on FHIR R4 连接器；Codex、Trae、WorkBuddy 入口强制只读 |
| `servers/documents` | 文档提取与来源处理 |
| `servers/phiguard` | PHI 扫描、脱敏与假名化支持 |
| `servers/audit` | 本地防篡改检测用哈希链审计 |
| `lib/patient-evolution-engine.mjs` | 首个参考工作流“查房前患者变化摘要” |
| `servers/api` | 参考侧边栏、REST 与 CDS Hooks 适配器 |

“查房前患者变化摘要”用于证明插件内核如何支撑一个真实临床工作流，但不再代表 Medcius 的全部产品边界。后续工作流必须以独立技能包扩展，并分别定义用户、触发时点、权限、证据、失败行为和验证方案。

## 共同安全契约

- 缺少患者、就诊、用户、租户、时间、来源或必要参考范围时失败关闭；
- 每个事实保留原文 span、FHIR resource ID 或明确的 `null`；
- 阴性、未提及、未评估和无法判断必须分开；
- 自由文本进入模型上下文、日志、审计或导出前先经过 PHI Guard；
- Agent 适配默认只读，不暴露 `create_resource` 或 `update_resource`；
- 不输出自主诊断、治疗推荐、处方裁决或无人工确认的 EHR 写回；
- 工程检查和合成病例不等于临床证据。

## 宿主适配

Codex：

```powershell
codex plugin marketplace add "$PWD\.agents\plugins"
codex plugin add medcius@medcius-local
```

Trae 使用根目录 `.trae/mcp.json`、`.trae/rules/` 和 `.trae/skills/`；WorkBuddy/CodeBuddy 使用 `.mcp.json`、`.rules/` 和 `.codebuddy/skills/`。这些入口复用同一 host wrapper，并保持 FHIR 只读。

企业 Agent 仍需在管理后台配置规则、技能、MCP、身份与凭据，并完成医院批准的 Test Run。安装插件不等于获得临床部署、数据处理或 EHR 写回授权。

## 当前证据边界

- 自动化测试证明代码路径与契约可运行，不证明临床准确性；
- 合成病例证明评测管线，不证明真实病区表现；
- 尚无独立真实 EHR 验收、连续病例标注、医生 time-motion 或多中心证据；
- 真实部署必须重新评估模型会话、身份体系、TLS、日志、遥测、租户隔离和数据处理边界。

完整定位、架构和 P0-P4 发展路径见仓库根目录 [README](../../README.md)。
