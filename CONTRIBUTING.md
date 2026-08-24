# Medcius 社区共创指南 (Contributing Guide)

欢迎加入 **Medcius** 开源共创社区！

Medcius 致力于构建面向中国临床的**去幻觉（Evidence-Gated）、高合规、本地化**医疗 AI Agent 基础设施与微服务体系。我们坚信：**真正可靠的医疗 AI 不能仅由算法工程师闭门造车，必须由一线临床医师、药师、医学生、病案编码员与技术专家共同塑造与严谨校验。**

无论你是医学院在读学生、规培医师、临床药师、病案编码员，还是开源开发者，你的每一行医学规则、每一个对抗陷阱用例、每一份脱敏标注，都将直接帮助中国医疗信息化走向更安全、高效的未来！

---

## 🌟 核心贡献方向 (Contribution Tracks)

你可以根据自身的专业背景与兴趣，选择以下任意方向参与共创：

### 🩺 Track 1: 临床医生与医学生 (Clinicians & Medical Students)
- **临床病历对抗测试用例构建**：
  - 编写或补充典型的合成出院记录/门诊病历（位于 `plugins/medcius/skills/clinical-note-extract/assets/china-notes/`）。
  - 覆盖临床常见陷阱：**疑似/待查诊断（不升阶）、既往手术史 vs 本次手术、阴性体征、预防性用药（非诊断）、检验异常（非并发症）**。
- **临床交互与真实工作流优化**：
  - 测试 HL7 FHIR CDS Hooks 开医嘱卡片在真实科室场景的合理性。
  - 提出临床医生站（EMR）免切屏交互与辅助录入的痛点和改进建议。

### 💊 Track 2: 临床药师与药学专业人员 (Clinical Pharmacists)
- **处方审核陷阱集共创**：
  - 向 `plugins/medcius/evals/china-skills/cases/prescription-review.json` 补充临床高频不合理处方用例。
  - 覆盖：**儿童无体重剂量核算、老人肾功能减退肌酐换算（$\mu\text{mol/L}$）、中西药配伍禁忌（十八反十九畏）、CYP450 酶代谢互补信号、超说明书剂量**。
- **药品说明书结构化语料包整理**：
  - 协助校验和扩充本地官方说明书库（`Local Drug Labels`），标注适应症、禁忌、相互作用章节原文。
- **真实世界双盲金标准标注**：
  - 参与 `plugins/medcius/evals/clinical-validation/` 批次验证，提供药师专业盲标（Gold Standard），评估算法灵敏度与特异度。

### 📊 Track 3: 病案编码员与医保管理专家 (Medical Coders & NHSA Specialists)
- **医保版 ICD-10 编码与手术操作映射校验**：
  - 核验临床诊断名称到国家医保版 ICD-10 标准编码的转换规则（如 `.8` 特指与 `.9` 未特指的区别）。
  - 区分结算清单手术操作编码与卫健委 CCHI 收费项目的边界。
- **医保结算清单质控规则完善**：
  - 补充主要诊断选择合规性规则、性别/年龄限制规则及各省市 DRG/DIP 分组前置机检条件。
- **省级医保待遇文件整理**：
  - 整理各省门诊慢特病认定标准、报销比例政策文件，扩充 `nhsa-policy` 的 Layer 3 知识库。

### 💻 Track 4: 软件工程师与医学信息学开发者 (Engineers & Informaticians)
- **临床系统接口与集成**：
  - 扩展 CDS Hooks 钩子类型（如 `patient-view`、`order-select`），开发主流 HIS/EMR 系统的适配器。
- **安全与本地算法优化**：
  - 强化中文临床实体命名识别（NER）脱敏模型，优化 `phiguard` 规则库与 AES-256-GCM 加密存储。
- **知识图谱与多 Agent 调度**：
  - 优化 `ClinicalSupervisor` 的任务编排与状态机，构建医药知识图谱推理引擎。

---

## 🛡️ 医学伦理与患者隐私第一准则 (Ethics & Privacy First)

> [!CAUTION]
> **绝对红线：任何提交的内容严禁包含真实患者的未脱敏隐私信息！**

1. **去标识化强制要求**：
   - 提交任何病历或处方样例前，必须通过 `PHI Guard` 扫描脱敏，患者姓名必须采用假名（如 `张三` 或 `[PSN:xxx]`），身份证号、真实住院号、联系电话、详细家庭住址必须使用合成虚拟数据。
2. **证据出处可追溯 (No Hallucination)**：
   - 任何新增的审方规则、医保政策，必须提供明确的**官方文件文号、现行药品说明书版本或权威临床指南出处**。严禁凭大模型记忆或个人直觉编造。
3. **开源授权**：
   - 所有贡献的代码、用例与规则库将以 **MIT License** 开源，造福全行业。

---

## 🚀 参与共创流程 (Step-by-Step Workflow)

### 1. Fork 并克隆仓库
```bash
git clone https://github.com/你的用户名/Medcius.git
cd Medcius
```

### 2. 本地环境自检与运行
```bash
# 检查本地环境与语料状态
node scripts/doctor.mjs

# 运行自动化评测套件
node scripts/run-evals.mjs

# 运行所有功能测试
node tests/test-security.mjs
node tests/test-supervisor.mjs
node tests/test-cds-hooks.mjs
node tests/test-api-routes.mjs
```

### 3. 创建分支并进行修改
```bash
git checkout -b feat/add-pediatric-prescription-cases
# 进行修改、编写测试用例
```

### 4. 提交测试与回归验证
确保所有自动化门闩与测试均 100% 通过：
```bash
node scripts/validate-gate.mjs
node scripts/validate-skills.mjs
```

### 5. 提交 Pull Request
- 提交 PR 时，请简要说明：
  1. 贡献类型（病历抽取/医保编码/审方规则/接口代码）；
  2. 医学依据来源（如《抗菌药物临床应用指导原则》、《国家医保药品目录(2024)》等）；
  3. 本地测试通过截图。

---

## 🏆 贡献者致谢与荣誉 (Recognition)

每一位参与贡献的医学生、临床专家与开发者，都将被永久记录在 Medcius 项目的 **Contributors 贡献者名单** 与发布 Release Notes 中。

感谢你与我们一起，用严谨的医学证据和工程力量，守护临床医疗 AI 的安全底线！❤️
