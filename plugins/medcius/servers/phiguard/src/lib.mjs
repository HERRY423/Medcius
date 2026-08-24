// PHI Guard detection + transformation library. Pure functions, no I/O.
// Heuristics tuned for CN clinical text: 18-digit resident ID (with checksum),
// CN mobile numbers, emails, labeled MRNs (住院号/门诊号/病历号/登记号), and
// label-context names (患者：/姓名：…). Name detection WITHOUT a label is
// deliberately NOT attempted — document this limitation, don't fake it.

import { sha256Hex, hmacHex } from "../../shared/crypto.mjs";

export const RE_ID18 = /\d{17}[\dXx]/g;
export const RE_PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
export const RE_FIXED_PHONE = /(?<!\d)0\d{2,3}[- ]?\d{7,8}(?!\d)/g;
export const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const RE_MRN_LABEL = /(住院号|门诊号|病历号|登记号|医保卡号|就诊卡号)\s*[：:]\s*([A-Za-z0-9\-]{4,25})/g;
export const RE_NAME_LABEL = /(患者|姓名|家属|联系人)\s*[：:]\s*([\u4e00-\u9fa5]{2,4})/g;
export const RE_DOCTOR_LABEL = /(主管医师|主治医师|主任医师|住院医师|副主任医师|责任护士|记录人|接诊医师|审核药师|调配药师)\s*[：:]\s*([\u4e00-\u9fa5]{2,4})/g;
export const RE_BED_WARD = /(病区|病房|床位|床号)\s*[：:]\s*([A-Za-z0-9\u4e00-\u9fa5\-]{1,15})/g;
export const RE_ADDRESS_LABEL = /(住址|现住址|家庭地址|户籍地址|联系地址)\s*[：:]\s*([^\n，,。；;]{4,50})/g;

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];

/** GB 11643 checksum for an 18-digit resident ID string. */
export function idChecksumOk(id18) {
  if (!/^\d{17}[\dXx]$/.test(id18)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(id18[i]) * ID_WEIGHTS[i];
  return ID_CHECK[sum % 11] === id18[17].toUpperCase();
}

function maskValue(value, keepLast) {
  const v = String(value);
  const keep = Math.max(0, Math.min(keepLast ?? 2, v.length - 1));
  if (v.length <= 1 + keep) return "*".repeat(v.length);
  return v[0] + "*".repeat(v.length - 1 - keep) + v.slice(v.length - keep);
}

/**
 * Scan text for PHI candidates. Overlapping matches resolved longest-first /
 * earliest-start. Returns spans so callers can render or transform.
 */
export function scanText(text) {
  const found = [];
  const push = (re, type, extra) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      found.push({
        type,
        start: m.index,
        end: m.index + m[0].length,
        value: m[0],
        sample: maskValue(m[0], type === "name_label" || type === "doctor_label" ? 0 : 2),
        ...extra?.(m),
      });
    }
  };
  push(RE_MRN_LABEL, "mrn_label", (m) => ({ sub_type: m[1] }));
  push(RE_NAME_LABEL, "name_label", (m) => ({ name: undefined }));
  push(RE_DOCTOR_LABEL, "doctor_label", (m) => ({ role: m[1] }));
  push(RE_BED_WARD, "bed_ward", (m) => ({ sub_type: m[1] }));
  push(RE_ADDRESS_LABEL, "address_label", (m) => ({ sub_type: m[1] }));
  push(RE_ID18, "id_card", (m) => ({ checksum_valid: idChecksumOk(m[0]) }));
  push(RE_PHONE, "phone_cn_mobile");
  push(RE_FIXED_PHONE, "phone_cn_fixed");
  push(RE_EMAIL, "email");

  // de-overlap: sort by (start, longer first), greedily accept non-overlapping
  found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out = [];
  let lastEnd = -1;
  for (const f of found) {
    if (f.start < lastEnd) continue;
    out.push(f);
    lastEnd = f.end;
  }
  return {
    findings: out,
    counts: out.reduce((acc, f) => ((acc[f.type] = (acc[f.type] ?? 0) + 1), acc), {}),
    total: out.length,
  };
}

/** Raw-PHI presence test used by the audit server's guard (fast, no spans). */
export function containsRawPhi(text) {
  RE_ID18.lastIndex = 0;
  RE_PHONE.lastIndex = 0;
  if (RE_ID18.test(text)) return { hit: true, type: "id_card" };
  if (RE_PHONE.test(text)) return { hit: true, type: "phone_cn_mobile" };
  return { hit: false };
}

/**
 * Redact per scan results.
 * mode='mask': keep first char + last `keepLast` chars, '*' the rest.
 * mode='hash': replace with [TYPE:sha8].
 */
export function redactText(text, { mode = "mask", keepLast = 2 } = {}) {
  const { findings } = scanText(text);
  let out = text;
  // replace from the end so earlier offsets stay valid
  for (const f of [...findings].sort((a, b) => b.start - a.start)) {
    const repl =
      mode === "hash"
        ? `[${f.type}:${sha256Hex(f.value).slice(0, 8)}]`
        : maskValue(f.value, f.type === "name_label" ? 0 : keepLast);
    out = out.slice(0, f.start) + repl + out.slice(f.end);
  }
  return { text: out, redacted: findings.length, by_type: scanText(text).counts };
}

/**
 * Stable pseudonymization: each identifier → [PSN:<hmac8>] keyed by salt and
 * type+value, so the same person/number maps to the same token within one salt
 * domain without revealing the original.
 */
export function pseudonymizeText(text, { salt }) {
  if (!salt || typeof salt !== "string" || salt.length < 8)
    throw new Error("pseudonymizeText: salt required (>=8 chars); set CLAUDE_MEDCIUS_PHI_SALT for stability");
  const { findings } = scanText(text);
  let out = text;
  for (const f of [...findings].sort((a, b) => b.start - a.start)) {
    const token = `[PSN:${hmacHex(salt, `${f.type}|${f.value}`, 8)}]`;
    out = out.slice(0, f.start) + token + out.slice(f.end);
  }
  return { text: out, pseudonymized: findings.length };
}
