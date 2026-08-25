# Medcius 实验性与非核心功能归档 (Experimental Capabilities)

本目录为 Medcius 架构收敛至**唯一旗舰产品（住院医生查房前“患者变化摘要”插件）**后的实验性功能隔离区。

---

## 1. 架构收敛原则 (Strategic Direction)

依据医疗大模型与临床落地的最高设计原则：
1. **停止通用平台化膨胀**：停止扩展多 Agent 调度编排器（Supervisor/Orchestrator）、管理驾驶舱（院长/主任仪表盘、医生质控画像、CME 培训模拟器）；
2. **停止在单一插件中混合多重角色**：将医保编码员、药师处方审核、医保办飞检、临床试验筛选等职责剥离，主插件 100% 聚焦**住院医师查房前 24h/72h 病情演变摘要**；
3. **保持窄而稳定的核心运行时**：
   - SMART on FHIR 2.2 App Launch + EHR 侧边栏/嵌入面板；
   - 临床文档抽取（`clinical-note-extract`）；
   - 确定性检验趋势与用药方案 Diff 计算（`patient-evolution-engine.mjs`）；
   - PHI 脱敏与本地 SHA-256 审计链；
   - 医生确认后结构化插入查房病程草稿。

---

## 2. 隔离与归档模块列表

| 模块名称 | 原路径 | 归档定位 |
|---|---|---|
| **多 Agent 调度编排引擎** | `plugins/medcius/orchestrator/` | 实验性探索，旗舰插件直接采用确定性计算与受约束抽取，不依赖自主 Agent 调度 |
| **管理驾驶舱与质控评分** | `plugins/medcius/servers/api/src/analytics-engine.mjs` | 实验性院内管理工具，移出医生查房主交互流 |
| **临床质控监控器** | `plugins/medcius/servers/api/src/qc-monitor.mjs` | 实验性后台监听，不干扰医生查房 |
| **CME 培训模拟器** | `plugins/medcius/servers/api/src/learning-engine.mjs` | 教学科研工具，与临床生产查房彻底隔离 |
| **综合实验工作台 HTML** | `plugins/medcius/servers/api/src/ui/workbench.html` | 研发调试保留（访问 `/workbench`），默认路由 `/` 与 `/sidebar` 切换至查房侧边栏 |

---

## 3. 旗舰产品交互规范

- **界面仅保留四块**：
  1. 「发生了什么变化」
  2. 「今天仍待处理什么」
  3. 「哪些资料不足」
  4. 「查看原始证据」
- **三类标签强制标注**：`【原文事实】`、`【规则提醒】`、`【资料不足】`；
- **防自主写回**：严禁 AI 自主写回病历；必须由医生逐项选择、预览并附带电子签名确认后，生成结构化查房记录草稿。
