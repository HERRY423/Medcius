# 安全架构与威胁模型（Security Architecture & Threat Model）v1.0

> **用途**：把 Medcius 的安全设计从「分散在各文档的声明」整合为一份**威胁→控制→代码落点→验证方式**的四列映射，作为安全评审与渗透测试的范围基线。对应运维手册 `docs/ops/PRODUCTIZATION-OPERATIONS.md` §3/§6；隐私合规见 `PRIVACY-SECURITY.md`。
> **状态**：v1.0。文中每一项控制均有代码落点与自动化验证；标注 [待落地] 的项需要部署环境配合。

## 1. 资产与信任边界

**核心资产**：患者可识别信息（PHI）、审计哈希链、判定规则完整性、药师签核私钥、官方语料 snapshot。

```text
信任边界 TB1：医生工作站 ↔ 前置机 API（JWT/RBAC、TLS、限流）
信任边界 TB2：前置机 ↔ 医院数据源（只读凭据、GET-only 连接器、出口假名化）
信任边界 TB3：前置机 ↔ LLM（档位 A 不出域 / 档位 B 仅脱敏文本出域 / 档位 C 禁止）
信任边界 TB4：进程内 模型上下文 ↔ 输出（PHI Guard + 证据门控 + signoff）
```

## 2. 已声明的安全不变式（违反即缺陷）

1. **默认关闭**：缺任一上下文（患者/就诊/租户/时间/来源/参考范围）必须 fail-closed；
2. **只读边界**：连接器 `capabilities:["read"]`，写方法在初始化即拒绝；Codex manifest 永不含 `create_resource`/`update_resource`；
3. **出口即假名化**：信封离开连接器进程前完成 `[PSN:*]` 假名化，残留原始 PHI 直接阻断；
4. **审计链 append-only**：任何测试不得为通过而削弱哈希链；
5. **判定不经生成式服务**（ARCH-02/D1）；
6. **写回必须药师 ECDSA P-256 签核且仅在治理 Level 4**。

## 3. 威胁 → 控制 → 落点 → 验证（STRIDE 映射）

| # | 威胁 | 类别 | 控制与代码落点 | 验证 |
|---|---|---|---|---|
| T1 | 伪造/越权 Token 访问 API | Spoofing | 默认关闭鉴权、严格 JWT issuer/audience/alg/租户绑定（`servers/api/src/auth-middleware.mjs`）；RBAC 角色矩阵 | `tests/test-auth-and-rbac.mjs` |
| T2 | 暴力破解凭据 / 凭据填充 | Spoofing | 失败计数锁定（5 次/5 分钟 → 锁 15 分钟）（`security-hardening.mjs` createBruteForceGuard）；生产禁用 `/auth/token` 直发 | `tests/test-security-hardening.mjs` T2/T5 |
| T3 | API 滥用 / 资源耗尽 DoS | DoS | 固定窗口限流（默认 240 req/min，`MEDCIUS_RATE_LIMIT_PER_MIN` 可调）、10MB 请求体上限、health/OPTIONS 豁免 | 同上 T1/T4 |
| T4 | 中间人 / 协议降级 | Tampering | 生产强制 TLS、禁止静默 HTTP（`server.mjs`）；HSTS 仅 TLS 下发送 | `server.mjs` 启动断言 + 加固测试 T3 |
| T5 | 点击劫持 / MIME 嗅探 / 引用泄漏 | Information Disclosure | 全局安全响应头：nosniff、DENY、no-referrer、no-store、CSP frame-ancestors 'none'（`securityHeaders()`） | 加固测试 T3 |
| T6 | 横向越权（跨租户/跨患者读取） | Elevation | 信封六字段逐项比对 + 记录级 patient/encounter 校验（`read-only-hospital-data-bridge.mjs`） | `test-real-connectors.mjs` T4、`test-clinical-closure.mjs` |
| T7 | PHI 经日志/导出/模型上下文泄漏 | Information Disclosure | PHI Guard 前置管道 + 出口守卫双模式阻断（`lib/connectors/phi-exit-guard.mjs`、`servers/phiguard`） | `test-negative-leakage.mjs`、`test-real-connectors.mjs` T6/T7 |
| T8 | 审计记录篡改 | Repudiation | append-only SQLite + SHA-256 哈希链 + verify_chain（`servers/audit`） | `run-all-checks` 各步 verify + health 端点 |
| T9 | 数据库文件窃取 | Information Disclosure | AES-256-GCM 安全存储（`servers/shared/secure-store.mjs`），密钥经 `CLAUDE_MEDCIUS_ENCRYPTION_KEY` 注入 | `tests/test-security.mjs` |
| T10 | 处方判定被伪造 / 冒充药师签核 | Tampering/Spoofing | ECDSA P-256 可验证签名（`servers/shared/digital-signature.mjs`）+ 治理 Level 4 门禁（`lib/governance-mode.mjs`） | `tests/test-governance-mode.mjs` |
| T11 | 官方语料被样例数据静默替换 | Tampering | production-guard H01 硬门闩：official=0 即 halt（`lib/production-guard.mjs`）+ data_class 分层 | `scripts/validate-gate.mjs` |
| T12 | 合成数据冒充临床证据 | Repudiation | 三级通行证分类 + clinical_evidence_pass 独立门禁 | `run-all-checks.mjs` 汇总层 |

## 4. 传输边缘加固基线（v1.0 新增）

| 控制 | 默认值 | 配置项 | 说明 |
|---|---|---|---|
| 限流窗口 | 60s 固定窗口 | — | 每客户端身份（认证用户优先，否则 IP）独立计数 |
| 限流阈值 | 240 req/min | `MEDCIUS_RATE_LIMIT_PER_MIN` | 惰性解析，超限返回 429 + Retry-After |
| 暴力锁定阈值 | 5 次失败 | — | 授权失败计入；成功即清零 |
| 锁定时长 | 15 分钟 | — | 锁定期间所有受限路由 429 |
| 豁免路由 | GET /health、OPTIONS | — | 存活探针不被限流饿死 |
| 安全响应头 | nosniff/DENY/no-referrer/no-store/CSP | — | HSTS max-age=31536000 仅 TLS |

水平扩展部署时，限流/锁定状态应上移至 mTLS 前置网关（运维手册 §3.1 [待落地]），本模块作为单机兜底。

## 5. 密钥管理摘要

| 密钥 | 用途 | 注入方式 | 轮换 |
|---|---|---|---|
| `CLAUDE_MEDCIUS_PHI_SALT` | 假名化盐域 | 密钥管理系统注入 | 见运维手册 §7（需治理委员会同步） |
| `CLAUDE_MEDCIUS_ENCRYPTION_KEY` | AES-256-GCM 存储 | 同上 | 双信封常规流程 |
| TLS 证书/私钥 | 传输加密 | `MEDCIUS_TLS_KEY/CERT` | 院方证书体系 [待落地] |
| 药师签核私钥 | Level 4 写回签名 | 药师本地保管 | 个人级密钥治理 |

## 6. 残余风险与待落地项

- [待落地] mTLS 双向认证与前置网关（依赖院方网络评审，R27）
- [待核] 托管 API 服务商生成式 AI 备案状态（R20）
- 进程内存态限流/锁定在多实例部署下不共享（单机兜底定位已声明）
- CSP 当前允许 `'unsafe-inline'` 样式（侧边栏 UI 需要）；脚本源已锁 'self'
