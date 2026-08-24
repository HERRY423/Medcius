# 隐私与安全基线（Privacy & Security Baseline）

> 工程约束文档：定义 Medcius 处理患者数据的**默认强制规则**。与《个人信息保护法》《数据安全法》《健康医疗数据安全指南》的对齐条目标 **[待核]** 表示需合规部门最终确认。

## 1. 数据流与最小化

```
处方/病历文本 ──▶ phiguard.scan/redact ──▶ 技能门控判定 ──▶ audit.record_event（仅脱敏后内容）
                     │                                              │
                     └─ 原文永不进入：日志 / 审计链 / 导出 / 长期记忆      └─ signoff（药师签核）
```

- **强制规则 1**：自由文本进入日志、审计、导出、模型上下文前必须过 `phiguard`。
- **强制规则 2**：审计链 `record_event` 内建正则守卫，身份证/手机号原文直接拒绝（`phi_guard='acknowledged'` 留痕为已知晓风险，供极少数受控场景）。
- **强制规则 3**：`subject_ref` 一律用假名（`phiguard.pseudonymize` 的 `[PSN:*]` 或机构侧 MRN 映射），盐经 `CLAUDE_MEDCIUS_PHI_SALT` 注入。

## 2. 存储安全（诚实现状 + 路线）

| 项 | 现状 | 缓解 | 目标 |
|---|---|---|---|
| SQLite 明文落盘 `~/.claude/data/medcius/*` | 是 | 目录权限 0700；宿主磁盘加密（BitLocker/FileVault）；数据不出本机 | 字段级加密：`shared/crypto.mjs` 已提供 AES-256-GCM，用于 reversible 映射表与未来敏感列 |
| 审计库防篡改 | 哈希链 + append-only 触发器；`synchronous=FULL` | 定期 `verify_chain`；导出附 head_hash 异地复核 | — |
| 密钥管理 | 盐/密钥经环境变量注入 | 禁止入库、禁止写日志；轮换时旧 token 作废声明 | 接机构 KMS |

## 3. 访问与角色（院内部署前提）

- 医师：发起审核、查看自己患者的判定；
- 药师：`signoff`（agree/override/reject）——未签核批次不视为完成；
- admin：语料导入（official 数据包）、审计导出、`verify_chain`；
- 以上角色映射到院内账号体系是私有化交付的一部分，插件层先以 `actor/signer` 字符串占位并要求真实身份（测试环境除外）。

## 4. 事件与响应

- 疑似 PHI 泄漏 → 立即 `verify_chain` 确认审计完整 → 导出涉事时段 `export_batch` → 按机构流程上报 **[待核：个保法通知时限]**。
- 语料投毒/版本异常 → `corpus_status` 的 source 清单 + snapshot 链可定位引入点；official 包导入必须记录来源 URL 与文件哈希。

## 5. 已知边界（不冒充）

- phiguard 不检测无标签裸姓名、住址、固话、银行卡；
- SQLite 非 SQLCipher 全库加密；
- 本文档不构成法律合规意见。
