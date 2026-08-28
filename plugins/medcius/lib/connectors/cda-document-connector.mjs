// P2 CDA / Document Channel Read-Only Connector (REG-ACTION-TRACKER R26 PoC).
//
// Covers hospital EHRs that expose discharge summaries / progress notes as
// CDA or XML documents (电子病历评级达标院区最广覆盖的接入路径). The connector
// receives an injected document catalog (`listDocuments`) and loader
// (`loadDocument`) so deployments bind it to their DocumentReference store,
// 视图库文档表, or export share — this module performs no I/O itself and only
// reads. Narrative text is flattened while preserving reading order so
// clinical-note-extract can bind facts back to original spans.

const ENTITY_MAP = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

function decodeEntities(text) {
  return text.replace(/&(?:lt|gt|amp|quot|apos|#39|nbsp);/g, (entity) => ENTITY_MAP[entity] || entity);
}

/**
 * Flatten CDA/XML markup into plain text. Extracts <text> narrative blocks
 * when present (CDA section narrative), otherwise falls back to the whole
 * document; tags become separators so words never fuse across boundaries.
 */
export function flattenDocumentToText(xml, { maxChars = 60000 } = {}) {
  if (typeof xml !== "string" || !xml.trim()) {
    throw new Error("CONNECTOR_CDA_DOCUMENT_EMPTY");
  }
  const narrativeBlocks = [...xml.matchAll(/<text[\s>][\s\S]*?<\/text>/gi)].map((match) => match[0]);
  const source = narrativeBlocks.length ? narrativeBlocks.join("\n") : xml;
  let text = source
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/[ \t]+/g, " ");
  text = decodeEntities(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  if (!text.trim()) throw new Error("CONNECTOR_CDA_NARRATIVE_EMPTY");
  return text.length > maxChars ? `${text.slice(0, maxChars)}…[TRUNCATED]` : text;
}

function buildEnvelope(connectorId, context, records, sourceVersion) {
  return {
    source_system: connectorId,
    tenant_id: context.tenant_id,
    patient_id: context.patient_id,
    encounter_id: context.encounter_id,
    fetched_at: new Date().toISOString(),
    source_version: sourceVersion,
    records,
  };
}

/**
 * Create a read-only CDA/document channel connector for the bridge
 * (bridge kind: "notes").
 *
 * @param {object} options
 * @param {(context: object) => Promise<Array<{id: string, title?: string, content_type?: string}>>} options.listDocuments
 * @param {(context: object, document: object) => Promise<string>} options.loadDocument - returns raw CDA/XML/PDF-text content.
 * @param {string} [options.sourceVersion]
 * @param {string} [options.id]
 */
export function createCdaDocumentConnector({
  listDocuments,
  loadDocument,
  sourceVersion = null,
  id = "cda-document-channel",
} = {}) {
  if (typeof listDocuments !== "function") throw new Error("CONNECTOR_LIST_DOCUMENTS_REQUIRED");
  if (typeof loadDocument !== "function") throw new Error("CONNECTOR_LOAD_DOCUMENT_REQUIRED");

  return {
    id,
    kind: "notes",
    capabilities: ["read"],
    async readPatient(context) {
      const documents = await listDocuments(context);
      if (!Array.isArray(documents)) throw new Error("CONNECTOR_CDA_CATALOG_INVALID");
      const records = [];
      for (const document of documents) {
        if (!document?.id) throw new Error("CONNECTOR_CDA_DOCUMENT_ID_REQUIRED");
        const raw = await loadDocument(context, document);
        const text = flattenDocumentToText(raw);
        records.push({
          id: document.id,
          document_id: document.id,
          title: document.title || text.split("\n")[0],
          content_type: document.content_type || "application/hl7-cda+xml",
          text,
          source_format: "cda",
        });
      }
      return buildEnvelope(id, context, records, sourceVersion);
    },
  };
}
