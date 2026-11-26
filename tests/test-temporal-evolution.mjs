import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HospitalAgentAdapter } from '../plugins/medcius/lib/hospital-agent-adapter.mjs';
import { assertEvolutionConsistency } from '../plugins/medcius/lib/output-consistency.mjs';
import { validateContract } from '../scripts/lib/schema-contract.mjs';
import { PatientEvolutionEngine as Engine } from '../plugins/medcius/lib/patient-evolution-engine.mjs';
import { calculateTemporalDelta, evaluateTemporalDelta, temporalTimestamp } from '../plugins/medcius/lib/calculation-reference.mjs';
import { resolveRecordVersions } from '../plugins/medcius/lib/record-lifecycle.mjs';
import { syntheticTemporalInput, owned, lab, urine, vitals, NOW, T0 } from './fixtures/temporal-evolution.mjs';

const run = (input = syntheticTemporalInput()) => Engine.analyzePatientEvolution(input).blocks.temporal_analysis;
const diuretic = r => r.interventions.find(i => i.drug_id === 'furosemide');
const rule = (r, id) => r.delta_checks.find(c => c.rule_id === id);
const sample = (value, timestamp, unit = 'umol/L') => ({ value, timestamp, unit });

test('synthetic executed diuretic has exact six-hour totals, morning deltas and noncausal graph', () => {
  const input = syntheticTemporalInput(), original = structuredClone(input), out = run(input), chain = diuretic(out);
  assert.equal(chain.timestamp, T0);
  assert.equal(chain.urine_after.total_ml, 850);
  assert.equal(chain.urine_before.total_ml, 300);
  assert.equal(chain.urine_delta_ml, 550);
  assert.equal(chain.next_morning.date, '2026-11-05');
  const potassium = chain.next_morning.trajectories.find(t => t.metric === 'k');
  assert.ok(Math.abs(potassium.delta.delta + 0.6) < 1e-10);
  assert.equal(potassium.before.source_reference.source_id, 'k-before');
  assert.equal(potassium.after.source_reference.source_id, 'k-after');
  assert.equal(chain.actual_dose, 20);
  assert.equal(chain.treatment_day, null);
  assert.ok(out.graph.edges.length > 0);
  assert.ok(out.graph.edges.every(e => e.causal === false && out.graph.nodes.some(n => n.id === e.from) && out.graph.nodes.some(n => n.id === e.to)));
  assert.ok(chain.source_references.every(r => r.source_id && r.source_system && /^[a-f0-9]{64}$/.test(r.record_sha256)));
  assert.deepEqual(input, original);
  assert.ok(Object.isFrozen(out));
});

test('antibiotic order and actual execution remain distinct; sampled Tmax and biomarker series align', () => {
  const out = run(), chains = out.interventions.filter(c => c.drug_id === 'meropenem');
  assert.deepEqual(new Set(chains.map(c => c.kind)), new Set(['order', 'administration']));
  const c = chains.find(c => c.kind === 'administration');
  // Bins are 24 hours since execution, not local calendar-day maxima.
  assert.deepEqual(c.temperature_peaks.map(p => p.observed_max), [39.2, 37.6, null]);
  const pct = c.trajectories.find(t => t.metric === 'pct');
  assert.equal(pct.before.value, 12.4); assert.equal(pct.after.value, 3.1);
  assert.equal(pct.delta.elapsed_hours, 49);
  assert.ok(c.overlapping_interventions.some(i => i.source_references.some(r => r.source_id === 'diuretic-admin')));
  assert.ok(chains.every(c => c.treatment_day === null && c.causal_attribution === 'not_established'));
});

test('actual administration is required for diuretic and planned dose never becomes actual dose', () => {
  const input = syntheticTemporalInput(); input.medications[0].administrations = [];
  assert.equal(diuretic(run(input)), undefined);
  input.medications[0].administrations = [{ ...owned('a', 'synthetic-MAR'), order_id: 'diuretic', performed_at: T0, execution_status: 'administered' }];
  const c = diuretic(run(input)); assert.equal(c.actual_dose, null); assert.equal(c.route, null);
});

test('cancelled/entered-in-error administrations and bad source binding cannot create anchors', () => {
  for (const patch of [{ status: 'entered-in-error' }, { status: 'cancelled' }, { execution_status: 'dispensed' }, { order_id: 'wrong' }, { performed_at: null }]) {
    const input = syntheticTemporalInput(); Object.assign(input.medications[0].administrations[0], patch);
    assert.equal(diuretic(run(input)), undefined, JSON.stringify(patch));
  }
});

test('stopped order does not erase a prior actual administration; unknown drug aliases abstain', () => {
  const input = syntheticTemporalInput(); input.medications[0].status = 'stopped'; input.medications[0].stopped_at = '2026-11-04T12:00:00Z';
  assert.equal(diuretic(run(input)).urine_after.total_ml, 850);
  input.medications[0].drug_name = '非呋塞米或未映射商品名';
  assert.equal(diuretic(run(input)), undefined);
  assert.ok(run(input).data_gaps.some(g => g.reason === 'DRUG_CLASS_UNMAPPED'));
});

test('identity is checked for records, nested administrations, and historical inputs', () => {
  for (const field of ['patient_id', 'encounter_id', 'tenant_id']) {
    const input = syntheticTemporalInput(); input.medications[0].administrations[0][field] = 'other';
    assert.throws(() => run(input), /IDENTITY_MISMATCH/);
    const input2 = syntheticTemporalInput(); input2.observations[0][field] = 'other';
    assert.throws(() => run(input2), /MISMATCH/);
  }
  const input = syntheticTemporalInput(); delete input.observations[1].tenant_id;
  assert.equal(diuretic(run(input)).next_morning.trajectories.find(t => t.metric === 'k').after, null);
  input.context = null; assert.equal(run(input).status, 'not_evaluable');
});

test('missing clinical timezone does not label a record next morning; no host timezone fallback', () => {
  const input = syntheticTemporalInput(); delete input.context.timezone;
  assert.equal(diuretic(run(input)).next_morning.reason, 'CLINICAL_TIMEZONE_REQUIRED');
  input.context.timezone_offset = '+08:00'; assert.equal(diuretic(run(input)).next_morning.date, '2026-11-05');
  input.context.timezone = 'not-a-zone'; assert.equal(diuretic(run(input)).next_morning.status, 'not_evaluable');
});

test('urine missing intervals, cumulative totals, overlap, and partial boundary periods stay unknown', () => {
  for (const patch of [{ period_start: null }, { volume_basis: 'cumulative' }, { period_start: '2026-11-04T05:00:00Z' },
    { period_end: '2026-11-04T10:00:00Z' }, { urine_output_ml: -1 }, { record_kind: 'planned_infusion' }]) {
    const input = syntheticTemporalInput(); Object.assign(input.nursingFeed[1], patch);
    const c = diuretic(run(input)); assert.equal(c.urine_after.total_ml, null, JSON.stringify(patch)); assert.equal(c.urine_delta_ml, null);
  }
});

test('explicit zero remains zero; partial data and an unfinished six-hour window are not complete totals', () => {
  const input = syntheticTemporalInput(); input.nursingFeed[1].urine_output_ml = 0; input.nursingFeed[2].urine_output_ml = 0;
  assert.equal(diuretic(run(input)).urine_after.total_ml, 0);
  input.nursingFeed.splice(2, 1);
  const c = diuretic(run(input)); assert.equal(c.urine_after.total_ml, null); assert.equal(c.urine_after.observed_partial_ml, 0);
  input.now = '2026-11-04T10:00:00Z'; assert.equal(diuretic(run(input)).urine_after.status, 'window_in_progress');
});

test('duplicate resource versions do not double count; conflicting interval or actual-dose versions abstain', () => {
  const input = syntheticTemporalInput(); input.nursingFeed.push(structuredClone(input.nursingFeed[1]));
  assert.equal(diuretic(run(input)).urine_after.total_ml, 850);
  input.nursingFeed.at(-1).period_start = '2026-11-04T07:00:00Z';
  assert.equal(diuretic(run(input)).urine_after.total_ml, null);
  const input2 = syntheticTemporalInput(); input2.medications[0].administrations.push({ ...input2.medications[0].administrations[0], actual_dose: 40 });
  assert.equal(diuretic(run(input2)), undefined);
});

test('corrected observation uses selected version and retains its exact version reference', () => {
  const input = syntheticTemporalInput(); const after = input.observations[1];
  input.observations.push({ ...after, version_id: '2', status: 'corrected', value: 3.6,
    supersedes_version_id: '1', updated_at: '2026-11-05T03:00:00Z' });
  const p = diuretic(run(input)).next_morning.trajectories.find(t => t.metric === 'k').after;
  assert.equal(p.value, 3.6); assert.equal(p.source_reference.version_id, '2');
});

test('future, unknown-time, provisional and withdrawn measurements never establish a response', () => {
  for (const patch of [{ effective_time: '2099-01-01T00:00:00Z' }, { effective_time: null, resulted_at: null },
    { resulted_at: '2099-01-01T00:00:00Z' }, { status: 'preliminary' }, { status: 'entered-in-error' }]) {
    const input = syntheticTemporalInput(); Object.assign(input.observations[1], patch);
    assert.equal(diuretic(run(input)).next_morning.trajectories.find(t => t.metric === 'k').after, null, JSON.stringify(patch));
  }
});

test('unit conversion preserves precision; incompatible source, specimen or units block the delta', () => {
  const input = syntheticTemporalInput(); input.observations[2].value = 1; input.observations[2].unit = 'mg/dL';
  assert.equal(rule(run(input), 'creatinine_48h').before.value, 88.4);
  for (const patch of [{ unit: 'mmol/L' }, { source_system: 'different-lab' }, { specimen_type: 'urine' }, { method_code: 'different-method' }]) {
    const x = syntheticTemporalInput(); Object.assign(x.observations[3], patch);
    assert.equal(rule(run(x), 'creatinine_48h').triggered, null, JSON.stringify(patch));
  }
});

test('KDIGO absolute component includes 48 hours and 26.5, excluding one millisecond beyond', () => {
  const before = sample(80, '2026-11-03T04:00:00Z'), after = sample(106.5, NOW);
  assert.equal(evaluateTemporalDelta('creatinine_48h', before, after).triggered, true);
  assert.equal(evaluateTemporalDelta('creatinine_48h', before, { ...after, value: 106.4999 }).triggered, false);
  assert.equal(evaluateTemporalDelta('creatinine_48h', { ...before, timestamp: '2026-11-03T03:59:59.999Z' }, after).triggered, null);
  assert.equal(evaluateTemporalDelta('creatinine_48h', { ...before, value: 130 }, after).triggered, false);
});

test('native mg/dL threshold is 0.3 without rounding a subthreshold value upward', () => {
  const input = syntheticTemporalInput(); Object.assign(input.observations[2], { value: 1, unit: 'mg/dL' });
  Object.assign(input.observations[3], { value: 1.29999, unit: 'mg/dL' });
  assert.equal(rule(run(input), 'creatinine_48h').triggered, false);
  input.observations[3].value = 1.3; assert.equal(rule(run(input), 'creatinine_48h').triggered, true);
});

test('slow creatinine rise scans prior 48-hour pairs, including history beyond the display window', () => {
  const input = syntheticTemporalInput(); input.timeWindow = '24h';
  input.observations[2].effective_time = '2026-11-03T22:00:00Z'; input.observations[2].resulted_at = input.observations[2].effective_time;
  input.observations.push(lab('scr-middle', 'scr', 95, 'umol/L', '2026-11-04T15:00:00Z'));
  const c = rule(run(input), 'creatinine_48h');
  assert.equal(c.triggered, true); assert.equal(c.before.value, 80); assert.equal(c.pairs_evaluated, 2);
});

test('two same-time measurements, including equivalent timezones, do not select an arbitrary baseline', () => {
  const input = syntheticTemporalInput(); input.observations.push({ ...input.observations[3], id: 'another-scr', effective_time: '2026-11-05T06:00:00+08:00', value: 140 });
  assert.equal(rule(run(input), 'creatinine_48h').triggered, null);
});

test('NEWS2 rise is computed from complete same-time observations; missing/Scale 2/pediatric applicability abstains', () => {
  assert.equal(rule(run(), 'news2_rise').triggered, true);
  for (const patch of [{ supplemental_oxygen: null }, { news2_scale: 2 }, { consciousness: 'unknown' }, { respiratory_rate: -1 }]) {
    const input = syntheticTemporalInput(); Object.assign(input.nursingFeed.find(r => r.id === 'vital-later'), patch);
    assert.equal(rule(run(input), 'news2_rise').triggered, null, JSON.stringify(patch));
  }
  for (const patch of [{ age: 10 }, { pregnant: true }, { pregnant: null }]) {
    const input = syntheticTemporalInput(); Object.assign(input.patient, patch);
    assert.equal(rule(run(input), 'news2_rise').triggered, null);
  }
});

test('SOFA only compares complete source-reported same-version component totals, without assumed zero', () => {
  assert.equal(rule(run(), 'sofa_rise').triggered, true);
  for (const change of [s => { s.complete = false; }, s => { delete s.components.renal; }, s => { s.score = 10; }, s => { s.version = 'SOFA-2'; }]) {
    const input = syntheticTemporalInput(); change(input.nursingFeed.at(-1).sofa);
    assert.equal(rule(run(input), 'sofa_rise').triggered, null);
  }
  const input = syntheticTemporalInput(); input.nursingFeed = input.nursingFeed.filter(r => r.id !== 'sofa-before');
  assert.equal(rule(run(input), 'sofa_rise').triggered, null);
});

test('threshold candidates do not require a LIS critical flag and never become clinician facts or prescriptions', () => {
  const out = Engine.analyzePatientEvolution(syntheticTemporalInput()), t = out.blocks.temporal_analysis;
  assert.deepEqual(new Set(t.candidate_alerts.map(a => a.rule_id)), new Set(['creatinine_48h', 'news2_rise', 'sofa_rise']));
  assert.ok(t.candidate_alerts.every(a => a.category === 'RULE_ALERT' && a.clinical_alerts_enabled === false && a.diagnosis === null && a.clinical_action === null));
  assert.ok(!out.selectable_items.some(i => i.id.startsWith('RULE-DELTA')));
  assert.ok(!out.blocks.rule_reminders.some(i => i.id.startsWith('RULE-DELTA')));
  assert.equal(t.clinical_alerts_enabled, false);
});

test('pure delta math rejects zero-duration, missing, invalid, overflow and impossible timestamps', () => {
  const a = sample(0, '2026-11-05T02:00:00Z'), b = sample(2, '2026-11-05T03:00:00Z');
  assert.equal(calculateTemporalDelta(a, b).relative_delta, null);
  assert.equal(calculateTemporalDelta(a, b).slope_per_hour, 2);
  for (const p of [{ value: null }, { value: true }, { value: '' }, { value: Infinity }, { timestamp: a.timestamp }, { timestamp: '2026-02-30T03:00:00Z' }, { timestamp: '2026-11-05T03:00:00' }, { unit: '' }]) {
    assert.equal(calculateTemporalDelta(a, { ...b, ...p }).status, 'not_evaluable');
  }
  assert.equal(temporalTimestamp('2026-11-05T24:00:00Z'), null);
  assert.equal(calculateTemporalDelta({ ...a, value: -Number.MAX_VALUE }, { ...b, value: Number.MAX_VALUE }).status, 'not_evaluable');
});

test('research calculation can be disabled without changing existing summary projections', () => {
  const input = syntheticTemporalInput(), enabled = Engine.analyzePatientEvolution(input);
  const disabled = Engine.analyzePatientEvolution({ ...input, temporalAnalysis: false });
  assert.equal(disabled.blocks.temporal_analysis.status, 'disabled');
  assert.deepEqual(disabled.selectable_items, enabled.selectable_items);
  assert.deepEqual(run(input), run({ ...input, observations: [...input.observations].reverse(), nursingFeed: [...input.nursingFeed].reverse() }));
});

test('new source metadata participates in version conflict detection', () => {
  const row = vitals('same', NOW), other = { ...row, supplemental_oxygen: true };
  assert.equal(resolveRecordVersions([row, other], { sourceType: 'nursing', now: NOW }).current_records.length, 0);
});

test('explicit fluid-resuscitation execution also aligns measured urine; planned volume alone cannot', () => {
  const input = syntheticTemporalInput(); input.medications[0].drug_name = '液体'; input.medications[0].intervention_kind = 'fluid_resuscitation';
  input.medications[0].administrations[0].administered_volume_ml = 250;
  assert.equal(run(input).interventions.find(i => i.drug_class === 'fluid_resuscitation').urine_after.total_ml, 850);
});

test('the host adapter preserves timing, actual dose, source identity and the research block', () => {
  const input = syntheticTemporalInput();
  const out = HospitalAgentAdapter.executePreRoundWorkflow({ host: 'his_embed',
    context: { ...input.context, as_of: NOW, time_window: '72h' }, frozenRulePack: null,
    dataFeeds: { patient: input.patient, encounter: { id: input.context.encounter_id }, notes: [],
      lis: input.observations, nis: input.nursingFeed, his_orders: input.medications.map(m => ({ ...m, order_type: 'medication' })), pacs: [] } });
  const c = diuretic(out.summary.blocks.temporal_analysis);
  assert.equal(c.actual_dose, 20);
  assert.equal(c.urine_after.total_ml, 850);
  assert.equal(c.next_morning.date, '2026-11-05');
  assert.equal(c.source_references[1].source_system, 'synthetic-MAR');
  assert.equal(out.summary.blocks.temporal_analysis.candidate_alerts.length, 3);
});

test('schema and runtime reject live alert promotion, broken edges and evidence drift', () => {
  const schema = JSON.parse(readFileSync(new URL('../plugins/medcius/contracts/temporal-evolution.v1.schema.json', import.meta.url)));
  const summary = Engine.analyzePatientEvolution(syntheticTemporalInput());
  assert.equal(validateContract(schema, summary.blocks.temporal_analysis), true);
  for (const mutate of [s => { s.blocks.temporal_analysis.clinical_alerts_enabled = true; },
    s => { s.blocks.temporal_analysis.graph.edges[0].causal = true; },
    s => { s.blocks.temporal_analysis.candidate_alerts[0].diagnosis = 'AKI'; }]) {
    const copy = structuredClone(summary); mutate(copy);
    assert.throws(() => assertEvolutionConsistency(copy), /TEMPORAL_/);
    assert.throws(() => validateContract(schema, copy.blocks.temporal_analysis));
  }
  const copy = structuredClone(summary), alert = copy.blocks.temporal_analysis.candidate_alerts[0];
  alert.source_references[0] = { ...alert.source_references[0], source_id: 'other' };
  assert.throws(() => assertEvolutionConsistency(copy), /TEMPORAL_ALERT_SOURCES/);
});

test('conflicting generic name and ATC code cannot select a drug response chain', () => {
  const input = syntheticTemporalInput(); Object.assign(input.medications[0], { drug_code_system: 'ATC', drug_code: 'J01DH02' });
  assert.equal(diuretic(run(input)), undefined);
  assert.ok(run(input).data_gaps.some(g => g.reason === 'DRUG_NAME_CODE_CONFLICT'));
});

test('source-declared antibiotic escalation anchors its change timestamp and never infers escalation from a name', () => {
  const input = syntheticTemporalInput(); Object.assign(input.medications[1], { change_type: 'escalated', changed_at: '2026-11-04T00:00:00Z' });
  const c = run(input).interventions.find(i => i.drug_id === 'meropenem' && i.kind === 'order');
  assert.equal(c.timestamp, '2026-11-04T00:00:00Z'); assert.equal(c.event_subtype, 'source_reported_escalation');
  delete input.medications[1].changed_at;
  assert.equal(run(input).interventions.some(i => i.drug_id === 'meropenem' && i.kind === 'order'), false);
});

test('a previous-day dose is retained when its next-morning measurements fall inside the 24-hour display window', () => {
  const input = syntheticTemporalInput(); input.timeWindow = '24h'; input.now = '2026-11-05T15:00:00Z';
  assert.equal(diuretic(run(input)).next_morning.trajectories.find(t => t.metric === 'k').after.value, 3.3);
});

test('nonfinite normalization or volume totals never become numeric findings', () => {
  const input = syntheticTemporalInput(); input.nursingFeed[1].urine_output_ml = Number.MAX_VALUE; input.nursingFeed[2].urine_output_ml = Number.MAX_VALUE;
  Object.assign(input.observations[3], { value: Number.MAX_VALUE, unit: 'mg/dL' });
  const out = run(input);
  assert.equal(diuretic(out).urine_after.total_ml, null);
  assert.equal(rule(out, 'creatinine_48h').triggered, null);
});
