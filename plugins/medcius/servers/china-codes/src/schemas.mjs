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
];
