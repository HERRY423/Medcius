# 医生处方质量画像与持续改进 Agent 工作流 (Doctor Quality & CME Workflow)

## 1. 触发条件
- 质控科/医务处定期处方点评与质量月报；
- 医生登录工作台查看个人处方质量驾驶舱；
- 触发主动质控告警（如连续多次发生高危拦截或被药师驳回）。

---

## 2. 拓扑与工具调用序列

```
[时间窗口与医师/科室标识]
       │
       ▼
[Step 1: 审计链数据多维检索] ───► audit:query_events
       │ (检索过滤: 审方事件、药师签核记录、override 事件)
       │
       ▼
[Step 2: 质量指标统计与雷达图计算] ───► api:getDoctorQualityMetrics
       │ (综合评分、5大维度雷达: 禁忌证/相互作用/剂量/重复/特殊人群)
       │
       ▼
[Step 3: 缺陷归因与统计学显著性分析]
       │ (识别 Top 3 易错陷阱类别与高发科室分布)
       │
       ▼
[Step 4: 靶向 CME 实训案例与国家权威指南智能映射] ───► api:getContinuousImprovementRecommendations
       │ (国家卫健委《处方管理办法》、中华医学会指南条文精准关联)
       │
       ▼
[Step 5: 学习闭环与知识记忆沉淀] ───► memory:remember + 题库考核
```

---

## 3. 分步执行指令

### Step 1: 审计链事件检索与清洗
- **调用工具**: `audit:query_events`
- **过滤条件**: `actor = 'agent-prescription-reviewer'`, `time_range = [T-90d, Now]`
- **数据关联**: 将 `rx_review_verdict` 与对应的 `pharmacist_signoff` 关联，提取药师是 `agree`, `override` 还是 `reject`。

### Step 2: 5 维雷达图与合规得分计算
- **计算维度**:
  1. `contraindication_adherence`: 禁忌证依从率
  2. `interaction_prevention`: 相互作用防范率
  3. `dosage_accuracy`: 剂量与器官功能匹配率 (CrCl)
  4. `duplicate_avoidance`: 避免重复用药率
  5. `special_population_safety`: 特殊人群（儿科/孕产/老年）安全度

### Step 3: 针对性改进建议生成
- 对低分维度自动匹配内置指南知识库：
  - 剂量不足/过量 $\to$ 《中国成人慢性肾脏病患者合理用药指南》
  - 相互作用 $\to$ 《他汀类药物临床应用专家共识》CYP3A4 代谢抑制
  - 交叉过敏 $\to$ 《β-内酰胺类抗菌药物皮肤试验指导原则》
- 推送对应的交互式 CME 实训案例供医师自主演练。
