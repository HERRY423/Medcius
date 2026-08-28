# 质量管理体系受控文件与程序文件（SOP）清单 (QMS-CONTROLLED-DOCUMENTS)

> **版本**：v1.0 (2026-08)  
> **受控范围**：Medcius 临床工作流 Agent 插件全生命周期研发与产品化文档。

---

## 一、 文件层级架构 (Hierarchy of Documentation)

```text
┌─────────────────────────────────────────────────────────────┐
│  一级文件：质量手册 (Quality Manual)                        │
├─────────────────────────────────────────────────────────────┤
│  二级文件：程序文件 / 标准操作规程 (Standard Operating Procedures) │
├─────────────────────────────────────────────────────────────┤
│  三级文件：设计历史文件 (Design History File, DHF) / 技术报告│
├─────────────────────────────────────────────────────────────┤
│  四级文件：质量记录 / 自动化测试日志 / 审计链哈希快照        │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、 二级受控程序文件（SOP 清单）

| 文件编号 | 程序文件名称 | 负责部门 | 核心关联实施文件 |
|---|---|---|---|
| **SOP-DEV-01** | **医疗器械软件生存周期与设计控制规程** | 研发部 | [`docs/compliance/dhf/SRS-CN-SKILLS.md`](file:///c:/Medcius/docs/compliance/dhf/SRS-CN-SKILLS.md) |
| **SOP-DEV-02** | **软件配置管理与版本命名控制规程** | 研发部 | [`docs/compliance/dhf/VERSION-NAMING.md`](file:///c:/Medcius/docs/compliance/dhf/VERSION-NAMING.md) |
| **SOP-DEV-03** | **医疗器械软件风险管理操作规程** | 质保部/研发部 | [`docs/compliance/dhf/RISK-MANAGEMENT.md`](file:///c:/Medcius/docs/compliance/dhf/RISK-MANAGEMENT.md) |
| **SOP-DEV-04** | **软件缺陷管理、变更控制与发布规程** | 研发部/测试部 | [`scripts/validate-build-isolation.mjs`](file:///c:/Medcius/scripts/validate-build-isolation.mjs) |
| **SOP-SEC-05** | **医疗数据安全、网络安全与隐私脱敏规程** | 安全与合规部 | [`docs/compliance/privacy/DATA-PROTECTION-IMPACT-ASSESSMENT.md`](file:///c:/Medcius/docs/compliance/privacy/DATA-PROTECTION-IMPACT-ASSESSMENT.md) |
| **SOP-CLN-06** | **临床评价与影子研究真实世界数据采集规程** | 医学事务部 | [`docs/compliance/IRB-PROTOCOL-FRAMEWORK.md`](file:///c:/Medcius/docs/compliance/IRB-PROTOCOL-FRAMEWORK.md) |
| **SOP-QA-07** | **质量管理体系内部审核与管理评审规程** | 质保部 | [`docs/compliance/qms/QMS-INTERNAL-AUDIT-CHECKLIST.md`](file:///c:/Medcius/docs/compliance/qms/QMS-INTERNAL-AUDIT-CHECKLIST.md) |

---

## 三、 三级受控设计历史文件（DHF 清单）

| 文档编号 | 文档名称 | 对应标准条款 | 当前状态 |
|---|---|---|---|
| **DHF-01** | 软件需求规格说明书 (SRS) | IEC 62304 §5.2 | 🟢 受控 (`SRS-CN-SKILLS.md`) |
| **DHF-02** | 软件系统安全与架构设计说明书 | IEC 62304 §5.3 | 🟢 受控 (`SECURITY-ARCHITECTURE.md`) |
| **DHF-03** | 软件风险管理报告 (RMR) | ISO 14971 §4-§8 | 🟢 受控 (`RISK-MANAGEMENT.md`) |
| **DHF-04** | 需求-设计-测试双向追溯性矩阵 | IEC 62304 §5.2.6 | 🟢 自动同步 (`TRACEABILITY.md`) |
| **DHF-05** | 软件产品技术要求 (PTR 送审稿) | GB/T 25000.51 | 🟢 受控 (`PRODUCT-TECHNICAL-REQUIREMENTS.md`) |
| **DHF-06** | 软件单元与系统集成验证测试报告 | IEC 62304 §5.5-§5.7 | 🟢 自动生成 (37 项门禁通过) |
| **DHF-07** | 个人信息保护影响评估报告 (PIA) | 个保法 §55 | 🟢 受控 (`DATA-PROTECTION-IMPACT-ASSESSMENT.md`) |
| **DHF-08** | 临床评价报告大纲与影子研究报告 | 医疗器械临床评价指导原则 | 🟢 受控 (`CLINICAL-EVALUATION-REPORT-FRAMEWORK.md`) |

---

## 四、 四级质量记录与审计凭证

- **Git 提交不可变审计**：所有代码与文书变更均附带 PGP 签名与 Git Hash；
- **本地 SHA-256 审计链**：`plugins/medcius/servers/audit/` 持续记录每一个事件的 Merkle 链条；
- **CI 自动化门禁测试记录**：`scripts/run-all-checks.mjs` 每次全量回归生成结构化退出状态与控制台日志。
