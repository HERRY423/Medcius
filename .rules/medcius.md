# Medcius

仅用于工程、合成数据回放、集成测试和获批沙箱审查；不输出诊断、治疗建议或未经医生确认的 EHR 写回。执行前读取 `AGENTS.md`。

- 缺少患者、就诊、租户、时间、来源或参考范围时必须 fail-closed，不补造事实。
- 每个事实保留原文 span、FHIR resource ID 或明确的 null；阴性、未提及、未评估分开。
- 自由文本进入模型上下文、日志、审计或导出前先过 PHI Guard。
- FHIR MCP 只读；禁止 `create_resource` 和 `update_resource`。
- 工程/合成验证不等于临床证据；旗舰范围只限查房前患者变化摘要。
