// Synthetic fixtures, including official-labelled rows testing importer policy.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { crosswalk } from './fixtures/jiangsu-record-review.mjs';
import { terminologyDigest } from '../plugins/medcius/lib/terminology-crosswalk.mjs';
import { settlementFromNote } from '../plugins/medcius/lib/settlement-from-note.mjs';
const root = mkdtempSync(join(tmpdir(), 'medcius-js-crosswalk-'));
process.env.CLAUDE_MEDCIUS_DATA = root;
mkdirSync(join(root, 'china-codes'));
const legacy = new DatabaseSync(join(root, 'china-codes/data.sqlite'));
legacy.exec("CREATE TABLE migration_sentinel(id TEXT PRIMARY KEY, value TEXT); INSERT INTO migration_sentinel VALUES('existing','preserve me'); PRAGMA user_version=2;");
legacy.close();
const { db } = await import('../plugins/medcius/servers/china-codes/src/db.mjs');
const { HANDLERS: CC } = await import('../plugins/medcius/servers/china-codes/src/tools.mjs');
const { importCrosswalk, loadCrosswalk } = await import('../plugins/medcius/servers/china-codes/src/crosswalk-store.mjs');
after(() => {
  db.close();
  const target = resolve(root);
  assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('medcius-js-crosswalk-'));
  rmSync(target, { recursive: true, force: true });
});
const ingest = p => importCrosswalk(p, { expected_digest: terminologyDigest(p), review_id: 'synthetic-test-review' });
test('schema v2 upgrades additively and preserves existing data', () => {
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.prepare('SELECT value FROM migration_sentinel').get().value, 'preserve me');
});
test('immutable import is idempotent; changed content and missing digest fail atomically', () => {
  const p = crosswalk(); assert.equal(ingest(p).status, 'imported'); assert.equal(ingest(p).status, 'already_present');
  p.nodes[0].name = 'different'; assert.throws(() => ingest(p), /IMMUTABLE/);
  assert.equal(loadCrosswalk(p.pack_id).nodes[0].name, '合成基础病');
  p.pack_id = 'bad-review'; assert.throws(() => importCrosswalk(p, { expected_digest: 'wrong', review_id: 'r' }), /BINDING/);
  assert.equal(loadCrosswalk('bad-review'), null);
});
test('official-labelled imports require matching source bytes, not just a label', () => {
  const p = crosswalk(); p.pack_id = 'official-fixture'; p.data_class = 'official';
  assert.throws(() => ingest(p), /SOURCE_BYTES/);
  const source_bytes = Buffer.from('SYNTHETIC SOURCE NOT OFFICIAL EVIDENCE');
  p.source.sha256 = createHash('sha256').update(source_bytes).digest('hex');
  assert.equal(importCrosswalk(p, { expected_digest: terminologyDigest(p), review_id: 'synthetic-source-fixture', source_bytes }).source_hash_verified, true);
});
test('parallel releases survive process restart and query does not silently select latest', () => {
  const p = crosswalk(); p.pack_id = 'fixture-v2'; p.nodes[2].version = 'fixture-release-2'; ingest(p);
  const old = CC.get_code({ pack_id: 'fixture-crosswalk-1', code: 'DEMO-DX', code_system: 'NHSA-ICD10', code_version: 'fixture-release', region: 'CN-3209', as_of: '2026-10-03' });
  assert.equal(old.code_version, 'fixture-release');
  const missing = CC.get_code({ pack_id: 'fixture-v2', code: 'DEMO-DX', code_system: 'NHSA-ICD10', code_version: 'fixture-release', region: 'CN-3209', as_of: '2026-10-03' });
  assert.equal(missing.validation_status, 'unverifiable');
  const script = `const {HANDLERS:C}=await import(${JSON.stringify(new URL('../plugins/medcius/servers/china-codes/src/tools.mjs', import.meta.url).href)}); console.log(JSON.stringify(C.crosswalk_status()));`;
  const child = spawnSync(process.execPath, ['--input-type=module','-e',script], { encoding: 'utf8', env: process.env });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).packs.length, 3);
});
test('settlement uses the selected release and separates mapping candidates from chosen codes', () => {
  const result = settlementFromNote('出院诊断：合成基础病', CC, { codePackId: 'fixture-crosswalk-1',
    diagnosisSystem: 'NHSA-ICD10', diagnosisVersion: 'fixture-release', procedureVersion: 'fixture-release', region: 'CN-3209', asOf: '2026-10-03',
    crosswalk: { pack_id: 'fixture-crosswalk-1', from: { system: 'CLINICIAN-TERMS', version: 'fixture' },
      target: { system: 'JS-LOCAL-DX', version: 'fixture-release' }, region: 'CN-3209' } });
  assert.equal(result.settlement_list.出院主诊断[0].provenance.code, 'DEMO-DX');
  assert.equal(result.settlement_list.出院主诊断[0].provenance.validation_status, 'unverifiable');
  assert.equal(result.mappings[0].review.candidates[0].node.code, 'DEMO-JS');
  assert.equal(result.production_ready, false);
});
test('persisted tampering is detected before any code is returned', () => {
  const p = crosswalk(); p.pack_id = 'tamper-test'; ingest(p);
  db.prepare('UPDATE terminology_crosswalk_packs SET digest=? WHERE pack_id=?').run('0'.repeat(64), p.pack_id);
  assert.throws(() => loadCrosswalk(p.pack_id), /INTEGRITY/);
});
