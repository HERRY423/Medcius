# Medcius 实验性与非核心功能隔离区 (Experimental Quarantine)

本目录为 Medcius 架构收敛至**唯一旗舰产品（住院医生查房前“患者变化摘要”插件）**后的实验性组件隔离区。

---

## 1. 架构收敛原则与生产边界

生产发布包严格只包含：
- `patient-evolution-engine.mjs` (24/72h 确定性演变计算与检验趋势分析)
- `fhir` (SMART on FHIR 2.2 连接器)
- `clinical-note-extract` / `documents` (病历与文档客观提取)
- `phiguard` (本地 PHI 脱敏)
- `audit` (本地 SHA-256 审计链)
- `preround-sidebar.html` (住院医生查房一屏式侧边栏 UI)
- 旗舰专属评测与门禁测试

---

## 2. 隔离与归档实验性模块清单

以下组件已移出生产插件 `plugin.json`、`mcp.json` 与生产 CI 默认清单：

| 模块目录 | 功能定位 | 隔离理由 |
|---|---|---|
| `experimental/orchestrator/` | 多 Agent 调度编排引擎（Supervisor/Workers） | 旗舰插件直接采用确定性计算与受约束抽取，不依赖自主 Agent 调度 |
| `experimental/api/workbench.html` | 综合管理工作台 UI（含驾驶舱、CME、质控画像） | 移出医生查房主交互流，避免泛化管理平台膨胀 |
| `experimental/api/analytics-engine.mjs` | 管理驾驶舱与医生画像分析引擎 | 实验性院内管理工具，不属于查房前临床辅助 |
| `experimental/api/learning-engine.mjs` | CME 培训模拟器与自适应学习引擎 | 教学科研工具，与临床生产查房彻底隔离 |
| `experimental/api/qc-monitor.mjs` | 临床质控监控引擎 | 实验性后台监听工具 |
| `experimental/servers/memory/` | Agent 记忆库 (Agent Memory MCP) | 旗舰插件保持无状态会话与确定性计算，不依赖动态记忆注入 |
| `experimental/servers/china-trials/` | 临床试验登记检索 (China Trials MCP) | 属于研究与入组辅助，移出查房核心链路 |
| `experimental/workflows/` | 医保编码、反欺诈等历史工作流定义 | 职责剥离，保留供未来独立插件参考 |
| `experimental/tests/` | 实验性模块单元测试套件 | 与生产 CI 门禁解耦 |
