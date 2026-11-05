import { readFileSync } from 'node:fs';
import { createPatientSourceSnapshot } from '../../plugins/medcius/lib/patient-source-snapshot.mjs';
import { reconcileRecordEvidence } from '../../plugins/medcius/lib/record-evidence-reconciliation.mjs';
export const policy = JSON.parse(readFileSync(new URL('../../plugins/medcius/config/record-review/jiangsu-reference.v1.json', import.meta.url), 'utf8'));
export const context = { tenant_id: 'synthetic-tenant', patient_id: 'synthetic-patient', encounter_id: 'synthetic-encounter' };
export const begin = '2026-10-01T08:00:00+08:00', end = '2026-10-03T12:00:00+08:00', asOf = '2026-10-04T12:00:00+08:00';
export const coded = { code: 'DEMO-DX', code_system: 'NHSA-ICD10', code_version: 'fixture-release', kind: 'diagnosis', role: 'discharge_primary' };
export function input() {
  const base = { ...context, status: 'final', version_id: '1', event_time: '2026-10-02T08:00:00+08:00' };
  return { context, patient: { id: context.patient_id }, encounter: { id: context.encounter_id, admission_time: begin, discharge_time: end }, asOf,
    notes: [{ ...base, id: 'front', source_system: 'EMR', document_kind: 'front_sheet', event_time: end,
      text: '出院记录\n性别：男\n年龄：60岁\n入院日期：2026-10-01\n出院日期：2026-10-03\n实际住院：2天\n离院方式：1\n出院诊断：合成基础病',
      diagnoses: [coded], grouping_fields: { age_years: 60, sex: 'male', stay_days: 2, discharge_method: '1' } },
    { ...base, id: 'progress', source_system: 'EMR', document_kind: 'progress', signed: true, author_role: 'clinician',
      text: '目前诊断低钾血症，已安排纠正。' }],
    observations: [{ ...base, id: 'lab-k', source_system: 'LIS', concept_code: 'potassium', value: 2.4, unit: 'mmol/L', measurement_context: { specimen: 'serum' }, critical: true, result_direction: 'low' }],
    orders: [{ ...base, id: 'order-k', source_system: 'HIS', status: 'active', concept_code: 'potassium_replacement', order_kind: 'temporary',
      execution_status: 'pharmacy_returned', administrations: [] }],
    diagnosticReports: [], sourceAvailability: policy.sources.map(s => ({ kind: s.kind, source_system: s.system, status: 'complete',
      from: begin, to: end, watermark: end, context })) };
}
export function review(change = () => {}, p = policy) {
  const data = input(); change(data);
  const snapshot = createPatientSourceSnapshot(data);
  return reconcileRecordEvidence({ snapshot, front_sheet_id: 'front', policy: p });
}
export const profile = { schema_version: 'medcius.local-grouper-profile.v1', id: 'fixture-js-grouper', version: 'fixture-v1',
  province: 'CN-32', region: 'CN-3209', scheme: 'drg', grouping_version: 'JS-DRG-2.0-SYNTHETIC',
  adapter_id: 'fixture-adapter', rule_source: 'synthetic-fixture-only', rule_digest: 'a'.repeat(64),
  data_class: 'sample', effective_from: '2026-01-01', effective_until: '2026-12-31',
  code_releases: { diagnosis: { system: 'NHSA-ICD10', version: 'fixture-release' }, procedure: { system: 'NHSA-ICD9CM3', version: 'fixture-release' } },
  required_fields: ['age_years', 'sex', 'stay_days', 'discharge_method'] };
export function response(request) {
  return { request_id: request.request_id, request_digest: request.digest, profile_digest: request.profile_digest,
    region: request.region, scheme: request.scheme, grouping_version: request.grouping_version, rule_digest: request.rule_digest,
    status: 'grouped', group_code: 'SYNTHETIC-GROUP', mcc_cc: [] };
}
export function crosswalk() {
  return { schema_version: 'medcius.terminology-crosswalk.v1', pack_id: 'fixture-crosswalk-1', data_class: 'sample', region: 'CN-32',
    effective_from: '2026-01-01', effective_until: '2026-12-31',
    source: { name: 'synthetic only', version: 'fixture-v1', url: 'https://example.invalid/synthetic', sha256: 'b'.repeat(64), retrieved_on: '2026-01-01' },
    nodes: [
      { id: 'term', system: 'CLINICIAN-TERMS', version: 'fixture', code: 'term-1', name: '合成基础病', kind: 'clinical_term' },
      { id: 'clinical', system: 'NHC-ICD10', version: '2.0', code: 'DEMO-C1', name: '合成基础病', kind: 'diagnosis', full_length: true, is_main_diag_allowed: true },
      { id: 'nhsa', system: 'NHSA-ICD10', version: 'fixture-release', code: 'DEMO-DX', name: '合成基础病', kind: 'diagnosis', full_length: true, is_main_diag_allowed: true },
      { id: 'regional', system: 'JS-LOCAL-DX', version: 'fixture-release', code: 'DEMO-JS', name: '合成基础病', kind: 'diagnosis', full_length: true },
      { id: 'cchi', system: 'CCHI', version: 'fixture', code: 'DEMO-P1', name: '合成操作', kind: 'procedure', full_length: true },
      { id: 'icd9', system: 'NHSA-ICD9CM3', version: 'fixture-release', code: 'DEMO-P2', name: '合成操作', kind: 'procedure', full_length: true },
    ], edges: [['term','clinical'],['clinical','nhsa'],['nhsa','regional'],['cchi','icd9']].map(([from,to],i) =>
      ({ id: `edge-${i}`, from, to, relation: 'equivalent', bidirectional: true, source_locator: `synthetic row ${i}`, qualifiers: [] })) };
}
