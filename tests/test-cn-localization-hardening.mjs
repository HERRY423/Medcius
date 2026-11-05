// Synthetic adversarial fixtures. Engineering checks, never clinical validation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCnNote, parseLabs, parseCnDate, splitSections, splitSectionSpans, extractConTextAssertion, extractConTextAssertions, parseCompactVitals } from '../plugins/medcius/lib/parse-cn-note.mjs';
import { createCaSignatureAdapter, internalEcCaProvider } from '../plugins/medcius/lib/ca-signature-adapter.mjs';
import { createLlmInferenceClient } from '../plugins/medcius/lib/llm-inference-config.mjs';
import { createViewDbConnector } from '../plugins/medcius/lib/connectors/viewdb-connector.mjs';
import { createTextAnchor, inspectEvidenceAnchor } from '../plugins/medcius/lib/evidence-anchors.mjs';
import { scanText } from '../plugins/medcius/servers/phiguard/src/lib.mjs';
import { sha256Hex, canonicalJson } from '../plugins/medcius/servers/shared/crypto.mjs';
import { guardFreeTextEgress } from '../plugins/medcius/lib/local-phi-egress.mjs';
import { validateClinicalEvaluationIntake } from '../plugins/medcius/lib/clinical-evaluation-intake.mjs';
import { buildRecordQualityReport } from '../plugins/medcius/lib/nhsa-record-quality-engine.mjs';
import { DatabaseSync } from 'node:sqlite';
import { HospitalAgentAdapter, getPreRoundResearchSnapshot, replayPreRoundResearchSnapshot } from '../plugins/medcius/lib/hospital-agent-adapter.mjs';

test('mixed assertions abstain at sentence level; R/O stays uncertain', () => {
  assert.equal(extractConTextAssertion('双肺呼吸音粗，未闻及干湿啰音').presence, 'uncertain');
  assert.equal(extractConTextAssertion('R/O 肺炎').presence, 'uncertain');
  assert.equal(extractConTextAssertion('无明显诱因出现胸痛').presence, 'positive');
  assert.equal(extractConTextAssertion('').presence, 'not_mentioned');
});

test('laboratory units and exact source text are preserved without default units', () => {
  const src = 'Scr 1.2 mg/dL；血钾 3.1；Scr 88 μmol/L';
  const labs = parseLabs(src);
  assert.equal(labs.filter(x => x.name === '肌酐').length, 2);
  assert.equal(labs.find(x => x.name === '肌酐').unit, 'mg/dL');
  assert.equal(labs.find(x => x.name === '血钾').unit, null);
  for (const lab of labs) assert.equal(src.slice(lab.start, lab.end), lab.span);
});

test('uncertain primary diagnosis is not silently replaced by secondary diagnosis', () => {
  const note = parseCnNote('出院诊断：\n1. 肺炎待排\n2. 高血压');
  assert.equal(note.discharge_diagnosis_primary.value, null);
  assert.equal(note.discharge_diagnosis_primary.null_reason, 'mentioned_unclear');
  assert.equal(note.discharge_diagnosis_other.value, '高血压');
  const inline = parseCnNote('出院诊断：1. R/O 肺炎；2. 高血压');
  assert.equal(inline.discharge_diagnosis_primary.value, null);
  assert.equal(inline.discharge_diagnosis_other.value, '高血压');
});

test('guarding names before extraction preserves a byte-identical frozen replay and source anchors', () => {
  const context = { tenant_id: 'site', patient_id: 'patient-a', encounter_id: 'encounter-a', doctor_id: 'staff-a', as_of: '2026-10-03T14:00:00Z' };
  const result = HospitalAgentAdapter.executePreRoundWorkflow({ host: 'codex', context, dataFeeds: {
    patient: { id: 'patient-a', gender: 'male' }, notes: [{ id: 'note-a', patient_id: 'patient-a', encounter_id: 'encounter-a',
      timestamp: '2026-10-03T12:00:00Z', text: '病程记录：患者张合成因咳嗽入院，双肺呼吸音粗，未闻及干湿啰音。', source_version: undefined }] } });
  const snapshot = JSON.parse(JSON.stringify(getPreRoundResearchSnapshot(result), (_key, value) => value === undefined ? null : value));
  assert.deepEqual(replayPreRoundResearchSnapshot(snapshot.replayInput), snapshot.engineOutput);
  assert.doesNotMatch(JSON.stringify(snapshot), /张合成/);
  assert.equal(scanText('患者咳嗽，气促').total, 0);
  assert.equal(scanText('患者高血压，父亲高血糖，母亲白血病。').total, 0);
});

test('repeated sections retain both observations and invalid calendar dates are rejected', () => {
  assert.equal(splitSections('病程记录：胸闷\n病程记录：无发热')['病程记录'], '胸闷\n无发热');
  assert.equal(parseCnDate('2026-02-30'), null);
});

test('signature binds tenant, workflow, time, note and provider metadata', async () => {
  const ca = createCaSignatureAdapter();
  const payload = { text: '合成资料' };
  const { signature_record: r } = await ca.createSignatureRecord({ workflow: 'evolution', payload, signerId: 'synthetic-staff', role: 'physician', tenantId: 'synthetic-site' });
  assert.equal((await ca.verifySignatureRecord({ record: r, payload })).valid, true);
  const mutations = [x => x.signer.tenant_id = 'another-site', x => x.workflow = 'another-workflow',
    x => x.signed_at = '2000-01-01T00:00:00.000Z', x => x.signer_note = 'changed',
    x => x.provider = 'another-provider', x => x.algorithm = 'SM2_WITH_SM3', x => x.certificate_fingerprint = 'forged'];
  for (const mutate of mutations) {
    const changed = structuredClone(r); mutate(changed);
    assert.equal((await ca.verifySignatureRecord({ record: changed, payload })).valid, false);
  }
});

test('hosted inference cannot be enabled by attestations without an executing local detector', () => {
  assert.throws(() => createLlmInferenceClient({ config: { topology: 'B', model_id: 'synthetic', model_version: 'v1',
    prompt_pack_version: 'v1', endpoint: 'https://example.invalid', desensitization_attestation: true,
    phi_exit_guard_version: 'v1', egress_human_sampling_attested: true, bare_name_limitation_acknowledged: true },
    transport: async () => ({ text: 'never called' }) }), /LOCAL_PHI_DETECTOR_REQUIRED/);
});

test('SQL dialect rejects unsupported values and emits SQL Server parameter placeholders', async () => {
  const opts = { id: 'synthetic-lis', kind: 'lis', table: 'v_medcius_lis', columns: ['id'], query: async () => [] };
  assert.throws(() => createViewDbConnector({ ...opts, dialect: 'unknown' }), /DIALECT/);
  let observed;
  const connector = createViewDbConnector({ ...opts, dialect: 'sqlserver', query: async (sql, params) => { observed = { sql, params }; return []; } });
  await connector.readPatient({ tenant_id: 'T', patient_id: 'P', encounter_id: 'E' });
  assert.match(observed.sql, /TOP \(@p1\)/);
  assert.doesNotMatch(observed.sql, /LIMIT|\?/);
  assert.deepEqual(observed.params, [200, 'T', 'P', 'E']);
});

test('negation scope, coordinated findings, family attribution and pseudo-negation remain distinct', () => {
  const clauses = extractConTextAssertions('无发热，咳嗽及咳痰；双肺呼吸音粗，未闻及明显的干啰音、湿啰音；胸痛无缓解，但无气促');
  assert.deepEqual(clauses.map(x => x.presence), ['negative', 'negative', 'positive', 'negative', 'positive', 'negative']);
  const family = extractConTextAssertions('母亲有胸痛，患者否认胸痛');
  assert.deepEqual(family.map(x => x.experiencer), ['family_member', 'patient']);
  const mixedTime = extractConTextAssertions('母亲既往胸痛，患者现有咳嗽；既往胸闷，现无胸闷');
  assert.deepEqual(mixedTime.map(x => x.temporality), ['historical', 'current', 'historical', 'current']);
  assert.equal(extractConTextAssertion('不能排除肺炎').presence, 'uncertain');
  assert.equal(extractConTextAssertion('无明显诱因胸痛，伴气促').presence, 'positive');
});

test('original CRLF, bracket headings, repeated quotes and compact vitals keep exact offsets', () => {
  const text = '【病程记录】\r\n胸闷\r\n【病程记录】\r\n胸闷\r\n查体：神清语利。';
  const sections = splitSectionSpans(text);
  assert.equal(sections.length, 3);
  for (const s of sections) assert.equal(text.slice(s.start, s.end), s.text);
  const record = { id: 'synthetic-note', text };
  for (const s of sections.slice(0, 2)) {
    const item = { source_id: record.id, span: s.text, text_anchor: createTextAnchor(record, s) };
    assert.equal(inspectEvidenceAnchor(item, [record]).anchor_status, 'verbatim_verified');
    assert.equal(inspectEvidenceAnchor(item, [{ ...record, text: text + '变更' }]).anchor_status, 'stale_or_unverified');
  }
  const v = parseCompactVitals('T/P/R/BP:36.5/80/18/120/80')[0];
  assert.equal(v.values.diastolic_bp, 80); assert.equal(v.units, null);
  assert.equal(parseCompactVitals('T/P/R/BP:36.5/80/18/120').length, 0);
});

test('comparators, unit absence and analyte identity are not converted to point estimates or another analyte', () => {
  const labs = parseLabs('APTT 30 s；Scr < 1.0 mg/dL；尿素 5 mmol/L；肌钙蛋白 8 ng/L');
  assert.equal(labs.some(l => l.name === '凝血酶原时间'), false);
  assert.equal(labs.find(l => l.name === '肌酐').comparator, '<');
  assert.equal(labs.some(l => l.name === '尿素氮' || l.name === '肌钙蛋白I'), false);
});

const detector = { id: 'synthetic-local-detector', version: 'fixture-v1', execution: 'local',
  async detect(text) { return { text_sha256: sha256Hex(text), complete: true,
    spans: [...text.matchAll(/张合成/g)].map(m => ({ start: m.index, end: m.index + m[0].length, label: 'PERSON' })) }; } };
const hosted = { topology: 'B', model_id: 'synthetic', model_version: 'v1', prompt_pack_version: 'v1',
  endpoint: 'https://example.invalid', desensitization_attestation: true, phi_exit_guard_version: 'v1',
  egress_human_sampling_attested: true, bare_name_limitation_acknowledged: true };

test('local detector executes before transport; bare names and contextual family names are removed', async () => {
  let prompt;
  const client = createLlmInferenceClient({ config: hosted, localPhiDetector: detector,
    transport: async req => { prompt = req.prompt; return { text: '已抽取' }; } });
  const response = await client.extract({ text: '张合成因胸闷入院，妻子李合成陪同。赵合成主任医师查房。' });
  assert.doesNotMatch(prompt, /张合成|李合成|赵合成/);
  assert.match(prompt, /胸闷/);
  assert.equal(response.egress_receipt.passes_completed, 2);
  assert.equal(response.egress_receipt.complete_deidentification, 'NOT_ESTABLISHED');
  assert.equal(scanText('妻子李合成陪同').total, 1);
});

test('unbound, incomplete, invalid-span and failing detectors cannot release a prompt', async () => {
  for (const result of [{ complete: true, spans: [], text_sha256: 'wrong' },
    { complete: false, spans: [], text_sha256: sha256Hex('输入') },
    { complete: true, spans: [{ start: -1, end: 2, label: 'PERSON' }], text_sha256: sha256Hex('输入') }]) {
    let sent = false;
    const client = createLlmInferenceClient({ config: hosted, localPhiDetector: { ...detector, detect: async () => result },
      transport: async () => { sent = true; return { text: 'bad' }; } });
    await assert.rejects(client.extract({ text: '输入' }), /LOCAL_PHI/); assert.equal(sent, false);
  }
  await assert.rejects(guardFreeTextEgress('输入', { detector: { ...detector, detect: async () => { throw new Error('private content'); } } }), /LOCAL_PHI_DETECTOR_FAILED/);
});

test('a slow local detector is bounded, retains backpressure and never sends after the deadline', async () => {
  let sent = false;
  const slow = { ...detector, detect: async text => { await new Promise(r => setTimeout(r, 25)); return { complete: true, spans: [], text_sha256: sha256Hex(text) }; } };
  const c = createLlmInferenceClient({ config: { ...hosted, capacity: { max_concurrency: 1 } }, localPhiDetector: slow, timeoutMs: 5,
    transport: async () => { sent = true; return { text: 'bad' }; } });
  await assert.rejects(c.extract({ text: '输入' }), /LLM_TIMEOUT/);
  assert.equal(c.capacity().inflight, 1);
  await assert.rejects(c.extract({ text: '输入' }), /CONCURRENCY/);
  await new Promise(r => setTimeout(r, 35)); assert.equal(sent, false);
  assert.equal(c.capacity().inflight, 0);
  const fail = createLlmInferenceClient({ config: hosted, localPhiDetector: detector,
    transport: async () => { throw new Error('private-provider-content'); } });
  await assert.rejects(fail.extract({ text: '输入' }), e => e.message === 'LLM_TRANSPORT_FAILED');
});

test('hospital signatures reject local mock keys, legacy envelopes and revoked certificates', async () => {
  const args = { workflow: 'evolution', payload: { synthetic: true }, signerId: 'staff', role: 'physician', tenantId: 'site' };
  await assert.rejects(createCaSignatureAdapter({ profile: 'hospital' }).createSignatureRecord(args), /CA_HOSPITAL_PROVIDER_REQUIRED/);
  assert.equal((await createCaSignatureAdapter().verifySignatureRecord({ record: { schema_version: 'medcius.clinician-signature-record.v1' } })).valid, false);
  // EC fixture only tests the trust-response gate; it is not a real CA or an SM2 test.
  const ec = internalEcCaProvider();
  const bad = createCaSignatureAdapter({ profile: 'hospital', provider: { ...ec, assurance: 'hospital_ca',
    verify: async req => ({ ...await ec.verify(req), certificate_chain_valid: true, revocation_status: 'revoked',
      signer_id: req.signerId, tenant_id: req.tenantId, checked_at: new Date().toISOString() }) } });
  await assert.rejects(bad.createSignatureRecord(args), /CA_HOSPITAL_VERIFICATION_FAILED/);
});

test('view query actually isolates tenant/patient/encounter in SQLite and keeps truncation unknown', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE v_lis(id TEXT, tenant_id TEXT, patient_id TEXT, encounter_id TEXT)');
  const insert = db.prepare('INSERT INTO v_lis VALUES (?, ?, ?, ?)');
  insert.run('a','T','P','E'); insert.run('b','U','P','E'); insert.run('c','T','P','F');
  const opts = { id: 'sqlite-lis', kind: 'lis', table: 'v_lis', columns: ['id'], query: async (sql, p) => db.prepare(sql).all(...p) };
  try {
    const result = await createViewDbConnector(opts).readPatient({ tenant_id: 'T', patient_id: 'P', encounter_id: 'E' });
    assert.deepEqual(result.records.map(x => x.id), ['a']); assert.equal(result.complete, true);
    assert.equal((await createViewDbConnector({ ...opts, limit: 1 }).readPatient({ tenant_id: 'T', patient_id: 'P', encounter_id: 'E' })).complete, false);
    assert.throws(() => createViewDbConnector({ ...opts, tenantColumn: null }), /FIXED_TENANT/);
    await assert.rejects(createViewDbConnector({ ...opts, tenantColumn: null, fixedTenantId: 'T' }).readPatient({ tenant_id: 'U', patient_id: 'P', encounter_id: 'E' }), /TENANT_MISMATCH/);
  } finally { db.close(); }
});

test('database timeout retains backpressure until executor settles and all dialects bind values', async () => {
  let release;
  const opts = { id: 'lis', kind: 'lis', table: 'v_lis', columns: ['id'], timeoutMs: 5, maxConcurrency: 1,
    query: async () => new Promise(r => { release = r; }) };
  const context = { tenant_id: 'T', patient_id: 'P', encounter_id: 'E' };
  const conn = createViewDbConnector(opts);
  await assert.rejects(conn.readPatient(context), /TIMEOUT/);
  await assert.rejects(conn.readPatient(context), /CONCURRENCY_LIMIT/);
  release([]); await new Promise(r => setTimeout(r, 0));
  for (const [dialect, marker] of [['postgresql', '$4'], ['oracle', ':4'], ['mysql', '?']]) {
    let sql;
    await createViewDbConnector({ ...opts, dialect, schema: 'medcius', query: async (s,p) => { sql=s; assert.deepEqual(p,['T','P','E',200]); return []; } }).readPatient(context);
    assert.ok(sql.includes(marker)); assert.match(sql, /medcius\.v_lis/);
  }
});

test('P chapter is about origin, unknown code systems cannot trigger ICD rules, uncertain diagnosis is recorded', () => {
  const text = '出院记录\n性别：男 年龄：60岁\n出院诊断：围产期起源的疾病';
  const r = buildRecordQualityReport(text, { diagnosis_codes: [{ code: 'P27.1', code_system: 'ICD-10' }] });
  assert.equal(r.legality_conflicts.some(x => x.code === 'NEONATAL_DIAGNOSIS_AGE_CONFLICT'), false);
  assert.ok(r.advisory_hints.some(x => x.code === 'PERINATAL_ORIGIN_REVIEW'));
  const unknown = buildRecordQualityReport(text, { diagnosis_codes: [{ code: 'O80', code_system: 'CCHI' }] });
  assert.equal(unknown.legality_conflicts.some(x => x.code === 'OBSTETRIC_DIAGNOSIS_SEX_CONFLICT'), false);
  const uncertain = buildRecordQualityReport('出院记录\n出院诊断：R/O 肺炎');
  assert.equal(uncertain.element_gaps.some(x => x.code === 'PRIMARY_DISCHARGE_DIAGNOSIS_MISSING'), false);
  assert.ok(uncertain.advisory_hints.some(x => x.code === 'UNCERTAIN_PRIMARY_DIAGNOSIS'));
  assert.doesNotMatch(JSON.stringify(uncertain), /不得按疑似编码/);
  // NHC inpatient front-page definition counts admission/discharge days once.
  const stay = buildRecordQualityReport('入院日期：2011-06-12 出院日期：2011-06-15 住院天数：3天');
  assert.equal(stay.algebra_conflicts.some(x => x.code === 'STAY_DAYS_MISMATCH'), false);
  const sameDay = buildRecordQualityReport('入院日期：2024-08-01 出院日期：2024-08-01 住院天数：1天');
  assert.equal(sameDay.algebra_conflicts.some(x => x.code === 'STAY_DAYS_MISMATCH'), false);
});

const intakeRow = { note_id: 'synthetic-1', note_text: '出院诊断：合成测试疾病', gold: { discharge_diagnosis_primary: { value_contains: ['合成测试疾病'] } }, source_meta: { desensitized: true } };
test('evaluation identity, repeated records, PHI anywhere and patient split leakage fail closed', () => {
  assert.equal(validateClinicalEvaluationIntake([intakeRow], { synthetic: true }).data_kind, 'SYNTHETIC_ONLY');
  assert.throws(() => validateClinicalEvaluationIntake([intakeRow]), /MANIFEST_REQUIRED/);
  assert.throws(() => validateClinicalEvaluationIntake([intakeRow], { synthetic: true, manifest: {} }), /DATA_MODE_CONFLICT/);
  assert.throws(() => validateClinicalEvaluationIntake([intakeRow, intakeRow], { synthetic: true }), /DUPLICATE_NOTE_ID/);
  assert.throws(() => validateClinicalEvaluationIntake([{ ...intakeRow, gold: { free: '联系人：张合成' } }], { synthetic: true }), /PHI/);
  const manifest = { schema_version: 'medcius.clinical-evaluation-intake.v1', data_kind: 'retrospective',
    ...Object.fromEntries(['study_ref','protocol_ref','authorization_ref','ethics_ref','processing_ref','parser_version','site_ref','annotation_protocol_ref','split_policy_ref'].map(k=>[k, 'synthetic-ref'])),
    development_subject_refs: ['subject-a'] };
  const row = { ...intakeRow, source_meta: { desensitized: true, subject_ref: 'subject-a', source_record_ref: 'source-a', source_version: 'v1', split: 'evaluation', annotation_source: 'source_first', model_output_visible: false, annotator_refs: ['reviewer-a','reviewer-b'] } };
  manifest.dataset_sha256 = sha256Hex(canonicalJson([row]));
  assert.throws(() => validateClinicalEvaluationIntake([row], { manifest }), /SUBJECT_LEAKAGE/);
  manifest.development_subject_refs = [];
  const checked = validateClinicalEvaluationIntake([row], { manifest });
  assert.equal(checked.clinical_evidence, 'NOT_ESTABLISHED'); assert.equal(checked.reference_independence, 'NOT_ESTABLISHED');
});
