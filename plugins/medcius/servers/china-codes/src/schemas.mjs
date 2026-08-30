/** @typedef {import("../../shared/rpc.mjs").ToolDef} ToolDef */
/** @type {ToolDef[]} */
export const TOOLS = [
  {
    name: "search_codes",
    description: "Search local NHSA codes corpus (diagnosis ICD-10 / procedure ICD-9-CM-3-CN). Returns provenance six fields per hit. Sample rows excluded unless include_samples is true. Never fabricates.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        query: { description: "Keyword (CN term or code substring)", type: "string", minLength: 1 },
        code_type: { description: "Filter by code_type", type: "string", enum: ["diagnosis", "procedure"] },
        include_samples: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_code",
    description: "Fetch one NHSA code's full record + provenance.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        code: { type: "string", minLength: 1 },
        code_system: { type: "string", minLength: 1 },
      },
      required: ["code"],
    },
  },
  {
    name: "validate_code",
    description: "Validate code completeness (full_length) and version discipline. Returns validation_status valid|pending|unverifiable + reasons.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        code: { type: "string", minLength: 1 },
        code_system: { type: "string", minLength: 1 },
      },
      required: ["code"],
    },
  },
  {
    name: "search_drug_catalog",
    description: "Search local NHSA national drug catalog (category 甲/乙/谈判 + payment_restriction). Sample excluded unless include_samples is true.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        include_samples: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_drug_catalog",
    description: "Fetch one catalog entry by generic_name.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { generic_name: { type: "string", minLength: 1 } },
      required: ["generic_name"],
    },
  },
  {
    name: "corpus_status",
    description: "Corpus health: counts by data_class, sources, version audit.",
    inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: {} },
  },
  {
    name: "check_settlement_list",
    description: "结算清单机检：主诊断资格、性别限制诊断、手术-诊断关键词匹配。不是 DRG 分组器。",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        sex: { type: "string" },
        age: { type: "number" },
        items: { type: "array" },
      },
      required: ["items"],
    },
  },
  {
    name: "search_provincial_benefit",
    description: "L3 省级待遇摘录。无命中标待核，不得编造。L4 不给个体金额。",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        province: { type: "string" },
        insurance_type: { type: "string" },
        encounter: { type: "string" },
        include_samples: { type: "boolean" },
      },
      required: ["province"],
    },
  },
  {
    name: "check_record_quality",
    description: "病案首页/结算清单要素质量核对（确定性）：必填要素缺口、住院天数与费用代数一致性、离院方式取值、性别/年龄-诊断章节冲突、待查主诊断/肿瘤病理/损伤外部原因提示。不是 DRG/DIP 分组器，不输出编码修改建议，不判定医保违规。",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        note_text: { description: "出院记录/病案首页/结算清单文本（须脱敏或院内授权边界内）", type: "string", minLength: 1 },
      },
      required: ["note_text"],
    },
  },
  {
    name: "check_catalog_restriction",
    description: "医保药品目录限定支付范围关键词提示：比对待用诊断表述与目录限定支付原文的包含关系。关键词包含关系提示 ≠ 医保结算判定；是否报销以经办机构为准。",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        drug_name: { description: "通用名（须与目录导入名一致，可先 search_drug_catalog）", type: "string", minLength: 1 },
        diagnosis_terms: { description: "拟对照的诊断表述列表", type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
        include_samples: { type: "boolean" },
      },
      required: ["drug_name", "diagnosis_terms"],
    },
  },
];
