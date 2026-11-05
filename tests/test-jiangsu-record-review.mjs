import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { input, review, policy, profile, coded, response, end, crosswalk } from './fixtures/jiangsu-record-review.mjs';
import { createPatientSourceSnapshot } from '../plugins/medcius/lib/patient-source-snapshot.mjs';
import { reconcileRecordEvidence, assertRecordEvidenceReview } from '../plugins/medcius/lib/record-evidence-reconciliation.mjs';
import { createLocalGrouperPrecheck, validateGrouperProfile } from '../plugins/medcius/lib/local-grouper-precheck.mjs';
import { queryCodeMappings, checkCodePair, validateCrosswalk, searchVersionedCodes } from '../plugins/medcius/lib/terminology-crosswalk.mjs';
import { buildRecordQualityReport } from '../plugins/medcius/lib/nhsa-record-quality-engine.mjs';
import { reviewSettlementSnapshot } from '../plugins/medcius/lib/settlement-review-workflow.mjs';
import { resolveTextAnchor } from '../plugins/medcius/lib/evidence-anchors.mjs';
const flags = r => r.findings.map(f => f.code);
const addClaim = d => { d.notes[0].text += '；低钾血症'; };

test('documented omission links exact note span, LIS identity and ordered versus administered treatment', () => {
  const data = input(), snap = createPatientSourceSnapshot(data), r = reconcileRecordEvidence({ snapshot: snap, front_sheet_id: 'front', policy });
  const f = r.findings.find(f => f.code === 'DOCUMENTED_DIAGNOSIS_NOT_ON_FRONT_SHEET');
  assert.ok(f); assert.equal(f.mcc_cc, 'NOT_ASSESSED');
  const a = f.evidence.documentation[0].text_anchor;
  assert.equal(resolveTextAnchor(a, snap.records.notes.find(e => e.record.id === 'progress').record).anchor_status, 'verbatim_verified');
  assert.equal(f.evidence.objective[0].evidence[0].source_id, 'lab-k');
  assert.equal(f.evidence.treatment[0].administered, false);
  assert.equal(f.modifies_diagnosis, false); assert.equal(r.production_ready, false);
});
for (const sentence of ['否认低钾血症。', '低钾血症待排。', 'R/O 低钾血症。', '既往低钾血症。', '母亲低钾血症。']) {
  test(`no automatic omission from ${sentence}`, () => {
    const r = review(d => { d.notes[1].text = sentence; });
    assert.ok(!flags(r).includes('DOCUMENTED_DIAGNOSIS_NOT_ON_FRONT_SHEET'));
    assert.ok(flags(r).includes('ABNORMAL_EVIDENCE_REVIEW'));
  });
}
test('unsigned, front-sheet copies and non-clinician notes cannot corroborate themselves', () => {
  for (const change of [d => d.notes[1].signed = false, d => d.notes[1].author_role = 'coder',
    d => d.notes[1].document_kind = 'front_sheet', d => d.notes[1].text = d.notes[0].text]) {
    const r = review(d => { addClaim(d); change(d); });
    assert.ok(flags(r).includes('DATA_GAP'));
  }
});
test('completed source coverage is necessary for DATA_GAP and absent data never proves upcoding', () => {
  const change = d => { addClaim(d); d.notes.splice(1); d.observations = []; };
  const complete = review(change); assert.ok(flags(complete).includes('DATA_GAP'));
  const unknown = review(d => { change(d); d.sourceAvailability = []; });
  assert.ok(!flags(unknown).includes('DATA_GAP')); assert.ok(flags(unknown).includes('SOURCE_COVERAGE_UNKNOWN'));
  assert.equal(unknown.boundary.adjudicates_violation, false);
});
for (const mutate of [s => s.status = 'partial', s => s.from = end, s => s.to = '2026-10-02T10:00:00+08:00',
  s => s.watermark = '2026-10-02T10:00:00+08:00', s => s.watermark = '2027-01-01T00:00:00Z',
  s => s.context = { ...s.context, encounter_id: 'other' }]) {
  test('partial, stale, future or wrong-encounter receipts do not establish coverage', () => {
    const r = review(d => { d.sourceAvailability.forEach(mutate); });
    assert.ok(r.coverage.every(c => c.status === 'unknown'));
  });
}
test('cancelled LIS measurements and out-of-admission measurements are not diagnostic support', () => {
  for (const change of [d => d.observations[0].status = 'cancelled', d => d.observations[0].event_time = '2026-09-01T00:00:00Z']) {
    const r = review(d => { addClaim(d); change(d); });
    assert.ok(flags(r).includes('DATA_GAP'));
    assert.equal(r.conditions[0].evidence.objective[0].evidence.length, 0);
  }
});
test('missing units, preliminary results, string and null values are unknown, never numeric zero', () => {
  for (const change of [d => d.observations[0].unit = 'mg/dL', d => d.observations[0].value = null,
    d => d.observations[0].value = '2.4', d => d.observations[0].status = 'preliminary']) {
    const r = review(d => { addClaim(d); change(d); });
    assert.equal(r.conditions[0].evidence.objective[0].status, 'unknown');
    assert.ok(!flags(r).includes('DATA_GAP'));
  }
});
test('blood gas requires arterial specimen, oxygen context and numeric FiO2', () => {
  for (const measurement_context of [{}, { specimen: 'venous', fio2: 0.21, oxygen_device: 'room_air' },
    { specimen: 'arterial', fio2: 'unknown', oxygen_device: 'room_air' }]) {
    const r = review(d => { d.notes[0].text += '；呼吸衰竭'; d.observations.push({ ...d.observations[0], id: 'gas',
      concept_code: 'PaO2', value: 50, unit: 'mmHg', measurement_context }); });
    assert.equal(r.conditions.find(c => c.condition_id === 'respiratory_failure').evidence.objective[0].status, 'unknown');
  }
});
test('urine potassium cannot become a serum hypokalemia signal', () => {
  const r = review(d => { d.notes.splice(1); d.observations[0].measurement_context.specimen = 'urine'; });
  assert.ok(!flags(r).includes('ABNORMAL_EVIDENCE_REVIEW'));
  assert.equal(r.conditions[0].evidence.objective[0].status, 'unknown');
});
test('albumin alone does not corroborate severe malnutrition', () => {
  const r = review(d => { d.notes[0].text += '；重度营养不良'; d.observations.push({ ...d.observations[0], id: 'albumin', concept_code: 'albumin', value: 20, unit: 'g/L' }); });
  const c = r.conditions.find(c => c.condition_id === 'severe_malnutrition');
  assert.equal(c.evidence.objective[0].status, 'not_found_in_covered_sources');
});
test('actual administration is bound to the order and inpatient period', () => {
  const r = review(d => { d.orders[0].administrations = [{ id: 'admin-1', order_id: 'order-k', status: 'completed',
    execution_status: 'administered', performed_at: '2026-10-02T09:00:00+08:00' }]; });
  assert.equal(r.conditions[0].evidence.treatment[0].administered, true);
  assert.equal(r.conditions[0].evidence.treatment[0].administrations[0].id, 'admin-1');
});
test('stopped order retains earlier actual administrations', () => {
  const r = review(d => { d.orders[0].status = 'stopped'; d.orders[0].execution_status = 'stopped';
    d.orders[0].stopped_at = end; d.orders[0].administrations = [{ id: 'admin-before-stop', order_id: 'order-k', status: 'completed',
      execution_status: 'administered', performed_at: '2026-10-02T09:00:00+08:00' }]; });
  assert.equal(r.conditions[0].evidence.treatment[0].administered, true);
});
test('positive and later ruled-out diagnoses produce a conflict, never an omission prompt', () => {
  const r = review(d => { d.notes.push({ ...d.notes[1], id: 'later-note', event_time: '2026-10-03T09:00:00+08:00', text: '排除低钾血症。' }); });
  assert.ok(flags(r).includes('DIAGNOSIS_ASSERTION_CONFLICT'));
  assert.ok(!flags(r).includes('DOCUMENTED_DIAGNOSIS_NOT_ON_FRONT_SHEET'));
  assert.ok(r.conditions[0].evidence.documentation_opposing[0].text_anchor);
});
test('wrong-patient feeds and forged snapshots/reviews fail closed', () => {
  assert.throws(() => review(d => d.observations[0].patient_id = 'other'), /FAIL_CLOSED|MISMATCH/);
  assert.throws(() => reconcileRecordEvidence({ snapshot: {}, policy }), /FAIL_CLOSED/);
  assert.throws(() => assertRecordEvidenceReview(JSON.parse(JSON.stringify(review()))), /BOUND_RESULT/);
});
test('review attachment rejects a different front sheet', () => {
  const r = review();
  assert.throws(() => buildRecordQualityReport('出院诊断：其他', { evidence_review: r }), /MISMATCH/);
  assert.equal(buildRecordQualityReport(input().notes[0].text, { evidence_review: r }).evidence_reconciliation.digest, r.digest);
});

const selectors = { from: { system: 'CLINICIAN-TERMS', version: 'fixture', term: '合成基础病' },
  target: { system: 'JS-LOCAL-DX', version: 'fixture-release' }, region: 'CN-3209', as_of: '2026-10-03' };
test('three explicit release edges link terminology through clinical and NHSA to regional code', () => {
  const r = queryCodeMappings(crosswalk(), selectors);
  assert.equal(r.candidates[0].path.length, 3); assert.equal(r.candidates[0].node.code, 'DEMO-JS');
  assert.equal(r.validation_status, 'unverifiable'); assert.equal(r.automatic_code_selection, false);
});
test('CCHI and ICD-9 pair checks require reciprocal equivalence, not shared numerals', () => {
  const pack = crosswalk(), q = { left: { system: 'CCHI', version: 'fixture', code: 'DEMO-P1' },
    right: { system: 'NHSA-ICD9CM3', version: 'fixture-release', code: 'DEMO-P2' }, region: 'CN-3209', as_of: '2026-10-03' };
  assert.equal(checkCodePair(pack, q).status, 'bidirectional_equivalent_mapping');
  pack.edges[3].bidirectional = false;
  assert.equal(checkCodePair(pack, q).status, 'review_required');
  pack.edges[3].bidirectional = true; pack.edges[3].relation = 'broader';
  assert.equal(checkCodePair(pack, q).status, 'review_required');
});
test('missing/wrong release, other province and expired pack never fall back', () => {
  for (const opts of [{ ...selectors, from: { ...selectors.from, version: '' } }, { ...selectors, region: 'CN-33' },
    { ...selectors, as_of: '2027-01-01' }, { ...selectors, as_of: '2026-02-30' }]) assert.equal(queryCodeMappings(crosswalk(), opts).status, 'unverifiable');
});
test('mapping one-to-many, qualification and source synonym ambiguity remain explicit', () => {
  const p = crosswalk(); p.nodes.push({ ...p.nodes[3], id: 'other', code: 'DEMO-JS2' });
  p.edges.push({ ...p.edges[2], id: 'edge-other', to: 'other' });
  assert.equal(queryCodeMappings(p, selectors).status, 'ambiguous');
  p.nodes.pop(); p.edges.pop(); p.edges[2].qualifiers = ['requires manual confirmation'];
  assert.equal(queryCodeMappings(p, selectors).status, 'review_required');
  p.nodes.push({ ...p.nodes[0], id: 'term-other', code: 'term-2' });
  assert.equal(queryCodeMappings(p, selectors).reason, 'AMBIGUOUS_SOURCE_TERM');
});
test('invalid or cross-kind edges cannot enter the mapping corpus', () => {
  const p = crosswalk(); p.edges[3].from = 'nhsa'; assert.throws(() => validateCrosswalk(p), /INVALID/);
  const throughTerm = crosswalk(); throughTerm.edges.push({ ...throughTerm.edges[0], id: 'invalid-via-term', to: 'cchi' });
  assert.throws(() => validateCrosswalk(throughTerm), /INVALID/);
});
test('regional prefix tricks and contradictory source selectors are rejected', () => {
  assert.equal(queryCodeMappings(crosswalk(), { ...selectors, region: 'CN-32-other' }).status, 'unverifiable');
  assert.equal(queryCodeMappings(crosswalk(), { ...selectors, from: { ...selectors.from, code: 'term-1', term: 'different' } }).status, 'unverifiable');
});
test('versioned code lookup requires exact name and scope; sample never validates', () => {
  const opts = { query: '合成基础病', code_system: 'NHSA-ICD10', code_version: 'fixture-release', region: 'CN-3209', as_of: '2026-10-03', include_samples: true };
  assert.equal(searchVersionedCodes(crosswalk(), opts).hits[0].validation_status, 'unverifiable');
  assert.equal(searchVersionedCodes(crosswalk(), { ...opts, code_version: '2.0' }).total_matches, 0);
  assert.equal(searchVersionedCodes(crosswalk(), { ...opts, include_samples: false }).reason, 'SAMPLE_EXCLUDED');
});

const args = () => ({ review: review(), items: [coded], as_of: '2026-10-03' });
const adapter = fn => ({ id: 'fixture-adapter', transport: 'local', check: fn });
test('Jiangsu reference profile remains unconfigured until city, release and adapter are supplied', async () => {
  const p = JSON.parse(readFileSync(new URL('../plugins/medcius/config/groupers/jiangsu-unconfigured.v1.json', import.meta.url), 'utf8'));
  assert.equal(validateGrouperProfile(p).configured, false);
  assert.equal((await createLocalGrouperPrecheck({ profile: p })(args())).status, 'NOT_CONFIGURED');
});
test('local replay binds exact inputs and strips provider free text/weights', async () => {
  let sent;
  const check = createLocalGrouperPrecheck({ profile, adapter: adapter(({ request }) => { sent = request; return { ...response(request), free_text: 'do not echo', weight: 100 }; }) });
  const r = await check(args()); assert.equal(r.status, 'REPLAY_ONLY');
  assert.ok(!JSON.stringify(sent).includes('synthetic-patient')); assert.ok(!JSON.stringify(sent).includes('目前诊断'));
  assert.ok(!JSON.stringify(r).includes('do not echo')); assert.equal(r.result.weight, undefined);
  assert.equal(r.settlement_accepted, false);
});
for (const key of ['request_id', 'request_digest', 'region', 'grouping_version', 'rule_digest', 'profile_digest']) {
  test(`reject mismatched grouper ${key}`, async () => {
    const check = createLocalGrouperPrecheck({ profile, adapter: adapter(({ request }) => ({ ...response(request), [key]: 'other' })) });
    assert.equal((await check(args())).status, 'RESPONSE_REJECTED');
  });
}
test('MCC/CC from an unrelated diagnosis is rejected', async () => {
  const check = createLocalGrouperPrecheck({ profile, adapter: adapter(({ request }) => ({ ...response(request), mcc_cc: [{ ...coded, code: 'OTHER', classification: 'MCC' }] })) });
  assert.equal((await check(args())).status, 'RESPONSE_REJECTED');
});
test('release mismatch and unbound coding edits never invoke grouper', async () => {
  let calls = 0; const check = createLocalGrouperPrecheck({ profile, adapter: adapter(() => { calls++; }) });
  const a = args(); a.items = [{ ...coded, code_version: 'wrong' }]; assert.equal((await check(a)).status, 'CODE_RELEASE_MISMATCH');
  a.items = [{ ...coded, code: 'OTHER' }]; assert.equal((await check(a)).status, 'CODE_NOT_BOUND_TO_FRONT_SHEET');
  assert.equal(calls, 0);
});
test('timeout retains the occupied slot until provider settles and errors never expose source content', async () => {
  let release;
  const check = createLocalGrouperPrecheck({ profile, timeout_ms: 5, adapter: adapter(() => new Promise(resolve => { release = resolve; })) });
  assert.equal((await check(args())).status, 'TIMEOUT'); assert.equal((await check(args())).status, 'BUSY');
  release(null); await new Promise(resolve => setImmediate(resolve));
  const bad = createLocalGrouperPrecheck({ profile, adapter: adapter(() => { throw new Error('private-body'); }) });
  const r = await bad(args()); assert.equal(r.status, 'PROVIDER_FAILURE'); assert.ok(!JSON.stringify(r).includes('private-body'));
});
test('production-style invocation requires a site acceptance callback and versioned code validation', async () => {
  const liveProfile = { ...profile, data_class: 'site_reviewed' }, p = { ...policy, data_class: 'site_reviewed' };
  const a = { ...args(), review: review(() => {}, p) };
  const invoke = options => createLocalGrouperPrecheck({ profile: liveProfile, mode: 'local', adapter: adapter(({ request }) => response(request)), ...options })(a);
  assert.equal((await invoke({})).status, 'SITE_ACCEPTANCE_REQUIRED');
  assert.equal((await invoke({ authorize: () => true })).status, 'CODE_VALIDATION_REQUIRED');
  assert.equal((await invoke({ authorize: () => true, validateCode: () => ({ ...coded, data_class: 'official',
    validation_status: 'valid', effective_date: '2026-01-01', effective_until: '2026-12-31', is_main_diag_allowed: true }) })).status, 'LOCAL_RESPONSE_BOUND');
});
test('asynchronous site acceptance cannot race a second request into the adapter', async () => {
  let release;
  const p = { ...policy, data_class: 'site_reviewed' };
  const a = { ...args(), review: review(() => {}, p) };
  const check = createLocalGrouperPrecheck({ profile: { ...profile, data_class: 'site_reviewed' }, mode: 'local',
    adapter: adapter(() => { throw new Error('must not run'); }), authorize: () => new Promise(resolve => { release = resolve; }) });
  const first = check(a); assert.equal((await check(a)).status, 'BUSY');
  release(true); assert.equal((await first).status, 'CODE_VALIDATION_REQUIRED');
});
test('unattributed source and empty assessment report preserve unknown evidence', () => {
  const r = review(d => { d.observations[0].source_system = null; d.notes[0].text += '；重度营养不良';
    d.diagnosticReports.push({ ...d.notes[1], id: 'nutrition', source_system: 'EMR-ASSESSMENT', text: '', concept_code: 'nutrition_assessment' }); });
  assert.equal(r.coverage.find(c => c.kind === 'observations').status, 'unknown');
  assert.equal(r.conditions.find(c => c.condition_id === 'severe_malnutrition').evidence.objective[0].status, 'unknown');
});
test('revised LIS value supersedes a prior critical result and conflicting versions remain unknown', () => {
  const r = review(d => { d.notes.splice(1); d.observations.push({ ...d.observations[0], version_id: '2',
    status: 'corrected', updated_at: '2026-10-02T10:00:00+08:00', value: 4, critical: false }); });
  assert.ok(!flags(r).includes('ABNORMAL_EVIDENCE_REVIEW'));
  assert.equal(r.conditions[0].evidence.objective[0].evidence[0].value, 4);
  const conflict = review(d => { addClaim(d); d.observations.push({ ...d.observations[0], value: 4 }); });
  assert.equal(conflict.coverage.find(c => c.kind === 'observations').status, 'unknown');
});
test('structured front-sheet coding binds a reviewed synonym to an exact release', () => {
  const p = structuredClone(policy); p.conditions[0].diagnosis_codes = [{ code: coded.code, system: coded.code_system, version: coded.code_version }];
  const r = review(() => {}, p); assert.equal(r.conditions[0].on_front_sheet, true);
  assert.ok(!flags(r).includes('DOCUMENTED_DIAGNOSIS_NOT_ON_FRONT_SHEET'));
});
test('secondary workflow carries record evidence through settlement without activating a grouper', async () => {
  const snapshot = createPatientSourceSnapshot(input());
  const codes = { corpus_status: () => ({ counts: { codes: { official: 0 } } }), search_codes: () => ({ hits: [], total_matches: 0 }) };
  const r = await reviewSettlementSnapshot({ snapshot, front_sheet_id: 'front', policy, codes });
  assert.equal(r.settlement.record_quality.evidence_reconciliation.snapshot_id, snapshot.snapshot_id);
  assert.equal(r.local_precheck.status, 'NOT_CONFIGURED'); assert.equal(r.production_ready, false);
});
