// All rows are synthetic, including rows labelled 'official' to exercise policy.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settlementFromNote } from '../plugins/medcius/lib/settlement-from-note.mjs';
const root = mkdtempSync(join(tmpdir(), 'medcius-cn-corpus-test-'));
process.env.CLAUDE_MEDCIUS_DATA = root;
const { HANDLERS: CC } = await import('../plugins/medcius/servers/china-codes/src/tools.mjs');
const { db: codes } = await import('../plugins/medcius/servers/china-codes/src/db.mjs');
const { HANDLERS: DL } = await import('../plugins/medcius/servers/drug-labels/src/tools.mjs');
const { db: labels } = await import('../plugins/medcius/servers/drug-labels/src/db.mjs');
after(() => { codes.close(); labels.close(); rmSync(root, { recursive: true, force: true }); });
codes.exec("INSERT INTO sources(id,name,url) VALUES(1,'synthetic fixture','https://example.invalid/codes')");
labels.exec("INSERT INTO sources(id,name,url) VALUES(1,'synthetic fixture','https://example.invalid/labels')");
const insertCode = codes.prepare('INSERT INTO nhsa_codes(code,code_system,name,code_type,data_class,source_id,code_version,effective_date) VALUES(?,?,?,?,?,1,?,?)');
insertCode.run('X01','ICD-10','合成疾病','diagnosis','official','v1','2020-01-01');
insertCode.run('X01','CCHI','合成操作','procedure','official','v1','2020-01-01');
insertCode.run('X02','ICD-10','合成样例','diagnosis','sample','v1','2020-01-01');
const insertLabel = labels.prepare('INSERT INTO drug_labels(generic_name,approval_number,sections_json,data_class,source_id,source_version,effective_date) VALUES(?,?,?,?,1,?,?)');
insertLabel.run('合成药A','fixture-A1',JSON.stringify({ 肾功能: '按原始标签复核肾功能资料' }),'official','v1','2020-01-01');
insertLabel.run('合成药A','fixture-A2',JSON.stringify({ 肾功能: '不同剂型的标签' }),'official','v1','2020-01-01');
insertLabel.run('合成药B','fixture-B1','{}','official','v1','2020-01-01');

test('code systems never fall back and omission of a system does not choose an arbitrary code', () => {
  assert.equal(CC.get_code({ code: 'X01' }).error, 'ambiguous_code_system');
  assert.equal(CC.validate_code({ code: 'X01' }).validation_status, 'unverifiable');
  assert.equal(CC.get_code({ code: 'X01', code_system: 'CCHI' }).name, '合成操作');
  assert.equal(CC.validate_code({ code: 'X01', code_system: 'unloaded-system' }).validation_status, 'unverifiable');
  const hits = CC.search_codes({ query: 'X01', code_system: 'ICD-10' }).hits;
  assert.equal(hits.length, 1); assert.equal(hits[0].code_system, 'ICD-10');
  assert.equal(CC.validate_code({ code: 'X02', code_system: 'ICD-10' }).validation_status, 'unverifiable');
  assert.equal(CC.corpus_status().production_ready, false);
  insertCode.run('X03','ICD-10','合成疾病','diagnosis','official','v1','2020-01-01');
  const exact = CC.search_codes({ query: '合成疾病', code_system: 'ICD-10', match_mode: 'exact_name', limit: 1 });
  assert.equal(exact.total_matches, 2); assert.equal(exact.truncated, true);
  const ambiguous = settlementFromNote('出院诊断：合成疾病', CC, { diagnosisSystem: 'ICD-10' });
  assert.equal(ambiguous.settlement_list.出院主诊断[0].resolution_status, 'ambiguous');
  assert.equal(ambiguous.settlement_list.出院主诊断[0].provenance.code, null);
});

test('settlement lookup requires exact, unique names within the requested system', () => {
  let request;
  const fake = { corpus_status: () => ({ counts: { codes: { official: 3 } } }),
    search_codes: args => { request = args; return { hits: [{ code: 'X01', name: '合成疾病及其他', code_system: 'ICD-10' }] }; },
    validate_code: () => { throw new Error('must not validate wrong candidate'); } };
  const r = settlementFromNote('出院诊断：合成疾病', fake, { diagnosisSystem: 'ICD-10' });
  assert.equal(request.code_system, 'ICD-10');
  assert.equal(r.settlement_list.出院主诊断[0].provenance.code, null);
  assert.equal(r.settlement_list.出院主诊断[0].resolution_status, 'no_exact_match');
  assert.equal(r.production_ready, false);
  codes.exec("INSERT INTO gender_code_rules(code,sex_required) VALUES('X01','female')");
  const scoped = CC.check_settlement_list({ sex: 'male', items: [
    { code: 'X01', kind: 'procedure', code_system: 'CCHI' },
    { code: 'X01', kind: 'diagnosis', code_system: 'ICD-10' },
    { code: 'unknown', kind: 'diagnosis', code_system: 'ICD-10' }] });
  assert.deepEqual(scoped.checks.map(x => x.ok), [null, false, null]);
  assert.equal(scoped.fail_count, 1); assert.equal(scoped.unevaluated_count, 2);
});

test('different formulations cannot be resolved by first hit; explicit product selection works', () => {
  const ambiguity = DL.check_interactions({ drugs: ['合成药A','合成药B'] });
  assert.equal(ambiguity.pairs[0].status, 'insufficient_data');
  const selected = DL.check_interactions({ drugs: ['fixture-A1','fixture-B1'] });
  assert.equal(selected.pairs[0].a_label.approval_number, 'fixture-A1');
  assert.notEqual(selected.pairs[0].status, 'insufficient_data');
  assert.equal(DL.get_label({ label_id: 1, approval_number: 'fixture-A2' }).error, 'label_selector_mismatch');
  assert.equal(DL.corpus_status().production_ready, false);
});

test('indexed eGFR is not used as CrCl dose strata; missing VBP capability is explicit', () => {
  const r = DL.check_renal_dosing({ drugs: ['fixture-A1'], egfr: 20 });
  assert.equal(r.renal.bucket, null); assert.equal(r.dose_recommendation, null);
  assert.equal(r.per_drug[0].crcl_bucket, null);
  assert.equal(DL.check_renal_dosing({ drugs: [], crcl: -1 }).renal.bucket, null);
  assert.equal(DL.corpus_status().capabilities.vbp_substitution, 'NOT_IMPLEMENTED');
});

test('catalog lookup cannot replace a named product with the first substring match', () => {
  codes.exec("INSERT INTO nhsa_drug_catalog(generic_name,category,payment_restriction,data_class,source_id) VALUES('合成药B注射剂','乙类','限二线治疗','official',1)");
  assert.equal(CC.check_catalog_restriction({ drug_name: '合成药B', diagnosis_terms: ['二线治疗'] }).status, 'not_in_catalog_corpus');
  const exact = CC.check_catalog_restriction({ drug_name: '合成药B注射剂', diagnosis_terms: ['二线治疗'] });
  assert.equal(exact.payment_eligibility, 'NOT_EVALUATED');
});
