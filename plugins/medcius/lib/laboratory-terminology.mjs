// Local engineering candidates only. No national/hospital crosswalk is implied.
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../servers/shared/crypto.mjs';
import { deepFreeze } from '../servers/shared/immutable.mjs';
import { CALCULATION_REFERENCE, checkCreatinineDataQuality } from './calculation-reference.mjs';

const bytes = readFileSync(new URL('../rule-packs/laboratory-terminology.v1.json', import.meta.url));
export const LAB_TERMINOLOGY = deepFreeze(JSON.parse(bytes));
export const LAB_TERMINOLOGY_PROVENANCE = deepFreeze({ id: LAB_TERMINOLOGY.id, version: LAB_TERMINOLOGY.version,
  sha256: sha256Hex(bytes), status: LAB_TERMINOLOGY.status });
const norm = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const units = {
  serum_creatinine: { 'umol/L': 1, 'umol/l': 1, 'mg/dL': CALCULATION_REFERENCE.unit_factors.creatinine, 'mg/dl': CALCULATION_REFERENCE.unit_factors.creatinine },
  hs_troponin_i: { 'ng/L': 1, 'ng/l': 1, 'pg/mL': 1, 'pg/ml': 1, 'ng/mL': 1000, 'ng/ml': 1000 },
  hs_troponin_t: { 'ng/L': 1, 'ng/l': 1, 'pg/mL': 1, 'pg/ml': 1, 'ng/mL': 1000, 'ng/ml': 1000 },
  serum_potassium: { 'mmol/L': 1, 'mmol/l': 1, 'mEq/L': 1, 'mEq/l': 1 },
  serum_crp: { 'mg/L': 1, 'mg/l': 1, 'mg/dL': 10, 'mg/dl': 10 },
  serum_procalcitonin: { 'ng/mL': 1, 'ng/ml': 1, 'ug/L': 1, 'ug/l': 1 },
  blood_wbc_automated: { '10^9/L': 1, '10^9/l': 1, '10*9/L': 1, '10^3/uL': 1, '10^3/ul': 1, '10*3/uL': 1 },
};
export function validateLaboratoryTerminologyReference(ref) {
  if (!ref || ref.id !== 'medcius-laboratory-terminology' || !/^\d+\.\d+\.\d+$/.test(ref.version ?? '')
    || ref.status !== 'engineering_candidates_not_hospital_approved' || !Array.isArray(ref.concepts)
    || ref.concepts.length !== Object.keys(units).length || !Array.isArray(ref.sources) || !ref.sources.length) throw new Error('LAB_TERMINOLOGY_REFERENCE_INVALID');
  const ids = new Set(), aliases = new Set(), codes = new Set();
  const expected = { serum_creatinine: 'umol/L', hs_troponin_i: 'ng/L', hs_troponin_t: 'ng/L', serum_potassium: 'mmol/L',
    serum_crp: 'mg/L', serum_procalcitonin: 'ng/mL', blood_wbc_automated: '10^9/L' };
  for (const concept of ref.concepts) {
    if (!concept || !Object.hasOwn(units, concept.id) || ids.has(concept.id) || concept.canonical_unit !== expected[concept.id]
      || typeof concept.display !== 'string' || !concept.display || !Array.isArray(concept.aliases) || !concept.aliases.length
      || !Array.isArray(concept.loinc) || !concept.loinc.length || !Array.isArray(concept.specimen) || !concept.specimen.length
      || !['unspecified', 'high_sensitivity', 'automated'].includes(concept.method)) throw new Error('LAB_TERMINOLOGY_REFERENCE_INVALID');
    ids.add(concept.id);
    for (const alias of concept.aliases) {
      if (typeof alias !== 'string' || !alias.trim() || alias !== alias.trim().toLowerCase() || aliases.has(alias)) throw new Error('LAB_TERMINOLOGY_REFERENCE_INVALID');
      aliases.add(alias);
    }
    for (const loinc of concept.loinc) {
      if (!/^\d{2,6}-\d$/.test(loinc?.code ?? '') || codes.has(loinc.code)
        || !['mass_concentration', 'molar_concentration', 'number_concentration'].includes(loinc.property)) throw new Error('LAB_TERMINOLOGY_REFERENCE_INVALID');
      codes.add(loinc.code);
    }
  }
  return true;
}
validateLaboratoryTerminologyReference(LAB_TERMINOLOGY);
const base = (status, reason, candidates = []) => ({ status, reason, candidates, clinical_mapping_approved: false,
  calculation_authorized: false, provenance: LAB_TERMINOLOGY_PROVENANCE });
const findByAlias = x => LAB_TERMINOLOGY.concepts.find(c => c.aliases.includes(norm(x))) ?? null;
const loincSystem = x => ['LOINC', 'http://loinc.org'].includes(x);
const findByLoinc = x => LAB_TERMINOLOGY.concepts.find(c => c.loinc.some(l => l.code === x)) ?? null;
const ambiguousTroponin = x => /(?:肌钙蛋白|troponin|ctn)/i.test(String(x ?? ''))
  && (/(?:t\s*[/\\]\s*i|i\s*[/\\]\s*t|[ti]\s*或\s*[ti])/i.test(String(x))
    || !/(?:ctn[ti]|肌钙蛋白\s*[ti]|troponin\s*[ti])/i.test(String(x)));

export function inspectCreatinineSpecimen(record = {}) {
  const code = norm(typeof record.code === 'string' ? record.code : record.code?.coding?.[0]?.code ?? record.test_code);
  const label = norm(record.test_name ?? record.display_name ?? record.name);
  const specimen = norm(record.specimen_type);
  const knownSerum = ['serum', 'plasma', 'serum/plasma', 'ser/plas', '血清', '血浆'].includes(specimen);
  if (specimen && !knownSerum) return { eligible: false, reason: 'CREATININE_SPECIMEN_CONFLICT' };
  if (/尿肌酐|urine|urinary/.test(`${code} ${label}`)) return { eligible: false, reason: 'CREATININE_SPECIMEN_CONFLICT' };
  const sourceSystem = record.code_system ?? record.code?.coding?.[0]?.system;
  const coded = ['2160-0', '14682-9'].includes(code) && loincSystem(sourceSystem);
  const explicitBloodName = /血清肌酐|血浆肌酐|血肌酐|serum creatinine|plasma creatinine/.test(`${code} ${label}`);
  return knownSerum || coded || code === 'scr' || explicitBloodName
    ? { eligible: true, reason: null } : { eligible: false, reason: 'CREATININE_SPECIMEN_UNCONFIRMED' };
}

export function inspectLaboratoryTerminology({ code = null, code_system = null, name = null } = {}) {
  if ([code, code_system, name].some(x => x != null && (typeof x !== 'string' || x.length > 160))) return base('unavailable', 'INPUT_INVALID');
  if (ambiguousTroponin(name) || ambiguousTroponin(code)) return base('ambiguous', 'TROPONIN_ISOFORM_UNRESOLVED');
  const named = findByAlias(name), alias = findByAlias(code), coded = loincSystem(code_system) ? findByLoinc(code) : null;
  if (loincSystem(code_system) && code && !coded) return base('unknown', 'LOINC_NOT_IN_REFERENCE');
  const matches = [...new Set([named, alias, coded].filter(Boolean).map(c => c.id))];
  if (matches.length > 1) return base('conflict', 'CODE_NAME_CONFLICT', matches);
  const concept = LAB_TERMINOLOGY.concepts.find(c => c.id === matches[0]);
  if (!concept) return base('unknown', 'NO_EXACT_CANDIDATE');
  return { ...base(coded ? 'source_loinc_candidate' : 'local_alias_candidate', null, concept.loinc.map(x => x.code)),
    concept_id: concept.id, display: concept.display, expected_specimens: concept.specimen, expected_method: concept.method,
    source_loinc: coded ? code : null, canonical_unit: concept.canonical_unit };
}

export function normalizeLaboratoryMeasurement({ code = null, code_system = null, name = null, value = null, unit = null } = {}) {
  const mapping = inspectLaboratoryTerminology({ code, code_system, name });
  const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : null;
  const safeUnit = typeof unit === 'string' && /^[A-Za-zµμ0-9/\^*._%-]{1,32}$/.test(unit.trim()) ? unit : null;
  const fail = reason => ({ mapping, quantity: { status: 'not_calculated', reason, original_value: safeValue, original_unit: safeUnit,
    normalized_value: null, normalized_unit: null }, calculation_authorized: false });
  if (!mapping.concept_id) return fail('CONCEPT_UNRESOLVED');
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fail('VALUE_INVALID_OR_COMPARATOR');
  const clean = typeof unit === 'string' ? unit.trim().replace(/[µμ]/g, 'u') : '';
  const factor = units[mapping.concept_id]?.[clean];
  if (factor == null) return fail('UNIT_MISSING_OR_UNSUPPORTED');
  if (mapping.source_loinc === '2160-0' && !clean.startsWith('mg/')) return fail('LOINC_PROPERTY_UNIT_MISMATCH');
  if (mapping.source_loinc === '14682-9' && !clean.startsWith('umol/')) return fail('LOINC_PROPERTY_UNIT_MISMATCH');
  const converted = value * factor;
  if (!Number.isFinite(converted)) return fail('CONVERSION_NONFINITE');
  const quality = mapping.concept_id === 'serum_creatinine' ? checkCreatinineDataQuality(value, unit) : null;
  return { mapping, quantity: { status: quality && !quality.eligible ? 'held' : 'converted_candidate',
    reason: quality && !quality.eligible ? quality.reason : null, original_value: value, original_unit: unit,
    normalized_value: converted, normalized_unit: mapping.canonical_unit }, calculation_authorized: false,
    quality_provenance: quality?.provenance ?? null, comparison_authorized: false, interpretation: null };
}

// Same analyte and units do not establish cross-assay comparability. This only
// describes whether identifiers align; it never authorizes a clinical decision.
export function inspectTroponinPair(before, after) {
  const b = normalizeLaboratoryMeasurement(before), a = normalizeLaboratoryMeasurement(after);
  const fields = ['tenant_id', 'patient_id', 'encounter_id', 'source_system', 'specimen_type', 'assay_id', 'assay_version'];
  const same = fields.every(k => typeof before?.[k] === 'string' && before[k].trim() && before[k] === after?.[k]);
  const consistent = same && b.mapping.concept_id && b.mapping.concept_id === a.mapping.concept_id
    && ['hs_troponin_i', 'hs_troponin_t'].includes(b.mapping.concept_id)
    && b.quantity.status === 'converted_candidate' && a.quantity.status === 'converted_candidate';
  return { status: consistent ? 'identifiers_match' : 'not_comparable', reason: consistent ? null : 'ASSAY_SPECIMEN_SOURCE_OR_CONCEPT_UNCONFIRMED',
    before: b, after: a, clinical_comparison_authorized: false };
}
