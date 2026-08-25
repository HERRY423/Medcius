# 隐私保护与安全合规巡检 Agent 工作流 (PHI & Privacy Audit Workflow)

## 1. 触发条件
- 医院信息科安全审计与网络安全等级保护（等保三级）自查；
- 个人信息保护影响评估 (PIA) 定期复核；
- 数据出院脱敏管道健康度检查。

---

## 2. 拓扑与工具调用序列

```
[待检查数据源 / 审计日志 / 导出文件]
       │
       ▼
[Step 1: 全要素敏感信息扫描] ───► phiguard:scan
       │ (身份证、手机号、固定电话、银行卡[Luhn校验]、门牌地址、床号、医护签名)
       │
       ▼
[Step 2: 脱敏管道穿透测试] ───► phiguard:redact + phiguard:pseudonymize
       │ (验证 HMAC-SHA256 假名盐机制与不可逆性)
       │
       ▼
[Step 3: 审计链数据防泄漏校验] ───► audit:query_events
       │ (扫描 audit_events 表 payload 中是否存在明文泄露)
       │
       ▼
[Step 4: 区块链完整性独立验签] ───► audit:verify_chain
       │ (逐块比对 SHA-256 默克尔链，识别是否有外部篡改/删除)
       │
       ▼
[Step 5: 综合安全态势报告生成] ───► 安全评分与整改清单
```

---

## 3. 分步执行指令

### Step 1: 敏感要素全面扫描
- **调用工具**: `phiguard:scan`
- **支持识别的实体类型**:
  - `id_card`: 18 位二代居民身份证（含 GB 11643 校验码）
  - `phone_cn_mobile`: 11 位手机号
  - `phone_cn_fixed`: 3-4 位区号 + 7-8 位固定电话
  - `bank_card`: 16-19 位银行卡（经 Luhn 校验确认）
  - `address_label` / `unlabeled_address`: 结构化省/市/区/街道/弄/室住址
  - `mrn_label`: 住院号/门诊号
  - `bed_ward`: 病区与床位号
  - `doctor_label`: 科主任、主诊医师、管床医师、签字医师姓名

### Step 2: 假名盐与一致性校验
- 确保同一批次或跨工作流下同一患者的 pseudonym 生成具有一致性（基于系统统一 SALT）。

### Step 3: 审计链区块链完整性校验
- **调用工具**: `audit:verify_chain`
- 验证所有 block 的 `prev_chain_hash` 与 `chain_hash` 连续性，确保审计轨迹未受任何外部工具修改或非法删除。
