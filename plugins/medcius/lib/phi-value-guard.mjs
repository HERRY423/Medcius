// Mandatory async privacy boundary for transport values, file exports and audit.
// Request sessions are memory-only and do not manufacture clinical ownership.
import { resolvePhiDetector } from './phi-runtime.mjs';
import { createPhiRequestSession, assertPhiEntitySession, redactSessionEntities } from './phi-entity-session.mjs';
import { guardFreeTextEgress } from './local-phi-egress.mjs';
import { redactPhiText } from '../servers/phiguard/src/lib.mjs';
import { sealIdentityRecord, sealIdentifier, toModelSafe, containsRawStructuredPhi, mayContainStructuredJson } from './clinical-boundary.mjs';
import { isIntegrityMetadata } from '../servers/shared/integrity-metadata.mjs';

export async function guardPhiValue(value, { detector, signal, entitySession, context, reject = false } = {}) {
  const input = structuredClone(value);
  detector = await resolvePhiDetector({ detector, context });
  const own = entitySession ? null : createPhiRequestSession([input]);
  const session = entitySession ?? own.session;
  context = context ?? own?.context;
  assertPhiEntitySession(session, context);
  const checked = new Map();
  const text = async (v, key = '') => {
    // Preserve field context for Chinese NER; isolated Latin enum/ID tokens
    // otherwise look like people. The entire value still undergoes inference.
    const field = /^[a-z_][a-z0-9_]*$/i.test(key) ? key : 'text';
    const input = JSON.stringify({ [field]: v });
    if (checked.has(input)) return checked.get(input);
    // Chinese text (including standalone names and dynamic keys) is scanned in
    // its original form. Latin metadata retains JSON field context because this
    // Chinese model treats isolated words like "patient" as PERSON. Both paths
    // execute the same verified model; neither is an unscanned allowlist.
    if (/\p{Script=Han}/u.test(v)) {
      const raw = await guardFreeTextEgress(v, { detector, signal, entitySession: session, context });
      checked.set(input, raw.text); return raw.text;
    }
    const result = await guardFreeTextEgress(input, { detector, signal, entitySession: session, context });
    let parsed;
    try { parsed = JSON.parse(result.text); } catch { throw new Error('PHI_VALUE_FIELD_CONTEXT_BLOCKED'); }
    if (Object.keys(parsed).length !== 1 || typeof parsed[field] !== 'string') throw new Error('PHI_VALUE_FIELD_CONTEXT_BLOCKED');
    // JSON escaping must not hide whitespace-normalized dictionary matches or
    // labelled identifiers. Check the decoded value too, then re-run NER on any
    // changed representation before accepting it.
    let safe = redactPhiText(redactSessionEntities(parsed[field], { session, context }), { contextual: true });
    if (safe !== parsed[field]) {
      const again = await guardFreeTextEgress(JSON.stringify({[field]:safe}), {detector, signal, entitySession:session, context});
      try { parsed=JSON.parse(again.text); } catch { throw new Error('PHI_VALUE_FIELD_CONTEXT_BLOCKED'); }
      if(Object.keys(parsed).length!==1||typeof parsed[field]!=='string') throw new Error('PHI_VALUE_FIELD_CONTEXT_BLOCKED');
      safe=parsed[field];
    }
    checked.set(input, safe);
    return safe;
  };
  const visit = async (v, depth = 0, field = '') => {
    if (signal?.aborted) throw new Error('LOCAL_PHI_DETECTOR_ABORTED');
    if (depth > 64) throw new Error('PHI_VALUE_DEPTH');
    if (typeof v === 'string') {
      let parsed;
      if (mayContainStructuredJson(v)) { try { parsed = JSON.parse(v); } catch { /* ordinary text */ } }
      if (parsed && typeof parsed === 'object') {
        const safe = await visit(parsed, depth + 1);
        return JSON.stringify(safe) === JSON.stringify(parsed) ? v : JSON.stringify(safe);
      }
      return text(v, field);
    }
    if (Array.isArray(v)) { const out = []; for (const item of v) out.push(await visit(item, depth + 1, field)); return out; }
    if (!v || typeof v !== 'object') return toModelSafe(v);
    if (['image','audio','resource','resource_link'].includes(v.type)) throw new Error('PHI_OUTPUT_UNSCANNABLE_CONTENT');
    if ((v.contentType || v.content_type) && (v.data || v.url)) throw new Error('PHI_OUTPUT_UNSCANNABLE_ATTACHMENT');
    const safe = sealIdentityRecord(v);
    if (typeof v.reference === 'string' && /(?:^|\/)(?:Patient|Practitioner|RelatedPerson|Person)\//.test(v.reference) && v.display)
      safe.display = sealIdentifier(v.display, 'reference_display');
    const out = {};
    for (const [key, item] of Object.entries(safe)) {
      const safeKey = await text(key, 'property');
      if (Object.hasOwn(out, safeKey)) throw new Error('PHI_VALUE_KEY_COLLISION');
      Object.defineProperty(out, safeKey, { enumerable: true, value:
        isIntegrityMetadata(key, item, safe) ? item : await visit(item, depth + 1, key) });
    }
    return out;
  };
  try {
    const result = await visit(input);
    if (containsRawStructuredPhi(result).hit) throw new Error('PHI_OUTPUT_BLOCKED');
    if (reject && JSON.stringify(result) !== JSON.stringify(input)) throw new Error('PHI_RAW_VALUE_BLOCKED');
    return result;
  } finally { own?.session.dispose(); }
}
