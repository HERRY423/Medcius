import { lookupAtc, crossAllergyHits, ivHits, tcmHits, controlledHits, stewardshipHits, SIGNAL_SEVERITY } from "./safety-tables.mjs";

export const SAFETY_HANDLERS = {
  safety_screen({ drugs, allergies, encounter, days_supply, iv_together, include_samples }) {
    const list = (drugs ?? []).map((s) => String(s).trim()).filter(Boolean);
    const atc = list.flatMap(lookupAtc);
    const cross = crossAllergyHits(allergies ?? [], list);
    const iv = iv_together === false ? [] : ivHits(list);
    const tcm = tcmHits(list);
    const controlled = controlledHits(list, encounter ?? "outpatient", days_supply);
    const stewardship = stewardshipHits(list);
    const flags = [];
    if (cross.length) flags.push("cross_allergy");
    if (iv.length) flags.push("iv_incompatibility");
    if (tcm.length) flags.push("tcm_eighteen_clashes");
    if (controlled.some((c) => c.over_limit)) flags.push("controlled_over_limit");
    if (stewardship.some((s) => s.abx_grade === "特殊" || s.abx_grade === "限制")) flags.push("antibiotic_stewardship");
    return {
      drugs: list,
      atc,
      cross_allergy: cross,
      iv_compatibility: iv,
      tcm_incompatibility: tcm,
      controlled,
      stewardship,
      flags,
      severity_map: SIGNAL_SEVERITY,
      include_samples: Boolean(include_samples),
      coverage_disclaimer:
        "本院安全表（ATC/交叉过敏/配伍/抗菌分级/麻精限量/十八反）覆盖有限，不是美康 PASS。未命中 ≠ 无风险。开医嘱拦截须嵌 HIS；本工具为事后/旁路辅助。",
    };
  },
};
