import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { inspectLaboratoryTerminology as inspect, normalizeLaboratoryMeasurement as normalize, inspectTroponinPair,
  LAB_TERMINOLOGY, validateLaboratoryTerminologyReference } from '../plugins/medcius/lib/laboratory-terminology.mjs';
import { checkCreatinineDataQuality, calculateChineseMdrd, evaluateTemporalDelta } from '../plugins/medcius/lib/calculation-reference.mjs';
import { HospitalDataAdapter, calculateEgfrCkdEpi, normalizeLabUnit } from '../plugins/medcius/lib/hospital-data-adapter.mjs';
import { PatientEvolutionEngine } from '../plugins/medcius/lib/patient-evolution-engine.mjs';
import { parseHl7v2Message, privateSegmentWarnings, createHl7v2Connectors, mapOruObservations } from '../plugins/medcius/lib/connectors/hl7v2-connector.mjs';
import { ReadOnlyHospitalDataBridge } from '../plugins/medcius/lib/read-only-hospital-data-bridge.mjs';
import { createFhirR4Connectors } from '../plugins/medcius/lib/connectors/fhir-r4-connector.mjs';
import { createViewLibraryConnectors } from '../plugins/medcius/lib/connectors/view-library-connector.mjs';
import { VIEWDB_ROW_MAPPERS } from '../plugins/medcius/lib/connectors/viewdb-connector.mjs';
import { createMappedViewConnectors } from '../plugins/medcius/lib/connectors/site-view-mapping.mjs';
import { validatePrivateZProfile } from '../plugins/medcius/lib/connectors/private-z-profile.mjs';
import { TOOLS } from '../plugins/medcius/servers/china-codes/src/schemas.mjs';
import { syntheticTemporalInput } from './fixtures/temporal-evolution.mjs';

test('high-sensitivity troponin I/T synonyms stay distinct; ambiguous and contradictory inputs abstain', () => {
  for (const name of ['hs-cTnI', 'cTnI-HS', '超敏肌钙蛋白I', '高敏肌钙蛋白I']) {
    const c = inspect({ name }); assert.equal(c.concept_id, 'hs_troponin_i'); assert.deepEqual(c.candidates, ['89579-7']);
    assert.equal(c.calculation_authorized, false);
  }
  assert.equal(inspect({ name: 'hs-cTnT' }).concept_id, 'hs_troponin_t');
  for (const name of ['高敏肌钙蛋白T/I', '肌钙蛋白', 'troponin', 'cTn']) assert.equal(inspect({ name }).status, 'ambiguous');
  assert.equal(inspect({ code: '67151-1', code_system: 'LOINC', name: 'hs-cTnI' }).status, 'conflict');
  assert.equal(inspect({ code: '89579-7' }).status, 'unknown', 'a local numeric code is not automatically LOINC');
  assert.equal(inspect({ code: '89579-7', code_system: 'LOINC' }).status, 'source_loinc_candidate');
});

test('explicit compatible mass units convert without assuming assay comparability or rounding', () => {
  const n = (value, unit) => normalize({ name: 'hs-cTnI', value, unit });
  assert.equal(n(12, 'ng/L').quantity.normalized_value, 12);
  assert.equal(n(12, 'pg/mL').quantity.normalized_value, 12);
  assert.equal(n(0.012, 'ng/mL').quantity.normalized_value, 12);
  assert.equal(n(12, 'ng/L').calculation_authorized, false);
  assert.equal(n(12, 'ng/L').comparison_authorized, false);
  for (const unit of ['', 'NG/L', 'Ng/mL', 'mg/L', 'cups']) assert.equal(n(12, unit).quantity.status, 'not_calculated', unit);
  assert.equal(n(12, 'ng/L').interpretation, null);
  const invalid = n({ patient: 'private' }, '<private>');
  assert.equal(invalid.quantity.original_value, null); assert.equal(invalid.quantity.original_unit, null);
  assert.doesNotMatch(JSON.stringify(invalid), /private/);
});

test('LOINC mass and molar creatinine codes do not silently swap unit properties', () => {
  const mk = (code, value, unit) => normalize({ code, code_system: 'LOINC', value, unit });
  assert.equal(mk('2160-0', 1, 'mg/dL').quantity.normalized_value, 88.4);
  assert.equal(mk('14682-9', 88.4, 'umol/L').quantity.normalized_value, 88.4);
  assert.equal(mk('2160-0', 88.4, 'umol/L').quantity.reason, 'LOINC_PROPERTY_UNIT_MISMATCH');
  assert.equal(mk('14682-9', 1, 'mg/dL').quantity.reason, 'LOINC_PROPERTY_UNIT_MISMATCH');
  assert.equal(inspect({ name: '肌酐' }).candidates.length, 2);
});

test('conversion and comparison require explicit matched source, specimen and assay, with no clinical authorization', () => {
  const a = { name: 'hs-cTnI', value: 0.012, unit: 'ng/mL', tenant_id: 'synthetic-site', patient_id: 'synthetic-p',
    encounter_id: 'synthetic-e', source_system: 'synthetic-LIS',
    specimen_type: 'serum', assay_id: 'assay-A', assay_version: '1' };
  const b = { ...a, value: 20, unit: 'ng/L' };
  assert.equal(inspectTroponinPair(a, b).status, 'identifiers_match');
  assert.equal(inspectTroponinPair(a, b).clinical_comparison_authorized, false);
  for (const changes of [{ assay_id: 'other' }, { assay_version: null }, { specimen_type: 'plasma' }, { tenant_id: 'other' },
    { name: 'hs-cTnT' }, { source_system: null }, { unit: 'Mg/L' }, { patient_id: 'other' }, { encounter_id: null }]) assert.equal(inspectTroponinPair(a, { ...b, ...changes }).status, 'not_comparable');
});

test('clinically suspicious or missing creatinine units hold calculations without changing source value', () => {
  assert.equal(checkCreatinineDataQuality(0.9, 'umol/L').eligible, false);
  assert.equal(checkCreatinineDataQuality(0.9, 'mg/dL').normalized_value, 79.56);
  assert.equal(checkCreatinineDataQuality(0.9, '').eligible, false);
  assert.equal(checkCreatinineDataQuality(0.9, 'Mg/dL').eligible, false);
  assert.equal(checkCreatinineDataQuality(6000, 'umol/L').eligible, false);
  assert.equal(calculateEgfrCkdEpi(0.9, 50, 'male'), null);
  assert.equal(calculateChineseMdrd({ age: 50, sex: 'male', creatinine: 0.9, creatinine_unit: 'umol/L', stable_renal_function: true,
    adult_ckd: true, pregnant: false, dialysis: false }).reason, 'CREATININE_DATA_QUALITY_HOLD');
  const out = normalize({ name: '肌酐', value: 0.9, unit: 'umol/L' });
  assert.equal(out.quantity.status, 'held'); assert.equal(out.quantity.original_value, 0.9); assert.equal(out.quantity.original_unit, 'umol/L');
  assert.equal(normalizeLabUnit(1, 'Mg/dL', 'umol/L', 'scr').compatible, false);
});

test('creatinine quality hold blocks eGFR, trend and temporal alert but preserves explicit source critical', () => {
  const input = syntheticTemporalInput();
  const current = input.observations.find(r => r.id === 'scr-after'); current.value = 0.9; current.is_critical = true;
  const out = PatientEvolutionEngine.analyzePatientEvolution(input);
  const lab = out.blocks.what_changed.abnormal_labs.find(r => r.source_id === 'scr-after');
  assert.equal(lab.current_value, 0.9); assert.equal(lab.is_critical, true); assert.equal(lab.trend_direction, null);
  assert.equal(out.patient.egfr, null); assert.ok(out.blocks.data_gaps.some(g => g.gap_type === 'CREATININE_DATA_QUALITY_HOLD'));
  assert.equal(out.blocks.temporal_analysis.delta_checks.find(c => c.rule_id === 'creatinine_48h').triggered, null);
  const direct = evaluateTemporalDelta('creatinine_48h', { value: 0.9, unit: 'umol/L', timestamp: '2026-11-04T04:00:00Z' },
    { value: 110, unit: 'umol/L', timestamp: '2026-11-04T22:00:00Z' });
  assert.equal(direct.triggered, null); assert.equal(direct.comparison.delta, null);
});

test('urine creatinine or an unconfirmed specimen cannot enter serum renal calculations', () => {
  for (const update of [{ code: 'scr', specimen_type: 'urine' }, { code: 'creatinine', specimen_type: null, name: '肌酐' },
    { code: 'scr', specimen_type: null, name: '尿肌酐' }]) {
    const input = syntheticTemporalInput(), row = input.observations.find(r => r.id === 'scr-after');
    Object.assign(row, update);
    if (update.code === 'creatinine') input.observations.find(r => r.id === 'scr-before').code = 'creatinine';
    const out = PatientEvolutionEngine.analyzePatientEvolution(input);
    assert.equal(out.patient.egfr, null);
    assert.ok(out.blocks.data_gaps.some(g => g.gap_type === 'CREATININE_DATA_QUALITY_HOLD'));
    assert.equal(out.blocks.temporal_analysis.delta_checks.find(c => c.rule_id === 'creatinine_48h').triggered, null);
  }
});

test('LOINC property mismatch blocks calculations in both engine and temporal path', () => {
  const input = syntheticTemporalInput();
  for (const r of input.observations.filter(r => r.code === 'scr')) { r.code = '2160-0'; r.code_system = 'LOINC'; }
  const out = PatientEvolutionEngine.analyzePatientEvolution(input);
  assert.equal(out.patient.egfr, null);
  assert.ok(out.blocks.data_gaps.some(g => g.gap_type === 'CREATININE_DATA_QUALITY_HOLD'));
  assert.equal(out.blocks.temporal_analysis.delta_checks.find(c => c.rule_id === 'creatinine_48h').triggered, null);
  const candidate = out.blocks.laboratory_terminology.candidates.find(c => c.source_id === 'scr-after');
  assert.equal(candidate.quantity.reason, 'LOINC_PROPERTY_UNIT_MISMATCH');
});

test('troponin trend abstains when assay is unknown or differs and keeps measured facts', () => {
  const input = syntheticTemporalInput();
  const row = (id, value, timestamp, assay_id) => ({ id, code: 'hs-ctni', name: '超敏肌钙蛋白I', value, unit: 'ng/L',
    tenant_id: input.context.tenant_id, patient_id: input.context.patient_id, encounter_id: input.context.encounter_id,
    effective_time: timestamp, status: 'final', source_system: 'synthetic-LIS', assay_id, assay_version: '1', specimen_type: 'serum' });
  input.observations.push(row('troponin-old', 10, '2026-11-04T04:00:00Z', 'A'), row('troponin-new', 20, '2026-11-04T22:00:00Z', 'B'));
  let out = PatientEvolutionEngine.analyzePatientEvolution(input);
  let lab = out.blocks.what_changed.abnormal_labs.find(x => x.source_id === 'troponin-new');
  assert.equal(lab.current_value, 20); assert.equal(lab.trend_direction, null); assert.match(lab.delta_summary, /检测体系/);
  input.observations.at(-1).assay_id = 'A'; out = PatientEvolutionEngine.analyzePatientEvolution(input);
  lab = out.blocks.what_changed.abnormal_labs.find(x => x.source_id === 'troponin-new'); assert.equal(lab.trend_direction, '↑');
  delete input.observations.at(-1).assay_id; out = PatientEvolutionEngine.analyzePatientEvolution(input);
  assert.equal(out.blocks.what_changed.abnormal_labs.find(x => x.source_id === 'troponin-new').trend_direction, null);
  input.observations.at(-1).assay_id = 'A'; input.observations.at(-1).name = '高敏肌钙蛋白T';
  out = PatientEvolutionEngine.analyzePatientEvolution(input);
  assert.equal(out.blocks.what_changed.abnormal_labs.find(x => x.source_id === 'troponin-new').trend_direction, null);
});

test('held creatinine is neither labelled normal nor converted to a derived critical flag', () => {
  const pack = { clinical_rules: { critical_values: { scr: { low: 1, high: 350, unit: 'umol/L', danger_hint: 'synthetic' } } } };
  const record = { id: 'synthetic', code: 'scr', value: 0.9, unit: 'umol/L', ref_low: 0.5, ref_high: 1.2,
    sample_time: '2026-11-05T00:00:00Z', status: 'final' };
  const result = HospitalDataAdapter.normalizeLisFeed([record], { rulePack: pack });
  assert.equal(result.observations[0].value, 0.9); assert.equal(result.observations[0].is_critical, false);
  assert.ok(result.data_gaps.some(g => g.reason.includes('CREATININE_DATA_QUALITY_HOLD')));
  const input = syntheticTemporalInput(); input.observations = []; input.lisFeed = [record];
  const out = PatientEvolutionEngine.analyzePatientEvolution(input), lab = out.blocks.what_changed.abnormal_labs[0];
  assert.notEqual(lab.status_label, '正常'); assert.equal(lab.is_critical, false); assert.equal(lab.is_abnormal, null);
  record.is_critical = true;
  assert.equal(HospitalDataAdapter.normalizeLisFeed([record], { rulePack: pack }).observations[0].is_critical, true);
});

test('LIS normalization preserves assay metadata; local tool contracts stay read-only', () => {
  const result = HospitalDataAdapter.normalizeLisFeed([{ id: 'x', code: 'hs-ctni', value: 20, unit: 'ng/L',
    assay_id: 'A', assay_version: '1', specimen_type: 'serum', method_code: 'HS' }]);
  assert.equal(result.observations[0].assay_id, 'A'); assert.equal(result.observations[0].assay_version, '1');
  assert.ok(TOOLS.some(t => t.name === 'inspect_laboratory_terminology'));
  assert.ok(TOOLS.some(t => t.name === 'normalize_laboratory_quantity'));
});

test('local china-codes handlers return research-only terminology and quantity candidates', async () => {
  const base = join(process.cwd(), 'out', 'dirty-his'); mkdirSync(base, { recursive: true });
  const dataRoot = mkdtempSync(join(base, 'handler-test-')), previous = process.env.CLAUDE_MEDCIUS_DATA;
  process.env.CLAUDE_MEDCIUS_DATA = dataRoot;
  let db;
  try {
    const { HANDLERS } = await import('../plugins/medcius/servers/china-codes/src/tools.mjs');
    ({ db } = await import('../plugins/medcius/servers/china-codes/src/db.mjs'));
    const candidate = HANDLERS.inspect_laboratory_terminology({ name: 'hs-cTnI' });
    assert.equal(candidate.concept_id, 'hs_troponin_i'); assert.equal(candidate.calculation_authorized, false);
    const normalized = HANDLERS.normalize_laboratory_quantity({ name: 'hs-cTnI', value: 0.012, unit: 'ng/mL' });
    assert.equal(normalized.quantity.normalized_value, 12); assert.equal(normalized.calculation_authorized, false);
  } finally {
    db?.close();
    if (previous == null) delete process.env.CLAUDE_MEDCIUS_DATA; else process.env.CLAUDE_MEDCIUS_DATA = previous;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('read-only hospital views retain only explicitly mapped specimen, code system and assay metadata', async () => {
  const ctx = { tenant_id: 'synthetic-t', patient_id: 'synthetic-p', encounter_id: 'synthetic-e' };
  const row = { ...ctx, id: 'lab1', test_code: '89579-7', code_system: 'LOINC', test_name: 'hs-cTnI',
    result_value: 12, unit: 'ng/L', specimen_type: 'serum', method_code: 'hs', assay_id: 'assayA', assay_version: '1', unwanted: 'discard' };
  const library = createViewLibraryConnectors({ queryView: async () => [row] }).find(c => c.kind === 'lis');
  const result = (await library.readPatient(ctx)).records[0];
  for (const field of ['code_system', 'specimen_type', 'method_code', 'assay_id', 'assay_version']) assert.equal(result[field], row[field]);
  assert.equal(result.unwanted, undefined);
  const dbResult = VIEWDB_ROW_MAPPERS.lis({ ...row, item_code: row.test_code, item_name: row.test_name });
  for (const field of ['code_system', 'specimen_type', 'method_code', 'assay_id', 'assay_version']) assert.equal(dbResult[field], row[field]);
  const mapping = { schema_version: 1, mapping_id: 'synthetic_mapping', version: '1', tenant_id: ctx.tenant_id, data_class: 'synthetic', views: [
    { id: 'synthetic_lis', kind: 'lis', table: 'V_LIS', fields: Object.fromEntries(['id', 'patient_id', 'encounter_id', 'code_system',
      'specimen_type', 'method_code', 'assay_id', 'assay_version'].map(field => [field, { column: field, type: 'string',
        ...(['id', 'patient_id', 'encounter_id'].includes(field) ? { required: true } : {}) }])) } ] };
  const mapped = createMappedViewConnectors({ mapping, fixedTenantId: ctx.tenant_id, query: async () => [row] })[0];
  const mappedResult = (await mapped.readPatient(ctx)).records[0];
  assert.equal(mappedResult.assay_id, 'assayA'); assert.equal(mappedResult.assay_version, '1');
  assert.equal(mappedResult.code_system, 'LOINC'); assert.equal(mappedResult.specimen_type, 'serum');
});

test('laboratory reference rejects duplicate aliases, codes, changed unit dimensions or approval status', () => {
  assert.equal(validateLaboratoryTerminologyReference(LAB_TERMINOLOGY), true);
  for (const change of [r => { r.concepts[1].aliases.push('scr'); }, r => { r.concepts[1].loinc[0].code = '2160-0'; },
    r => { r.concepts[1].canonical_unit = 'mg/L'; }, r => { r.status = 'approved'; }]) {
    const ref = structuredClone(LAB_TERMINOLOGY); change(ref); assert.throws(() => validateLaboratoryTerminologyReference(ref), /REFERENCE_INVALID/);
  }
});

test('FHIR LIS preserves the coding system and does not promote A to critical', async () => {
  const resource = (id, flag) => ({ resourceType: 'Observation', id, status: 'final',
    subject: { reference: 'Patient/synthetic-p' }, encounter: { reference: 'Encounter/synthetic-e' },
    code: { coding: [{ system: 'http://loinc.org', code: '14682-9' }] }, valueQuantity: { value: 88.4, unit: 'umol/L' },
    effectiveDateTime: '2026-11-05T10:00:00Z', interpretation: [{ coding: [{ code: flag }] }] });
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', type: 'searchset',
    entry: [{ resource: resource('a', 'A') }, { resource: resource('aa', 'AA') }] }) });
  const connector = createFhirR4Connectors({ baseUrl: 'https://example.invalid/fhir', fetchImpl }).find(c => c.kind === 'lis');
  const result = await connector.readPatient({ tenant_id: 'synthetic-t', patient_id: 'synthetic-p', encounter_id: 'synthetic-e' });
  assert.equal(result.records[0].code_system, 'http://loinc.org');
  assert.equal(result.records[0].is_critical, false); assert.equal(result.records[1].is_critical, true);
});

test('unmapped HL7 private segments produce metadata-only warnings through actual connector', async () => {
  const raw = ['MSH|^~\\&|LAB|HOSP|MEDCIUS|HOSP|20261105100000+0800||ORU^R01|MSG1|P|2.5',
    'PID|1||synthetic-p', 'PV1|1|I|||||||||||||||||synthetic-e',
    'OBR|1||order', 'OBX|1|NM|K^Potassium||4|mmol/L|||||F', 'ZLB|private-patient-text|900'].join('\r');
  const message = parseHl7v2Message(raw);
  assert.deepEqual(privateSegmentWarnings(message), ['PRIVATE_SEGMENT_UNMAPPED:ZLB']);
  const connector = createHl7v2Connectors({ fetchMessages: async () => [raw] }).find(c => c.kind === 'lis');
  const envelope = await connector.readPatient({ tenant_id: 'synthetic-t', patient_id: 'synthetic-p', encounter_id: 'synthetic-e' });
  assert.ok(envelope.parse_warnings.includes('PRIVATE_SEGMENT_UNMAPPED:ZLB'));
  assert.doesNotMatch(JSON.stringify(envelope), /private-patient-text/);
});

test('HL7 abnormal A does not become critical; explicit LL and AA remain critical', () => {
  const msg = flag => parseHl7v2Message(['MSH|^~\\&|A|B|C|D|20261105100000||ORU^R01|M|P|2.5',
    'OBR|1||O', `OBX|1|NM|K^Potassium||4|mmol/L||${flag}|||F`].join('\r'));
  const abnormal = mapOruObservations(msg('A')).records[0];
  assert.equal(abnormal.is_critical, false); assert.equal(abnormal.interpretation, 'A');
  assert.equal(mapOruObservations(msg('LL')).records[0].is_critical, true);
  assert.equal(mapOruObservations(msg('AA')).records[0].is_critical, true);
});

test('HL7 observation preserves LN as explicit LOINC rather than guessing a numeric local code', () => {
  const m = parseHl7v2Message(['MSH|^~\\&|A|B|C|D|20261105100000||ORU^R01|M|P|2.5', 'OBR|1||O',
    'OBX|1|NM|14682-9^Creatinine^LN||88.4|umol/L|||||F'].join('\r'));
  assert.equal(mapOruObservations(m).records[0].code_system, 'LOINC');
});

test('a tenant-bound data-only Z profile yields research candidates and keeps source availability unknown', async () => {
  const profile = { schema_version: 'medcius.hl7-private-profile.v1', profile_id: 'synthetic-profile', version: '1',
    tenant_id: 'synthetic-t', status: 'unapproved_research_candidate', segments: [{ segment: 'ZLB', fields: { code: 1, value: 2, unit: 3 } }] };
  const raw = ['MSH|^~\\&|LAB|HOSP|MEDCIUS|HOSP|20261105100000+0800||ORU^R01|MSG1|P|2.5',
    'PID|1||synthetic-p', 'PV1|1|I|||||||||||||||||synthetic-e', 'OBR|1||order',
    'OBX|1|NM|K^Potassium||4|mmol/L|||||F', 'ZLB|LOCAL-SCR|0.9|umol/L'].join('\r');
  const connector = createHl7v2Connectors({ fetchMessages: async () => [raw], privateSegmentProfile: profile }).find(c => c.kind === 'lis');
  const ctx = { tenant_id: 'synthetic-t', doctor_id: 'synthetic-d', patient_id: 'synthetic-p', encounter_id: 'synthetic-e' };
  const envelope = await connector.readPatient(ctx), candidate = envelope.private_segment_candidates[0];
  assert.equal(candidate.local_code, 'LOCAL-SCR'); assert.equal(candidate.reported_value, 0.9);
  assert.equal(candidate.clinical_observation, false); assert.equal(candidate.calculation_authorized, false);
  assert.equal(envelope.records.some(r => r.code === 'LOCAL-SCR'), false);
  assert.ok(envelope.parse_warnings.includes('PRIVATE_SEGMENT_UNMAPPED:ZLB'));
  const basic = (id, kind, row) => ({ id, kind, capabilities: ['read'], async readPatient(c) {
    return { ...c, source_system: id, fetched_at: '2026-11-05T12:00:00Z', records: [row] }; } });
  const bridge = new ReadOnlyHospitalDataBridge({ connectors: [
    basic('p', 'patient', { id: ctx.patient_id }), basic('e', 'encounter', { id: ctx.encounter_id }), connector,
  ] });
  const snapshot = await bridge.readPatientSnapshot(ctx);
  assert.equal(snapshot.private_segment_candidates.length, 1);
  assert.equal(snapshot.source_availability.find(x => x.kind === 'lis').status, 'unknown');
  assert.match(snapshot.source_manifest.find(x => x.kind === 'lis').private_candidates_sha256, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.dataFeeds.lis.some(r => r.code === 'LOCAL-SCR'), false);
  await assert.rejects(() => connector.readPatient({ ...ctx, tenant_id: 'another' }), /TENANT_MISMATCH/);
  assert.throws(() => validatePrivateZProfile({ ...profile, status: 'approved' }), /PROFILE_INVALID/);
  assert.throws(() => validatePrivateZProfile({ ...profile, segments: [{ segment: 'ZLB', fields: { code: 1, value: 1, unit: 3 } }] }), /PROFILE_INVALID/);
  assert.throws(() => validatePrivateZProfile({ ...profile, transform: 'execute' }), /PROFILE_INVALID/);
});
