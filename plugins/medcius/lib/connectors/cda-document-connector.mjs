// Read-only CDA R2 document channel. The catalog is not proof of body ownership.
import { sourceLifecycle } from './source-lifecycle.mjs';
import { parseCnCdaR2 } from './cn-cda-r2.mjs';
import { parseBoundedXml, narrativeText } from './bounded-xml.mjs';
import { bindSourceOwnership } from '../clinical-boundary.mjs';

const fail = code => { throw new Error(`CONNECTOR_CDA_${code}`); };
export function flattenDocumentToText(xml, { maxChars = 60000, ...limits } = {}) {
  const root = parseBoundedXml(xml, limits), blocks = [];
  function visit(node) {
    if (node.name === 'text') blocks.push(narrativeText(node));
    else node.children.forEach(visit);
  }
  visit(root);
  const text = blocks.join('\n');
  if (!text.trim()) fail('NARRATIVE_EMPTY');
  if (text.length > maxChars) fail('NARRATIVE_LIMIT');
  return text;
}
function assertIdentity(source, context, required = false) {
  for (const key of ['tenant_id', 'patient_id', 'encounter_id']) {
    if (source[key] != null && source[key] !== context[key]) fail(`${key.split('_')[0].toUpperCase()}_MISMATCH`);
    if (required && key !== 'tenant_id' && !source[key]) fail('SOURCE_IDENTITY_REQUIRED');
  }
}

export function createCdaDocumentConnector({ listDocuments, loadDocument, sourceVersion = null,
  id = 'cda-document-channel', mode = 'cda_r2', fixedTenantId, cdaOptions = {},
  maxDocuments = 200, timeoutMs = 10000, maxConcurrency = 4 } = {}) {
  if (typeof listDocuments !== 'function' || typeof loadDocument !== 'function') fail('READER_REQUIRED');
  if (typeof fixedTenantId !== 'string' || !fixedTenantId.trim()) fail('FIXED_TENANT_REQUIRED');
  if (!['cda_r2', 'legacy_narrative'].includes(mode)) fail('MODE_INVALID');
  if (!Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 1000
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || !Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64) fail('LIMIT_INVALID');
  // Take a snapshot: caller mutation must not change identity selectors mid-read.
  cdaOptions = structuredClone(cdaOptions);
  let inflight = 0;
  return { id, kind: 'notes', capabilities: ['read'], async readPatient(context) {
    for (const k of ['tenant_id', 'patient_id', 'encounter_id']) if (typeof context?.[k] !== 'string' || !context[k].trim()) fail('CONTEXT_REQUIRED');
    context = { ...context };
    if (context.tenant_id !== fixedTenantId) fail('TENANT_MISMATCH');
    if (inflight >= maxConcurrency) fail('CONCURRENCY_LIMIT');
    const controller = new AbortController(); let timer;
    const checkAbort = () => { if (controller.signal.aborted) fail('TIMEOUT'); };
    const io = { signal: controller.signal, readOnly: true };
    // Don't release a timed-out slot while an uncooperative source is still reading.
    inflight++;
    const work = Promise.resolve().then(async () => {
      let catalog;
      try { catalog = await listDocuments(context, io); } catch { fail('CATALOG_READ_FAILED'); }
      checkAbort();
      const documents = Array.isArray(catalog) ? catalog : catalog?.documents;
      if (!Array.isArray(documents)) fail('CATALOG_INVALID');
      if (documents.length > maxDocuments) fail('DOCUMENT_LIMIT');
      const records = [], seen = new Set();
      for (const document of documents) {
        checkAbort();
        if (typeof document?.id !== 'string' || !document.id.trim()) fail('DOCUMENT_ID_REQUIRED');
        assertIdentity(document, context, mode === 'legacy_narrative');
        let raw;
        try { raw = await loadDocument(context, document, io); } catch { fail('DOCUMENT_READ_FAILED'); }
        checkAbort();
        const parsed = mode === 'cda_r2' ? parseCnCdaR2(raw, cdaOptions) : null;
        if (parsed) {
          assertIdentity(parsed, context, true);
          if (parsed.document_id !== document.id) fail('DOCUMENT_ID_MISMATCH');
          const catalogVersion = sourceLifecycle(document).version_id;
          if (catalogVersion != null && parsed.version_id != null && String(catalogVersion) !== parsed.version_id) fail('VERSION_MISMATCH');
        }
        const version = parsed?.version_id ?? sourceLifecycle(document).version_id;
        const duplicateKey = JSON.stringify([document.id, version]);
        if (seen.has(duplicateKey)) fail('DOCUMENT_DUPLICATE');
        seen.add(duplicateKey);
        const text = parsed?.text ?? flattenDocumentToText(raw, cdaOptions);
        const eventTime = document.event_time ?? document.authored_at ?? parsed?.effective_time ?? null;
        records.push(bindSourceOwnership(context, {
          ...sourceLifecycle(document), id: document.id, document_id: document.id,
          source_record_id: parsed?.set_id ? JSON.stringify([parsed.set_root, parsed.set_id]) : document.source_record_id ?? document.id,
          version_id: version, title: parsed?.title ?? document.title ?? null,
          content_type: 'application/hl7-cda+xml', text, source_format: mode,
          event_time: eventTime, timestamp: eventTime,
          cda_provenance: parsed ? {
            document_root: parsed.document_root, document_code: parsed.document_code, code_system: parsed.code_system,
            patient_identifier_root: parsed.patient_identifier_root, encounter_identifier_root: parsed.encounter_identifier_root,
            document_kind: parsed.document_kind, wst_part: parsed.wst_part, mapping_ref: parsed.mapping_ref,
            profile_status: parsed.profile_status, conformance_status: parsed.conformance_status,
            source_xml_sha256: parsed.source_xml_sha256,
            // XML locations refer to the original source, not to PHI-guarded text offsets.
            sections: parsed.sections.map(({ text: omitted, ...location }) => location),
          } : { conformance_status: 'LEGACY_NARRATIVE_ONLY' },
        }, { tenant_id: fixedTenantId, patient_id: parsed?.patient_id ?? document.patient_id,
          encounter_id: parsed?.encounter_id ?? document.encounter_id }));
      }
      return { source_system: id, tenant_id: context.tenant_id, patient_id: context.patient_id,
        encounter_id: context.encounter_id, fetched_at: new Date().toISOString(), source_version: sourceVersion,
        records, complete: !Array.isArray(catalog) && catalog.complete === true && catalog.truncated !== true,
        synchronized_through: !Array.isArray(catalog) ? catalog.synchronized_through ?? null : null };
    }).finally(() => { inflight--; });
    try {
      return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error('CONNECTOR_CDA_TIMEOUT'));
      }, timeoutMs); })]);
    } finally { clearTimeout(timer); }
  } };
}
