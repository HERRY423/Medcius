// Validate local evaluation inputs before scoring. Declarations do not prove
// authorization, anonymization, blinded review, or clinical effectiveness.
import { canonicalJson, sha256Hex } from '../servers/shared/crypto.mjs';
import { scanStructuredValue } from '../servers/phiguard/src/lib.mjs';

export function validateClinicalEvaluationIntake(cases, { synthetic = false, manifest = null } = {}) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('INTAKE_EMPTY');
  if (synthetic && manifest != null) throw new Error('INTAKE_DATA_MODE_CONFLICT');
  if (!synthetic) {
    if (manifest?.schema_version !== 'medcius.clinical-evaluation-intake.v1'
      || !['retrospective', 'prospective_shadow'].includes(manifest.data_kind)) throw new Error('INTAKE_MANIFEST_REQUIRED');
    for (const key of ['study_ref', 'protocol_ref', 'authorization_ref', 'ethics_ref', 'processing_ref', 'parser_version', 'site_ref', 'annotation_protocol_ref', 'split_policy_ref']) {
      if (typeof manifest[key] !== 'string' || !manifest[key].trim()) throw new Error(`INTAKE_MANIFEST_FIELD_REQUIRED:${key}`);
    }
    if (!Array.isArray(manifest.development_subject_refs)) throw new Error('INTAKE_DEVELOPMENT_SPLIT_REQUIRED');
    if (manifest.dataset_sha256 !== sha256Hex(canonicalJson(cases))) throw new Error('INTAKE_DATASET_BINDING_MISMATCH');
    if (scanStructuredValue(manifest).total) throw new Error('INTAKE_MANIFEST_PHI_DETECTED');
  }
  const ids = new Set(), content = new Set(), subjects = new Set();
  const development = new Set(manifest?.development_subject_refs ?? []);
  for (const [index, row] of cases.entries()) {
    const fail = code => { throw new Error(`${code}:line ${index + 1}`); };
    if (!row || row.source_meta?.desensitized !== true) fail('INTAKE_DESENSITIZATION_DECLARATION_REQUIRED');
    if (typeof row.note_text !== 'string' || !row.note_text.trim()) fail('INTAKE_NOTE_REQUIRED');
    if (typeof row.note_id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(row.note_id)) fail('INTAKE_OPAQUE_NOTE_ID_REQUIRED');
    if (ids.has(row.note_id)) fail('INTAKE_DUPLICATE_NOTE_ID');
    ids.add(row.note_id);
    const digest = sha256Hex(row.note_text.replace(/\s+/g, ' ').trim());
    if (content.has(digest)) fail('INTAKE_DUPLICATE_NOTE_CONTENT');
    content.add(digest);
    if (scanStructuredValue(row, { contextual: true }).total) fail('INTAKE_RAW_PHI_DETECTED');
    if (!row.gold || typeof row.gold !== 'object' || Array.isArray(row.gold) || !Object.keys(row.gold).length) fail('INTAKE_GOLD_REQUIRED');
    const meta = row.source_meta;
    if (!synthetic) {
      for (const key of ['subject_ref', 'source_record_ref', 'source_version']) {
        if (typeof meta[key] !== 'string' || !meta[key].trim()) fail(`INTAKE_SOURCE_FIELD_REQUIRED:${key}`);
      }
      if (meta.split !== 'evaluation' || development.has(meta.subject_ref)) fail('INTAKE_SUBJECT_LEAKAGE');
      if (meta.annotation_source !== 'source_first' || meta.model_output_visible !== false
        || !Array.isArray(meta.annotator_refs) || meta.annotator_refs.length < 2
        || meta.annotator_refs.some(x => typeof x !== 'string' || !x.trim())
        || new Set(meta.annotator_refs).size !== meta.annotator_refs.length) fail('INTAKE_REFERENCE_DESIGN_REQUIRED');
      subjects.add(meta.subject_ref);
    }
  }
  return { data_kind: synthetic ? 'SYNTHETIC_ONLY' : `DECLARED_${manifest.data_kind.toUpperCase()}`,
    intake_status: 'STRUCTURE_CHECKED', notes: cases.length, declared_subject_count: synthetic ? null : subjects.size,
    authorization_verification: synthetic ? 'NOT_APPLICABLE_SYNTHETIC' : 'EXTERNAL_REVIEW_REQUIRED',
    reference_independence: 'NOT_ESTABLISHED', clinical_evidence: 'NOT_ESTABLISHED' };
}
