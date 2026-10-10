// Offsets are UTF-16 code units in an exact decoded, PHI-guarded snapshot.
// They must never be applied directly to a live/reformatted EHR document.
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";

const version = r => r.version_id ?? r.meta?.versionId ?? r.source_version ?? null;
const validText = t => typeof t === "string" && !t.includes("\ufffd") && t.isWellFormed();
export function createTextAnchor(record, { field = "text", start, end } = {}) {
  const text = record?.[field];
  if (!record?.id || !validText(text) || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end <= start || end > text.length || !validText(text.slice(start, end))) return null;
  return { schema_version: "medcius.text-anchor.v2", source_id: record.id,
    source_system: record.source_system ?? null, version_id: version(record), field,
    start, end, offset_unit: "utf16", end_exclusive: true,
    exact: text.slice(start, end), content_sha256: sha256Hex(text),
    record_digest: sha256Hex(canonicalJson(record)), hash_basis: "exact_guarded_snapshot",
    boundary: "Validate against the bound snapshot before highlighting; never relocate automatically." };
}

export function resolveTextAnchor(anchor, record) {
  const reject = reason => ({ anchor_status: "stale_or_unverified", reason, highlight: null });
  if (!anchor || anchor.schema_version !== "medcius.text-anchor.v2" || anchor.offset_unit !== "utf16"
      || anchor.end_exclusive !== true) return reject("BOUND_ANCHOR_REQUIRED");
  if (!record || anchor.source_id !== record.id || anchor.source_system !== (record.source_system ?? null)
      || anchor.version_id !== version(record)) return reject("SOURCE_OR_VERSION_CHANGED");
  const text = record[anchor.field];
  if (!validText(text) || sha256Hex(text) !== anchor.content_sha256
      || sha256Hex(canonicalJson(record)) !== anchor.record_digest) return reject("SNAPSHOT_CHANGED");
  if (!Number.isInteger(anchor.start) || !Number.isInteger(anchor.end) || anchor.start < 0
      || anchor.end <= anchor.start || anchor.end > text.length
      || text.slice(anchor.start, anchor.end) !== anchor.exact) return reject("QUOTE_OR_OFFSETS_INVALID");
  return { anchor_status: "verbatim_verified", reason: "EXACT_SNAPSHOT_ONLY",
    highlight: { ...anchor, scope: "bound_snapshot_only" } };
}

// Verifies location only. A resource association is never a truth judgment.
export function inspectEvidenceAnchor(item, records = []) {
  const matches = records.filter((r) => r?.id && r.id === item.source_id);
  if (item.category === "DATA_GAP" || item.source_type === "AuditGap") {
    return { evidence_kind: "gap", anchor_status: "not_applicable", highlight: null };
  }
  if (item.source_type === "MultiSourceCrossAlignment") {
    const refs = (item.source_references || []).map(ref => ({ ...ref, anchor_status: ref.source_id && records.filter(r => r?.id === ref.source_id).length === 1 ? "resource_linked" : "unverified" }));
    return { evidence_kind: "derived", anchor_status: refs.length && refs.every(r => r.anchor_status === "resource_linked") ? "sources_linked" : "unverified", source_references: refs, highlight: null };
  }
  if (typeof item.span === "string" && item.span.length) {
    const hits = matches.flatMap((r) => ["text", "content", "span", "conclusion"].flatMap((field) => {
      const text = r[field];
      if (typeof text !== "string") return [];
      const hits = [];
      for (let start = text.indexOf(item.span); start >= 0; start = text.indexOf(item.span, start + 1)) {
        const anchor = createTextAnchor(r, { field, start, end: start + item.span.length });
        if (anchor) hits.push(anchor);
      }
      return hits;
    }));
    const unique = matches.length === 1 && hits.length === 1;
    const matchingVersion = unique && (item.version_id == null || item.version_id === hits[0].version_id);
    return { evidence_kind: "text", anchor_status: matchingVersion ? "verbatim_verified" : hits.length ? "ambiguous" : "unverified",
      text_anchor: matchingVersion ? hits[0] : null, highlight: matchingVersion ? resolveTextAnchor(hits[0], matches[0]).highlight : null };
  }
  return { evidence_kind: "structured", anchor_status: matches.length === 1 ? "resource_linked" : matches.length > 1 ? "ambiguous" : "unverified", highlight: null };
}
