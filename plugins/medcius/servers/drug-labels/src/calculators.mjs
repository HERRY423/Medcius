// Pure clinical calculators for drug-labels safety loop. No DB, no I/O.
// China default creatinine unit is μmol/L. Passing a Chinese lab value as mg/dL is a dosing accident.

export const MGDL_TO_UMOL = 88.4;
/** Adult Scr in mg/dL is almost never >15; 88 is a typical μmol/L value. */
export const SCR_MGDL_HARD_MAX = 15;

/**
 * Resolve serum creatinine. China lab slips are μmol/L.
 * - Prefer `scrUmolL`.
 * - `scrMgDl` > 15 is rejected (almost certainly μmol/L mis-tagged).
 * - Bare `scr` without unit: ≥20 → μmol/L; <20 → refuse (ambiguous).
 *
 * @param {{ scrUmolL?: unknown, scrMgDl?: unknown, scr?: unknown, scrUnit?: unknown }} args
 * @returns {{ umolL: number, mgDl: number, input_unit: 'umol_L'|'mg_dL', assumed: boolean, warning: string|null }}
 */
export function resolveCreatinine(args) {
  const unitRaw = args?.scrUnit != null ? String(args.scrUnit).trim().toLowerCase() : "";
  const unit =
    unitRaw === "umol_l" || unitRaw === "umol/l" || unitRaw === "μmol/l" || unitRaw === "μmol_l" || unitRaw === "umol"
      ? "umol_L"
      : unitRaw === "mg_dl" || unitRaw === "mg/dl" || unitRaw === "mgdl"
        ? "mg_dL"
        : "";

  const asNum = (v) => {
    if (typeof v === "number" && isFinite(v) && v > 0) return v;
    return null;
  };

  const umolIn = asNum(args?.scrUmolL);
  const mgIn = asNum(args?.scrMgDl);
  const scrIn = asNum(args?.scr);

  if (mgIn != null && mgIn > SCR_MGDL_HARD_MAX) {
    const err = new Error(
      `scrMgDl=${mgIn} 超出成人肌酐 mg/dL 合理上限（≤${SCR_MGDL_HARD_MAX}）。中国检验单单位是 μmol/L（如 88）。请改传 scrUmolL，禁止把 μmol/L 数值当作 mg/dL 计算。`,
    );
    err.name = "CreatinineUnitError";
    throw err;
  }

  if (umolIn != null) {
    const mgDl = umolIn / MGDL_TO_UMOL;
    const warning = umolIn < 20 ? "scrUmolL < 20，可能误把 mg/dL 当作 μmol/L；请核对检验单单位。" : null;
    return { umolL: umolIn, mgDl, input_unit: "umol_L", assumed: false, warning };
  }

  if (mgIn != null) {
    return { umolL: mgIn * MGDL_TO_UMOL, mgDl: mgIn, input_unit: "mg_dL", assumed: false, warning: null };
  }

  if (scrIn != null && unit === "umol_L") {
    return { umolL: scrIn, mgDl: scrIn / MGDL_TO_UMOL, input_unit: "umol_L", assumed: false, warning: null };
  }
  if (scrIn != null && unit === "mg_dL") {
    if (scrIn > SCR_MGDL_HARD_MAX) {
      const err = new Error(`scr=${scrIn} mg/dL 不合理。中国检验单请用 scrUmolL 或 scrUnit=umol_L。`);
      err.name = "CreatinineUnitError";
      throw err;
    }
    return { umolL: scrIn * MGDL_TO_UMOL, mgDl: scrIn, input_unit: "mg_dL", assumed: false, warning: null };
  }

  if (scrIn != null && !unit) {
    if (scrIn >= 20) {
      return {
        umolL: scrIn,
        mgDl: scrIn / MGDL_TO_UMOL,
        input_unit: "umol_L",
        assumed: true,
        warning: "未给单位；数值≥20，按中国检验单默认 μmol/L。若实际是 mg/dL 必须显式传 scrMgDl。",
      };
    }
    const err = new Error(
      `肌酐 ${scrIn} 无单位且 <20，无法判断是 mg/dL 还是 μmol/L。中国检验单请传 scrUmolL（μmol/L）。`,
    );
    err.name = "CreatinineUnitError";
    throw err;
  }

  const err = new Error("calc_renal 需要 scrUmolL（推荐，μmol/L）或显式 scrMgDl（mg/dL，≤15）");
  err.name = "CreatinineUnitError";
  throw err;
}

/**
 * Cockcroft-Gault. China formula uses Scr in μmol/L: (140-age)*wt*(0.85♀) / (0.818*Scr_umol).
 * Equivalent to US form with mg/dL via 88.4 conversion.
 * @param {{ age:number, weightKg:number, scrMgDl?:number, scrUmolL?:number, sex:'male'|'female' }} p
 */
export function cockcroftGault(p) {
  const { age, weightKg, sex } = p;
  if ([age, weightKg].some((v) => typeof v !== "number" || !isFinite(v) || v <= 0))
    throw new Error("cockcroftGault: age/weightKg must be positive numbers");
  if (sex !== "male" && sex !== "female") throw new Error("sex must be male|female");
  const { umolL, mgDl, input_unit, assumed, warning } = resolveCreatinine(p);
  const crcl = ((140 - age) * weightKg * (sex === "female" ? 0.85 : 1)) / (0.818 * umolL);
  return {
    crcl: Math.round(crcl * 10) / 10,
    unit: "mL/min",
    formula: "Cockcroft-Gault (Scr μmol/L, 0.818)",
    inputs: { age, weightKg, sex, scrUmolL: Math.round(umolL * 10) / 10, scrMgDl: Math.round(mgDl * 100) / 100, input_unit, assumed },
    warning,
  };
}

/**
 * CKD-EPI 2021 (race-free) eGFR. Internally uses mg/dL after resolveCreatinine.
 * @param {{ scrMgDl?:number, scrUmolL?:number, scr?:number, scrUnit?:string, age:number, sex:'male'|'female' }} p
 */
export function ckdEpi2021(p) {
  const { age, sex } = p;
  if (typeof age !== "number" || age <= 0) throw new Error("age positive");
  if (sex !== "male" && sex !== "female") throw new Error("sex must be male|female");
  const { mgDl, umolL, input_unit, assumed, warning } = resolveCreatinine(p);
  const k = sex === "female" ? 0.7 : 0.9;
  const a = sex === "female" ? -0.241 : -0.302;
  const min = Math.min(mgDl / k, 1), max = Math.max(mgDl / k, 1);
  const sexFactor = sex === "female" ? 1.012 : 1;
  const eGFR = 142 * Math.pow(min, a) * Math.pow(max, -1.2) * Math.pow(0.9938, age) * sexFactor;
  return {
    egfr: Math.round(eGFR * 10) / 10,
    unit: "mL/min/1.73m²",
    formula: "CKD-EPI 2021 (race-free)",
    inputs: { age, sex, scrUmolL: Math.round(umolL * 10) / 10, scrMgDl: Math.round(mgDl * 100) / 100, input_unit, assumed },
    warning,
  };
}

export function bmi({ weightKg, heightCm }) {
  if (weightKg <= 0 || heightCm <= 0) throw new Error("weightKg/heightCm positive");
  const h = heightCm / 100;
  const v = weightKg / (h * h);
  return { bmi: Math.round(v * 10) / 10, unit: "kg/m²", inputs: { weightKg, heightCm } };
}

// Mosteller BSA
export function bsaMosteller({ weightKg, heightCm }) {
  if (weightKg <= 0 || heightCm <= 0) throw new Error("weightKg/heightCm positive");
  const v = Math.sqrt((weightKg * heightCm) / 3600);
  return { bsa: Math.round(v * 100) / 100, unit: "m²", formula: "Mosteller", inputs: { weightKg, heightCm } };
}

export function doseByWeight({ weightKg, dosePerKg }) {
  if (weightKg <= 0 || dosePerKg <= 0) throw new Error("weightKg/dosePerKg positive");
  return { dose: Math.round(weightKg * dosePerKg * 100) / 100, unit: "mg (weight-based)", inputs: { weightKg, dosePerKg } };
}
export function doseByBsa({ bsa, dosePerM2 }) {
  if (bsa <= 0 || dosePerM2 <= 0) throw new Error("bsa/dosePerM2 positive");
  return { dose: Math.round(bsa * dosePerM2 * 100) / 100, unit: "mg (BSA-based)", inputs: { bsa, dosePerM2 } };
}

// Renal dosing bucket (for label matching; not a substitute for label text)
export function renalBucket(crcl) {
  if (typeof crcl !== "number" || !isFinite(crcl) || crcl < 0) throw new Error("crcl number >=0");
  if (crcl >= 50) return "normal_or_mild";
  if (crcl >= 30) return "moderate";
  if (crcl >= 15) return "severe";
  return "esrd_or_dialysis";
}

// Pregnancy/lactation signal buckets for label scanning
export const PREGNANCY_SIGNALS = ["妊娠", "孕妇", "致畸", "胎儿", "哺乳", "妊娠期", "孕期"];
export const LACTATION_SIGNALS = ["哺乳", "乳汁", "母乳"];
