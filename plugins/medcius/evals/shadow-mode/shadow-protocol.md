# Medcius 前置审方辅助系统 — 多中心静默试点 (Shadow Mode) 临床研究方案

> **方案版本**: v1.0.0 (Pre-registered Protocol)  
> **研究类型**: 前瞻性多中心静默旁路对比研究 (Prospective Multi-Center Shadow-Mode Study)  
> **合规阶段**: Level 2 静默试点 (Silent Pilot)

---

## 1. 研究背景与伦理合规

在医疗软件 (SaMD) 正式向临床医师与药师推送用药干预建议前，必须通过静默试点（Shadow Mode）验证系统在真实多中心异构环境下的准确性、安全性与稳健性。
- **零临床干涉原则**: 系统在医院 HIS/EMR 后台旁路运行，不阻断医生开方，不向医生端弹出阻塞对话框。
- **去标识化与隐私保护**: 所有处方数据严格遵循《个人信息保护法》与 Medcius PHI Guard 规范，敏感标识（身份证/手机号/住址）在院内网关层即时假名化。

---

## 2. 研究设计与盲法 SOP

### 2.1 双药师独立盲标 + 第三人裁决机制
```
                 [ 真实临床脱敏处方流 (Live De-identified Prescriptions) ]
                                      │
            ┌─────────────────────────┼─────────────────────────┐
            ▼                         ▼                         ▼
   [ 药师 A 独立标注 ]        [ 药师 B 独立标注 ]        [ Medcius AI 旁路推理 ]
  (Pharmacist A Gold)        (Pharmacist B Gold)        (AI Shadow Prediction)
            │                         │                         │
            └────────────┬────────────┘                         │
                         ▼                                      │
               [ 一致性校验 A == B ? ]                          │
                ├── 是 ──> 形成初审 Gold                        │
                └── 否 ──> [ 第三人主任药师仲裁 (Adjudication) ]  │
                                      │                         │
                                      ▼                         │
                           [ 最终裁决金标准 (Final Gold) ]       │
                                      │                         │
                                      └────────────┬────────────┘
                                                   ▼
                                  [ 多中心分层效能评估与假设检验 ]
                                   (Wilson 95% CI + McNemar Test)
```

1. **药师 A 与 药师 B 独立标注**: 两位具备 3 年以上临床审方经验的执业药师在不知晓 AI 预测结果、互不商议的前提下独立进行处方安全性审查。
2. **第三人仲裁 (Adjudicator)**: 当药师 A 与 药师 B 判定不一致时，由第三方主任药师进行盲法复核，出具权威裁决意见，作为最终 Gold。
3. **AI 旁路预测**: Medcius 引擎在处方生成瞬间并行运算，输出分维度安全判定（interaction, allergy, renal_dose, contraindication, special_population, duplicate_therapy）。

---

## 3. 分层抽样设计 (Stratification)

研究样本覆盖 3 家不同地域与梯度的三级医疗机构，按科室与药物大类分层：

1. **中心分层 (Hospital Centers)**:
   - 中心 1：北方综合性三甲医院 (Center-North)
   - 中心 2：华东专科医疗中心 (Center-East)
   - 中心 3：华南综合性医院 (Center-South)
2. **科室分层 (Clinical Departments)**:
   - 心血管内科、儿科、肾内科、普通外科、肿瘤科、重症医学科 (ICU)、急诊科
3. **药物大类分层 (Drug Classes)**:
   - 抗菌药物、心血管用药、口服降糖药、抗凝溶栓药、中成药及中西结合复方、特殊管制药品

---

## 4. 预注册主要终点与统计学假设 (Pre-registered Endpoints)

### 4.1 主要终点 (Primary Endpoints)
1. **总体灵敏度 (Sensitivity)**: 预设指标 $\ge 95.0\%$，且其 Wilson 95% 置信区间下限不得低于 $90.0\%$。
2. **总体特异度 (Specificity)**: 预设指标 $\ge 90.0\%$，且其 Wilson 95% 置信区间下限不得低于 $85.0\%$。
3. **严重禁忌零漏报 (Zero Critical Escape)**: 在绝对配伍禁忌、严重过敏休克史及黑框警告维度，系统漏报率必须为 $0.0\%$ ($FN = 0$)。

### 4.2 次要终点 (Secondary Endpoints)
1. **药师间一致性 (Inter-annotator Agreement)**: 药师 A 与 药师 B 间的 Cohen's Kappa 系数 $\kappa \ge 0.80$。
2. **警报疲劳控制 (Alert Precision / PPV)**: 阳性预测值 $\ge 85.0\%$，误报率 (FPR) $< 10.0\%$。
3. **推理时延 (Latency)**: 单张处方平均推理与规则匹配时延 $< 500\text{ ms}$。
