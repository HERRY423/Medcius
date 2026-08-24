/**
 * Hospital-side safety tables. Bounded, explicit, not a PASS-grade DDI DB.
 * Hits are flags for pharmacists — never "no risk".
 */

export const ATC_BY_GENERIC = [
  { re: /阿莫西林|青霉素|氨苄西林|哌拉西林/, atc: "J01C", ingredient: "penicillin", grade: "非限制", class_id: "penicillin" },
  { re: /头孢呋辛|头孢唑林|头孢曲松|头孢/, atc: "J01D", ingredient: "cephalosporin", grade: "限制", class_id: "cephalosporin" },
  { re: /克拉霉素|红霉素|阿奇霉素/, atc: "J01F", ingredient: "macrolide", grade: "非限制", class_id: "macrolide" },
  { re: /庆大霉素|阿米卡星|依替米星/, atc: "J01G", ingredient: "aminoglycoside", grade: "限制", class_id: "aminoglycoside" },
  { re: /他汀|辛伐他汀|阿托伐他汀/, atc: "C10AA", ingredient: "statin", grade: null, class_id: "statin" },
  { re: /华法林/, atc: "B01AA", ingredient: "warfarin", grade: null, class_id: "anticoagulant" },
  { re: /吗啡|哌替啶|芬太尼/, atc: "N02A", ingredient: "opioid", grade: null, class_id: "opioid", controlled: "麻醉药品" },
  { re: /地西泮|艾司唑仑/, atc: "N05BA", ingredient: "benzo", grade: null, class_id: "benzo", controlled: "第二类精神药品" },
  { re: /甘草/, atc: null, ingredient: "gancao", grade: null, class_id: "tcm" },
  { re: /草乌|川乌|附子/, atc: null, ingredient: "wutou", grade: null, class_id: "tcm" },
];

/** 青霉素类 ↔ 头孢菌素类 交叉过敏（需药师判断，不是绝对禁忌）。 */
export const CROSS_ALLERGY = [{ a: "penicillin", b: "cephalosporin", severity: "major", note: "β-内酰胺交叉过敏可能；药师评估后决定。不因未写头孢药名而断言无风险。" }];

/** 同瓶/同管路配伍：仅表内对。 */
export const IV_INCOMPAT = [{ a: /头孢/, b: /庆大霉素|阿米卡星/, severity: "contraindicated", note: "β-内酰胺与氨基糖苷同瓶可灭活；分开输注。样例表，非全配伍库。" }];

/** 十八反（经典歌诀，非说明书全文）。 */
export const TCM_FAN = [
  { a: /甘草/, b: /海藻|京大戟|甘遂|芫花/, pair: "甘草反海藻大戟甘遂芫花", severity: "major" },
  { a: /乌头|草乌|川乌|附子/, b: /半夏|瓜蒌|贝母|白蔹|白及/, pair: "乌头反半夏瓜蒌贝母白蔹白及", severity: "major" },
];

export const CONTROLLED_LIMITS = {
  麻醉药品: { outpatient_days: 3, emergency_days: 3, chronic_note: "癌痛等按规定延长" },
  第一类精神药品: { outpatient_days: 3, emergency_days: 3 },
  第二类精神药品: { outpatient_days: 7, emergency_days: 7 },
};

export const SIGNAL_SEVERITY = {
  cyp_complement: "major",
  class_token: "moderate",
  mention_found: "major",
};

export function lookupAtc(generic) {
  const g = String(generic ?? "");
  return ATC_BY_GENERIC.filter((r) => r.re.test(g)).map((r) => ({
    generic: g,
    atc: r.atc,
    ingredient: r.ingredient,
    class_id: r.class_id,
    abx_grade: r.grade,
    controlled: r.controlled ?? null,
  }));
}

export function crossAllergyHits(allergies, drugs) {
  const allg = (allergies ?? []).map(String);
  const hits = [];
  for (const d of drugs ?? []) {
    const info = lookupAtc(d);
    for (const row of CROSS_ALLERGY) {
      const drugIsB = info.some((i) => i.ingredient === row.b || i.class_id === row.b);
      const drugIsA = info.some((i) => i.ingredient === row.a || i.class_id === row.a);
      const allgHitsA = allg.some((a) => /青霉素|阿莫西林|青霉/.test(a) || a.includes(row.a));
      const allgHitsB = allg.some((a) => /头孢/.test(a));
      if ((allgHitsA && drugIsB) || (allgHitsB && drugIsA)) {
        hits.push({ allergy: allg.join(","), drug: d, severity: row.severity, note: row.note });
      }
    }
  }
  return hits;
}

export function ivHits(drugs) {
  const list = (drugs ?? []).map(String);
  const hits = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      for (const rule of IV_INCOMPAT) {
        const ab = rule.a.test(list[i]) && rule.b.test(list[j]);
        const ba = rule.a.test(list[j]) && rule.b.test(list[i]);
        if (ab || ba) hits.push({ drug_a: list[i], drug_b: list[j], severity: rule.severity, note: rule.note });
      }
    }
  }
  return hits;
}

export function tcmHits(drugs) {
  const list = (drugs ?? []).map(String);
  const hits = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      for (const rule of TCM_FAN) {
        const ab = rule.a.test(list[i]) && rule.b.test(list[j]);
        const ba = rule.a.test(list[j]) && rule.b.test(list[i]);
        if (ab || ba) hits.push({ drug_a: list[i], drug_b: list[j], pair: rule.pair, severity: rule.severity, note: "十八反歌诀表；须中药师辨证，不是西药说明书命中。" });
      }
    }
  }
  return hits;
}

export function controlledHits(drugs, encounter, daysSupply) {
  const hits = [];
  for (const d of drugs ?? []) {
    const info = lookupAtc(d);
    for (const i of info) {
      if (!i.controlled) continue;
      const lim = CONTROLLED_LIMITS[i.controlled];
      const enc = encounter === "emergency" ? lim.emergency_days : lim.outpatient_days;
      const over = typeof daysSupply === "number" && enc && daysSupply > enc;
      hits.push({
        drug: d,
        category: i.controlled,
        max_days: enc,
        days_supply: daysSupply ?? null,
        over_limit: !!over,
        note: over ? `${i.controlled} 门诊/急诊常用限量 ${enc} 日（癌痛等按规定延长）` : `${i.controlled}：核对处方限量与专用处方`,
        severity: over ? "major" : "moderate",
      });
    }
  }
  return hits;
}

export function stewardshipHits(drugs) {
  return (drugs ?? []).flatMap((d) =>
    lookupAtc(d)
      .filter((i) => i.abx_grade)
      .map((i) => ({
        drug: d,
        abx_grade: i.abx_grade,
        atc: i.atc,
        note: i.abx_grade === "特殊" ? "特殊使用级须会诊" : i.abx_grade === "限制" ? "限制使用级须权限医师" : "非限制使用级仍须适应症",
        severity: i.abx_grade === "特殊" ? "major" : "moderate",
      })),
  );
}
