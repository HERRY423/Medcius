// Frozen MCP tool contract for mcp-server-drug-labels.
// Literals ARE the wire format — edit deliberately.

/** @typedef {import("../../shared/rpc.mjs").ToolDef} ToolDef */

/** @type {ToolDef[]} */
export const TOOLS = [
  {
    name: "search_labels",
    description:
      "Search the local drug-label corpus by keyword (generic name / brand name / approval number). Returns provenance summary for each hit. Sample rows are excluded unless include_samples is true.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        query: {
          description: "Keyword — generic name, brand name, or approval number substring.",
          type: "string",
          minLength: 1,
        },
        include_samples: {
          description: "Whether to include synthetic sample rows (data_class=sample). Default false.",
          type: "boolean",
        },
        limit: {
          description: "Max rows to return (1-50, default 10).",
          type: "integer",
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_label",
    description:
      "Fetch a single label's full sections and provenance. Supply label_id or approval_number (one must be present). Always returns data_class, disclaimer, and snapshot info.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        label_id: { description: "Row id from search_labels.", type: "integer", minimum: 1 },
        approval_number: { description: "Approval number (国药准字...).", type: "string", minLength: 1 },
        section: {
          description: "If set, return only this section key (e.g. 药物相互作用).",
          type: "string",
          minLength: 1,
        },
      },
      anyOf: [
        { required: ["label_id"] },
        { required: ["approval_number"] },
      ],
    },
  },
  {
    name: "check_interactions",
    description:
      "Pair-wise interaction check over the LOCAL corpus only. For each unordered pair among the named drugs, reports whether the other's name appears in the first drug's interaction section (via interaction_mentions). Never asserts 'no interaction' — when labels exist but no mention is found the result is no_mention_in_corpus with an explicit limited-coverage disclaimer. Missing labels yield insufficient_data. Sample rows are excluded unless include_samples is true.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        drugs: {
          description: "2-20 drug identifiers (generic/brand names or approval numbers).",
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 2,
          maxItems: 20,
        },
        include_samples: {
          description: "Allow sample rows when resolving names. Default false.",
          type: "boolean",
        },
      },
      required: ["drugs"],
    },
  },
  {
    name: "list_snapshots",
    description: "Audit trail: list version snapshots for one label (by approval_number).",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        approval_number: { type: "string", minLength: 1 },
      },
      required: ["approval_number"],
    },
  },
  {
    name: "corpus_status",
    description: "Corpus health: counts by data_class, sources list with last ingest time.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {},
    },
  },
  {
    name: "check_allergy",
    description: "Allergy cross-check: patient allergy list vs label allergen/禁忌/成分 sections. Returns per-drug hit with excerpt. Never asserts 'no allergy risk' beyond corpus.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        allergies: { description: "Patient allergy strings (e.g. 青霉素, 磺胺)", type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 20 },
        drugs: { description: "Drugs to check (generic/brand/approval)", type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 20 },
        include_samples: { type: "boolean" },
      },
      required: ["allergies", "drugs"],
    },
  },
  {
    name: "check_contraindication",
    description: "Contraindication screen: patient conditions vs label 禁忌/注意事项. Per-drug status: hit|no_mention_in_corpus|insufficient_data.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        conditions: { description: "Patient conditions/comorbidities", type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 20 },
        drugs: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 20 },
        include_samples: { type: "boolean" },
      },
      required: ["conditions", "drugs"],
    },
  },
  {
    name: "check_renal_dosing",
    description: "Renal dosing probe: CrCl bucket + label renal/老年/特殊人群 section excerpt. Reports whether label mentions renal adjustment for the bucket.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        drugs: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 20 },
        crcl: { description: "Creatinine clearance mL/min (if known) — else use calc_renal", type: "number", minimum: 0, maximum: 300 },
        egfr: { description: "eGFR mL/min/1.73m2 (alternative)", type: "number", minimum: 0, maximum: 200 },
        include_samples: { type: "boolean" },
      },
      required: ["drugs"],
    },
  },
  {
    name: "check_special_population",
    description: "Special-population scan (pregnancy/lactation/children/elderly/hepatic) vs label sections. Returns per-drug signals with excerpts.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        population: { type: "string", enum: ["pregnancy", "lactation", "children", "elderly", "hepatic"] },
        drugs: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 20 },
        include_samples: { type: "boolean" },
      },
      required: ["population", "drugs"],
    },
  },
  {
    name: "check_duplicate_therapy",
    description: "Duplicate therapy scan by ingredient overlap (from label 成分/通用名). Flags same-ingredient or same-class pairs.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        drugs: { type: "array", items: { type: "string", minLength: 1 }, minItems: 2, maxItems: 20 },
        include_samples: { type: "boolean" },
      },
      required: ["drugs"],
    },
  },
  {
    name: "calc_renal",
    description:
      "Cockcroft-Gault CrCl + CKD-EPI 2021 eGFR. China default unit is μmol/L (scrUmolL). Passing a Chinese lab value as scrMgDl (e.g. 88) is rejected. Never treat unlabeled 88 as mg/dL.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        age: { type: "integer", minimum: 0, maximum: 120 },
        weightKg: { type: "number", minimum: 1, maximum: 300 },
        heightCm: { type: "number", minimum: 30, maximum: 250 },
        scrUmolL: { description: "血清肌酐 μmol/L（中国检验单默认）", type: "number", minimum: 10, maximum: 2000 },
        scrMgDl: { description: "血清肌酐 mg/dL；仅当单位确实是 mg/dL 且 ≤15。88 会被拒绝。", type: "number", minimum: 0.1, maximum: 15 },
        scr: { description: "无单位数值：≥20 按 μmol/L；<20 拒绝并要求 scrUmolL 或 scrUnit", type: "number", minimum: 0.1 },
        scrUnit: { type: "string", enum: ["umol_L", "mg_dL"] },
        sex: { type: "string", enum: ["male", "female"] },
        calc: { type: "string", enum: ["crcl", "egfr", "both"] },
      },
      required: ["age", "sex"],
    },
  },
  {
    name: "validate_approval_format",
    description:
      "Format-only check for 国药准字 / 进口注册证号. Never claims the number exists in NMPA. exists is always false.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { approval_number: { type: "string", minLength: 1 } },
      required: ["approval_number"],
    },
  },
  {
    name: "calc_dose",
    description: "Dose helpers: BMI, BSA (Mosteller), weight-based and BSA-based dose.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        weightKg: { type: "number", minimum: 1, maximum: 300 },
        heightCm: { type: "number", minimum: 30, maximum: 250 },
        dosePerKg: { type: "number", minimum: 0.01 },
        dosePerM2: { type: "number", minimum: 0.01 },
        bsa: { type: "number", minimum: 0.2, maximum: 4 },
        calc: { type: "string", enum: ["bmi", "bsa", "dose_weight", "dose_bsa"] },
      },
      required: ["calc"],
    },
  },
  {
    name: "safety_screen",
    description:
      "ATC/成分、青霉素-头孢交叉过敏、输液配伍、抗菌分级、麻精限量、十八反。表内命中才 FLAG；未命中≠无风险。非 PASS 开医嘱拦截。",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        drugs: { type: "array", items: { type: "string" }, minItems: 1 },
        allergies: { type: "array", items: { type: "string" } },
        encounter: { type: "string", enum: ["outpatient", "emergency", "inpatient"] },
        days_supply: { type: "number" },
        iv_together: { type: "boolean" },
        include_samples: { type: "boolean" },
      },
      required: ["drugs"],
    },
  },
];
