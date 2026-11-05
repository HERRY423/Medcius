// Fixed clinical literals, never populated from a caller or source record.
// Only whole dosage-form names are protected from neural false positives;
// the patient/session dictionary always takes priority over these literals.
const FORM_NAMES = /(?:阿司匹林肠溶片|替格瑞洛片|硫酸氢氯吡格雷片|阿托伐他汀钙片|瑞舒伐他汀钙片|单硝酸异山梨酯片|注射用头孢曲松钠|盐酸二甲双胍片|螺内酯片|呋塞米片)/gu;

export function withinClinicalLiteral(text, span) {
  return [...text.matchAll(FORM_NAMES)].some(m => span.start >= m.index && span.end <= m.index + m[0].length);
}
