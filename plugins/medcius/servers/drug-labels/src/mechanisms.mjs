// CYP / pharmacological-class signals extracted from label text.
// Complements name-substring interaction matching. Never asserts "no interaction".

/** @typedef {{ signal: string, excerpt: string }} SignalHit */

export const CYP_RULES = [
  { signal: "cyp3a4_inhibitor", re: /CYP\s*3A4[^。；;]{0,24}(强)?抑制|(强)?抑制剂[^。；;]{0,24}CYP\s*3A4/i },
  { signal: "cyp3a4_substrate", re: /CYP\s*3A4\s*底物|经\s*CYP\s*3A4\s*代谢/i },
  { signal: "cyp3a4_inducer", re: /CYP\s*3A4[^。；;]{0,24}诱导|诱导剂[^。；;]{0,24}CYP\s*3A4/i },
  { signal: "cyp2d6_inhibitor", re: /CYP\s*2D6[^。；;]{0,24}抑制/i },
  { signal: "cyp2d6_substrate", re: /CYP\s*2D6\s*底物|经\s*CYP\s*2D6\s*代谢/i },
  { signal: "cyp2c9_inhibitor", re: /CYP\s*2C9[^。；;]{0,24}抑制/i },
  { signal: "cyp2c9_substrate", re: /CYP\s*2C9\s*底物|经\s*CYP\s*2C9\s*代谢/i },
];

/** Complementary CYP pairs: inhibitor × substrate (same isoform). */
export const CYP_COMPLEMENT = [
  ["cyp3a4_inhibitor", "cyp3a4_substrate"],
  ["cyp2d6_inhibitor", "cyp2d6_substrate"],
  ["cyp2c9_inhibitor", "cyp2c9_substrate"],
];

export const PHARM_CLASSES = [
  { id: "statin", tokens: ["他汀类", "他汀"], generic: /他汀/ },
  { id: "macrolide", tokens: ["大环内酯"], generic: /克拉霉素|红霉素|阿奇霉素|罗红霉素|泰利霉素/ },
  { id: "anticoagulant", tokens: ["抗凝", "华法林"], generic: /华法林|香豆素/ },
  { id: "penicillin", tokens: ["青霉素类"], generic: /青霉素|阿莫西林|氨苄西林|哌拉西林/ },
];

/**
 * @param {string} text
 * @param {number} [radius]
 * @returns {string}
 */
function excerpt(text, idx, radius = 50) {
  const lo = Math.max(0, idx - radius);
  const hi = Math.min(text.length, idx + radius);
  return text.slice(lo, hi).replace(/\s+/g, " ").trim();
}

/**
 * @param {Record<string, unknown>} sections
 * @returns {string}
 */
export function interactionText(sections) {
  if (!sections || typeof sections !== "object") return "";
  const parts = [];
  for (const [k, v] of Object.entries(sections)) {
    if (typeof v !== "string") continue;
    if (k.includes("相互作用") || k.includes("CYP") || k.includes("注意")) parts.push(v);
  }
  return parts.join("。");
}

/**
 * @param {Record<string, unknown>} sections
 * @param {string | null} genericName
 * @param {string | string[] | null} declaredClass
 * @returns {SignalHit[]}
 */
export function extractSignals(sections, genericName, declaredClass) {
  const text = interactionText(sections);
  /** @type {Map<string, SignalHit>} */
  const out = new Map();
  const add = (signal, ex) => {
    if (!out.has(signal)) out.set(signal, { signal, excerpt: ex });
  };

  const classes = Array.isArray(declaredClass) ? declaredClass : declaredClass ? [declaredClass] : [];
  for (const c of classes) {
    const id = String(c).trim().toLowerCase();
    if (id) add(`pharm_class:${id}`, `declared pharm_class=${id}`);
  }

  const generic = String(genericName ?? "");
  for (const cls of PHARM_CLASSES) {
    if (cls.generic.test(generic)) add(`pharm_class:${cls.id}`, generic);
  }

  if (text) {
    for (const rule of CYP_RULES) {
      const m = text.match(rule.re);
      if (m && m.index != null) add(rule.signal, excerpt(text, m.index));
    }
    for (const cls of PHARM_CLASSES) {
      for (const tok of cls.tokens) {
        const idx = text.indexOf(tok);
        if (idx >= 0) add(`class_mentioned:${cls.id}`, excerpt(text, idx));
      }
    }
  }
  return [...out.values()];
}

/**
 * Complementary CYP or class-token hits between two labels' signal sets.
 * @param {SignalHit[]} signalsA
 * @param {SignalHit[]} signalsB
 * @returns {{ kind: string, a: string, b: string }[]}
 */
export function complementaryHits(signalsA, signalsB) {
  const sa = new Set(signalsA.map((s) => s.signal));
  const sb = new Set(signalsB.map((s) => s.signal));
  /** @type {{ kind: string, a: string, b: string }[]} */
  const hits = [];
  for (const [x, y] of CYP_COMPLEMENT) {
    if (sa.has(x) && sb.has(y)) hits.push({ kind: "cyp_complement", a: x, b: y });
    if (sa.has(y) && sb.has(x)) hits.push({ kind: "cyp_complement", a: y, b: x });
  }
  for (const cls of PHARM_CLASSES) {
    const mentioned = `class_mentioned:${cls.id}`;
    const klass = `pharm_class:${cls.id}`;
    if (sa.has(mentioned) && sb.has(klass)) hits.push({ kind: "class_token", a: mentioned, b: klass });
    if (sb.has(mentioned) && sa.has(klass)) hits.push({ kind: "class_token", a: klass, b: mentioned });
  }
  return hits;
}

const APPROVAL_DOMESTIC = /^国药准字[HZSB][0-9]{8}$/;
const APPROVAL_IMPORT_J = /^国药准字J[0-9]{8}$/;
const APPROVAL_IMPORT_CERT = /^(注册证号)?[HS][0-9]{8}$/;

/**
 * Format-only check. Never claims the number exists in NMPA.
 * @param {string} raw
 */
export function validateApprovalFormat(raw) {
  const s = String(raw ?? "").replace(/\s+/g, "").trim();
  if (!s) return { ok: false, kind: "empty", reason: "空文号", exists: false };
  if (APPROVAL_DOMESTIC.test(s)) return { ok: true, kind: "domestic", reason: "国产批准文号格式", exists: false, note: "仅格式，不证明国家局在册" };
  if (APPROVAL_IMPORT_J.test(s)) return { ok: true, kind: "import_repack", reason: "进口分装国药准字J+8位", exists: false, note: "仅格式，不证明在册" };
  if (APPROVAL_IMPORT_CERT.test(s)) return { ok: true, kind: "import_cert", reason: "进口注册证号格式", exists: false, note: "仅格式，不证明在册" };
  if (/^国药准字[HZSBJ]\d{1,7}$/.test(s)) return { ok: false, kind: "too_short", reason: "数字须为 8 位", exists: false };
  return { ok: false, kind: "unrecognized", reason: "无法识别为国药准字/进口注册证号格式", exists: false };
}
