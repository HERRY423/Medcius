# 第一家医院静默试点最小范围（P0）

> Product baseline: 0.8.0-pilot; document revision: 1; approval: DRAFT_UNAPPROVED

> 这是进信息科机房之前必须锁死的范围。不是产品愿景，不是注册材料。超出本页的技能一律视为冻结。

## 做什么

| 项 | 锁定值 |
|---|---|
| 工作流 | 仅 `patient-evolution-summary` |
| 临床入口 | HIS 患者页 iframe `/his/embed` 或院内 SSO；**不是** Codex / Trae / WorkBuddy |
| 数据 | P3 视图库只读：`v_medcius_patient` / `encounter` / `nis_vitals` / `lis_results` / `his_orders`；PACS 后补 |
| 治理 | 最高 `silent_pilot`：不向医生弹窗、不提供病程草稿、不写回 |
| 激活 | IRB 编号 + 数据协议 SHA-256 + 只读账号（`capabilities: ["read"]`） |
| 人因 | 独立观察员秒表；方案草案拟定安全非劣且均节省 ≥ 90 秒，须完成正式预注册。合成测量不能作为临床证据；当前结果见 [证据索引](../evidence/CURRENT-EVIDENCE.md) |

## 冻结与工程储备

`shift-handover`、`consult-preparation`、`discharge-readiness-check` 保持 **P0-FROZEN**。已有源快照、输出一致性和三个工作流的改动属于工程储备与回归保护；本地测试通过不授予医院试点权限。`clinical-landing-policy.mjs` 继续在临床入口拒绝冻结技能。

下一阶段工作优先级按试点缺口排序：

| 顺序 | 交付物 | 当前证据边界 | 关闭条件 |
|---|---|---|---|
| 1 | 院内专科规则包 | 仅 sandbox 包；生产可用包 0 | 医院责任人批准、适用科室/日期明确、批准文档摘要绑定，实际加载通过 |
| 2 | P3 只读视图库联调 | 合成连接器测试，真实联调未验收 | 院方签认映射/账号权限，核验患者/就诊/时间/来源/缺失与停机行为 |
| 3 | IRB 与数据协议 | 仓库没有可作为授权的正式证据 | 伦理/协议/数据处理边界批准，站点激活材料核验 |
| 4 | 原文与资源锚点 | 合成重放含文本、结构化、派生及缺口，非全逐字 span | 逐类固定分母，独立复核；缺口不得变成已核验事实 |
| 5 | 正式知识包 | 正式语料覆盖尚未建立 | 官方来源、版本/生效日、许可与完整性核验；无库保持阻断 |

冻结技能逐个解冻，必须有独立的预期用途、负责医生、权限/输出/失败/回滚契约、独立证据方案和批准记录；经变更评审后同步修改本页、技能状态、临床入口政策和回归测试。共享组件改进不触发自动解冻。现阶段不开展这些技能的新临床功能扩张。

## 不做什么

- 交接班 / 会诊准备 / 出院核对 / 审方
- 医生侧 CDS 卡片、侧边栏插入病程、HIS 写回
- 把 `out/*-report.md` DEMO 报告带进伦理或招标材料
- 在未设 `MEDCIUS_LIVE_HOSPITAL_DATA=1` 且未通过 `site-activation` 时连生产视图库

## 上线命令（院内前置机）

```powershell
$env:MEDCIUS_CLINICAL_LANDING="1"
$env:MEDCIUS_GOVERNANCE_STAGE="silent_pilot"
# 仅在信息科开通只读视图且 IRB/协议齐备后：
# $env:MEDCIUS_LIVE_HOSPITAL_DATA="1"
node scripts/serve.mjs --port 8080
```

HIS 将患者页 iframe 指向 `https://<前置机>/his/embed`，用 `postMessage` 发送 `his:patient-context`。医生看到的是静默提示，不是摘要。

## 验收

```powershell
node tests/test-p0-clinical-landing.mjs
node tests/test-real-connectors.mjs
```
