# Medcius — 住院医生查房前“患者变化摘要”插件

<p align="center">
  <a href="https://github.com/HERRY423/Medcius/releases"><img src="https://img.shields.io/badge/version-0.2.0--pilot-blue.svg" alt="Version 0.2.0-pilot"></a>
  <a href="https://hl7.org/fhir/smart-app-launch/STU2.2/"><img src="https://img.shields.io/badge/SMART_on_FHIR-STU_2.2-green.svg" alt="SMART on FHIR 2.2"></a>
  <a href="https://cds-hooks.hl7.org/2.0/"><img src="https://img.shields.io/badge/CDS_Hooks-2.0_(patient--view)-orange.svg" alt="CDS Hooks 2.0"></a>
  <a href="file:///LICENSE"><img src="https://img.shields.io/badge/license-MIT-lightgrey.svg" alt="License MIT"></a>
  <img src="https://img.shields.io/badge/CI_Quality_Gates-14%2F14_PASS-brightgreen.svg" alt="CI Gates Pass">
  <img src="https://img.shields.io/badge/Data_Security-Local_Stdio_%2F_PHI_Guarded-blueviolet.svg" alt="Local Security">
</p>

---

## 1. 产品定位与临床核心价值 (Flagship Overview)

**Medcius** 专注于解决住院医生晨交班与查房前的核心痛点：在海量电子病历、检验单和医嘱中快速获知患者最新演变。

医生在医院已有 EHR 中打开患者病历或查房列表时，插件通过 **SMART on FHIR 2.2** 自动预取当前患者上下文，无需输入患者姓名或病历号，以**极简一屏式 4 块界面**呈现病情动态：

```
+-------------------------------------------------------------------------------+
|  床位 12  张** (65岁 男)    就诊号: IP-2026-90812 | 诊断: 冠心病，2型糖尿病      |
|  摘要跨度: [ 过去 24 小时 (Active) ]  [ 过去 72 小时 ]              [↻ 刷新]  |
+-------------------------------------------------------------------------------+
| 1. 发生了什么变化 (What Changed)                                               |
|   ☑ 【原文事实】 症状演变: 今日晨起诉胸闷好转，无心悸，体温最高 37.8℃          |
|   ☑ 【原文事实】 异常检验: 血肌酐: 142 μmol/L (基线 88 -> 当前 142, ↑ +54.0)  |
|   ☑ 【原文事实】 异常检验: 血钾: 4.1 mmol/L (基线 3.2 -> 当前 4.1, ↑ +0.9)    |
|   ☑ 【原文事实】 + 新增用药: 注射用头孢曲松钠 2.0g ivgtt qd                   |
|   ☑ 【原文事实】 - 停用医嘱: 呋塞米片 20mg po bid (水肿消退，停用利尿剂)        |
|   ☑ 【原文事实】 ~ 剂量调整: 硝苯地平控释片 30mg qd -> 60mg qd                |
+-------------------------------------------------------------------------------+
| 2. 今天仍待处理什么 (What's Pending)                                          |
|   ☑ 【待出报告】 胸部 CT 平扫 (08-23 14:00 检查已完成，待出终报)              |
|   ☑ 【待出报告】 血液细菌培养及药敏 (08-22 20:00 标本检验中)                   |
|   ☑ 【待办医嘱】 24小时动态心电图 (Holter) 今日 09:30 执行                    |
|   ☑ 【待办会诊】 肾内科床旁会诊 (评估急性肾功能恶化原因)                      |
+-------------------------------------------------------------------------------+
| 3. 哪些资料不足 (Critical Data Gaps)                                          |
|   ☑ 【资料不足】 过敏史未明确记录 (查房时需重点向家属补问青霉素过敏史并补录)   |
|   ☑ 【资料不足】 入院体重未录入 (护士站需补测体重以核算剂量)                  |
+-------------------------------------------------------------------------------+
| 4. 查看原始证据 (Source Evidence & Exact Spans)                               |
|   • 点击任意条目即可高亮展开病历原文真实 Span、检验单号与 FHIR Resource ID       |
+-------------------------------------------------------------------------------+
|  [☑ 全选]   已选 10 项                                 [ ✍️ 插入查房记录 ]    |
+-------------------------------------------------------------------------------+
```

---

## 2. 严格的临床与合规边界 (Clinical Safety Boundaries)

1. **三不原则**：
   - **不诊断**：不生成鉴别诊断或结论性病情定性；
   - **不制定治疗方案**：不自主推荐药品或处方组合；
   - **不自主写回病历**：默认严格只读，必须由医生勾选确认并附带电子签名，方可生成标准查房病程草稿。
2. **三类标签体系**：
   - `【原文事实】`：严格源自病历原文段落或 LIS/EMR 原始数据；
   - `【规则提醒】`：基于确定性算法与说明书知识的边界提醒；
   - `【资料不足】`：明确标出关键缺失要素（如未录入过敏史、缺少 48h 肾功能、未测体重）。
3. **失败关闭 (Fail-Closed)**：
   - 请求缺失有效的患者 ID 或就诊记录时，直接返回提示卡片，**严禁在真实临床请求中回退生成任何虚构患者或合成病历**。
4. **动态 LIS 参考区间优先 (Trend-Only 模式)**：
   - 优先使用医院 LIS / FHIR 提供的 `observation.referenceRange`；
   - **参考区间缺失时**：系统自动切换为“仅趋势模式”，只计算 $\Delta$ 波动值与方向箭头（$\uparrow / \downarrow$），严禁主观判断偏高/偏低或危急值。
5. **零伪造原文 Span**：
   - 彻底禁止通过字符串拼接制造虚假“原文 Span”；结构化资源未命中病历原文时 `span` 严格置 `null`，确保证据链 100% 真实客观。

---

## 3. 核心架构与生产本地服务 (Architecture)

Medcius 生产运行时采用极窄、极稳的无状态架构，全部计算与存储均在医院内网本地完成，不连接外部公网服务：

```
+-----------------------------------------------------------------------------------+
|                           Hospital EHR / EMR UI                                   |
|                                                                                   |
|  [ SMART App Launch 2.2 ]                  [ CDS Hooks 2.0: patient-view ]        |
|            │                                              │                       |
|            ▼                                              ▼                       |
|  +─────────────────────────────────────────────────────────────────────────────+  |
|  |           Medcius Pre-Round Sidebar (preround-sidebar.html)                 |  |
|  +─────────────────────────────────────────────────────────────────────────────+  |
|            │                                              │                       |
|            ▼                                              ▼                       |
|  +──────────────────────────────────+    +─────────────────────────────────────+  |
|  |   PatientEvolutionEngine         |    |   Security & Compliance             |  |
|  |   • 24h / 72h Diff 计算          |    |   • Local PHI Guard (本地脱敏)      |  |
|  |   • 动态 LIS 检验趋势            |    |   • Local Audit Chain (SHA-256)     |  |
|  |   • 用药调整方案对比             |    |   • Digital Signature (电子签名)    |  |
|  |   • 待办事项与资料缺口           |    |   • Fail-Closed (失败关闭)          |  |
|  +──────────────────────────────────+    +─────────────────────────────────────+  |
|            │                                              │                       |
|            ▼                                              ▼                       |
|  +─────────────────────────────────────────────────────────────────────────────+  |
|  |              Local MCP Servers (stdio Only, Zero Data Outflow)              |  |
|  |   1. FHIR                  (SMART on FHIR 2.2 / EHR 资源连接器)             |  |
|  |   2. Contracts Analyzer    (documents / 结构化病历客观提取)                 |  |
|  |   3. PHI 卫士 (phiguard)   (纯本地隐私敏感信息扫描与脱敏)                   |  |
|  |   4. 本地审计链 (audit)    (不可篡改哈希审计与验签)                         |  |
|  +─────────────────────────────────────────────────────────────────────────────+  |
+-----------------------------------------------------------------------------------+
```

> **注**：多 Agent 编排引擎（Supervisor）、管理驾驶舱（Analytics）、CME 培训模拟器、医保编码检索等历史组件已彻底物理隔离在 [`experimental/`](experimental/README.md) 目录中，不随生产包默认启动。

---

## 4. 快速开始 (Quick Start)

### 4.1 启动本地生产服务

```bash
# 启动 Medcius 生产 HTTP 与 CDS Hooks 2.0 服务
node plugins/medcius/servers/api/src/server.mjs
```

服务就绪后：
- **查房前摘要侧边栏 UI**：`http://localhost:8080/sidebar?patient_id=IP-2026-90812`
- **CDS Hooks 2.0 发现端点**：`http://localhost:8080/cds-services`
- **健康检查与门禁状态**：`http://localhost:8080/health`

### 4.2 安装到 Claude Code

```bash
/plugin marketplace add HERRY423/Medcius
/plugin install medcius@medcius
```

### 4.3 运行全量 14 项生产质量门禁 (CI Quality Gates)

```bash
node scripts/run-all-checks.mjs
```

---

## 5. 质量门禁与准入三级分类 (Three-Tier Pass Status)

Medcius 严格执行医疗软件质量门禁三级分类体系：

| 分类层级 | 状态 | 准入标准 |
|---|---|---|
| **1. `engineering_pass`** | 🟢 **PASS** | 单元测试、代码规范、API 契约与构建隔离 100% 通过 |
| **2. `synthetic_validation_pass`** | 🟢 **PASS** | 合成临床陷阱评测（53 案例）、动态区间计算与负向泄漏测试通过 |
| **3. `clinical_evidence_pass`** | 🔒 **BLOCKED** | **严禁将合成测试当做临床有效性依据**；必须经由独立三甲医院专家双盲标定、第三人仲裁的多中心影子研究（$\kappa \ge 0.80$）方可解锁正式临床发布通行证 |

---

## 6. 开源许可与贡献

本项目采用 [MIT License](LICENSE)。欢迎医疗信息化工程师、临床专家与药师共同参与建设！