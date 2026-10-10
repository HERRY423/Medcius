// Compatibility facade. Detection and transforms live in the canonical PHI library.
// P0-3 honesty: heuristics cover labeled/pattern PHI (ID/phone/MRN/bed/doctor labels).
// Bare names without labels (e.g. narrative "王建国因胸痛入院") are NOT guaranteed;
// phi_safe means "no labeled/pattern PHI detected", never "bare-name free".
import { scanText, pseudonymizeText, redactPhiText } from "../servers/phiguard/src/lib.mjs";
import { hmacHex } from "../servers/shared/crypto.mjs";
export const PHI_BARE_NAME_LIMITATION = "bare names without contextual labels are not guaranteed (heuristic_scan_only); B-egress requires local NER second pass + human sampling";
export class EnhancedPhiGuard {
  static generateToken(text,category,salt=process.env.CLAUDE_MEDCIUS_PHI_SALT) {
    if(typeof salt!=="string"||salt.length<8) throw new Error("PHI_SALT_REQUIRED");
    return "[PSN:"+hmacHex(salt,category+"|"+text,32)+"]";
  }
  static sanitize(text="",{salt=process.env.CLAUDE_MEDCIUS_PHI_SALT,mode="PSEUDONYMIZE"}={}) {
    if(typeof text!=="string") throw new Error("PHI_TEXT_REQUIRED");
    const findings=scanText(text,{contextual:true}).findings;
    const sanitized=mode==="PSEUDONYMIZE"&&salt ? pseudonymizeText(text,{salt,contextual:true}).text : redactPhiText(text,{contextual:true});
    const remaining=scanText(sanitized,{contextual:true}).total;
    if(remaining) throw new Error("PHI_GUARD_FAIL_CLOSED");
    return {sanitized,detected_count:findings.length,detected_entities:findings.map(f=>({type:f.type})),phi_safe:true,assurance:"heuristic_scan_only",bare_name_limited:true,limitation:PHI_BARE_NAME_LIMITATION};
  }
  static assertSafeOrThrow(text="") {
    if(scanText(text,{contextual:true}).total) throw new Error("PHI_GUARD_FAIL_CLOSED: raw identifiers detected");
    return true;
  }
}
