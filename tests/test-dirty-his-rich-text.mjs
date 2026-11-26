import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRichText, prepareRichTextTree, projectRichTextSpan } from '../plugins/medcius/lib/rich-note-normalization.mjs';
import { createTextAnchor, resolveRichSourceAnchor } from '../plugins/medcius/lib/evidence-anchors.mjs';
import { guardPatientSourceInput } from '../plugins/medcius/lib/patient-source-phi.mjs';
import { PatientEvolutionEngine } from '../plugins/medcius/lib/patient-evolution-engine.mjs';
import { ReadOnlyHospitalDataBridge } from '../plugins/medcius/lib/read-only-hospital-data-bridge.mjs';
import { createPatientSourceSnapshot } from '../plugins/medcius/lib/patient-source-snapshot.mjs';
import { withPhiExitGuard } from '../plugins/medcius/lib/connectors/phi-exit-guard.mjs';
import { sha256Hex } from '../plugins/medcius/servers/shared/crypto.mjs';

const context = { tenant_id: 'synthetic-t', doctor_id: 'synthetic-d', patient_id: 'synthetic-p', encounter_id: 'synthetic-e' };
const note = text => ({ id: 'synthetic-note', source_system: 'synthetic-EMR', version_id: '1', status: 'final',
  patient_id: context.patient_id, encounter_id: context.encounter_id, tenant_id: context.tenant_id,
  timestamp: '2026-11-05T10:00:00Z', text });
const detector = { id: 'synthetic-empty-detector', version: '1', execution: 'local',
  async detect(text) { return { complete: true, text_sha256: sha256Hex(text), spans: [] }; } };

test('HTML preserves decoded text, paragraph boundaries, cell structure and source intervals', () => {
  const raw = '<div>体格检查：</div><table><tr><th>项目</th><th>结果</th></tr><tr><td>血钾</td><td>3.3 mmol/L</td></tr></table><p>胸&#38391;，无气促。</p>';
  const result = normalizeRichText(raw, 'html');
  assert.equal(result.status, 'normalized');
  assert.match(result.text, /项目\t结果\t\n血钾\t3.3 mmol\/L/);
  assert.match(result.text, /胸闷，无气促/);
  assert.equal(result.tables[0].rows.length, 2);
  assert.deepEqual(result.tables[0].rows.map(row => row.cells.length), [2, 2]);
  const record = prepareRichTextTree(note(raw));
  const start = record.text.indexOf('胸闷'), end = start + 2;
  const anchor = createTextAnchor(record, { start, end });
  const projected = resolveRichSourceAnchor(anchor, record, raw);
  assert.equal(projected.status, 'verified_for_exact_source');
  assert.deepEqual(projected.source_spans.map(s => raw.slice(s.start, s.end)).join(''), '胸&#38391;');
  assert.equal(resolveRichSourceAnchor(anchor, record, raw.replace('胸', '心')).status, 'unavailable');
  assert.equal(resolveRichSourceAnchor(anchor, { ...record, version_id: '2' }, raw).status, 'unavailable');
});

test('anchors across formatting tags are disjoint; invented separators have no raw highlight', () => {
  const raw = '<p>胸<b>闷</b>气促</p><p>未发热</p>', record = prepareRichTextTree(note(raw));
  const start = record.text.indexOf('胸闷气促');
  const span = projectRichTextSpan(record, raw, { start, end: start + 4 });
  assert.equal(span.status, 'verified_for_exact_source');
  assert.deepEqual(span.source_spans.map(s => raw.slice(s.start, s.end)), ['胸', '闷', '气促']);
  const newline = record.text.indexOf('\n');
  assert.equal(projectRichTextSpan(record, raw, { start: newline - 1, end: newline + 1 }).reason, 'INSERTED_SEPARATOR_NOT_PROJECTABLE');
});

test('RTF Unicode, fallback and GBK byte escapes decode with source mapping', () => {
  const raw = String.raw`{\rtf1\ansi\ansicpg936\uc1 \u-32520?\u-27145?\par \'c4\'e3\'ba\'c3}`;
  const result = normalizeRichText(raw, 'rtf');
  assert.equal(result.status, 'normalized');
  assert.equal(result.text, '胸闷\n你好');
  const record = prepareRichTextTree(note(raw));
  const span = projectRichTextSpan(record, raw, { start: record.text.indexOf('你好'), end: record.text.indexOf('你好') + 2 });
  assert.equal(span.status, 'verified_for_exact_source');
  assert.equal(span.source_spans.map(s => raw.slice(s.start, s.end)).join(''), String.raw`\'c4\'e3\'ba\'c3`);
});

test('RTF tables preserve multiple rows and do not invent an empty last cell', () => {
  const raw = String.raw`{\rtf1\ansi\ansicpg1252\trowd A\cell B\cell\row\trowd C\cell D\cell\row}`;
  const result = normalizeRichText(raw, 'rtf');
  assert.equal(result.status, 'normalized');
  assert.equal(result.tables.length, 1);
  assert.deepEqual(result.tables[0].rows.map(row => row.cells.length), [2, 2]);
  assert.match(result.text, /A\tB\t\nC\tD\t\n/);
});

test('malformed, hidden, embedded, unknown encodings and incompatible table content quarantine without source text', () => {
  const cases = [
    ['html', '<p>胸闷<script>private</script></p>'], ['html', '<p><b>胸闷</p></b>'],
    ['html', '<p style="display:none">private</p>'], ['html', '<p>胸闷&bogus;</p>'],
    ['html', '<table><tr><td>胸闷</tr></table>'], ['html', '<p>乱码�</p>'],
    ['rtf', String.raw`{\rtf1\ansi \'c4\'e3}`], ['rtf', String.raw`{\rtf1\ansi\ansicpg932 \'82\'a0}`],
    ['rtf', String.raw`{\rtf1\object private}`], ['rtf', String.raw`{\rtf1\v private}`],
    ['rtf', String.raw`{\rtf1\bin10 private}`], ['rtf', String.raw`{\rtf1\u33016}`],
    ['html', '<p>&amp;#x738B;&amp;#x4F1F;</p>'], ['html', '<p><img src="secret"></p>'],
    ['html', '<table><tr><td colspan="bad">x</td></tr></table>'], ['rtf', String.raw`{\rtf1 ok}{private}`],
    ['html', '<p style="display&#58;none">private</p>'], ['html', '<p style="opacity:0">private</p>'],
    ['html', '<p class="hidden">private</p>'],
  ];
  for (const [format, raw] of cases) {
    const out = normalizeRichText(raw, format);
    assert.equal(out.status, 'quarantined', raw); assert.equal(out.text, null);
    assert.doesNotMatch(JSON.stringify(out), /private|胸闷/);
  }
});

test('bounded harmless inline formatting is supported without executing CSS', () => {
  const result = normalizeRichText('<p style="font-weight:bold;font-size:12pt">患者胸闷</p>', 'html');
  assert.equal(result.status, 'normalized'); assert.equal(result.text, '患者胸闷\n');
});

test('unknown binary encoding is quarantined before bytes can reach output or text parsing', () => {
  const source = note(new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3])); source.content_type = 'text/rtf';
  const record = prepareRichTextTree(source);
  assert.equal(record.text, ''); assert.equal(record.rich_text_normalization.status, 'quarantined');
  assert.equal(record.rich_text_normalization.reason, 'RICH_BINARY_ENCODING_UNCONFIRMED');
  assert.doesNotMatch(JSON.stringify(record), /196|227|186|195/);
});

test('PHI guard sees decoded names before hashing or returning text; altered text invalidates original offsets', async () => {
  const raw = '<p>病程记录：&#x738B;&#x4F1F;诉胸闷。</p>';
  const input = { context, patient: { id: context.patient_id, name: '王伟' }, encounter: { id: context.encounter_id }, notes: [note(raw)] };
  input.notes[0].other_payload = raw;
  const { input: guarded, session } = await guardPatientSourceInput(input, { detector });
  try {
    assert.doesNotMatch(JSON.stringify(guarded), /王伟|&#x738B;|&#x4F1F;/);
    assert.equal(guarded.notes[0].rich_text_normalization.status, 'normalized_mapping_unavailable');
    assert.equal(guarded.notes[0].rich_text_normalization.reason, 'PHI_GUARD_CHANGED_TEXT');
    assert.equal(guarded.notes[0].rich_text_normalization.offset_map.length, 0);
    assert.equal(projectRichTextSpan(guarded.notes[0], raw, { start: 0, end: 1 }).status, 'unavailable');
  } finally { session.dispose(); }
});

test('encoded text without tags is normalized before the detector, not leaked as entity syntax', async () => {
  const raw = '&#x738B;&#x4F1F;诉胸闷', input = { context, patient: { id: context.patient_id, name: '王伟' },
    encounter: { id: context.encounter_id }, notes: [note(raw)] };
  const { input: guarded, session } = await guardPatientSourceInput(input, { detector });
  try { assert.doesNotMatch(JSON.stringify(guarded), /王伟|&#x738B;|&#x4F1F;/); }
  finally { session.dispose(); }
});

test('direct synthetic evolution extracts normalized note and quarantines unsafe HTML', () => {
  const input = { context, patient: { id: context.patient_id }, now: '2026-11-05T12:00:00Z',
    notes: [note('<div>病程记录：</div><p>患者胸闷。</p>')] };
  const out = PatientEvolutionEngine.analyzePatientEvolution(input);
  const symptom = out.blocks.what_changed.clinical_symptoms.find(s => s.summary.includes('胸闷'));
  assert.ok(symptom); assert.equal(symptom.text_anchor.exact, '患者胸闷');
  assert.doesNotMatch(JSON.stringify(out), /<div>|<p>/);
  input.notes[0].text = '<p>胸闷<script>unsafe</script></p>';
  const blocked = PatientEvolutionEngine.analyzePatientEvolution(input);
  assert.ok(blocked.blocks.data_gaps.some(g => g.gap_type === 'RICH_TEXT_QUARANTINED'));
  assert.equal(blocked.blocks.what_changed.clinical_symptoms.length, 0);
  assert.doesNotMatch(JSON.stringify(blocked), /unsafe|<script>/);
});

test('the read-only bridge normalizes before releasing notes and marks quarantine as source uncertainty', async () => {
  const raw = note('<div>病程记录：</div><p>胸闷</p>');
  const notes = { id: 'synthetic-EMR', kind: 'notes', capabilities: ['read'], async readPatient(c) {
    return { ...c, source_system: this.id, fetched_at: '2026-11-05T12:00:00Z', records: [raw] }; } };
  const base = (id, kind, resource) => ({ id, kind, capabilities: ['read'], async readPatient(c) {
    return { ...c, source_system: id, fetched_at: '2026-11-05T12:00:00Z', records: [{ id: resource }] }; } });
  const bridge = new ReadOnlyHospitalDataBridge({ connectors: [base('patient', 'patient', context.patient_id),
    base('encounter', 'encounter', context.encounter_id), notes] });
  const first = await bridge.readPatientSnapshot(context);
  assert.doesNotMatch(JSON.stringify(first.dataFeeds.notes), /<div>|<p>/);
  assert.equal(raw.text.startsWith('<div>'), true, 'connector-owned input is not mutated');
  assert.equal(first.source_availability.find(s => s.kind === 'notes').status, 'available');
  raw.text = '<p>胸闷<script>secret_his_content</script></p>';
  const second = await bridge.readPatientSnapshot(context);
  assert.equal(second.source_availability.find(s => s.kind === 'notes').status, 'unknown');
  assert.equal(second.dataFeeds.notes[0].rich_text_normalization.status, 'quarantined');
  assert.doesNotMatch(JSON.stringify(second), /<script>|secret_his_content/);
});

test('synchronous source snapshots normalize before dictionary PHI guard and exclude quarantined notes', () => {
  const raw = '<p>病程记录：&#x738B;&#x4F1F;诉胸闷。</p>';
  const input = { context, patient: { id: context.patient_id, name: '王伟' }, encounter: { id: context.encounter_id },
    asOf: '2026-11-05T12:00:00Z', notes: [note(raw)],
    sourceAvailability: [{ kind: 'notes', status: 'available', query_read_complete: true }] };
  const snapshot = createPatientSourceSnapshot(input), guarded = snapshot.records.notes[0].record;
  assert.doesNotMatch(JSON.stringify(snapshot), /王伟|&#x738B;|&#x4F1F;|<p>/);
  assert.equal(guarded.rich_text_normalization.status, 'normalized_mapping_unavailable');
  assert.equal(input.notes[0].text, raw);
  input.notes[0].text = '<p>胸闷<script>private</script></p>';
  const quarantined = createPatientSourceSnapshot(input);
  assert.equal(quarantined.records.notes[0].eligible, false);
  assert.equal(quarantined.excluded[0].reason, 'RICH_TEXT_QUARANTINED');
  assert.equal(quarantined.source_availability[0].status, 'unknown');
  assert.doesNotMatch(JSON.stringify(quarantined), /private|<script>/);
});

test('compatibility connector exit scans decoded identifiers and invalidates changed offsets', async () => {
  const raw = '<p>电话：&#49;&#51;&#57;&#48;&#48;&#48;&#48;&#49;&#49;&#49;&#49;</p>';
  const source = { id: 'legacy-notes', kind: 'notes', capabilities: ['read'], async readPatient(c) {
    return { ...c, source_system: this.id, records: [note(raw)] }; } };
  const safe = await withPhiExitGuard(source, { salt: 'synthetic-only-salt' }).readPatient(context);
  assert.doesNotMatch(JSON.stringify(safe), /13900001111|&#49;|<p>/);
  assert.equal(safe.records[0].rich_text_normalization.status, 'normalized_mapping_unavailable');
  await assert.rejects(() => withPhiExitGuard(source, { salt: 'synthetic-only-salt', mode: 'assert' }).readPatient(context),
    /PHI_EXIT_GUARD_RAW_PHI_BLOCKED/);
});
