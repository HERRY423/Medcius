# 隐私与安全基线（Privacy & Security Baseline）

> 工程约束文档：定义 Medcius 处理患者数据的**默认强制规则**。与《个人信息保护法》《数据安全法》《健康医疗数据安全指南》严格对齐。

## 1. 数据流与最小化

```
处方/病历文本 ──▶ phiguard.scan/redact ──▶ 技能门控判定 ──▶ audit.record_event（仅脱敏后内容）
                     │                                              │
                     └─ 原文永不进入：日志 / 审计链 / 导出 / 长期记忆      └─ signoff（药师可验证数字签名签核）
```

- **强制规则 1**：自由文本进入日志、审计、导出、模型上下文前必须经过 `phiguard` 扫描与假名化。
- **强制规则 2**：审计链 `record_event` 内建硬性正则与算法守卫，身份证/手机号/银行卡原文一律无条件硬性拒绝，彻底废除任何 acknowledged 绕过通行路径。
- **强制规则 3**：`subject_ref` 一律用假名（`phiguard.pseudonymize` 的 `[PSN:*]` 或机构侧 MRN 映射），盐值由环境 `CLAUDE_MEDCIUS_PHI_SALT` 或安全随机生成，杜绝任何硬编码固定 salt。
- **强制规则 4**：生产环境 API 默认强制 `includeSamples=false`，官方知识包未就绪时直接触发 `PRODUCTION_GATE_HALT`，杜绝样例数据混入生产。

## 2. 存储与传输安全

| 项 | 现状 | 缓解 / 落地实现 | 目标 |
|---|---|---|---|
| 传输加密 (In-Transit) | TLS 1.3 / HTTPS 原生支持 | `servers/api/src/server.mjs` 支持证书与私钥配置 (`MEDCIUS_TLS_CERT`/`KEY`) | 院内前置网关 mTLS 双向认证 |
| 字段级加密与存储 (At-Rest) | AES-256-GCM 密文存储 | `shared/crypto.mjs` + `shared/secure-store.mjs` 密文落盘 | 对接医院硬件加密机 / KMS |
| 审计库防篡改 | 哈希链 + append-only 触发器；`synchronous=FULL` | 定期 `verify_chain`；导出附 head_hash 异地复核 | 医保与药监合规归档存证 |
| 可验证电子签名 | ECDSA P-256 密码学签名 | `shared/digital-signature.mjs` 绑定药师公钥，支持签名验证与防篡改 | 电子处方防抵赖法律效力 |
| 密钥与盐值管理 | 动态随机生成 / 环境变量注入 | 严禁明文硬编码默认 salt，禁止入库、禁止写日志 | 院内 KMS 自动轮换 |

## 3. 访问控制、身份鉴权与多租户隔离 (RBAC & Multi-Tenancy)

- **统一身份认证**: 支持 SMART on FHIR / OIDC 标准 JWT Bearer Token 及医院统一身份网关头 (`X-Hospital-Token`)。
- **细粒度 RBAC 角色体系**:
  - `physician` (医生): 发起处方审核、调取编码建议、处理会诊。
  - `pharmacist` (药师): 处方审核、人工签核 (`signoff` agree/override/reject)、查看质控与学习报表。
  - `auditor` (合规审计员): 链条完整性校验 (`verify_chain`)、审计日志检索与安全导出。
  - `admin` (系统管理员): 知识包管理、QC 异常扫描、阶段发布状态机晋升。
  - `system` (HIS 内部集成): 自动化流水线集成。
- **多租户逻辑隔离**: 全链路透传 `tenant_id`，审计事件、学习记忆与本地知识包在租户维度严格隔离。

## 4. 四阶段阶梯发布治理状态机

系统内置阶梯式发布控制状态机 (`lib/governance-mode.mjs`)：
1. **Level 1 回顾性研究 (Retrospective Study)**: 离线合成管线测试与历史脱敏评测，严禁 HIS 写回。
2. **Level 2 静默试点 (Silent Pilot / Shadow Mode)**: 真实临床旁路并行推理，双药师独立盲标 + 第三人裁决，零临床打扰。
3. **Level 3 建议模式 (Advisory Mode)**: 前置非阻塞提醒，药师自主选择，收集 override 理由。
4. **Level 4 认证签核写回 (Certified Writeback)**: 药师完成 ECDSA 数字签名签核后，方可向 HIS 处方系统写回。
**禁止跨级跳跃发布**，晋级必须提供完备的先决条件证据。

## 5. 事件响应与负向防泄漏保障

- 自动化负向泄漏测试套件 (`tests/test-negative-leakage.mjs`) 覆盖 18 位身份证、手机号、银行卡号、深度嵌套 JSON 注入等多种攻击与失误场景。
- 疑似安全异常立即触发 `verify_chain` 审计校验与异动报告。
