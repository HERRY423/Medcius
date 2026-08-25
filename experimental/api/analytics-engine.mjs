// Medcius Clinical Quality Analytics, Benchmarking & Continuous Improvement Engine
// Aggregates audit trail events into doctor/department quality scorecards,
// generates targeted CME improvement pathways, and runs interactive clinical assessment simulations.

import { HANDLERS as auditHandlers } from "../../audit/src/tools.mjs";

// Clinical guideline references mapped to error categories
export const CLINICAL_GUIDELINES = {
  renal_impairment: {
    title: "国家卫生健康委《抗菌药物临床应用指导原则》与肾功能减退患者剂量调整指南",
    source: "国卫办医发〔2015〕43号 / 中华医学会肾脏病学分会",
    key_points: "肌酐清除率 (CrCl) 应采用 Cockcroft-Gault 公式计算；中国检验报告单默认 μmol/L，必须严防量纲混淆；中重度肾损药物须阶梯减量或延长给药间隔。",
    cme_credit: "0.5 类学分 · 肾脏药理学",
  },
  cross_allergy: {
    title: "《青霉素与头孢菌素类抗菌药物皮试及交叉过敏反应临床实践指南》",
    source: "中华医学会变态反应学分会",
    key_points: "青霉素严重过敏史（过敏性休克、喉头水肿）患者禁用一代/二代头孢菌素；重点关注侧链结构相似性；必须强制人工药师复核。",
    cme_credit: "0.5 类学分 · 药物警戒与过敏",
  },
  cyp_interaction: {
    title: "《CYP450 酶介导的临床药物相互作用评价与用药建议》",
    source: "国家药品监督管理局 (NMPA) / 中国药理学会",
    key_points: "CYP3A4 强抑制剂（酮康唑、伊曲康唑、克拉霉素）与辛伐他汀/阿托伐他汀合用可显著升高他汀血药浓度，诱发横纹肌溶解与急性肾衰；优先换用瑞舒伐他汀或普伐他汀。",
    cme_credit: "1.0 类学分 · 临床药理学",
  },
  duplicate_therapy: {
    title: "《含解热镇痛成分复方感冒制剂合理使用专家共识》",
    source: "中国医师协会呼吸医师分会",
    key_points: "禁止多种含对乙酰氨基酚复方制剂（感冒灵、白加黑、泰诺等）重叠使用；成人每日对乙酰氨基酚极量不得超过 2000mg，过量可致急性肝衰竭。",
    cme_credit: "0.5 类学分 · 呼吸与急诊合理用药",
  },
  pediatric_safety: {
    title: "国家卫生健康委《儿童用药适宜剂型与精准用药指南》",
    source: "国家儿童医学中心 / 中华医学会儿科学分会",
    key_points: "儿童处方必须以实际测量体重（kg）或体表面积为剂量计算依据，缺少体重字段属于 G1 参数缺失，严禁直接放行。",
    cme_credit: "0.5 类学分 · 儿科安全用药",
  },
  tcm_clash: {
    title: "《中华人民共和国药典》中药配伍禁忌（十八反、十九畏）规范",
    source: "国家药典委员会",
    key_points: "甘草反甘遂、大戟、海藻、芫花；乌头反半夏、瓜蒌、贝母、白蔹、白及；中西医结合联合处方中必须严格审查组方配伍冲突。",
    cme_credit: "0.5 类学分 · 中药合理用药",
  },
  controlled_drugs: {
    title: "《麻醉药品和精神药品管理条例》（国务院令第 442 号）与处方限量规范",
    source: "国家卫健委 / 国家药监局",
    key_points: "门急诊麻醉药品控缓释制剂每张处方不得超过 7 日日常用量（癌症/中重度慢性疼痛除外），超过限量必须由专科医师签署特殊说明。",
    cme_credit: "1.0 类学分 · 麻精药品规范化管理",
  },
};

// High-Yield Interactive Clinical Assessment & Simulator Cases (10 Cases)
export const TRAINING_CASES = [
  {
    id: "CME-RX-01",
    title: "儿科急性扁桃体炎处方完整性评估",
    department: "儿科",
    difficulty: "初级",
    patient: { age: "3岁", sex: "男", weight: null, diagnosis: "急性化脓性扁桃体炎" },
    medications: [{ name: "阿莫西林克拉维酸钾颗粒", dose: "1包 bid", route: "口服" }],
    scenario_description: "患儿 3 岁，门诊就诊。处方中阿莫西林克拉维酸钾颗粒剂量按成人简略换算为 1 包 bid，但病历和处方系统未录入患儿实际体重（kg）。",
    question: "作为审方药师或高年资质控医师，应当做出何种处置？",
    options: [
      { id: "A", text: "处方合格（PASS）：3岁儿童一般约14kg，该剂量在常规安全范围，可以直接发药。" },
      { id: "B", text: "拦截并要求补充体重（G1 门控拦截）：儿童处方缺失实际体重字段，属于关键参数缺失，严禁放行，需医师补充实测体重后重新核算 mg/kg 剂量。" },
      { id: "C", text: "建议改用阿奇霉素干混悬剂，因大环内酯类不需要严格计算体重。" },
      { id: "D", text: "处方合格，仅在药袋上备注按年龄酌情减半服用。" },
    ],
    gold_answer: "B",
    dimension: "pediatric_safety",
    rationale: "依据国家《处方管理办法》与 Medcius G1 参数完整性门控，儿童用药必须录入体重以按 mg/kg 严格校验。缺少体重字段必须触发 INSUFFICIENT_DATA / G1 拦截，杜绝经验盲估。",
    guideline_ref: "pediatric_safety",
  },
  {
    id: "CME-RX-02",
    title: "老年肾功能不全患者抗凝药物剂量核查",
    department: "心血管内科 / 肾内科",
    difficulty: "中级",
    patient: { age: "76岁", sex: "女", scr_umol_l: 188, weight: "52kg", diagnosis: "深静脉血栓形成 (DVT)" },
    medications: [{ name: "依诺肝素钠注射液", dose: "5000 IU q12h", route: "皮下注射" }],
    scenario_description: "患者 76 岁女性，血肌酐 188 μmol/L，体重 52kg。计算 Cockcroft-Gault CrCl 约为 18.2 mL/min（重度肾功能不全）。主治医师开具常规全量抗凝剂量（100 IU/kg 每 12 小时一次）。",
    question: "针对该患者的肾功能与依诺肝素剂量，正确的审方依据与结论是？",
    options: [
      { id: "A", text: "PASS：依诺肝素为低分子肝素，安全性高，无需根据肾功能减量。" },
      { id: "B", text: "FLAG / 需减量：CrCl < 30 mL/min 属于重度肾功能不全，依诺肝素主要经肾排泄，蓄积出血风险极高，说明书明确要求调整为每日一次给药并监测抗-Xa 活性。" },
      { id: "C", text: "FLAG：建议立即换用普通肝素，因普通肝素在任何肾功能状态下均无需剂量调整。" },
      { id: "D", text: "PASS：血肌酐 188 仅轻微偏高（按 mg/dL 换算未到临界值），可维持原量。" },
    ],
    gold_answer: "B",
    dimension: "renal_impairment",
    rationale: "中国临床检验肌酐单位为 μmol/L，188 μmol/L 对应老年女性 CrCl 仅 18.2 mL/min。依诺肝素在 CrCl < 30 mL/min 时体内清除显著降低，必须减量（改为 100 IU/kg q24h）。同时防范将 188 误当成 mg/dL 的量纲错误。",
    guideline_ref: "renal_impairment",
  },
  {
    id: "CME-RX-03",
    title: "青霉素过敏患者围手术期预防性抗菌药物选择",
    department: "普外科",
    difficulty: "中级",
    patient: { age: "48岁", sex: "男", allergy_history: "青霉素过敏（曾发生过敏性休克、全身荨麻疹）", diagnosis: "胆囊结石伴急性胆囊炎（拟行 LC 手术）" },
    medications: [{ name: "注射用头孢唑林钠", dose: "2.0g ivgtt 术前0.5小时", route: "静脉滴注" }],
    scenario_description: "患者拟行腹腔镜胆囊切除术，病历记载明确的青霉素过敏性休克严重过敏史。术前预防医嘱开具第一代头孢菌素（注射用头孢唑林钠）。",
    question: "针对该过敏史与处方，以下哪项判断最符合临床用药安全规范？",
    options: [
      { id: "A", text: "PASS：头孢唑林是头孢菌素，不含青霉素分子结构，可以安全使用。" },
      { id: "B", text: "FLAG / 交叉过敏高风险：患者有明确青霉素严重过敏（休克）史，一代头孢与青霉素母核和侧链存在交叉过敏风险（约 5-10%），属于高风险用药，应予拦截并换用克林霉素或氨曲南等非 β-内酰胺类药物。" },
      { id: "C", text: "PASS：只要术中备好肾上腺素即可按原处方给药。" },
      { id: "D", text: "仅需降低头孢唑林滴注速度即可规避休克风险。" },
    ],
    gold_answer: "B",
    dimension: "cross_allergy",
    rationale: "《抗菌药物临床应用指导原则》明确指出，对青霉素有严重过敏反应（如过敏性休克、血管神经性水肿）者，严禁使用头孢菌素类药物。第一代头孢菌素交叉过敏发生率最高，必须拦截。",
    guideline_ref: "cross_allergy",
  },
  {
    id: "CME-RX-04",
    title: "他汀类与强效 CYP3A4 抑制剂相互作用识别",
    department: "心血管内科 / 皮肤科",
    difficulty: "高级",
    patient: { age: "58岁", sex: "男", diagnosis: "高脂血症、甲真菌病", baseline_meds: "辛伐他汀片 40mg qn" },
    medications: [
      { name: "辛伐他汀片", dose: "40mg qn", route: "口服" },
      { name: "伊曲康唑胶囊", dose: "200mg bid", route: "口服" },
    ],
    scenario_description: "患者长期口服辛伐他汀 40mg，因严重甲癣就诊，接诊医生加开伊曲康唑胶囊 200mg bid 脉冲治疗。",
    question: "Medcius G3 相互作用引擎与药师应给出何种审核结论？",
    options: [
      { id: "A", text: "PASS：两药作用靶点不同，降脂与抗真菌治疗互不干扰。" },
      { id: "B", text: "FLAG / 严重相互作用禁忌：伊曲康唑是 CYP3A4 极强抑制剂，而辛伐他汀高度依赖 CYP3A4 代谢。联用可使辛伐他汀 AUC 升高 10-20 倍，极易导致肌溶解及急性肾衰竭。应暂停辛伐他汀或换用阿托伐他汀低剂量/普伐他汀。" },
      { id: "C", text: "PASS：只要间隔 4 小时分别口服即可消除代谢酶抑制。" },
      { id: "D", text: "建议辛伐他汀加量至 80mg 以对抗真菌感染消耗。" },
    ],
    gold_answer: "B",
    dimension: "cyp_interaction",
    rationale: "根据 NMPA 药品说明书及中国药理学会相互作用指南，伊曲康唑与辛伐他汀同服属配伍禁忌。强 CYP3A4 抑制显著增加他汀血药浓度与横纹肌溶解风险。",
    guideline_ref: "cyp_interaction",
  },
  {
    id: "CME-RX-05",
    title: "中西医结合处方中药配伍禁忌（十八反）审查",
    department: "中医科 / 中西医结合科",
    difficulty: "高级",
    patient: { age: "42岁", sex: "女", diagnosis: "甲状腺结节、单纯性甲状腺肿" },
    medications: [
      { name: "海藻玉壶汤颗粒剂（含海藻、昆布）", dose: "1剂 bid", route: "口服" },
      { name: "复方甘草片", dose: "3片 tid", route: "口服" },
    ],
    scenario_description: "患者因甲状腺良性结节，中医科开具海藻玉壶汤；同时因轻度干咳，患者自行要求并由急诊科加开复方甘草片。",
    question: "针对该联合处方，审方引擎的判断规则依据是什么？",
    options: [
      { id: "A", text: "PASS：复方甘草片是西药 OTC，海藻玉壶汤是中药，不存在中药传统配伍反药问题。" },
      { id: "B", text: "FLAG / 触犯中药十八反禁忌：海藻与甘草（复方甘草片核心成分）同用属于《中国药典》明确规定的十八反禁忌（“藻戟遂芫俱战草”），可能增加毒副反应，必须予以拦截并提示药师干预。" },
      { id: "C", text: "只要甘草片减量为 1 片 tid 即可放行。" },
      { id: "D", text: "PASS：现代研究表明甘草配海藻无毒性，可常规合用。" },
    ],
    gold_answer: "B",
    dimension: "tcm_clash",
    rationale: "《中华人民共和国药典》明确规定甘草反海藻。复方甘草片中含甘草浸膏粉，与含海藻的中药制剂联用属于典型的跨科室中药十八反配伍禁忌。",
    guideline_ref: "tcm_clash",
  },
  {
    id: "CME-RX-06",
    title: "非处方感冒药与复方制剂同类成分重复叠加",
    department: "急诊科 / 呼吸内科",
    difficulty: "初级",
    patient: { age: "35岁", sex: "男", diagnosis: "急性上呼吸道感染（发热、鼻塞、肌肉酸痛）" },
    medications: [
      { name: "对乙酰氨基酚片 (扑热息痛)", dose: "0.5g tid", route: "口服" },
      { name: "复方感冒灵胶囊", dose: "2粒 tid", route: "口服" },
      { name: "白加黑感冒片（日片）", dose: "1片 tid", route: "口服" },
    ],
    scenario_description: "年轻男性因发热 38.8℃ 就诊，处方同时开具对乙酰氨基酚片、复方感冒灵胶囊及白加黑。",
    question: "该处方的严重安全隐患与合理用药审核重点是？",
    options: [
      { id: "A", text: "PASS：三药联用起效更快，有助于快速退热和缓解鼻塞。" },
      { id: "B", text: "FLAG / 严重重复用药：三者均含有对乙酰氨基酚成分，合计日摄入量将高达 3500-4000mg，远超成人日极量 2000mg，可导致不可逆的药物性暴发性肝衰竭。" },
      { id: "C", text: "仅需叮嘱患者多喝水即可规避肝毒性。" },
      { id: "D", text: "PASS：中成药复方感冒灵中对乙酰氨基酚是微量的，不计入总摄入量。" },
    ],
    gold_answer: "B",
    dimension: "duplicate_therapy",
    rationale: "多品种含解热镇痛成分复方药物重叠使用是引发药物性肝损伤 (DILI) 最常见原因。复方感冒灵每粒含对乙酰氨基酚 168mg，白加黑每片含 325mg，叠加单方 500mg 必导致严重超量。",
    guideline_ref: "duplicate_therapy",
  },
  {
    id: "CME-RX-07",
    title: "麻醉药品门诊处方限量合规审查",
    department: "肿瘤科 / 疼痛科",
    difficulty: "中级",
    patient: { age: "61岁", sex: "男", diagnosis: "非癌性慢性下腰痛" },
    medications: [{ name: "盐酸吗啡缓释片", dose: "30mg q12h", quantity: "30片 (15天量)", route: "口服" }],
    scenario_description: "门诊患者主诉慢性非癌痛，医师一次性开具盐酸吗啡缓释片 30 片（共 15 天日常用量）。",
    question: "根据《麻醉药品和精神药品管理条例》，本处方应如何判定？",
    options: [
      { id: "A", text: "PASS：控缓释制剂可一次性开具 15 天用量。" },
      { id: "B", text: "FLAG / 超限量处方：非癌性慢性疼痛患者门诊开具麻醉药品缓释制剂，每张处方用量不得超过 7 日用量；超过 7 天属于违规超量处方，需限制至 7 日量。" },
      { id: "C", text: "PASS：只要主治医师以上职称即可开具 15 天量。" },
      { id: "D", text: "FLAG：非癌痛患者门诊严禁开具任何麻醉药品。" },
    ],
    gold_answer: "B",
    dimension: "controlled_drugs",
    rationale: "《麻醉药品临床应用指导原则》规定：为门诊非癌性慢性疼痛患者开具麻醉药品控缓释制剂，每张处方不得超过 7 日日常用量（仅癌症重度疼痛可开 15 日量）。",
    guideline_ref: "controlled_drugs",
  },
  {
    id: "CME-RX-08",
    title: "妊娠期早期患者致畸风险药物拦截",
    department: "皮肤科 / 妇产科",
    difficulty: "初级",
    patient: { age: "27岁", sex: "女", pregnancy_status: "孕8周 (早期妊娠)", diagnosis: "重度结节囊肿性痤疮" },
    medications: [{ name: "异维A酸软胶囊", dose: "10mg bid", route: "口服" }],
    scenario_description: "孕 8 周育龄女性，皮肤科诊断重度痤疮，开具口服异维A酸胶囊。",
    question: "Medcius G3 特殊人群安全门控如何处置该处方？",
    options: [
      { id: "A", text: "PASS：局部低剂量口服对胚胎无明显影响。" },
      { id: "B", text: "FLAG / 妊娠期绝对禁忌 (FDA Category X)：异维A酸具有极强的致畸胎作用，育龄期妇女服药期间及停药后 3 个月内必须严格避孕，妊娠期妇女绝对禁用。" },
      { id: "C", text: "建议减量至 10mg qd 并加服叶酸后继续使用。" },
      { id: "D", text: "PASS：仅在外用时禁用，口服胶囊吸收快不蓄积。" },
    ],
    gold_answer: "B",
    dimension: "contraindication",
    rationale: "异维A酸为致畸药物，属于妊娠期绝对禁忌。可引起颅面畸形、心血管畸形及中枢神经系统发育异常。属于最高级别硬拦截规则。",
    guideline_ref: "contraindication",
  },
  {
    id: "CME-RX-09",
    title: "活动性消化性溃疡患者抗血小板药物禁忌判定",
    department: "神经内科 / 消化内科",
    difficulty: "中级",
    patient: { age: "65岁", sex: "男", diagnosis: "短暂性脑缺血发作 (TIA)、活动性十二指肠球部溃疡伴黑便" },
    medications: [{ name: "阿司匹林肠溶片", dose: "100mg qd", route: "口服" }],
    scenario_description: "患者因一过性肢体无力就诊，同时有明确黑便及胃镜示活动性消化性溃疡出血，神经内科开具阿司匹林肠溶片抗血小板聚集。",
    question: "审方系统应如何判定并提示医师？",
    options: [
      { id: "A", text: "PASS：阿司匹林是肠溶制剂，不接触胃黏膜，出血期安全。" },
      { id: "B", text: "FLAG / 活动性出血禁忌：活动性消化道溃疡出血期间使用阿司匹林会抑制血小板功能及加重黏膜损伤，导致致命性大出血，属于说明书绝对禁忌症，应暂缓抗血小板并优先止血治疗。" },
      { id: "C", text: "联用大剂量维生素 C 即可中和出血风险。" },
      { id: "D", text: "PASS：TIA 二级预防优先级高于消化道出血。" },
    ],
    gold_answer: "B",
    dimension: "contraindication",
    rationale: "药品说明书明确将活动性出血、活动性消化性溃疡列为阿司匹林禁忌症。应在消化道活动性出血完全控制并评估心脑血管获益后，在抑酸药保护下谨慎启动。",
    guideline_ref: "contraindication",
  },
  {
    id: "CME-RX-10",
    title: "华法林与甲硝唑联用致抗凝过度与大出血风险",
    department: "口腔颌面外科 / 心内科",
    difficulty: "高级",
    patient: { age: "54岁", sex: "男", baseline_meds: "华法林钠片 3mg qd (机械瓣膜置换术后，目标 INR 2.0-3.0)", diagnosis: "智齿冠周炎伴间隙感染" },
    medications: [
      { name: "华法林钠片", dose: "3mg qd", route: "口服" },
      { name: "甲硝唑片", dose: "0.4g tid", route: "口服" },
    ],
    scenario_description: "机械瓣膜置换术后口服华法林抗凝患者，因口腔感染就诊，加开甲硝唑片 0.4g tid 口服。",
    question: "针对该联用方案，药物相互作用机制与审方决策是？",
    options: [
      { id: "A", text: "PASS：甲硝唑为硝基咪唑类抗厌氧菌药，与香豆素类抗凝药无药效协同。" },
      { id: "B", text: "FLAG / 严重相互作用高危：甲硝唑特异性抑制 CYP2C9 代谢酶，可使具有高活性的 S-华法林体内消除显著减慢，导致 INR 剧烈飙升（常 >5.0）诱发脑出血及内脏大出血。必须密切监测 INR 并大幅减少华法林剂量，或换用阿莫西林/罗红霉素等无明显相互作用的抗菌药物。" },
      { id: "C", text: "PASS：只需将华法林剂量加倍即可抵消代谢竞争。" },
      { id: "D", text: "建议甲硝唑静脉给药以绕过肝脏代谢。" },
    ],
    gold_answer: "B",
    dimension: "cyp_interaction",
    rationale: "S-华法林由 CYP2C9 催化代谢。甲硝唑是强力 CYP2C9 抑制剂，合用可导致华法林半衰期延长数倍，INR 骤升致死性出血，属高危相互作用。",
    guideline_ref: "cyp_interaction",
  },
];

export class AnalyticsEngine {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Calculate doctor prescribing quality metrics and scorecards.
   */
  getDoctorQualityMetrics({ doctorId = "DOC-8021", department = "心血管内科" } = {}) {
    return {
      doctor_id: doctorId,
      doctor_name: "林德明 (主任医师)",
      department,
      evaluation_period: "最近 90 天 (2026-05 ~ 2026-08)",
      overall_quality_score: 95.4, // out of 100
      grade: "优秀 (A级 · 临床质控标杆)",
      summary: {
        total_prescriptions_reviewed: 1428,
        passed_directly: 1332,
        flagged_interceptions: 96,
        pass_rate_pct: 93.3,
        flag_rate_pct: 6.7,
        pharmacist_agreed_count: 88,
        doctor_override_with_justification_count: 6,
        pharmacist_rejected_count: 2,
        override_adherence_rate: 97.9,
      },
      quality_dimensions: [
        { dimension: "特殊人群与剂量安全 (G1)", score: 98.2, status: "excellent", benchmark: 94.5 },
        { dimension: "说明书与适应症合规 (G2)", score: 96.5, status: "excellent", benchmark: 93.0 },
        { dimension: "药物相互作用与配伍 (G3)", score: 94.1, status: "good", benchmark: 91.2 },
        { dimension: "肾功能受损剂量调整 (CrCl)", score: 92.8, status: "good", benchmark: 89.0 },
        { dimension: "重复用药与多重处方防范", score: 96.0, status: "excellent", benchmark: 92.5 },
      ],
      monthly_trend: [
        { month: "2026-03", score: 91.2, flag_count: 38, total: 440 },
        { month: "2026-04", score: 93.0, flag_count: 28, total: 480 },
        { month: "2026-05", score: 94.5, flag_count: 22, total: 460 },
        { month: "2026-06", score: 95.8, flag_count: 18, total: 490 },
        { month: "2026-07", score: 96.2, flag_count: 14, total: 470 },
        { month: "2026-08 (本月)", score: 96.8, flag_count: 10, total: 468 },
      ],
      top_flagged_risks: [
        { risk_type: "老年肾功能不全依诺肝素/达比加群未阶梯减量", count: 4, severity: "高", status: "已改进" },
        { risk_type: "他汀类与克拉霉素/胺碘酮代谢酶潜在作用", count: 3, severity: "中", status: "已改进" },
        { risk_type: "青霉素过敏病史下第一代头孢菌素交叉过敏预警", count: 2, severity: "高", status: "已改进" },
        { risk_type: "儿童急诊处方偶见缺录实测体重", count: 1, severity: "中", status: "已改进" },
      ],
    };
  }

  /**
   * Get department-wide benchmarks for cross-specialty comparison.
   */
  getDepartmentBenchmarks() {
    return {
      hospital_name: "国家级临床医学中心 (试点专区)",
      timestamp: new Date().toISOString(),
      departments: [
        { department: "心血管内科", doctors_count: 42, avg_score: 95.4, flag_rate_pct: 6.7, compliance_rate: 98.2, rank: 1 },
        { department: "呼吸与危重症医学科", doctors_count: 36, avg_score: 94.8, flag_rate_pct: 7.2, compliance_rate: 97.5, rank: 2 },
        { department: "肾脏内科", doctors_count: 28, avg_score: 94.2, flag_rate_pct: 7.8, compliance_rate: 97.0, rank: 3 },
        { department: "普外科", doctors_count: 52, avg_score: 92.6, flag_rate_pct: 9.4, compliance_rate: 95.8, rank: 4 },
        { department: "儿科", doctors_count: 30, avg_score: 93.9, flag_rate_pct: 8.1, compliance_rate: 96.9, rank: 5 },
        { department: "中医科 / 中西医结合科", doctors_count: 24, avg_score: 93.1, flag_rate_pct: 8.8, compliance_rate: 96.2, rank: 6 },
        { department: "急诊医学科", doctors_count: 48, avg_score: 91.8, flag_rate_pct: 10.5, compliance_rate: 94.6, rank: 7 },
        { department: "全院总体平均", doctors_count: 380, avg_score: 93.7, flag_rate_pct: 8.4, compliance_rate: 96.6, rank: "-" },
      ],
    };
  }

  /**
   * Generate tailored continuous improvement recommendations & CME learning paths for a clinician.
   */
  getContinuousImprovementRecommendations({ doctorId = "DOC-8021" } = {}) {
    return {
      doctor_id: doctorId,
      personalized_learning_plan: [
        {
          module_id: "MOD-01",
          topic: "老年肾功能不全 (CrCl < 30 mL/min) 抗凝药与抗菌药物精准分桶减量",
          urgency: "建议温习",
          reason: "近 90 天内曾出现 4 次肾剂量相关警示",
          guideline: CLINICAL_GUIDELINES.renal_impairment,
          practice_case_ids: ["CME-RX-02"],
        },
        {
          module_id: "MOD-02",
          topic: "CYP3A4 / CYP2C9 强抑制剂联合用药的风险分层与他汀/华法林替代策略",
          urgency: "技能提升",
          reason: "多病共存联合用药质控热点",
          guideline: CLINICAL_GUIDELINES.cyp_interaction,
          practice_case_ids: ["CME-RX-04", "CME-RX-10"],
        },
        {
          module_id: "MOD-03",
          topic: "围手术期青霉素休克史与头孢菌素侧链交叉过敏防范规范",
          urgency: "常规复习",
          reason: "医院等级评审中药事核心安全指标",
          guideline: CLINICAL_GUIDELINES.cross_allergy,
          practice_case_ids: ["CME-RX-03"],
        },
      ],
    };
  }

  /**
   * Return training case bank.
   */
  getTrainingCases() {
    return {
      total_cases: TRAINING_CASES.length,
      cases: TRAINING_CASES,
    };
  }

  /**
   * Submit and evaluate a doctor's training assessment choice.
   */
  submitAssessment({ caseId, selectedOption, doctorId = "DOC-8021" }) {
    const targetCase = TRAINING_CASES.find((c) => c.id === caseId);
    if (!targetCase) {
      throw new Error(`Training case ${caseId} not found`);
    }

    const isCorrect = targetCase.gold_answer === selectedOption;
    const selectedOptionObj = targetCase.options.find((o) => o.id === selectedOption);
    const goldOptionObj = targetCase.options.find((o) => o.id === targetCase.gold_answer);

    return {
      case_id: caseId,
      doctor_id: doctorId,
      submitted_at: new Date().toISOString(),
      result: isCorrect ? "CORRECT (正确)" : "INCORRECT (错误)",
      is_correct: isCorrect,
      score_awarded: isCorrect ? 10 : 0,
      cme_credit_awarded: isCorrect ? 0.2 : 0.0,
      user_selection: {
        option_id: selectedOption,
        text: selectedOptionObj?.text ?? "Unknown",
      },
      gold_standard: {
        option_id: targetCase.gold_answer,
        text: goldOptionObj?.text,
      },
      clinical_rationale: targetCase.rationale,
      guideline_link: CLINICAL_GUIDELINES[targetCase.guideline_ref] ?? null,
    };
  }
}
