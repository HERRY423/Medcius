# Medcius 项目规则

Medcius 是面向一线临床医生的 Agent 插件，不是独立临床平台或自主诊疗 Agent。宿主 Agent 负责交互与编排，Medcius 提供受约束的技能和工具，医生核对证据并作出最终决定。查房前患者变化摘要是首个参考工作流，不是全部产品边界。当前仅用于工程、合成数据回放、集成测试和获批沙箱审查，不输出诊断、治疗建议或未经医生确认的 EHR 写回。

执行任务前读取 `AGENTS.md`，并按场景加载：
- `medcius-fhir`：先 status，再显式连接；只使用只读 FHIR MCP。
- `medcius-clinical-note-extract`：事实必须保留原文 span、来源 ID 和显式 null。

必须 fail-closed：患者、就诊、租户、时间、来源或参考范围缺失时不得补造事实；“阴性”“未提及”“未评估”分开。自由文本进入模型上下文、日志、审计或导出前必须经过 PHI Guard。不得调用或启用 `create_resource`、`update_resource`。工程/合成验证不等于临床证据。新增临床工作流必须独立声明用户、触发时点、权限、输出、失败行为、禁止行为和验证计划。
