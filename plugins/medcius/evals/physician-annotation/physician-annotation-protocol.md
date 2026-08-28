# Medcius 查房前患者变化摘要 — 独立临床医生双盲标注与仲裁研究方案 (Physician Annotation Protocol)

> **方案版本**: v1.0.0 (Pre-registered Protocol)  
> **研究类型**: 前瞻性住院病区连续病例双盲标注与仲裁对照研究 (Double-Blind Clinician Annotation & Adjudication Study)  
> **对应工作流**: 住院查房前患者病情演变与关键变化摘要 (Inpatient Pre-Round Patient Evolution Summary)  
> **合规阶段**: Level 2 静默试点与临床证据预研 (Silent Pilot & Evidence Pre-evaluation)

---

## 1. 研究背景与伦理合规 (Background & Ethics)

在查房前患者变化摘要插件正式向住院医师开放临床辅助前，必须通过独立执业医师的双盲标注，客观评估 AI 结构化提取在症状演变、检验趋势、待办排期、安全缺口以及原文证据溯源上的准确性、完备性与可信度。

- **零临床干扰原则 (Zero Clinical Interference)**：研究在医院测试沙箱与历史/脱敏连续病例上进行，不影响真实病区诊疗与医嘱下达；
- **隐私保护 (PHI Guard)**：所有入组病历严格遵循《个人信息保护法》，在标注前完成假名化与去标识化处理。

---

## 2. 标注流程与双盲 SOP (Double-Blind SOP)

```text
               [ 住院病区连续入组病例 (Consecutive Inpatient Ward Cases) ]
                                            │
                  ┌─────────────────────────┼─────────────────────────┐
                  ▼                         ▼                         ▼
         [ 医生 A 独立盲标 ]        [ 医生 B 独立盲标 ]        [ Medcius AI 旁路提取 ]
       (Physician A Gold)        (Physician B Gold)        (AI Shadow Prediction)
                  │                         │                         │
                  └────────────┬────────────┘                         │
                               ▼                                      │
                     [ 一致性校验 A == B ? ]                          │
                      ├── 是 ──> 形成初审 Gold                        │
                      └── 否 ──> [ 第三人主任医师仲裁 (Adjudication) ] │
                                            │                         │
                                            ▼                         │
                                 [ 最终裁决金标准 (Final Gold) ]       │
                                            │                         │
                                            └────────────┬────────────┘
                                                         ▼
                                        [ 多维度效能评估与置信区间检验 ]
                                         (Wilson 95% CI + Cohen's Kappa)
```

### 2.1 参与专家资质
1. **标注医生 A 与 医生 B**：两名具备 3 年以上临床住院总/主治医师执业资质的心血管内科医师，在互不商议、不知晓 AI 提取结果的前提下独立完成标注；
2. **第三人仲裁专家 (Adjudicator)**：具备 10 年以上临床经验的心内科主任医师，负责在医生 A 与医生 B 判定不一致时出具最终裁决。

---

## 3. 标注维度与判定标准 (Evaluation Dimensions)

| 评估维度 | 标注关注点 | 合格判定要求 |
|---|---|---|
| **1. 症状与病情演变** | 24/72h 内主诉改善、加重、新发体征 | 原文语义一致、断言准确 (present/absent/possible) |
| **2. 异常检验与动态** | LIS 检验升降趋势、危急值识别 | 严格遵从动态参考区间；无参考区间时不得武断标为异常 |
| **3. 用药医嘱调整** | 新增、停用、剂量调整、限制级抗菌药天数 | 医嘱变更类型无遗漏、疗程计算准确 |
| **4. 待办与追踪事项** | 未出报告的影像、微生物培养、未执行会诊 | 待办事项全覆盖，排期时点准确 |
| **5. 临床资料缺口** | 过敏史缺失、基线肌酐缺失、参考区间缺失 | 必须显式提示医生，严禁隐瞒或幻觉补全 |
| **6. 原文证据保真度** | 提取条目是否具备字面一致的原文 Span | 严禁捏造或跨段拼接虚假 Span ($FP_{span} = 0$) |

---

## 4. 预注册主要终点与统计学门槛 (Pre-registered Endpoints)

### 4.1 主要终点 (Primary Endpoints)
1. **总体灵敏度 (Sensitivity)**: $\ge 95.0\%$，且 Wilson 95% 置信区间下限 $\ge 90.0\%$；
2. **总体特异度 (Specificity)**: $\ge 90.0\%$，且 Wilson 95% 置信区间下限 $\ge 85.0\%$；
3. **双医生标注一致性 (Cohen's Kappa)**: $\kappa \ge 0.80$；
4. **关键演变零漏报 (Zero Critical Escape)**: 在严重病情加重、检验危急值与过敏史缺口维度，漏报率必须为 0 ($FN = 0$)；
5. **虚构证据零容忍 (Zero Fabricated Spans)**: 虚构或不匹配 Span 数量必须为 0 ($FP_{span} = 0$)。

### 4.2 三级合规通行证分类 (Three-Tier Pass Classification)
- `1. engineering_pass`: 算法公式、分层统计引擎与置信区间计算无误；
- `2. synthetic_validation_pass`: 沙箱合成病例与模拟标注达到预设门槛；
- `3. clinical_evidence_pass`: 仅在获得三甲医院伦理委员会 (IRB) 批件、三位执业医师数字签名及不可篡改数据集 SHA-256 审计链后方可认定。
