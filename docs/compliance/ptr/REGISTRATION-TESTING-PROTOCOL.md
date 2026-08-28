# 医疗器械注册检验（性能与网络安全）预测试方案 (REGISTRATION-TESTING-PROTOCOL)

> **版本**：v1.0 (2026-08)  
> **适用范围**：国家级/省级医疗器械检验机构对 Medcius 开展软件性能、网络安全与数据完整性全项注册检验的前置自测与预验方案。

---

## 一、 检验环境与前置准备

1. **测试服务器环境**：标准前置机服务器（64位操作系统，Node.js ≥ v20.0，TLS 1.3 启用）；
2. **测试数据源**：获准使用的标准化测试沙箱（`hospital-cardiology-sandbox.mjs`）及 300 例标准化合成病例文档库；
3. **安全检测工具**：OWASP ZAP、Burp Suite、SSL Labs 证书套件及 Medcius 内置自动化门禁套件。

---

## 二、 重点注册检验项目与自测用例集

### 1. 软件功能性与容错测试（GB/T 25000.51 基础）

| 用例编号 | 检验项目 | 输入条件 | 预期输出与合格判据 | 执行脚本 / 证据 |
|---|---|---|---|---|
| **TC-FUNC-01** | 24h 查房演变事实提取 | 包含体温 38.5℃、血肌酐 142 umol/L、阿托伐他汀医嘱的标准病案 | 准确输出演变摘要，事实与原文 Span 字符级一致。 | `test-preround-summary.mjs` |
| **TC-FUNC-02** | 液体平衡代数和计算 | 入量 2500ml（口服+静脉），出量 1800ml（尿量+引流） | 计算净平衡为 $+700\text{ ml}$，数值严格无误差。 | `test-clinical-landing-advancement.mjs` |
| **TC-FUNC-03** | 缺失参考范围降级 | 检验结果无 LIS 参考区间 | 标记为“无参考区间 (仅呈现趋势)”，不盲目判定异常。 | `test-clinical-safety-rules.mjs` |
| **TC-FUNC-04** | 缺失就诊信息失败关闭 | 请求报文中缺少 `encounter_id` | 立即抛出 `CONTEXT_MISSING` 异常，拒绝向下游输出。 | `test-clinical-safety-rules.mjs` |

---

### 2. 网络安全与抗攻击测试（医疗器械网络安全指导原则基准）

| 用例编号 | 安全检验项目 | 攻击/测试手法 | 预期防护效果 | 执行脚本 / 证据 |
|---|---|---|---|---|
| **TC-SEC-01** | API 暴力破解锁定 | 连续发送 6 次错误凭据请求 | 第 6 次请求触发 IP/用户锁定，返回 HTTP 429 且拒绝服务。 | `test-security-hardening.mjs` |
| **TC-SEC-02** | API 突发流量限流 | 1 秒内突发发送超过 100 次请求 | 超出阈值请求被平滑丢弃，返回 HTTP 429 与 Retry-After。 | `test-security-hardening.mjs` |
| **TC-SEC-03** | 安全响应头强化 | 发起常规 GET 请求并检查 HTTP Header | 响应头包含 `X-Content-Type-Options: nosniff`、`Strict-Transport-Security`。 | `test-security-hardening.mjs` |
| **TC-SEC-04** | 跨患者越权隔离 | 携带 Tenant-A 凭据请求 Tenant-B 患者 | 抛出租户隔离违规，拒绝数据返回。 | `test-auth-and-rbac.mjs` |
| **TC-SEC-05** | 传输层 mTLS 双向认证 | 使用未注册或伪造的客户端证书建立连接 | TLS 握手在网关层被直接拒绝，无法建立 TCP 连接。 | `test-enterprise-deployment.mjs` |

---

### 3. 数据隐私与脱敏防护测试

| 用例编号 | 检验项目 | 输入条件 | 预期防护效果 | 执行脚本 / 证据 |
|---|---|---|---|---|
| **TC-PRIV-01** | 敏感证件号脱敏 | 病历中包含真实身份证号与手机号 | 出口守卫 100% 擦除或替换为假名化哈希 Token。 | `test-negative-leakage.mjs` |
| **TC-PRIV-02** | 审计链防篡改校验 | 手动修改 SQLite/JSON 审计记录某个字段 | 校验器 `verify_chain` 立即报告哈希不匹配，审计红线报警。 | `test-security.mjs` |

---

## 三、 预检验全量执行与自检结论

在向检验所正式送检前，执行全量自动化预测试流水线：
```powershell
node scripts/run-all-checks.mjs
```
**自测判定准则**：所有 37 项性能、安全、合规与算法门禁必须 100% 呈现 PASS，无任何 Warning 或未捕获异常。
