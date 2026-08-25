# Medcius 项目规则

Medcius 是住院查房前患者变化摘要项目。仅用于工程、合成数据回放、集成测试和获批沙箱审查，不输出诊断、治疗建议或未经医生确认的 EHR 写回。

执行任务前读取 `AGENTS.md`，并按场景加载：
- `medcius-fhir`：先 status，再显式连接；只使用只读 FHIR MCP。
- `medcius-clinical-note-extract`：事实必须保留原文 span、来源 ID 和显式 null。

必须 fail-closed：患者、就诊、租户、时间、来源或参考范围缺失时不得补造事实；“阴性”“未提及”“未评估”分开。自由文本进入模型上下文、日志、审计或导出前必须经过 PHI Guard。不得调用或启用 `create_resource`、`update_resource`。工程/合成验证不等于临床证据。
