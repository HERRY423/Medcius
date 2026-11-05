// Verbatim extraction only. Never infer a missing laboratory unit or convert values.
const ANALYTES = [
  ['肌酐', '血肌酐|肌酐|Scr'], ['尿素氮', '尿素氮|BUN'], ['尿素', '尿素(?!氮)'], ['尿酸', '血尿酸|尿酸|UA'],
  ['血钾', '血钾|钾离子|K\\+?'], ['血钠', '血钠|钠离子|Na\\+?'], ['血氯', '血氯|氯离子|Cl-?'],
  ['血钙', '血钙|总钙|Ca'], ['血镁', '血镁|镁离子|Mg'],
  ['ALT', 'ALT|谷丙转氨酶|丙氨酸氨基转移酶'], ['AST', 'AST|谷草转氨酶|天冬氨酸氨基转移酶'],
  ['总胆红素', '总胆红素|TBIL'], ['直接胆红素', '直接胆红素|结合胆红素|DBIL'],
  ['白蛋白', '白蛋白|清蛋白|ALB'], ['GGT', '谷氨酰转肽酶|GGT|r-GT|γ-GT'],
  ['白细胞', '白细胞(?:计数)?|WBC'], ['红细胞', '红细胞(?:计数)?|RBC'],
  ['血红蛋白', '血红蛋白(?:浓度)?|HGB|Hb'], ['血小板', '血小板(?:计数)?|PLT'],
  ['中性粒细胞比例', '中性粒细胞(?:百分比|比例)|NEUT%'],
  ['肌钙蛋白I', '超敏肌钙蛋白I|肌钙蛋白I|hs-cTnI|cTnI'], ['肌钙蛋白', '超敏肌钙蛋白(?![IT])|肌钙蛋白(?![IT])'],
  ['NT-proBNP', 'NT-proBNP|氨基末端脑钠肽前体|脑钠肽前体'], ['CK-MB', '肌酸激酶同工酶|CK-MB'],
  ['CRP', '超敏C反应蛋白|C反应蛋白|hs-CRP|CRP'], ['降钙素原', '降钙素原|PCT'],
  ['凝血酶原时间', '凝血酶原时间|PT'], ['INR', '国际标准化比值|INR'], ['D-二聚体', 'D-二聚体|D-Dimer|DD'],
  ['血糖', '空腹血糖|随机血糖|血糖|GLU'], ['HbA1c', '糖化血红蛋白|HbA1c'],
];
const UNIT = '(?:[*×]\\s*)?10\\s*\\^\\s*(?:12|9)\\s*/\\s*L|(?:[μµu]mol|mmol|mol|mg|[μµu]g|ng|pg|g|U|G)\\s*/\\s*(?:dL|mL|L)|%|秒|s';

export function parseLabs(input) {
  const text = String(input ?? '');
  const labs = [];
  for (const [name, aliases] of ANALYTES) {
    const re = new RegExp(`(?<![A-Za-z])(?:${aliases})\\s*[：:为]?\\s*([<>≤≥＜＞]?)\\s*([+-]?\\d+(?:\\.\\d+)?)(?![\\d.])(?:[ \\t]*(${UNIT})(?![A-Za-z]))?`, 'gi');
    for (const m of text.matchAll(re)) {
      const span = m[0];
      const sourceUnit = m[3] ?? null;
      let unit = sourceUnit?.replace(/\s+/g, '').replace(/^[*×]/, '').replace(/[μµ]/g, 'u') ?? null;
      // Preserve the existing creatinine API alias only for an explicitly written unit.
      if (name === '肌酐' && unit?.toLowerCase() === 'umol/l') unit = 'umol_L';
      if (name === 'INR' && unit == null) unit = 'ratio';
      labs.push({ name, value: Number(m[2]), unit, source_unit: sourceUnit,
        unit_status: sourceUnit ? 'reported' : name === 'INR' ? 'dimensionless' : 'not_mentioned',
        comparator: m[1] || '=', span, start: m.index, end: m.index + span.length, offset_unit: 'utf16' });
    }
  }
  return labs.sort((a, b) => a.start - b.start);
}

export function parseCompactVitals(input) {
  const text = String(input ?? '');
  const out = [];
  // Five numeric fields only; a missing BP component never gets guessed.
  const re = /\bT\s*\/\s*P\s*\/\s*R\s*\/\s*BP\s*[：:=]\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)(?![\d/])/gi;
  for (const m of text.matchAll(re)) {
    out.push({ values: { temperature: +m[1], pulse: +m[2], respiratory_rate: +m[3], systolic_bp: +m[4], diastolic_bp: +m[5] },
      units: null, unit_status: 'not_mentioned', interpretation: null,
      span: m[0], start: m.index, end: m.index + m[0].length, offset_unit: 'utf16' });
  }
  return out;
}
