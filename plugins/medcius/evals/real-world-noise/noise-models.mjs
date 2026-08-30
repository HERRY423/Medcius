// Real-World Noise Models (真实病历脏数据噪声模型 · 缺口二标定工具).
//
// Purpose: the deterministic parser (parse-cn-note) and the LLM extraction layer
// were only ever validated on clean templated synthetic notes. Real Chinese
// clinical notes arrive with non-standard headings, OCR confusion, abbreviations,
// section reordering, whitespace chaos and scan artifacts. This module applies
// DETERMINISTIC, SEEDED transforms that structurally mimic those failure modes
// so the extraction layer's robustness floor can be measured before real
// desensitized data arrives (and the same harness grades real data via
// ingest-real-data.mjs later).
//
// Hard rules:
//   - same seed => byte-identical output (replayable in CI);
//   - transforms are text-level only; they never invent clinical facts;
//   - every model documents which real-world failure mode it mimics.

/** mulberry32 — small deterministic PRNG. */
export function createRng(seed) {
  const num = typeof seed === "number" ? Math.floor(seed) : hashSeed(String(seed));
  let a = num >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(text) {
  let h = 1779033703;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

// Common OCR confusions in scanned Chinese notes (character-level).
const OCR_CONFUSIONS = [
  ["已", "己"], ["未", "末"], ["日", "曰"], ["土", "士"], ["人", "入"],
  ["0", "O"], ["1", "l"], ["6", "b"], ["8", "B"], ["，", ","], ["。", "."],
];

// Abbreviations real clinicians write instead of standard terms.
const ABBREVIATIONS = [
  ["慢性阻塞性肺疾病", "COPD"],
  ["慢性阻塞性肺疾病急性加重", "AECOPD"],
  ["心房颤动", "房颤"],
  ["急性心肌梗死", "心梗"],
  ["急性阑尾炎", "急阑尾炎"],
  ["腹腔镜胆囊切除术", "LC术"],
];

// Standard headings -> variants seen in real/legacy EHR exports.
const HEADING_VARIANTS = [
  ["出院诊断", ["【出院诊断】", "出院诊断:", "出院诊断:", "诊断（出院）:", "出院时诊断:"]],
  ["入院诊断", ["【入院诊断】", "入院诊断:", "入院诊断:", "入院时诊断:"]],
  ["手术及操作", ["手术及操作名称:", "手术/操作:", "手术操作名称:"]],
  ["过敏史", ["药物过敏史:", "过敏史:", "【过敏史】"]],
  ["体格检查", ["查体:", "体格检查:", "PE:"]],
  ["出院医嘱", ["出院医嘱及注意事项:", "出院处理:"]],
  ["主诉", ["主诉:"]],
  ["现病史", ["现病史:"]],
];

function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

/** Model 1: heading variants (非标标题/半角冒号/括号标题). */
export function headingVariants(text, rng) {
  let out = String(text);
  for (const [standard, variants] of HEADING_VARIANTS) {
    const re = new RegExp(`^${standard}\\s*[：:]`, "gm");
    if (re.test(out) && rng() < 0.9) {
      out = out.replace(re, `${pick(rng, variants)}`);
    }
  }
  return out;
}

/** Model 2: whitespace & line-structure chaos (换行丢失/全角空格/标点粘连). */
export function whitespaceChaos(text, rng) {
  const lines = String(text).split("\n");
  const out = [];
  for (const line of lines) {
    if (out.length && rng() < 0.3) {
      // merge with previous line (section content run together)
      out[out.length - 1] += `　${line.trim()}`;
    } else if (rng() < 0.15) {
      out.push(`  ${line.trim()}  `);
    } else {
      out.push(line);
    }
  }
  return out.join("\n").replace(/[。；;]\s*$/gm, (m) => (rng() < 0.2 ? "" : m));
}

/** Model 3: seeded section reordering (段落乱序，来自导出/粘贴). */
export function sectionReorder(text, rng) {
  const src = String(text).replace(/\r\n/g, "\n");
  const blocks = src.split(/\n\n+/);
  if (blocks.length < 3) return src;
  const head = blocks[0];
  const rest = blocks.slice(1);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [head, ...rest].join("\n\n");
}

/** Model 4: OCR character confusion (扫描/OCR 字符混淆，按比例随机命中). */
export function ocrConfusion(text, rng, { rate = 0.06 } = {}) {
  return String(text)
    .split("")
    .map((ch) => {
      const rule = OCR_CONFUSIONS.find(([from]) => from === ch);
      if (rule && rng() < rate) return rule[1];
      return ch;
    })
    .join("");
}

/** Model 5: abbreviation & format dialects (缩写、日期与性别书写方言). */
export function abbreviationDialect(text, rng) {
  let out = String(text);
  for (const [standard, abbr] of ABBREVIATIONS) {
    if (standard.length > 2 && out.includes(standard) && rng() < 0.8) {
      out = out.split(standard).join(abbr);
    }
  }
  out = out.replace(/(\d{4})-(\d{1,2})-(\d{1,2})/g, (_m, y, mo, d) => `${y}年${Number(mo)}月${Number(d)}日`);
  out = out.replace(/性别[：:]\s*男/g, rng() < 0.5 ? "性别 男" : "性别:男");
  out = out.replace(/性别[：:]\s*女/g, rng() < 0.5 ? "性别 女" : "性别:女");
  out = out.replace(/年龄[：:]\s*(\d+)/g, (_m, n) => `年龄${n}岁`);
  return out;
}

/** Model 6: scan artifacts (页眉页脚、水印、点线、重复打印噪声). */
export function scanArtifacts(text, rng) {
  const lines = String(text).split("\n");
  const out = [];
  for (const line of lines) {
    out.push(line);
    if (rng() < 0.12) out.push("─────────────────────────");
    if (rng() < 0.08) out.push(`第${1 + Math.floor(rng() * 3)}页`);
  }
  if (rng() < 0.6) out.push("SYNTH-SCAN-HOSPITAL WATERMARK 合成水印");
  return out.join("\n");
}

export const NOISE_MODELS = {
  heading_variants: headingVariants,
  whitespace_chaos: whitespaceChaos,
  section_reorder: sectionReorder,
  ocr_confusion: ocrConfusion,
  abbreviation_dialect: abbreviationDialect,
  scan_artifacts: scanArtifacts,
  combined: (text, rng) => {
    // Real-world pipeline: every failure mode can co-occur.
    let out = headingVariants(text, rng);
    out = abbreviationDialect(out, rng);
    out = sectionReorder(out, rng);
    out = whitespaceChaos(out, rng);
    out = ocrConfusion(out, rng, { rate: 0.04 });
    out = scanArtifacts(out, rng);
    return out;
  },
};

/** Apply one named model deterministically. */
export function applyNoise(text, model, seed = 1) {
  const transform = NOISE_MODELS[model];
  if (!transform) throw new Error(`NOISE_MODEL_UNKNOWN: ${model}`);
  return transform(String(text ?? ""), createRng(`${model}:${seed}`));
}
