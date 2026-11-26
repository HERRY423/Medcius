// Fixed clinical literals, never populated from a caller or source record.
// Whole dosage-form names and tightly qualified medication expressions are
// protected from neural false positives; source identity always takes priority.
const FORM_NAMES = /(?:阿司匹林肠溶片|替格瑞洛片|硫酸氢氯吡格雷片|阿托伐他汀钙片|瑞舒伐他汀钙片|单硝酸异山梨酯片|注射用头孢曲松钠|盐酸二甲双胍片|螺内酯片|呋塞米片)/gu;

// A closed local vocabulary, not a general name exemption. Bare herb names
// can also be real person names. Only explicit medication grammar qualifies.
export const CLINICAL_HERBS=Object.freeze('黄芪 黄芩 茯苓 莪术 薏苡 栝楼 瓜蒌 诃子 浙贝 泽泻 羌活 白芷 细辛 附子 半夏 藁本 郁金 防己 荆芥 白蔹 豨莶 蓖麻 蒺藜 蚕蛹 水蛭 杜仲 苏木 陈皮 白术 白芍 何首乌 刘寄奴 徐长卿 王不留行 夏枯草 黄连 麦冬 秦艽 当归 甘草 朱砂 常山 海金沙'.split(' '));
// Extend the medication grammar only. The bare words may be identities and
// must remain eligible for the ordinary neural subject check outside it.
const HERB_SOURCE=[...CLINICAL_HERBS,'厚朴','葛根','牡丹皮','泽兰'].sort((a,b)=>b.length-a.length).join('|');
const HERB_NAMES=new RegExp(`(?:${HERB_SOURCE})(?:颗粒|胶囊|饮片|煎剂|片)?`,'gu');
const DOSE='[ \\t]*[0-9０-９]+(?:[.．][0-9０-９]+)?[ \\t]*(?:mg|g|mL|ml|毫克|克|毫升)(?=[ \\t]*(?:[、，,;；。\\r\\n]|$))';
const PRESCRIPTION_PREFIX=new RegExp(`(?:^|[。；;\\r\\n])(?:中药处方|中药|中草药处方|处方|药物|用药)[：:][ \\t\\r\\n]*(?:(?:${HERB_SOURCE})(?:颗粒|胶囊|饮片|煎剂|片)?${DOSE}[、，,\\r\\n \\t]*)*$`,'u');
const DOSE_AFTER=new RegExp(`^${DOSE}`,'u');
const HEADERS=/(?:^|[。；;\r\n])(?<header>中药处方|中草药处方)(?=[：:])/dgu;

export function clinicalLiteralSpans(text) {
  const spans=[...text.matchAll(FORM_NAMES)].map(m=>({start:m.index,end:m.index+m[0].length,kind:'dosage_form'}));
  // Include the polarity token since a PERSON prediction may straddle it.
  // Require a clause boundary and the following symptom or exam wording.
  const clinicalClause=/(?:^|[。；;\r\n])(?<term>窦(?:缓|速)(?:有|无)(?=(?:明显)?(?:头晕|心悸|胸闷|胸痛|气促|乏力))|腓总神经(?=查体|支配区|传导速度))/dgu;
  for(const match of text.matchAll(clinicalClause)) {
    const [start,end]=match.indices.groups.term;
    spans.push({start,end,kind:'clinical_clause'});
  }
  for(const m of text.matchAll(HEADERS)) {const [start,end]=m.indices.groups.header;spans.push({start,end,kind:'clinical_header'});}
  for(const m of text.matchAll(HERB_NAMES)) {
    // A bounded lookback must not invent a start-of-clause at its cut point.
    const cut=Math.max(0,m.index-256),left=(cut?'\0':'')+text.slice(cut,m.index),right=text.slice(m.index+m[0].length);
    const dose=DOSE_AFTER.exec(right),prescription=!!dose&&PRESCRIPTION_PREFIX.test(left);
    const administration=/(?:口服|服用|停用|加用|给予|予以)[ \t]*$/u.test(left)
      &&(/^[ \t]*(?:后|期间|治疗)/u.test(right)||!!dose);
    if(prescription||administration) spans.push({start:m.index,end:m.index+m[0].length+(dose?.[0].length??0),kind:'medication_expression'});
    if((prescription||administration) && m[0]==='牡丹皮') spans.push({start:m.index,end:m.index+m[0].length,kind:'location_mislabelled_herb'});
  }
  return spans;
}

export function createClinicalLiteralMatcher(text) {
  const literals=clinicalLiteralSpans(text);
  return span=>literals.some(s=>span.start>=s.start&&span.end<=s.end
    &&(span.label===undefined||span.label==='PERSON'||s.kind==='clinical_header'&&['ADDRESS','ORGANIZATION'].includes(span.label)
      ||s.kind==='location_mislabelled_herb'&&span.label==='ADDRESS'&&span.start===s.start&&span.end===s.end));
}

export function withinClinicalLiteral(text, span) {
  return createClinicalLiteralMatcher(text)(span);
}
