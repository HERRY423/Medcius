# 文档导航与当前工作范围

当前医院试点仅限 [查房前患者演变静默流程](ops/FIRST-HOSPITAL-SILENT-PILOT.md)。临床范围以该文件与运行时策略为准。产品还包含其他技能，但工程实现不代表临床启用。

- [当前证据与测量身份](evidence/CURRENT-EVIDENCE.md)：区分工程、合成执行、合成指标与临床证据。
- [原文锚定与自动化偏差整改](evidence/SPAN-AND-AUTOMATION-BIAS-REMEDIATION.md)：版本绑定高亮、LIS 可见范围与医院验收边界。
- [PHI 与摘要完整性修复](evidence/PHI-INTEGRITY-METADATA-REMEDIATION.md)：确定性反例、签名/审计回归、严格隐私入口及历史产物核验。
- [评测负对照与院方审核准备](evidence/EVALUATION-CONTROLS-AND-RULE-REVIEW.md)：六类新增负对照、实际评分漏洞及未签署规则包材料。
- [受控文档基线](compliance/qms/CONTROLLED-BASELINE.md)：产品版本、组件版本与文件修订分开；当前待批准。
- [前一轮问题修复](evidence/SCREENSHOT-REMEDIATION.md)：评测、规则与出口安全。
- [本轮范围与门禁修复](evidence/SCOPE-GOVERNANCE-REMEDIATION.md)：冻结、受控文件、检查语义与产物管理。

## 工程升级笔记索引

| 笔记 | 定位 | 临床权限 |
|---|---|---|
| [会诊准备](consult-preparation-upgrade.md) | 冻结工作流的工程储备 | P0-FROZEN |
| [出院文档核对](discharge-document-check-upgrade.md) | 冻结工作流的工程储备 | P0-FROZEN |
| [交接班](shift-handover-upgrade.md) | 冻结工作流的工程储备 | P0-FROZEN |
| [医生界面收敛](doctor-interface-convergence.md) | 参考适配器工程说明 | 受站点与静默模式约束 |
| [MCP 扩展交互](mcp-extension-clinician-interaction.md) | 证据选择、疑点与受限宿主上下文 | 可选面板仅合成资料；原生宿主待验收 |
| [输出一致性](output-consistency-hardening.md) | 共享组件与合成回归 | 不授予新工作流权限 |

这些笔记记录实现细节，不替代医院验收、变更批准或受控产品声明。
