import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTextAnchor, resolveTextAnchor, inspectEvidenceAnchor } from '../plugins/medcius/lib/evidence-anchors.mjs';
import { assessCriticalVisibility } from '../plugins/medcius/lib/critical-visibility.mjs';
import { PatientEvolutionEngine } from '../plugins/medcius/lib/patient-evolution-engine.mjs';
import { StagedDraftService } from '../plugins/medcius/lib/staged-draft-service.mjs';
import { ReadOnlyHospitalDataBridge } from '../plugins/medcius/lib/read-only-hospital-data-bridge.mjs';
import { createPatientSourceSnapshot } from '../plugins/medcius/lib/patient-source-snapshot.mjs';
import { scanStructuredValue } from '../plugins/medcius/servers/phiguard/src/lib.mjs';
import { toModelSafe } from '../plugins/medcius/lib/clinical-boundary.mjs';
import { assertEvolutionConsistency } from '../plugins/medcius/lib/output-consistency.mjs';

const asOf = '2026-10-07T08:00:00Z';
const note = { id: 'synthetic-note', source_system: 'synthetic-emr', version_id: 'v1', text: '🙂病程\r\n否认胸痛。继续观察。' };
const start = note.text.indexOf('否认胸痛');
const anchor = () => createTextAnchor(note, { start, end: start + 4 });

test('exact snapshot roundtrip preserves UTF16 coordinates and cryptographic bindings', () => {
  const a = JSON.parse(JSON.stringify(anchor()));
  assert.equal(a.start, 6); // emoji occupies two UTF16 code units
  assert.equal(resolveTextAnchor(a, structuredClone(note)).highlight.exact, '否认胸痛');
  assert.deepEqual(toModelSafe(a), a);
  for (const invalid of [{ start: 1, end: 2 }, { start: -1, end: 2 }, { start: 0, end: 999 }, { start: 1.5, end: 2 }])
    assert.equal(createTextAnchor(note, invalid), null);
});

test('edits, co-signing, negation changes, new versions and other source records disable old highlights', () => {
  for (const change of [{ text: '补充：' + note.text }, { text: note.text.replace('否认', '诉有') },
    { text: note.text.replace('\r\n', '\n') }, { signed_by: 'senior-fixture' },
    { version_id: 'v2' }, { id: 'other-note' }, { source_system: 'other-hospital' }]) {
    const result = resolveTextAnchor(anchor(), { ...note, ...change });
    assert.equal(result.highlight, null);
    assert.equal(result.anchor_status, 'stale_or_unverified');
  }
  assert.ok(resolveTextAnchor(anchor(), note).highlight, 'archived original remains separately addressable');
});

test('bare offsets, modified quote and repeated source text cannot create false unique evidence', () => {
  assert.equal(resolveTextAnchor({ start, end: start + 4 }, note).highlight, null);
  assert.equal(resolveTextAnchor({ ...anchor(), exact: '存在胸痛' }, note).highlight, null);
  assert.equal(resolveTextAnchor({ ...anchor(), start: 0 }, note).highlight, null);
  const repeated = { ...note, text: '否认胸痛。否认胸痛。' };
  assert.equal(inspectEvidenceAnchor({ source_id: note.id, span: '否认胸痛' }, [repeated]).anchor_status, 'ambiguous');
  const duplicateFields = { ...note, content: note.text };
  assert.equal(inspectEvidenceAnchor({ source_id: note.id, span: '否认胸痛' }, [duplicateFields]).highlight, null);
  assert.equal(inspectEvidenceAnchor({ source_id: note.id, version_id: 'v2', span: '否认胸痛' }, [note]).highlight, null);
});

test('proper UTF8/GBK decoding agrees; byte offsets and lossy decoded text are rejected', () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // independently specified GBK for 中文
  const text = new TextDecoder('gbk', { fatal: true }).decode(gbk);
  assert.equal(text, '中文');
  const record = { id: 'encoding-fixture', text };
  const a = createTextAnchor(record, { start: 0, end: 2 });
  const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(text, 'utf8'));
  assert.ok(resolveTextAnchor(a, { ...record, text: utf8 }).highlight);
  assert.equal(createTextAnchor(record, { start: 0, end: gbk.length }), null);
  assert.equal(createTextAnchor({ ...record, text: new TextDecoder('utf-8').decode(gbk) }, { start: 0, end: 2 }), null);
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(gbk));
});

test('shared immutable source snapshot binds note evidence to archived content', () => {
  const context = { tenant_id: 'fixture', patient_id: 'p', encounter_id: 'e' };
  const snapshot = createPatientSourceSnapshot({ context, patient: { id: 'p' }, encounter: { id: 'e' }, asOf,
    notes: [{ ...note, timestamp: '2026-10-07T07:00:00Z' }] });
  const entry = snapshot.records.notes[0];
  assert.ok(resolveTextAnchor(entry.evidence.text_anchor, entry.record).highlight);
  assert.equal(entry.evidence.span.content_sha256, entry.evidence.text_anchor.content_sha256);
  assert.throws(() => { entry.record.text = '修改'; }, TypeError);
  assert.equal(snapshot.source_visibility.can_exclude_critical_values, false);
});

test('empty, successful, failed and unknown LIS reads never establish a clinical negative', () => {
  for (const sources of [[], ...['available', 'available_empty', 'unavailable', 'unknown'].map(status => [{ kind: 'lis', status, fetched_at: asOf }])]) {
    const result = assessCriticalVisibility({ sources, asOf, flaggedCount: 0 });
    assert.equal(result.hospital_critical_absence, 'NOT_ESTABLISHED');
    assert.equal(result.can_exclude_critical_values, false);
    assert.equal(result.coverage_status, 'incomplete_or_unknown');
    assert.match(result.message, /不能据此认定/);
  }
});

test('read success and current fetch time do not conceal an older upstream watermark', () => {
  const source = { kind: 'lis', status: 'available_empty', query_read_complete: true, fetched_at: asOf, synchronized_through: '2026-10-07T07:40:00Z' };
  const result = assessCriticalVisibility({ sources: [source], asOf, flaggedCount: 0 });
  assert.ok(result.reasons.includes('UPSTREAM_BEHIND_SNAPSHOT'));
  assert.equal(result.sources[0].synchronized_through, source.synchronized_through);
  const future = assessCriticalVisibility({ sources: [{ ...source, synchronized_through: '2026-10-07T09:00:00Z' }], asOf });
  assert.ok(future.reasons.includes('SYNC_TIME_INCONSISTENT'));
  const complete = assessCriticalVisibility({ sources: [{ ...source, synchronized_through: asOf }], asOf });
  assert.equal(complete.coverage_status, 'reported_snapshot_coverage_only');
  assert.equal(complete.can_exclude_critical_values, false, 'connector assertion is not clinical proof');
});

test('the actual engine, glance and exported draft retain incomplete coverage', () => {
  const sources = [{ kind: 'lis', status: 'available_empty', fetched_at: asOf }];
  const summary = PatientEvolutionEngine.analyzePatientEvolution({ patient: { id: 'p' }, now: asOf, sourceAvailability: sources });
  const views = StagedDraftService.generateProgressiveViewsFromSummary(summary);
  assert.notEqual(views.glance.color, 'GREEN');
  assert.match(views.glance.headline, /不能据此认定无危急值/);
  assert.deepEqual(views.digest.blocks.critical_visibility, summary.critical_visibility);
  const draft = StagedDraftService.createStagedDraft({ progressiveViews: views });
  assert.match(draft.rendered_markdown, /危急值通知通道/);
  assert.match(draft.rendered_markdown, /不能据此认定/);
  const tampered = structuredClone(summary);
  tampered.critical_visibility.can_exclude_critical_values = true;
  assert.throws(() => assertEvolutionConsistency(tampered), /CRITICAL_VISIBILITY/);
});

test('a later critical record stays visible while other unsynchronized results remain unknown', () => {
  const summary = PatientEvolutionEngine.analyzePatientEvolution({ patient: { id: 'p' }, now: asOf,
    lisFeed: [{ id: 'late-critical', code: 'k', name: '血钾', value: 6.5, unit: 'mmol/L', is_critical: true,
      status: 'final', sample_time: '2026-10-07T07:45:00Z' }], sourceAvailability: [{ kind: 'lis', status: 'available' }] });
  assert.ok(summary.critical_values.length > 0);
  assert.equal(summary.critical_visibility.observed_flagged_count, summary.critical_values.length);
  const views = StagedDraftService.generateProgressiveViewsFromSummary(summary);
  assert.equal(views.glance.color, 'RED');
  assert.match(views.glance.headline, /仍不能排除/);
});

test('read-only bridge preserves upstream sync metadata without deriving it from record or fetch time', async () => {
  const context = { tenant_id: 'fixture', doctor_id: 'd', patient_id: 'p', encounter_id: 'e' };
  const envelope = { ...context, records: [], fetched_at: asOf, synchronized_through: '2026-10-07T07:40:00Z', complete: true };
  const bridge = new ReadOnlyHospitalDataBridge({ requiredKinds: [], connectors: [{ id: 'lis-view', kind: 'lis', capabilities: ['read'], readPatient: async () => envelope }] });
  const result = await bridge.readPatientSnapshot(context);
  assert.equal(result.source_availability[0].synchronized_through, envelope.synchronized_through);
  assert.ok(assessCriticalVisibility({ sources: result.source_availability, asOf }).reasons.includes('UPSTREAM_BEHIND_SNAPSHOT'));
  delete envelope.synchronized_through;
  const missing = await bridge.readPatientSnapshot(context);
  assert.equal(missing.source_availability[0].synchronized_through, null);
});

test('typed HMAC metadata remains exact but untyped signatures and free text remain scanned', () => {
  const signature = 'a'.repeat(20) + '13912345678' + 'b'.repeat(33);
  assert.equal(scanStructuredValue({ signature, signature_algorithm: 'HMAC_SHA256' }).total, 0);
  assert.ok(scanStructuredValue({ signature }).total > 0);
  assert.ok(scanStructuredValue({ signature: '13912345678', signature_algorithm: 'HMAC_SHA256' }).total > 0);
  assert.ok(scanStructuredValue({ text: signature }).total > 0);
});
