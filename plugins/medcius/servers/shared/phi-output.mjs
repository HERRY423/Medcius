// Mandatory egress for patient/document transports. Detection is heuristic;
// this enforces the boundary, not a claim of complete de-identification.
import { toModelSafe, containsRawStructuredPhi, sealIdentifier, sealIdentityRecord } from "../../lib/clinical-boundary.mjs";
import { isIntegrityMetadata } from "./integrity-metadata.mjs";

export function guardToolOutput(value) {
  function visit(v) {
    if (typeof v === "string") {
      // FHIR handlers put serialized resources inside MCP text blocks.
      try {
        const parsed = /^\s*[\[{]/.test(v) ? JSON.parse(v) : null;
        if (parsed && typeof parsed === 'object') {
          const safe = visit(parsed);
          return JSON.stringify(safe) === JSON.stringify(parsed) ? v : JSON.stringify(safe);
        }
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
      return toModelSafe(v);
    }
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") {
      if (["image", "audio", "resource", "resource_link"].includes(v.type)) {
        throw new Error("PHI_OUTPUT_UNSCANNABLE_CONTENT");
      }
      // Binary FHIR attachments cannot be inspected by the text guard.
      if ((v.contentType || v.content_type) && (v.data || v.url)) {
        return { contentType: v.contentType || v.content_type, withheld: "PHI_UNSCANNABLE_ATTACHMENT" };
      }
      // Seal identities once at this level; inspect serialized child objects
      // before transforming their strings, preserving field/format semantics.
      const safe = sealIdentityRecord(v);
      if (typeof v.reference === "string" && /(?:^|\/)(?:Patient|Practitioner|RelatedPerson|Person)\//.test(v.reference) && v.display) safe.display = sealIdentifier(v.display, "reference_display");
      const out = {};
      for (const [key, item] of Object.entries(safe)) {
        if (containsRawStructuredPhi(key).hit) throw new Error("PHI_OUTPUT_UNSAFE_KEY");
        out[key] = isIntegrityMetadata(key, item, safe) ? item : visit(item);
      }
      return out;
    }
    return toModelSafe(v);
  }
  const result = visit(value);
  if (containsRawStructuredPhi(result).hit) throw new Error("PHI_OUTPUT_BLOCKED");
  return result;
}

export function safeToolFailure() {
  return { content: [{ type: "text", text: '{"error":"TOOL_FAILED_OR_PHI_OUTPUT_BLOCKED"}' }], isError: true };
}

export function writeSafeDiagnostic(text) {
  try { process.stderr.write(guardToolOutput(text)); }
  catch { process.stderr.write("DIAGNOSTIC_REDACTED\n"); }
}
