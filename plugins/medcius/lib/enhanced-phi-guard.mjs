// Compatibility facade. Detection and transforms live in the canonical PHI library.
// Sync API runs deterministic detection. sanitizeDual also requires an actual
// local detector. phi_safe means those checks passed, never complete recall.
import { scanText } from "../servers/phiguard/src/lib.mjs";
import { hmacHex } from "../servers/shared/crypto.mjs";
import { assertPhiEntitySession, mergePhiSpans } from './phi-entity-session.mjs';
import { guardFreeTextEgress } from './local-phi-egress.mjs';
import { assertSyncPhiAllowed } from './production-phi-policy.mjs';
export const PHI_BARE_NAME_LIMITATION = "bare names without contextual labels are not guaranteed (heuristic_scan_only); B-egress requires local NER second pass + human sampling";
export class EnhancedPhiGuard {
  static generateToken(text,category,salt=process.env.CLAUDE_MEDCIUS_PHI_SALT) {
    if(typeof salt!=="string"||salt.length<8) throw new Error("PHI_SALT_REQUIRED");
    return "[PSN:"+hmacHex(salt,category+"|"+text,32)+"]";
  }
  static sanitize(text="",{salt=process.env.CLAUDE_MEDCIUS_PHI_SALT,mode="PSEUDONYMIZE",entitySession,context}={}) {
    assertSyncPhiAllowed(context);
    if(typeof text!=="string") throw new Error("PHI_TEXT_REQUIRED");
    if (entitySession) assertPhiEntitySession(entitySession, context);
    const known = entitySession ? entitySession.scan(text, context).map(s => ({ ...s, type: 'session_entity' })) : [];
    const findings=mergePhiSpans([...scanText(text,{contextual:true}).findings, ...known]);
    let sanitized = text;
    for (const s of findings.toReversed()) sanitized = sanitized.slice(0,s.start)
      + (mode === 'PSEUDONYMIZE' && salt ? this.generateToken(text.slice(s.start,s.end),s.type,salt) : `[REDACTED:${s.type}]`) + sanitized.slice(s.end);
    const remaining=scanText(sanitized,{contextual:true}).total;
    if(remaining || (entitySession && entitySession.scan(sanitized, context).length)) throw new Error("PHI_GUARD_FAIL_CLOSED");
    return {sanitized,detected_count:findings.length,detected_entities:findings.map(f=>({type:f.type})),phi_safe:true,
      assurance:entitySession ? 'session_dictionary_and_heuristics' : 'heuristic_scan_only',ner_status:'NOT_RUN',bare_name_limited:true,limitation:PHI_BARE_NAME_LIMITATION};
  }
  static async sanitizeDual(text, { entitySession, context, detector, signal } = {}) {
    assertPhiEntitySession(entitySession, context);
    const result = await guardFreeTextEgress(text, { entitySession, context, detector, signal });
    return { sanitized: result.text, receipt: result.receipt, phi_safe: true,
      assurance: 'dual_track_executed', complete_deidentification: 'NOT_ESTABLISHED' };
  }
  static assertSafeOrThrow(text="", { entitySession, context } = {}) {
    assertSyncPhiAllowed(context);
    if (entitySession) assertPhiEntitySession(entitySession, context);
    if(scanText(text,{contextual:true}).total || (entitySession && entitySession.scan(text, context).length)) throw new Error("PHI_GUARD_FAIL_CLOSED: raw identifiers detected");
    return true;
  }
}
