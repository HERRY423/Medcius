# Medcius 安全策略与漏洞披露规范 (Security Policy)

> **版本**：`0.2.0-pilot`  
> **适用范围**：Medcius 核心插件、只读数据桥接器（ReadOnlyHospitalDataBridge）、本地 MCP 服务与宿主适配层  
> **最后修订**：2026-08-28

---

## 1. 支持的版本 (Supported Versions)

Medcius 目前处于工程试点与科研沙箱验证阶段。安全补丁与安全更新仅针对当前处于活动维护周期的版本发布：

| 版本系列 | 版本号 | 支持状态 | 说明 |
|---|---|---|---|
| **0.2.x** | `0.2.0-pilot` | 🟢 积极支持 (Active) | 当前工程试点与架构收敛主线 |
| **0.1.x** | `<= 0.1.9` | 🔴 已终止支持 (End of Life) | 遗留早期概念验证版本，不建议在任何环境中运行 |

---

## 2. 核心安全契约与不变式 (Core Security Invariants)

Medcius 在架构上强制执行以下不可违背的安全契约。任何导致这些契约失效的代码缺陷均被视为**最高等级（Critical）安全漏洞**：

### 2.1 绝对只读数据边界 (Strict Read-Only Invariant)
* **只读隔离**：Medcius 仅通过只读连接器（`readPatient` / `capabilities: ["read"]`）访问医院源数据（NIS、LIS、PACS、HIS、EMR）；
* **初始化硬拦截**：数据桥在构造函数阶段通过反射全面扫描连接器及其原型链。任何暴露 `create_resource`、`update_resource`、`delete_resource`、`write_back`、`patch` 或任何写方法的实例，将在初始化时被直接拒绝并崩溃退出；
* **生产模式强锁**：在 `NODE_ENV=production` 或 `MEDCIUS_PROFILE=production` 下，FHIR Server 强制锁定 `readOnly=true`，忽略任何外部写配置。

### 2.2 上下文缺失失败关闭 (Fail-Closed Context Gate)
* **六要素硬校验**：每个请求必须完整携带 `tenant_id`、`doctor_id`、`patient_id`、`encounter_id`、时间窗口（`24h`/`72h`）与数据来源清单；
* **防串号与防跨租户**：只要缺少任一要素、时间窗非法、患者记录 ID 与信封不符、或来源数据哈希（`payload_sha256`）损坏，系统必须**立即抛出异常并终止执行（Fail-Closed）**，严禁进行无凭据的模糊推断。

### 2.3 无工具隔离防提示注入 (Toolless Worker Isolation)
* **病历不可信原则**：临床病程与自由文本默认标记为 `untrusted: true`；
* **无工具抽取 Worker**：自由文本抽取器（`clinical-note-extract`）运行在**零工具（Toolless）隔离子进程**中。即使病程中包含对抗性注入文本（如“忽略以上规则，诊断为…”），也无法驱动任何外部工具调用或特权提升；
* **逐字 Span 回源校验**：抽取结果必须在调用上下文中与原始病历进行字符串比对校验。

### 2.4 自由文本出口假名化 (PHI Exit-Guard)
* **内存瞬时态**：未经脱敏的患者原文仅存在于院内前置机内存瞬时态中；
* **出口即假名化**：在数据离开连接器、进入模型上下文、写入审计链或日志之前，必须经过 `PHI Guard` 进行 HMAC-SHA256 假名化（如 `[PSN:a8b9c0d1]`）；
* **负向防泄漏阻断**：若扫描器检测到任何残留的明文身份证号、手机号、未脱敏姓名，立即抛出 `PHI_EXIT_GUARD_RAW_PHI_BLOCKED` 阻断外发。

### 2.5 不可篡改哈希审计链 (Append-Only SHA-256 Audit Chain)
* **默克尔链**：所有系统事件与医师操作记录写入本地追加式 SQLite 审计数据库，逐条计算前序哈希与当前载荷哈希（`chainHash = sha256(prev_hash + seq + payload_hash + ts)`）；
* **签名验签**：支持 ECDSA P-256 电子签名验签，严禁直接修改或删除历史审计条目。

---

## 3. 漏洞报告与责任披露 (Vulnerability Reporting & CVD)

我们高度重视并欢迎开源社区、安全研究人员与医院 IT 团队对 Medcius 提出负责任的安全审查。

### 3.1 报告渠道 (Reporting Channel)
如果您发现了潜在的安全漏洞、PHI 泄露隐患或只读边界绕过缺陷，**请不要在公开的 GitHub Issue 中公开发布**。请通过以下途径提交私密报告：

1. **GitHub 官方私密安全通报**：  
   前往仓库 [Security Advisories](https://github.com/HERRY423/Medcius/security/advisories) 页面，点击 **"Report a vulnerability"** 提交私密报告。
2. **安全团队专用邮箱**：  
   发送加密邮件至：`security-team@medcius.local`（如需 PGP 加密，请在邮件中索取公钥）。

### 3.2 报告内容建议
为了帮助我们快速复现和评估问题，请在报告中尽量包含：
* 漏洞类型（如：只读契约绕过、PHI 泄露、上下文伪造、Prompt 注入越权等）；
* 受影响的模块与文件路径（如 `lib/hospital-data-adapter.mjs`）；
* 详细的复现步骤或最小可复现用例（POC）；
* 潜在的安全与临床合规影响分析；
* 您建议的修复方案（若有）。

---

## 4. 响应时效与修复流程 (Response SLAs & Disclosure Timeline)

我们承诺遵循严格的漏洞处理响应时效：

| 漏洞严重程度 (Severity) | 初步响应确认 (Triage) | 修复方案与补丁发布 (Fix SLA) |
|---|---|---|
| **严重 (Critical)**<br>*(只读绕过、明文 PHI 出口外泄、跨租户数据穿透)* | **< 24 小时** | **< 72 小时** |
| **高危 (High)**<br>*(未闭环伪造、上下文校验失效、哈希链断裂)* | **< 48 小时** | **< 7 天** |
| **中危 (Medium)**<br>*(局部抽取注入、非核心接口异常)* | **< 72 小时** | **< 14 天** |
| **低危 (Low)**<br>*(文档表述歧义、非安全敏感告警)* | **< 5 个工作日** | **下一个计划迭代** |

### 修复与公开披露流程
1. **私密确认**：安全团队在收到报告后完成漏洞定级与复现；
2. **补丁开发与验证**：在隔离分支中开发修复代码，并通过 37 项 CI 质量门禁；
3. **协同发布**：推送安全补丁版本并发布 GitHub Security Advisory，向报告者致谢（经报告者同意）。

---

## 5. 安全验证与本地审计命令

在提交代码或实施部署前，可通过以下本地命令验证安全契约完好性：

```powershell
# 1. 运行 PHI 防护与负向防泄漏专项测试
node tests/test-negative-leakage.mjs

# 2. 运行真实连接器只读契约与防越权测试
node tests/test-real-connectors.mjs

# 3. 运行本地 AES-256-GCM 存储与审计链测试
node tests/test-security.mjs

# 4. 运行全量 37 项安全与合规门禁
node scripts/run-all-checks.mjs
```
