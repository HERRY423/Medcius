// Public-Reference Reviewer — deterministic rule engine for the
// public-reference-validation eval tier.
//
// Implements the six prescription-review dimensions (interaction / allergy /
// dose_renal / contraindication / special_population / duplicate_therapy)
// against a versioned public-reference fact pack. Every emitted flag carries
// the fact_id and public source of the rule that fired (D4 可解释纪律);
// absence of evidence is reported as `clear` only when the dimension actually
// consulted the pack — never as an unqualified "未发现相互作用" (G3 纪律).
//
// Tier discipline: this engine powers engineering-level consistency checks vs
// PUBLIC reference facts. It is NOT a clinical efficacy claim and must not be
// presented as clinical evidence.

import { readFileSync } from "node:fs";

export const DIMENSIONS = [
  "interaction",
  "allergy",
  "dose_renal",
  "contraindication",
  "special_population",
  "duplicate_therapy",
];

function normalize(name) {
  return String(name || "").replace(/\s+/g, "").replace(/（.*?）|\(.*?\)/g, "");
}

export function loadPack(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function findInteractions(pack, drugs) {
  const hits = [];
  const norm = drugs.map((rx) => normalize(rx?.generic ?? rx));
  for (const pair of pack.interaction_pairs || []) {
    const ai = norm.indexOf(normalize(pair.drug_a));
    const bi = norm.indexOf(normalize(pair.drug_b));
    if (ai !== -1 && bi !== -1 && ai !== bi) hits.push(pair);
  }
  return hits;
}

function findContraindications(pack, drugs, patient) {
  const hits = [];
  for (const rx of drugs) {
    const drug = normalize(rx.generic);
    for (const rule of pack.contraindications || []) {
      if (normalize(rule.drug) !== drug) continue;
      if (rule.condition === "pregnancy" && patient.pregnant === true) hits.push(rule);
      else if (rule.condition === "active_liver_disease" && patient.active_liver_disease === true) hits.push(rule);
      else if (rule.condition === "sulfa_allergy" && typeof patient.allergy === "string" && patient.allergy.includes("磺胺")) hits.push(rule);
    }
  }
  return hits;
}

function findRenalIssues(pack, drugs, patient) {
  const hits = [];
  const relevantDrugs = drugs.filter((rx) => (pack.renal_rules || []).some((r) => normalize(r.drug) === normalize(rx.generic)));
  if (!Number.isFinite(patient.crcl_ml_min)) {
    return { hits, insufficient: relevantDrugs.length > 0 };
  }
  for (const rx of relevantDrugs) {
    for (const rule of pack.renal_rules || []) {
      if (normalize(rule.drug) !== normalize(rx.generic)) continue;
      if ((rule.action === "forbidden_below" || rule.action === "reduce_or_monitor_below")
        && patient.crcl_ml_min < rule.crcl_threshold_ml_min) hits.push(rule);
    }
  }
  return { hits, insufficient: false };
}

function findSpecialPopulation(pack, drugs, patient) {
  const hits = [];
  for (const rx of drugs) {
    const drug = normalize(rx.generic);
    for (const rule of pack.special_population || []) {
      if (normalize(rule.drug) !== drug) continue;
      if (rule.population === "pediatric_under_18" && Number.isFinite(patient.age) && patient.age < 18) hits.push(rule);
      else if (rule.population === "pregnancy" && patient.pregnant === true) hits.push(rule);
    }
  }
  return hits;
}

function findDuplicates(pack, drugs) {
  const hits = [];
  const norm = drugs.map((rx) => normalize(rx.generic));
  for (const dup of pack.duplicate_therapy || []) {
    const members = (dup.members || []).map(normalize);
    const matched = norm.filter((name) => members.includes(name));
    if (matched.length >= 2) hits.push({ ...dup, matched });
  }
  return hits;
}


/**
 * Review one case. Returns per-dimension verdicts:
 *   flag              — a public-reference fact fired (with fact_id + source)
 *   clear             — dimension consulted, no fact fired (basis recorded)
 *   insufficient_data — required patient context missing (fail-closed, G1)
 */
export function reviewCase(caseInput, pack) {
  const drugs = caseInput?.rx?.drugs || [];
  const patient = caseInput?.patient || {};
  const dimensions = {};

  const interactions = findInteractions(pack, drugs);
  dimensions.interaction = interactions.length
    ? { verdict: "flag", facts: interactions }
    : { verdict: "clear", basis: "interaction_pairs 全表未命中该组合" };

  const contraHits = findContraindications(pack, drugs, patient);
  dimensions.contraindication = contraHits.length
    ? { verdict: "flag", facts: contraHits }
    : { verdict: "clear", basis: "contraindications 规则未命中" };

  const renal = findRenalIssues(pack, drugs, patient);
  dimensions.dose_renal = renal.hits.length
    ? { verdict: "flag", facts: renal.hits }
    : renal.insufficient
      ? { verdict: "insufficient_data", basis: "处方含肾剂量规则药物但未提供 CrCl/eGFR" }
      : { verdict: "clear", basis: "renal_rules 未命中或处方无相关药物" };

  const popHits = findSpecialPopulation(pack, drugs, patient);
  dimensions.special_population = popHits.length
    ? { verdict: "flag", facts: popHits }
    : { verdict: "clear", basis: "special_population 规则未命中" };

  const dupHits = findDuplicates(pack, drugs);
  dimensions.duplicate_therapy = dupHits.length
    ? { verdict: "flag", facts: dupHits }
    : { verdict: "clear", basis: "duplicate_therapy 同类成员 <2，未命中" };

  // Allergy: direct allergen-vs-drug-name match; cross-allergy always goes to
  // the pharmacist (转人工), never auto-cleared as "no allergy risk".
  let allergyHit = null;
  if (typeof patient.allergy === "string" && patient.allergy.trim()) {
    for (const rx of drugs) {
      const drugName = normalize(rx.generic);
      const allergyText = patient.allergy;
      // 中文药名命名规则：剥离剂型后缀后以「西林」结尾者属青霉素类（如阿莫西林、哌拉西林）。
      const stemName = drugName.replace(/(胶囊|片|注射液|注射用|颗粒|缓释片|肠溶片|干混悬剂)$/, "");
      const isPenicillinClass = /西林$/.test(stemName) || /西林(?=(胶囊|片|注射液|颗粒))/.test(drugName);
      if ((allergyText.includes("磺胺") && drugName.includes("磺胺"))
        || (allergyText.includes("青霉素") && (drugName.includes("青霉素") || isPenicillinClass))) {
        allergyHit = {
          fact_id: "PRF-ALG-DIRECT",
          statement: `患者过敏原「${allergyText}」与处方药物 ${rx.generic} 直接相关`,
          source: "过敏史直接比对规则（公开药学常识；交叉过敏评估转药师）",
        };
        break;
      }
    }
  }
  dimensions.allergy = allergyHit
    ? { verdict: "flag", facts: [allergyHit] }
    : (patient.allergy == null && drugs.length > 0)
      ? { verdict: "insufficient_data", basis: "未提供过敏史（G1 缺失上下文 fail-closed）" }
      : { verdict: "clear", basis: "所提供过敏史与处方药物无直接匹配（交叉过敏评估转药师）" };

  const anyFlag = Object.values(dimensions).some((d) => d.verdict === "flag");
  const anyInsufficient = Object.values(dimensions).some((d) => d.verdict === "insufficient_data");
  return {
    overall: anyFlag ? "flag" : anyInsufficient ? "insufficient_data" : "clear",
    dimensions,
    pack_source_version: pack.source_version,
  };
}

