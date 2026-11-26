// Data-only, tenant-bound mappings produce review candidates, never clinical
// observations. Z segments are local; no meaning is inferred from the name.
import { canonicalJson, sha256Hex } from '../../servers/shared/crypto.mjs';
import { deepFreeze } from '../../servers/shared/immutable.mjs';

const keyset = (obj, allowed) => obj && typeof obj === 'object' && !Array.isArray(obj)
  && Object.keys(obj).every(k => allowed.includes(k));
export function validatePrivateZProfile(profile) {
  if (profile == null) return null;
  if (!keyset(profile, ['schema_version', 'profile_id', 'version', 'tenant_id', 'status', 'segments'])
    || profile.schema_version !== 'medcius.hl7-private-profile.v1' || profile.status !== 'unapproved_research_candidate'
    || ![profile.profile_id, profile.version, profile.tenant_id].every(v => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(v))
    || !Array.isArray(profile.segments) || !profile.segments.length || profile.segments.length > 20) throw new Error('HL7_PRIVATE_PROFILE_INVALID');
  const names = new Set();
  for (const spec of profile.segments) {
    if (!keyset(spec, ['segment', 'fields']) || !/^Z[A-Z0-9]{2}$/.test(spec.segment) || names.has(spec.segment)
      || !keyset(spec.fields, ['code', 'value', 'unit']) || Object.keys(spec.fields).length !== 3
      || !Object.values(spec.fields).every(n => Number.isInteger(n) && n >= 1 && n <= 40)
      || new Set(Object.values(spec.fields)).size !== 3) throw new Error('HL7_PRIVATE_PROFILE_INVALID');
    names.add(spec.segment);
  }
  const copied = structuredClone(profile);
  return deepFreeze({ profile: copied, sha256: sha256Hex(canonicalJson(copied)) });
}

export function projectPrivateZCandidates(message, configured, context, { sourceSystem } = {}) {
  if (!configured) return { candidates: [], warnings: [] };
  const { profile, sha256 } = configured;
  if (profile.tenant_id !== context?.tenant_id) throw new Error('CONNECTOR_HL7_PRIVATE_TENANT_MISMATCH');
  if (!message?.controlId) return { candidates: [], warnings: ['PRIVATE_SEGMENT_MESSAGE_ID_MISSING'] };
  const patientId = message.get('PID', 3), encounterId = message.get('PV1', 19) || message.get('PID', 18);
  if (!patientId || !encounterId) return { candidates: [], warnings: ['PRIVATE_SEGMENT_IDENTITY_MISSING'] };
  if (patientId !== context.patient_id) throw new Error('CONNECTOR_HL7_PATIENT_MISMATCH');
  if (encounterId !== context.encounter_id) throw new Error('CONNECTOR_HL7_ENCOUNTER_MISMATCH');
  const candidates = [], warnings = [];
  for (let index = 0; index < message.segments.length; index++) {
    const segment = message.segments[index], spec = profile.segments.find(s => s.segment === segment.fields[0]);
    if (!spec) continue;
    const code = segment.fields[spec.fields.code], rawValue = segment.fields[spec.fields.value], unit = segment.fields[spec.fields.unit];
    if (typeof code !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(code)
      || typeof rawValue !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(rawValue)
      || !Number.isFinite(Number(rawValue)) || typeof unit !== 'string' || !/^[A-Za-zµμ0-9/\^*._%-]{1,32}$/.test(unit)) {
      warnings.push(`PRIVATE_SEGMENT_FIELDS_INVALID:${spec.segment}`); continue;
    }
    candidates.push({ id: `private-${sha256Hex(canonicalJson([sourceSystem, message.controlId, index, spec.segment])).slice(0, 20)}`,
      source_system: sourceSystem ?? null, source_segment: spec.segment, source_segment_index: index,
      source_message_id: message.controlId, patient_id: patientId, encounter_id: encounterId, tenant_id: context.tenant_id,
      local_code: code, reported_value: Number(rawValue), reported_unit: unit,
      profile_id: profile.profile_id, profile_version: profile.version, profile_sha256: sha256,
      status: 'unapproved_research_candidate', clinical_observation: false, calculation_authorized: false });
  }
  return { candidates, warnings };
}
