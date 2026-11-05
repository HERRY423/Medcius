import { calculateChineseMdrd, classifyChineseAdultBmi } from "../../../lib/calculation-reference.mjs";
import { evaluateChinaClinicalRules } from "../../../lib/china-clinical-rules.mjs";
import { guardPatientSourceInput } from "../../../lib/patient-source-phi.mjs";
import { loadChinaPharmacyCatalog, buildChinaMedicationCoverage, checkChinaMedicationSafety } from "../../../lib/china-pharmacy-catalog.mjs";
import { requiresProductionPhi } from "../../../lib/production-phi-policy.mjs";

export const CHINA_HANDLERS = {
  calc_cn_reference({ calculation, inputs = {} }) {
    if (calculation === "c_mdrd_175") return calculateChineseMdrd(inputs);
    if (calculation === "china_adult_bmi") return classifyChineseAdultBmi(inputs);
    throw new Error("CN_CALCULATION_UNSUPPORTED");
  },
  china_pharmacy_lookup({ medications = [], region, hospital_id, as_of }) {
    if (!Array.isArray(medications) || !medications.length || medications.length > 50) throw new Error("CN_MEDICATIONS_BOUNDED_ARRAY_REQUIRED");
    // Public product identifiers only; no free-text patient input on this lookup tool.
    const allowed = new Set(["id", "drug_name", "approval_number", "manufacturer", "dosage_form", "spec", "tcm_injection", "diluents", "mixed_with_other_drugs"]);
    if (medications.some(m => !m || Object.keys(m).some(k => !allowed.has(k)))) throw new Error("CN_PRODUCT_LOOKUP_FIELDS_INVALID");
    const production = requiresProductionPhi();
    const catalog = loadChinaPharmacyCatalog({ production });
    const context = { region, hospital_id, as_of, production };
    return { catalog_version: catalog.version, catalog_sha256: catalog.sha256,
      safety: checkChinaMedicationSafety({ medications, catalog, context }),
      coverage: buildChinaMedicationCoverage({ medications, catalog, context }) };
  },
  async check_cn_clinical(input) {
    if (!Array.isArray(input?.records) || input.records.length > 1000) throw new Error("CN_CLINICAL_RECORD_LIMIT");
    const { input: guarded, session } = await guardPatientSourceInput({ ...input, encounter: { id: input.context?.encounter_id } });
    try { return evaluateChinaClinicalRules(guarded); } finally { session.dispose(); }
  },
};

export const CHINA_TOOLS = [
  { name: "calc_cn_reference", description: "中国改良MDRD(175系数)或中国成人BMI；需明确单位及适用条件；不提供剂量建议。", inputSchema: {
    type: "object", additionalProperties: false, required: ["calculation", "inputs"], properties: {
      calculation: { type: "string", enum: ["c_mdrd_175", "china_adult_bmi"] }, inputs: { type: "object", additionalProperties: false, properties: {
        age: { type: "number", minimum: 18 }, sex: { type: "string", enum: ["male", "female"] }, creatinine: { type: "number", exclusiveMinimum: 0 },
        creatinine_unit: { type: "string", enum: ["mg/dL", "umol/L", "μmol/L", "µmol/L"] }, stable_renal_function: { type: "boolean" }, adult_ckd: { type: "boolean" },
        pregnant: { type: "boolean" }, dialysis: { type: "boolean" }, weight_kg: { type: "number", exclusiveMinimum: 0 }, height_cm: { type: "number", exclusiveMinimum: 0 },
        pregnant_or_postpartum: { type: "boolean" }, athlete: { type: "boolean" },
      } },
    } } },
  { name: "china_pharmacy_lookup", description: "按批准文号、厂家、剂型、规格及地区/日期查询已审校本地药学目录；甲乙类、双通道、VBP及支付限定均非患者报销裁定。", inputSchema: {
    type: "object", additionalProperties: false, required: ["medications", "region", "as_of"], properties: {
      medications: { type: "array", minItems: 1, maxItems: 50, items: { type: "object" } }, region: { type: "string" }, hospital_id: { type: "string" }, as_of: { type: "string", format: "date-time" },
    } } },
  { name: "check_cn_clinical", description: "对本地结构化HIS记录执行异步双轨脱敏后，核查中国专科质控、VTE及特殊使用级抗菌药节点；资料不足不判违规。", inputSchema: {
    type: "object", additionalProperties: false, required: ["context", "patient", "asOf", "records"], properties: {
      context: { type: "object", required: ["tenant_id", "patient_id", "encounter_id"] }, patient: { type: "object" },
      asOf: { type: "string", format: "date-time" }, records: { type: "array", maxItems: 1000, items: { type: "object" } }, region: { type: "string" },
    } } },
];
