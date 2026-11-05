// PHI Guard detection + transformation library. Pure functions, no I/O.
// Heuristics tuned for CN clinical text: 18-digit resident ID (with checksum),
// CN mobile numbers, emails, labeled MRNs (住院号/门诊号/病历号/登记号), and
// label/context names (患者：/姓名：… and bounded clinician/relative cues).
// Unconstrained bare-name recall is not guaranteed; remote extraction also
// requires the deployment-local detector in lib/local-phi-egress.mjs.

import { sha256Hex, hmacHex } from "../../shared/crypto.mjs";
import { isIntegrityMetadata } from "../../shared/integrity-metadata.mjs";
import { AsyncLocalStorage } from 'node:async_hooks';
const scanScopes=new AsyncLocalStorage();
// Memoize only a deterministic clean regex scan, within one awaited operation.
// This does not attest NER or session-dictionary clearance. Those independent
// gates are still required, including after dictionary injection.
export function withPhiTextScanScope(work) {
  const scope={active:true,clean:new Set(),fields:new Map(),bytes:0};
  return scanScopes.run(scope,async()=>{
    try { return await work(); }
    finally { scope.active=false;scope.clean.clear();scope.fields.clear();scope.bytes=0; }
  });
}
export function normalizedPhiFieldKey(key) {
  const scope=scanScopes.getStore();
  if(scope?.active && scope.fields.has(key)) return scope.fields.get(key);
  const normalized=key.replace(/[_\s-]/g,'').toLowerCase();
  if(scope?.active && key.length<=256 && scope.fields.size<2048) scope.fields.set(key,normalized);
  return normalized;
}

export const RE_ID18 = /\d{17}[\dXx]/g;
export const RE_PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
// Deliberately retain detection beside letters in free text (e.g. tel139...x).
// Structured integrity values use scanStructuredValue; broadening this regex's
// boundary to hex/alphanumeric characters would hide real identifiers.
export const RE_FIXED_PHONE = /(?<!\d)0\d{2,3}[-—\s]?[1-9]\d{6,7}(?!\d)/g;
export const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const RE_BANK_CARD = /(?<!\d)(?:62\d{14,17}|4\d{15}|5[1-5]\d{14})(?!\d)/g;
export const RE_MRN_LABEL = /(住院号|门诊号|病历号|登记号|医保卡号|就诊卡号|社保卡号|健康卡号)\s*[：:]\s*([A-Za-z0-9\-]{4,25})/g;
export const RE_NAME_LABEL = /(患者|姓名|家属|联系人|监护人)\s*[：:]\s*([\u4e00-\u9fa5]{2,4})/g;
export const RE_DOCTOR_LABEL = /(主管医师|主治医师|主任医师|住院医师|副主任医师|责任护士|记录人|接诊医师|审核药师|调配药师|科主任|主诊医师|管床医师|管床医生|查房教授)\s*[：:]\s*([\u4e00-\u9fa5]{2,4})/g;
export const RE_BED_WARD = /(病区|病房|床位|床号)\s*[：:]\s*([A-Za-z0-9\u4e00-\u9fa5\-]{1,15})/g;
export const RE_ADDRESS_LABEL = /(住址|现住址|家庭地址|户籍地址|联系地址|通讯地址)\s*[：:]\s*([^\n，,。；;]{4,60})/g;
export const RE_UNLABELED_ADDRESS = /([\u4e00-\u9fa5]{2,6}(?:省|自治区|市))?([\u4e00-\u9fa5]{2,6}(?:市|区|县|旗))([\u4e00-\u9fa5]{2,10}(?:镇|乡|街道|路|街|巷|大道))(?:\d{1,5}(?:号|弄|栋|幢|单元|室))/g;
// A specific street and house number need no city/label to be identifying.
export const RE_STREET_ADDRESS = /[\u4e00-\u9fa5]{2,16}?(?:大道|大街|路|街|巷|弄)(?:\s*[0-9０-９一二三四五六七八九十百甲乙丙-]+(?:号|弄|栋|幢|单元|楼|层|室))+/g;

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
// Contextual candidates need a surname cue; arbitrary clinical words after
// 患者 (e.g. 患者咳嗽) are not names. This remains incomplete heuristic coverage.
const CONTEXT_NAME = '(?:欧阳|司马|上官|诸葛|东方|皇甫|尉迟|公孙|慕容|[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛范彭郎鲁韦昌马苗方俞任袁柳史唐费薛雷贺倪汤滕殷罗毕郝安常乐于傅皮卞齐康伍余顾孟平黄和穆萧尹姚邵湛汪祁毛狄米贝明臧计伏成戴宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍万卢莫房解应宗丁宣邓单洪包左石崔吉龚程邢裴陆荣翁荀羊惠甄曲封储焦段侯全宁武刘景詹龙叶白赖卓谭庄晏瞿耿满聂晁冷辛简曾沙关查游权盖桓公])([\\u4e00-\\u9fa5]{1,3}?)';

/** GB 11643 checksum for an 18-digit resident ID string. */
export function idChecksumOk(id18) {
  if (!/^\d{17}[\dXx]$/.test(id18)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(id18[i]) * ID_WEIGHTS[i];
  return ID_CHECK[sum % 11] === id18[17].toUpperCase();
}

/** Luhn algorithm checksum for bank cards. */
export function luhnCheckOk(numStr) {
  if (!/^\d{13,19}$/.test(numStr)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = numStr.length - 1; i >= 0; i--) {
    let digit = parseInt(numStr.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
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
export function scanText(text, { contextual = true } = {}) {
  text = String(text ?? "");
  const scope=scanScopes.getStore(), cacheKey=scope?.active ? `${contextual?'1':'0'}${text}` : null;
  if(cacheKey!==null && scope.clean.has(cacheKey)) return {findings:[],counts:{},total:0};
  // Token digests may contain long numeric runs. Do not reinterpret generated
  // tokens as new phone/ID spans and corrupt them on a second boundary pass.
  const protectedSpans = [...text.matchAll(/\[(?:ID:[A-Za-z0-9_-]+:(?:[a-f0-9]{32}|REDACTED)|PSN:(?:[a-f0-9]{8}|[a-f0-9]{32}|[a-f0-9]{64})|REDACTED:[A-Za-z0-9_]+)\]/g)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const found = [];
  const push = (re, type, extra, accept) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (accept && !accept(m)) continue;
      if (protectedSpans.some((span) => m.index >= span.start && m.index + m[0].length <= span.end)) continue;
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
  push(RE_UNLABELED_ADDRESS, "address_unlabeled");
  push(RE_STREET_ADDRESS, "address_street_number");
  push(RE_ID18, "id_card", (m) => ({ checksum_valid: idChecksumOk(m[0]) }));
  push(RE_BANK_CARD, "bank_card", (m) => ({ luhn_valid: luhnCheckOk(m[0]) }));
  push(RE_PHONE, "phone_cn_mobile");
  push(RE_FIXED_PHONE, "phone_cn_fixed");
  push(RE_EMAIL, "email");
  if (contextual) {
    // Optional legacy context profile, shared by both detection and transform.
    // Deliberately bounded to names adjacent to introductions/actions.
    const clinicalWords = new Set(['高热', '高血压', '高血糖', '高血脂', '高龄', '包块', '焦虑', '白血病', '黄疸', '心悸']);
    const plausibleName = m => !clinicalWords.has(m[1]);
    push(new RegExp(`(?:患者|病人|患儿)(${CONTEXT_NAME})(?=[，,]|诉|因|于|今日|昨日|入院|出院)`, 'g'), "context_patient", null, plausibleName);
    push(new RegExp(`(?:由其[子女]|陪护人(?:家属)?(?:姓名)?[：:]?|家属(?:姓名)?[：:]?)(${CONTEXT_NAME})(?=[，,。]|送入|陪同|代诉|诉称)`, 'g'), "context_relative", null, plausibleName);
    push(new RegExp(`(?:妻子|丈夫|配偶|儿子|女儿|父亲|母亲|兄长|姐姐|弟弟|妹妹)\\s*(${CONTEXT_NAME})(?=陪同|代诉|签字|签名|送入|表示|诉称|[，,。；;])`, 'g'), "context_relative", null, plausibleName);
    push(/(?<![\u4e00-\u9fa5])([\u4e00-\u9fa5]{2,4})(?:主任医师|副主任医师|主治医师|住院医师|医生|医师|护士|教授)(?=查房|会诊|建议|签名|签字|[，,。；;\s]|$)/g, "context_clinician");
    push(/(?:患者系|就职于|任职于|担任)(?:某|原)?(?:市委|省委|局长|科长|主任|书记|董事长|总经理|校长|院长)/g, "context_title");
    push(/病案号[：:]\s*[A-Za-z0-9_-]{4,25}/g, "mrn_label");
  }

  // de-overlap: sort by (start, longer first), greedily accept non-overlapping
  found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out = [];
  let lastEnd = -1;
  for (const f of found) {
    if (f.start < lastEnd) continue;
    out.push(f);
    lastEnd = f.end;
  }
  if(!out.length && scope?.active && scope.clean.size<2048 && scope.bytes+cacheKey.length*2<=2_000_000) {
    scope.clean.add(cacheKey);scope.bytes+=cacheKey.length*2;
  }
  return {
    findings: out,
    counts: out.reduce((acc, f) => ((acc[f.type] = (acc[f.type] ?? 0) + 1), acc), {}),
    total: out.length,
  };
}

/** Raw-PHI presence test. Same findings as scanText, including labeled names and beds. */
export function containsRawPhi(text) {
  if (text == null || text === "") return { hit: false };
  const scan = scanText(String(text));
  if (!scan.total) return { hit: false };
  return { hit: true, type: scan.findings[0].type };
}

/** Scan structured textual content without flattening cryptographic metadata.
 * This is the text scanner, not the structured identity-field policy.
 * JSON strings inside records remain free text and are scanned as such.
 */
export function scanStructuredValue(value, options = {}) {
  const findings = [];
  function visit(item) {
    if (typeof item === 'string' || typeof item === 'number') {
      findings.push(...scanText(String(item), options).findings); return;
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      findings.push(...scanText(key, options).findings);
      if (!Array.isArray(item) && isIntegrityMetadata(key, child, item)) continue;
      visit(child);
    }
  }
  visit(value);
  return { findings, total: findings.length };
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
 * Stable pseudonymization: each identifier → [PSN:<hmac32>] keyed by salt and
 * type+value, so the same person/number maps to the same token within one salt
 * domain without revealing the original.
 */
export function pseudonymizeText(text, { salt, contextual = true }) {
  if (!salt || typeof salt !== "string" || salt.length < 8)
    throw new Error("pseudonymizeText: salt required (>=8 chars); set CLAUDE_MEDCIUS_PHI_SALT for stability");
  const { findings } = scanText(text, { contextual });
  let out = text;
  for (const f of [...findings].sort((a, b) => b.start - a.start)) {
    const token = `[PSN:${hmacHex(salt, `${f.type}|${f.value}`, 32)}]`;
    out = out.slice(0, f.start) + token + out.slice(f.end);
  }
  return { text: out, pseudonymized: findings.length };
}

export function redactPhiText(text, options = {}) {
  let out = String(text ?? "");
  for (const f of scanText(out, options).findings.reverse()) out = out.slice(0, f.start) + `[REDACTED:${f.type}]` + out.slice(f.end);
  return out;
}
