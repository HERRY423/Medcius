import { parseBoundedXml, CDA_NS, children, one, path, narrativeText } from './bounded-xml.mjs';
import { sha256Hex } from '../../servers/shared/crypto.mjs';

// Standard part numbers are NOT ClinicalDocument.code values; bind local codes
// explicitly to a codeSystem and reviewed site mapping, never infer from title.
export const WST500_DOCUMENT_KINDS = Object.freeze({
  34: 'admission', 37: 'first_progress', 38: 'daily_progress', 40: 'difficult_case_discussion',
  41: 'handover', 49: 'discharge_record', 53: 'discharge_summary',
});
function fail(code) { throw new Error(`CONNECTOR_CDA_${code}`); }
function identifier(node, rootSelector = null, element = 'id') {
  const ids = children(node, element).filter(n => !n.attrs.nullFlavor && n.attrs.root
    && (rootSelector == null || n.attrs.root === rootSelector));
  if (ids.length > 1) fail('IDENTIFIER_AMBIGUOUS');
  if (!ids.length) return null;
  return { root: ids[0].attrs.root, value: ids[0].attrs.extension || ids[0].attrs.root };
}
function cdaTime(raw, timezoneOffset) {
  if (!raw) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?([+-]\d{4})?$/.exec(raw);
  if (!m) return null;
  const zone = m[8] ? `${m[8].slice(0,3)}:${m[8].slice(3)}` : timezoneOffset;
  if (!zone || !/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(zone) || /^[+-]14:(?!00)/.test(zone)) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`, time = `${m[4]}:${m[5]}:${m[6]}`;
  if (+m[4] > 23 || +m[5] > 59 || +m[6] > 59) return null;
  const dateCheck = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(dateCheck) || new Date(dateCheck).toISOString().slice(0,10) !== date) return null;
  return `${date}T${time}${m[7] ? `.${m[7]}` : ''}${zone}`;
}

export function parseCnCdaR2(xml, { profiles = [], patientIdRoot = null, encounterIdRoot = null,
  timezoneOffset = null, maxChars = 60000, ...xmlLimits } = {}) {
  if (!Array.isArray(profiles) || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 1000000) fail('CONFIG_INVALID');
  const selectors = new Set();
  for (const p of profiles) {
    if (!p?.code || !p.code_system || !WST500_DOCUMENT_KINDS[p.wst_part] || !p.mapping_ref) fail('PROFILE_INVALID');
    const selector = `${p.code_system}|${p.code}`;
    if (selectors.has(selector)) fail('PROFILE_AMBIGUOUS');
    selectors.add(selector);
  }
  const root = parseBoundedXml(xml, xmlLimits);
  if (root.name !== 'ClinicalDocument' || root.ns !== CDA_NS) fail('ROOT_INVALID');
  const docId = identifier(root);
  if (!docId) fail('DOCUMENT_IDENTIFIER_REQUIRED');
  const targets = children(root, 'recordTarget');
  if (targets.length !== 1) fail('SINGLE_PATIENT_REQUIRED');
  const patient = identifier(one(targets[0], 'patientRole'), patientIdRoot);
  const encounter = identifier(path(root, 'componentOf', 'encompassingEncounter'), encounterIdRoot);
  if (!patient || !encounter) fail('SOURCE_IDENTITY_REQUIRED');
  const code = one(root, 'code')?.attrs ?? {};
  const profile = profiles.find(p => p.code === code.code && p.code_system === code.codeSystem);
  const sections = [];
  function collect(parent, prefix) {
    for (const [i, component] of children(parent, 'component').entries()) {
      const section = one(component, 'section');
      if (!section) continue;
      if (children(section, 'subject').length) fail('SECTION_SUBJECT_UNSUPPORTED');
      const xpath = `${prefix}/component[${i+1}]/section`, content = one(section, 'text');
      if (content) sections.push({ title: narrativeText(one(section, 'title')) || null, text: narrativeText(content),
        code: one(section, 'code')?.attrs.code ?? null,
        source_xpath: `${xpath}/text`, xml_start: content.start, xml_end: content.end, offset_unit: 'utf16' });
      collect(section, xpath);
    }
  }
  const body = path(root, 'component', 'structuredBody');
  if (!body) fail('STRUCTURED_BODY_REQUIRED');
  collect(body, '/ClinicalDocument/component/structuredBody');
  const text = sections.map(s => s.title ? `${s.title}：\n${s.text}` : s.text).join('\n');
  if (!text.trim()) fail('NARRATIVE_EMPTY');
  if (text.length > maxChars) fail('NARRATIVE_LIMIT');
  const version = one(root, 'versionNumber')?.attrs.value ?? null;
  const setId = identifier(root, null, 'setId');
  if (version != null && !/^[1-9]\d*$/.test(version)) fail('VERSION_INVALID');
  return { text, sections, patient_id: patient.value, encounter_id: encounter.value,
    patient_identifier_root: patient.root, encounter_identifier_root: encounter.root,
    document_id: docId.value, document_root: docId.root, title: narrativeText(one(root, 'title')) || null,
    document_code: code.code ?? null, code_system: code.codeSystem ?? null,
    document_kind: profile ? WST500_DOCUMENT_KINDS[profile.wst_part] : 'unknown',
    wst_part: profile?.wst_part ?? null, profile_status: profile ? 'site_mapping_selected' : 'unmapped',
    mapping_ref: profile?.mapping_ref ?? null, version_id: version, set_id: setId?.value ?? null, set_root: setId?.root ?? null,
    effective_time: cdaTime(one(root, 'effectiveTime')?.attrs.value, timezoneOffset),
    source_xml_sha256: sha256Hex(xml), conformance_status: 'NOT_XSD_OR_SCHEMATRON_VALIDATED' };
}
