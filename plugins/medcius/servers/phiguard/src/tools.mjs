import { scanText, redactText, pseudonymizeText } from "./lib.mjs";
import { requiresProductionPhi } from '../../../lib/production-phi-policy.mjs';
import { resolvePhiDetector } from '../../../lib/phi-runtime.mjs';
import { createPhiRequestSession } from '../../../lib/phi-entity-session.mjs';
import { guardFreeTextEgress } from '../../../lib/local-phi-egress.mjs';

const EPHEMERAL = `ephemeral-${Math.random().toString(36).slice(2)}`;

function saltSource(explicit) {
  if (explicit) return { salt: explicit, source: "argument" };
  if (process.env.CLAUDE_MEDCIUS_PHI_SALT) return { salt: process.env.CLAUDE_MEDCIUS_PHI_SALT, source: "env:CLAUDE_MEDCIUS_PHI_SALT" };
  return { salt: EPHEMERAL, source: "ephemeral (unstable across restarts — set CLAUDE_MEDCIUS_PHI_SALT for stable tokens)" };
}

/** @type {Record<string, (a: Record<string, unknown>) => unknown>} */
const LEGACY_HANDLERS = {
  scan({ text }) {
    return { ...scanText(text), limitation: "姓名仅识别“患者：/姓名：/家属：/联系人：”标签上下文；无标签的裸名字不检测——不要据此断言无 PHI。" };
  },
  redact({ text, mode, keep_last }) {
    return redactText(text, { mode: mode === "hash" ? "hash" : "mask", keepLast: keep_last ?? 2 });
  },
  pseudonymize({ text, salt }) {
    const s = saltSource(salt);
    const r = pseudonymizeText(text, { salt: s.salt });
    return { ...r, salt_source: s.source, stable: s.source !== "ephemeral (unstable across restarts — set CLAUDE_MEDCIUS_PHI_SALT for stable tokens)" ? true : false };
  },
  status() {
    const s = saltSource(null);
    return {
      salt_source: s.source,
      algorithms: { detection: "regex+GB11643-checksum v2", pseudonymization: "HMAC-SHA256 truncated 8 hex", redaction: "mask|sha256-8" },
      coverage: [
        "id_card(18位含校验)",
        "phone_cn_mobile",
        "phone_cn_fixed(区号固话)",
        "email",
        "mrn_label(住院/门诊/病历/登记/医保/就诊卡号)",
        "name_label(患者/姓名/家属/联系人)",
        "doctor_label(主管/主治/主任/住院医师/护士/药师签名)",
        "bed_ward(病区/病房/床位/床号)",
        "address_label(住址/现住址/家庭地址/联系地址)"
      ],
      limitations: [
        "无标签裸姓名不检测（避免误报，也不冒充全覆盖）",
        "银行卡/非标准自造缩写未全量覆盖",
        "pseudonymize 的盐决定跨会话稳定性；ephemeral 盐重启即换",
        "本工具是纵深防御的一层，不替代传输/静态加密与访问控制",
      ],
    };
  },
};

async function productionOperation(name, args) {
  const { text } = structuredClone(args);
  const detector = await resolvePhiDetector();
  if (name === 'status') return { algorithms: { detection: 'session_dictionary+local_cpu_ner+rules' },
    ner_status: 'READY', complete_deidentification: 'NOT_ESTABLISHED' };
  const { session, context } = createPhiRequestSession();
  try {
    const result = await guardFreeTextEgress(text, { detector, entitySession: session, context });
    // Production never releases partial identifiers, including keep_last/mask.
    if (name === 'scan') return { changed: result.text !== text, receipt: result.receipt,
      complete_deidentification: 'NOT_ESTABLISHED' };
    return { text: result.text, receipt: result.receipt, mode: 'full_redaction',
      stable: false, complete_deidentification: 'NOT_ESTABLISHED' };
  } finally { session.dispose(); }
}
export const HANDLERS = Object.freeze(Object.fromEntries(Object.entries(LEGACY_HANDLERS).map(([name, handler]) =>
  [name, args => requiresProductionPhi() ? productionOperation(name, args) : handler(args)])));
