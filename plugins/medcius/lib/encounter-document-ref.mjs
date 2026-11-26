// Select one current, source-attributed instance of a document for review.
export function currentEncounterDocument(snapshot, kind, { requireFinal = false } = {}) {
  const versions = snapshot.records.notes.filter(entry => entry.record.document_kind === kind);
  const finality = entry => ["final", "revised"].includes(entry.lifecycle.result_status)
    || (!requireFinal && (entry.lifecycle.result_status === "preliminary" || entry.record.status === "draft"));
  const candidates = versions.filter(entry => entry.eligible && finality(entry) && entry.evidence.source_system
    && typeof entry.record.text === "string" && entry.record.text.trim());
  if (candidates.length > 1 || versions.some(entry => entry.selection_status === "conflict")) return { status: "conflict", entry: null };
  return candidates.length === 1 ? { status: "source_linked", entry: candidates[0] } : { status: "missing_or_unverified", entry: null };
}

export function encounterDocumentReference({ evidence, lifecycle }) {
  return { source_id: evidence.source_id, source_system: evidence.source_system, version_id: evidence.version_id,
    content_sha256: evidence.content_sha256, timestamp: evidence.recorded_at ?? evidence.event_time,
    result_status: lifecycle.result_status, source_status: lifecycle.source_status, locator: evidence.locator };
}
