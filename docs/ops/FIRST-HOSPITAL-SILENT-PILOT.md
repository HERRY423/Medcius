# 第一家医院静默试点最小范围（P0）

> 这是进信息科机房之前必须锁死的范围。不是产品愿景，不是注册材料。超出本页的技能一律视为冻结。

## 做什么

| 项 | 锁定值 |
|---|---|
| 工作流 | 仅 `patient-evolution-summary` |
| 临床入口 | HIS 患者页 iframe `/his/embed` 或院内 SSO；**不是** Codex / Trae / WorkBuddy |
| 数据 | P3 视图库只读：`v_medcius_patient` / `encounter` / `nis_vitals` / `lis_results` / `his_orders`；PACS 后补 |
| 治理 | 最高 `silent_pilot`：不向医生弹窗、不提供病程草稿、不写回 |
| 激活 | IRB 编号 + 数据协议 SHA-256 + 只读账号（`capabilities: ["read"]`） |
| 人因 | 独立观察员秒表；预注册终点为安全非劣且均节省 ≥ 90 秒。合成 79% 不得当临床证据 |

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
