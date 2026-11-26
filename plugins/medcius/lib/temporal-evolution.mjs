// Deterministic time association for silent research / synthetic replay.
// Edges mean only "observed after". They never establish a treatment effect.
import { TEMPORAL_REFERENCE as REF, TEMPORAL_PROVENANCE, temporalTimestamp, checkCreatinineDataQuality, isAmbiguousMassUnit,
  calculateTemporalDelta, evaluateTemporalDelta } from './calculation-reference.mjs';
import { calculateNews2 } from './hospital-data-adapter.mjs';
import { classifyRecordLifecycle, resolveRecordVersions } from './record-lifecycle.mjs';
import { actualFluidRecord } from './order-execution.mjs';
import { canonicalJson, sha256Hex } from '../servers/shared/crypto.mjs';
import { normalizeLaboratoryMeasurement, inspectCreatinineSpecimen } from './laboratory-terminology.mjs';

const HOUR = 3600000;
const number = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) ? Number(v) : null;
const iso = ms => new Date(ms).toISOString();
const system = r => r.source_system ?? r._source?.system ?? null;
const version = r => r.version_id ?? r.meta?.versionId ?? null;
const observedAt = r => r.effective_time ?? r.effectiveDateTime ?? r.sample_time ?? r.event_time ?? r.timestamp ?? null;
const orderedAt = r => r.authored_on ?? r.ordered_at ?? r.start_time ?? null;
const shortId = value => sha256Hex(canonicalJson(value)).slice(0, 24);
const anchor = (r, type, timestamp) => ({ source_type: type, source_id: r.id, source_system: system(r),
  version_id: version(r), timestamp, record_sha256: sha256Hex(canonicalJson(r)), hash_basis: 'normalized_guarded_record' });
const uniqueRefs = refs => [...new Map(refs.map(r => [canonicalJson(r), r])).values()];
const metricAliases = {
  scr: ['scr', 'creatinine', '肌酐', '血肌酐', '2160-0', '14682-9'],
  k: ['k', 'potassium', '血钾', '钾', '2823-3'],
  na: ['na','sodium','血钠','钠','2951-2'], cl: ['cl','chloride','血氯','氯','2075-0'],
  ca: ['ca','calcium','总钙','钙','2000-8'], mg: ['mg','magnesium','血镁','镁','2601-3'],
  wbc: ['wbc', '白细胞', '白细胞计数', '6690-2'],
  pct: ['pct', 'procalcitonin', '降钙素原', '33959-8'],
  crp: ['crp', 'c-reactive protein', 'c反应蛋白', '1988-5'],
};
const units = { scr: 'umol/L', k: 'mmol/L', na: 'mmol/L', cl: 'mmol/L', ca: 'mmol/L', mg: 'mmol/L', wbc: '10^9/L', pct: 'ng/mL', crp: 'mg/L', temperature: 'Cel', news2: 'points', sofa: 'points' };
function metricOf(r) {
  const code = String(typeof r.code === 'string' ? r.code : r.code?.coding?.[0]?.code ?? r.test_code ?? '').toLowerCase();
  if (/^\d{2,6}-\d$/.test(code) && !['LOINC', 'http://loinc.org'].includes(r.code_system ?? r.code?.coding?.[0]?.system)) return null;
  return Object.entries(metricAliases).find(([, aliases]) => aliases.includes(code))?.[0] ?? null;
}
const electrolytes = ['k', 'na', 'cl', 'ca', 'mg'];
export function isElectrolyteMeasurement(record) {
  const code = String(typeof record.code === 'string' ? record.code : record.code?.coding?.[0]?.code ?? record.test_code ?? '').toLowerCase();
  return electrolytes.some(metric => metricAliases[metric].includes(code));
}
function normalized(metric, rawValue, rawUnit) {
  const value = number(rawValue), unit = String(rawUnit ?? '').trim().toLowerCase().replace(/\s/g, '').replace(/[µμ]/g, 'u');
  if (value == null || value < 0 || isAmbiguousMassUnit(rawUnit)) return null;
  if (metric === 'scr') { const check = checkCreatinineDataQuality(value, rawUnit); return check.eligible ? check.normalized_value : null; }
  if (['na','cl','ca','mg'].includes(metric)) return unit === 'mmol/l' ? value : null;
  if (metric === 'k') return ['mmol/l', 'meq/l'].includes(unit) ? value : null;
  if (metric === 'wbc') return ['10^9/l', '10*9/l', '10^3/ul', '10*3/ul'].includes(unit) ? value : null;
  if (metric === 'pct') return ['ng/ml', 'ug/l'].includes(unit) ? value : null;
  if (metric === 'crp') return unit === 'mg/l' ? value : unit === 'mg/dl' ? value * 10 : null;
  return null;
}
function point(r, metric, value, type = 'Observation') {
  const timestamp = observedAt(r), originalUnit = r.unit ?? r.valueQuantity?.unit ?? null;
  return { metric, value, unit: units[metric], timestamp,
    original_value: number(r.value ?? r.valueQuantity?.value), original_unit: /^mg\/dl$/i.test(originalUnit ?? '') ? 'mg/dL' : originalUnit,
    comparison_key: canonicalJson([system(r), r.specimen_type ?? null, r.method_code ?? null, metric === 'sofa' ? r.sofa?.version : null]),
    source_reference: anchor(r, type, timestamp) };
}
function compare(before, after, maxHours) {
  if (!before || !after) return { status: 'not_evaluable', reason: 'PAIRED_MEASUREMENTS_MISSING', delta: null, slope_per_hour: null };
  if (before.comparison_key !== after.comparison_key) return { status: 'not_evaluable', reason: 'SOURCE_METHOD_OR_SPECIMEN_MISMATCH', delta: null, slope_per_hour: null };
  return calculateTemporalDelta(before, after, { maxHours });
}
// The caller supplies the selected source versions. Keep the same arithmetic
// in ordinary summary facts even when experimental temporal alerts are disabled.
export function reviewedElectrolyteTrends(currentRecords, context, nowMs, cutoff) {
  const series = new Map();
  for (const record of currentRecords) {
    const metric = metricOf(record);
    if (!electrolytes.includes(metric) || !record.id || !system(record)) continue;
    if (!['tenant_id', 'patient_id', 'encounter_id'].every(k => context?.[k] && record[k] === context[k])) continue;
    const status = classifyRecordLifecycle(record, { sourceType: 'observation', now: nowMs }).result_status;
    if (!['final', 'revised'].includes(status)) continue;
    const ms = temporalTimestamp(observedAt(record));
    if (ms == null || ms > nowMs || [record.resulted_at, record.issued, record.recorded_at, record.updated_at, record.meta?.lastUpdated]
      .some(v => v != null && (temporalTimestamp(v) == null || temporalTimestamp(v) > nowMs))) continue;
    const values = series.get(metric) ?? [];
    values.push({ record, ms });
    series.set(metric, values);
  }
  const trends = [];
  for (const metric of electrolytes) {
    const values = series.get(metric);
    if (!values) continue;
    values.sort((a, b) => a.ms - b.ms || String(a.record.id).localeCompare(String(b.record.id)));
    const latest = values.at(-1), prior = values.at(-2);
    if (latest.ms < cutoff) continue;
    const pair = [prior, latest].filter(Boolean).map(v => v.record);
    const points = pair.map(r => point(r, metric, normalized(metric, r.value ?? r.valueQuantity?.value, r.unit ?? r.valueQuantity?.unit)));
    const before = prior ? points[0] : null, after = points.at(-1);
    const comparable = prior && prior.ms < latest.ms && values.at(-3)?.ms !== prior.ms
      && pair.every(r => {
        const low = number(r.ref_low ?? r.referenceRange?.[0]?.low?.value), high = number(r.ref_high ?? r.referenceRange?.[0]?.high?.value);
        return ['serum', 'plasma', '血清', '血浆'].includes(r.specimen_type) && typeof r.method_code === 'string' && r.method_code.trim()
          && low != null && high != null && low < high
          && [r.comparator, r.value_comparator, r.valueQuantity?.comparator].every(v => v == null || v === '=')
          && [r.ref_unit, r.referenceRange?.[0]?.low?.unit, r.referenceRange?.[0]?.high?.unit]
            .every(unit => unit == null || normalized(metric, 1, unit) === 1);
      }) && ['assay_id', 'assay_version'].every(k => prior.record[k] === latest.record[k]);
    const delta = comparable ? compare(before, after, 72) : { status: 'not_evaluable',
      reason: 'COMPARABLE_ELECTROLYTE_PAIR_REQUIRED', delta: null, elapsed_hours: null, slope_per_hour: null };
    trends.push({ metric, unit: units[metric], before, after, ...delta,
      direction: delta.delta == null ? 'unknown' : delta.delta > 0 ? 'rising' : delta.delta < 0 ? 'falling' : 'unchanged',
      source_references: points.map(p => p.source_reference), causal_attribution: 'not_established' });
  }
  return trends;
}

function unambiguous(points, pick) {
  if (!points.length) return null;
  const selected = points[pick === 'first' ? 0 : points.length - 1];
  return points.filter(p => Date.parse(p.timestamp) === Date.parse(selected.timestamp)).length === 1 ? selected : null;
}
function trend(points, metric, start, end, baselineHours = REF.windows.baseline_hours) {
  const beforePoints = points.filter(p => p.metric === metric && Date.parse(p.timestamp) >= start - baselineHours * HOUR && Date.parse(p.timestamp) < start);
  const afterPoints = points.filter(p => p.metric === metric && Date.parse(p.timestamp) > start && Date.parse(p.timestamp) <= end);
  const before = unambiguous(beforePoints, 'last'), after = unambiguous(afterPoints, 'last');
  const delta = compare(before, after, baselineHours + (end - start) / HOUR);
  return { metric, unit: units[metric], before, after, points: afterPoints, delta,
    status: delta.status, time_basis: 'measurement_time', reference_range_interpretation: 'not_performed' };
}
function localClock(timestamp, context) {
  try {
    if (context.timezone) {
      const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: context.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp)).map(p => [p.type, p.value]));
      return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour) };
    }
    const offset = context.timezone_offset;
    if (typeof offset !== 'string' || !/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(offset) || /^[+-]14:(?!00)/.test(offset)) return null;
    const minutes = (offset[0] === '-' ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4)));
    const local = new Date(Date.parse(timestamp) + minutes * 60000);
    return { date: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
  } catch { return null; }
}

function urineWindow(rows, start, end, now) {
  const selected = [], excluded = [];
  for (const r of rows) {
    if (r.urine_output_ml == null) continue;
    const a = temporalTimestamp(r.period_start), b = temporalTimestamp(r.period_end), t = temporalTimestamp(observedAt(r));
    if (a == null || b == null || b <= a) {
      if (t != null && t >= start && t <= end) excluded.push({ reason: 'URINE_INTERVAL_UNKNOWN', source_id: r.id });
      continue;
    }
    if (b <= start || a >= end) continue;
    if (!actualFluidRecord(r) || r.volume_basis !== 'interval_total' || number(r.urine_output_ml) == null || Number(r.urine_output_ml) < 0
      || a < start || b > end || b > now) {
      excluded.push({ reason: 'URINE_INTERVAL_NOT_COMPARABLE', source_id: r.id }); continue;
    }
    selected.push({ start: a, end: b, value: Number(r.urine_output_ml), source_reference: anchor(r, 'Nursing', observedAt(r)) });
  }
  selected.sort((a, b) => a.start - b.start || a.end - b.end);
  const overlap = selected.some((p, i) => i > 0 && p.start < selected[i - 1].end);
  const complete = !excluded.length && !overlap && selected.length > 0 && selected[0].start === start
    && selected.at(-1).end === end && selected.every((p, i) => i === 0 || p.start === selected[i - 1].end) && end <= now;
  const sum = !overlap && !excluded.length && selected.length ? selected.reduce((total, p) => total + p.value, 0) : null;
  const observedTotal = Number.isFinite(sum) ? sum : null, usable = complete && observedTotal != null;
  return { start: iso(start), end: iso(end), status: usable ? 'complete' : overlap ? 'overlap' : end > now ? 'window_in_progress' : 'incomplete',
    total_ml: usable ? observedTotal : null, observed_partial_ml: observedTotal, coverage_complete: usable,
    rate_ml_per_hour: usable ? observedTotal / ((end - start) / HOUR) : null,
    source_references: selected.map(p => p.source_reference), excluded };
}

export function analyzeTemporalEvolution({ context, patient = {}, observations = [], nursing = [], orders = [],
  now, cutoffTime, disabled = false } = {}) {
  const result = { schema_version: 'medcius.temporal-evolution.v1', status: 'evaluated', mode: 'engineering_silent_only',
    clinical_alerts_enabled: false, causal_attribution: 'not_established', provenance: TEMPORAL_PROVENANCE,
    interventions: [], electrolyte_trends: [], delta_checks: [], candidate_alerts: [], data_gaps: [], graph: { nodes: [], edges: [] } };
  if (disabled) return { ...result, status: 'disabled' };
  if ([observations, nursing, orders].some(rows => !Array.isArray(rows) || rows.length > 10000)) throw new Error('TEMPORAL_FEED_INVALID');
  const nowMs = typeof now === 'number' ? now : temporalTimestamp(now), cutoff = typeof cutoffTime === 'number' ? cutoffTime : temporalTimestamp(cutoffTime);
  const gap = (reason, record = null, type = null) => result.data_gaps.push({ category: 'DATA_GAP', reason,
    source_id: record?.id ?? null, source_system: record ? system(record) : null, source_type: type });
  if (![nowMs, cutoff].every(Number.isFinite) || cutoff > nowMs) throw new Error('TEMPORAL_TIME_CONTEXT_INVALID');
  if (['patient_id', 'encounter_id', 'tenant_id'].some(k => typeof context?.[k] !== 'string' || !context[k].trim())) {
    gap('TEMPORAL_IDENTITY_CONTEXT_REQUIRED'); return { ...result, status: 'not_evaluable' };
  }
  const identity = r => {
    if (['patient_id', 'encounter_id', 'tenant_id'].some(k => r[k] != null && r[k] !== context[k])) throw new Error('TEMPORAL_SOURCE_IDENTITY_MISMATCH');
    return ['patient_id', 'encounter_id', 'tenant_id'].every(k => r[k] === context[k]);
  };
  function select(records, type, requireFinal = true) {
    if (!Array.isArray(records) || records.length > 10000) throw new Error('TEMPORAL_FEED_INVALID');
    const eligible = [];
    for (const r of records) {
      if (!r || typeof r !== 'object') { gap('TEMPORAL_RECORD_INVALID', null, type); continue; }
      if (!identity(r) || !r.id || !system(r)) { gap('TEMPORAL_SOURCE_CONTEXT_MISSING', r, type); continue; }
      eligible.push(r);
    }
    const resolution = resolveRecordVersions(eligible, { sourceType: type, now: nowMs });
    for (const entry of resolution.entries) if (['conflict', 'future'].includes(entry.selection_status)) gap(`TEMPORAL_SOURCE_${entry.selection_status.toUpperCase()}`, entry.record, type);
    return resolution.current_records.filter(r => {
      const state = classifyRecordLifecycle(r, { sourceType: type, now: nowMs });
      if (state.result_status === 'entered_in_error' || (type !== 'order' && state.result_status === 'cancelled')) return false;
      if (requireFinal && !['final', 'revised'].includes(state.result_status)) { gap('TEMPORAL_FINAL_MEASUREMENT_REQUIRED', r, type); return false; }
      const t = temporalTimestamp(type === 'order' ? orderedAt(r) : type === 'administration' ? r.performed_at : observedAt(r));
      const invalidAvailability = [r.resulted_at, r.issued, r.recorded_at, r.updated_at, r.meta?.lastUpdated].some(v => v != null && (temporalTimestamp(v) == null || temporalTimestamp(v) > nowMs));
      if (t == null || t > nowMs || invalidAvailability) { gap('TEMPORAL_TIMESTAMP_UNUSABLE', r, type); return false; }
      return true;
    });
  }
  const labs = select(observations.filter(r => r && metricOf(r)), 'observation');
  const nis = select(nursing, 'nursing');
  const selectedOrders = select(orders, 'order', false);
  const points = [];
  for (const r of labs) {
    const metric = metricOf(r), converted = normalized(metric, r.value ?? r.valueQuantity?.value, r.unit ?? r.valueQuantity?.unit);
    const sourceCode = typeof r.code === 'string' ? r.code : r.code?.coding?.[0]?.code;
    const sourceSystem = r.code_system ?? r.code?.coding?.[0]?.system;
    const loincCheck = metric === 'scr' && ['2160-0', '14682-9'].includes(sourceCode)
      ? normalizeLaboratoryMeasurement({ code: sourceCode, code_system: sourceSystem, value: number(r.value ?? r.valueQuantity?.value), unit: r.unit ?? r.valueQuantity?.unit }) : null;
    const value = Number.isFinite(converted) && (metric !== 'scr' || inspectCreatinineSpecimen(r).eligible)
      && loincCheck?.quantity.reason !== 'LOINC_PROPERTY_UNIT_MISMATCH' ? converted : null;
    if (value == null || (metric === 'scr' && value <= 0)) gap('TEMPORAL_VALUE_OR_UNIT_UNUSABLE', r, 'observation');
    points.push(point(r, metric, metric === 'scr' && value <= 0 ? null : value));
  }
  for (const r of nis) {
    if (r.temperature != null) points.push(point(r, 'temperature', number(r.temperature), 'Nursing'));
    const hasVitals = ['respiratory_rate', 'respiration_rate', 'rr', 'spo2', 'systolic_bp', 'heart_rate', 'consciousness'].some(k => r[k] != null);
    if (hasVitals) {
      const score = calculateNews2({ ...r, respiration_rate: r.respiration_rate ?? r.respiratory_rate ?? r.rr });
      const applicable = number(patient.age) >= 18 && patient.pregnant === false && r.news2_scale === 1
        && ['systolic_bp', 'heart_rate', 'temperature'].every(k => number(r[k]) > 0)
        && number(r.respiration_rate ?? r.respiratory_rate ?? r.rr) > 0;
      points.push(point(r, 'news2', applicable && score.complete ? score.score : null, 'Nursing'));
      if (!applicable || !score.complete) gap('NEWS2_COMPLETE_APPLICABLE_SCALE1_MEASUREMENT_REQUIRED', r, 'nursing');
    }
    if (r.sofa != null) {
      const s = r.sofa, components = ['respiration', 'coagulation', 'liver', 'cardiovascular', 'cns', 'renal'];
      const valid = s.version === 'SOFA-1996' && s.complete === true && Number.isInteger(s.score) && number(patient.age) >= 18
        && components.every(k => Number.isInteger(s.components?.[k]) && s.components[k] >= 0 && s.components[k] <= 4)
        && components.reduce((sum, k) => sum + s.components[k], 0) === s.score;
      points.push(point(r, 'sofa', valid ? s.score : null, 'Nursing'));
      if (!valid) gap('SOFA_COMPLETE_VERSIONED_COMPONENTS_REQUIRED', r, 'nursing');
    }
  }
  points.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || canonicalJson(a.source_reference).localeCompare(canonicalJson(b.source_reference)));

  result.electrolyte_trends = reviewedElectrolyteTrends(labs, context, nowMs, cutoff);

  // Exact vocabulary; never infer drug class, escalation, or dose from prose.
  const events = [], allAdministrations = [];
  for (const order of selectedOrders) {
    const label = String(order.drug_name ?? '').trim().toLowerCase();
    const namedDrug = REF.drugs.find(d => d.aliases.includes(label));
    const codedDrug = order.drug_code_system === 'ATC' ? REF.drugs.find(d => order.drug_code === d.atc) : null;
    const conflict = namedDrug && order.drug_code_system === 'ATC' && order.drug_code !== namedDrug.atc;
    const drug = conflict ? null : namedDrug ?? codedDrug;
    if (conflict) gap('DRUG_NAME_CODE_CONFLICT', order, 'order');
    const fluid = order.intervention_kind === 'fluid_resuscitation';
    if (!drug && !fluid && order.drug_name) gap('DRUG_CLASS_UNMAPPED', order, 'order');
    const raw = order.administrations ?? [];
    if (!Array.isArray(raw) || raw.length > 10000) throw new Error('TEMPORAL_ADMINISTRATION_FEED_INVALID');
    const bound = [];
    for (const event of raw) {
      if (!event || event.order_id !== order.id) { gap('ADMINISTRATION_ORDER_BINDING_UNKNOWN', event, 'administration'); continue; }
      identity(event); // explicit mismatches are rejected before parent containment.
      bound.push({ ...event, patient_id: event.patient_id ?? order.patient_id, encounter_id: event.encounter_id ?? order.encounter_id,
        tenant_id: event.tenant_id ?? order.tenant_id, source_system: system(event) ?? system(order), event_time: event.performed_at });
    }
    const actual = select(bound, 'administration', false).filter(r => r.execution_status === 'administered');
    for (const a of actual) {
      const event = { id: `administration-${shortId([system(a), a.id, version(a)])}`, kind: 'administration',
        timestamp: a.performed_at, drug_id: drug?.id ?? null, drug_class: drug?.class ?? (fluid ? 'fluid_resuscitation' : 'unknown'),
        order_id: order.id, actual_dose: number(a.actual_dose), dose_unit: a.dose_unit ?? null,
        route: a.route ?? null, administered_volume_ml: number(a.administered_volume_ml),
        source_references: [anchor(order, 'MedicationRequest', orderedAt(order)), anchor(a, 'MedicationAdministration', a.performed_at)],
        identity_basis: 'source_bound_parent_order', treatment_day: null };
      allAdministrations.push(event);
      if (drug || fluid) events.push(event);
    }
    if (drug?.class === 'antibacterial' && classifyRecordLifecycle(order, { sourceType: 'order', now: nowMs }).result_status !== 'cancelled') {
      const escalation = order.change_type === 'escalated', eventTime = escalation ? order.changed_at : orderedAt(order);
      if (temporalTimestamp(eventTime) == null || temporalTimestamp(eventTime) > nowMs) gap('ANTIBIOTIC_CHANGE_TIME_REQUIRED', order, 'order');
      else events.push({ id: `order-${shortId([system(order), order.id, version(order)])}`,
        kind: 'order', event_subtype: escalation ? 'source_reported_escalation' : 'order_started', timestamp: eventTime,
        drug_id: drug.id, drug_class: drug.class, order_id: order.id,
        source_change_type: order.change_type ?? null, administration_confirmed: actual.length > 0, treatment_day: null,
        source_references: [anchor(order, 'MedicationRequest', eventTime)] });
    }
    if ((drug?.class === 'loop_diuretic' || fluid) && !actual.length) gap('ACTUAL_ADMINISTRATION_REQUIRED', order, 'order');
  }
  const uniqueEvents = [...new Map(events.map(e => [e.id, e])).values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id));
  for (const event of uniqueEvents) {
    const start = Date.parse(event.timestamp), duration = event.drug_class === 'antibacterial' ? REF.windows.infection_hours : REF.windows.urine_hours;
    const end = Math.min(nowMs, start + duration * HOUR);
    // A dose before the display window can still have a next-morning lab in it.
    const retentionHours = event.drug_class === 'antibacterial' ? duration : Math.max(48, duration);
    if (start > nowMs || start + retentionHours * HOUR < cutoff) continue;
    const chain = { ...event, relation: 'temporal_association_only', causal_attribution: 'not_established',
      window: { start: iso(start), end: iso(start + duration * HOUR), observed_through: iso(end), complete: nowMs >= start + duration * HOUR },
      trajectories: [], overlapping_interventions: allAdministrations.filter(e => e.id !== event.id && Date.parse(e.timestamp) >= start && Date.parse(e.timestamp) <= end).map(e => ({ id: e.id, timestamp: e.timestamp, source_references: e.source_references })) };
    if (event.drug_class === 'antibacterial') {
      chain.trajectories = ['temperature', 'wbc', 'pct', 'crp'].map(metric => trend(points, metric, start, end));
      const temperature = points.filter(p => p.metric === 'temperature' && p.value != null && Date.parse(p.timestamp) > start && Date.parse(p.timestamp) <= end);
      chain.temperature_peaks = Array.from({ length: Math.ceil((end - start) / (24 * HOUR)) }, (_, index) => {
        const a = start + index * 24 * HOUR, b = Math.min(end, a + 24 * HOUR), inBin = temperature.filter(p => Date.parse(p.timestamp) > a && Date.parse(p.timestamp) <= b);
        return { start: iso(a), end: iso(b), observed_max: inBin.length ? Math.max(...inBin.map(p => p.value)) : null,
          measurement_count: inBin.length, continuous_coverage: 'unknown', source_references: inBin.map(p => p.source_reference) };
      });
    } else {
      chain.urine_before = urineWindow(nis, start - duration * HOUR, start, nowMs);
      chain.urine_after = urineWindow(nis, start, start + duration * HOUR, nowMs);
      chain.urine_delta_ml = chain.urine_before.coverage_complete && chain.urine_after.coverage_complete ? chain.urine_after.total_ml - chain.urine_before.total_ml : null;
      const local = localClock(event.timestamp, context);
      chain.next_morning = { status: local ? 'evaluated' : 'not_evaluable', reason: local ? null : 'CLINICAL_TIMEZONE_REQUIRED', trajectories: [] };
      if (local) {
        const nextDate = new Date(Date.parse(`${local.date}T00:00:00Z`) + 24 * HOUR).toISOString().slice(0, 10);
        const morning = points.filter(p => { const c = localClock(p.timestamp, context); return c?.date === nextDate && c.hour >= REF.windows.morning_start_hour && c.hour < REF.windows.morning_end_hour; });
        chain.next_morning.date = nextDate;
        chain.next_morning.trajectories = ['k', 'scr'].map(metric => trend([...points.filter(p => Date.parse(p.timestamp) < start), ...morning], metric, start, nowMs));
      }
    }
    const trajectories = [...chain.trajectories, ...(chain.next_morning?.trajectories ?? [])];
    chain.source_references = uniqueRefs([...event.source_references, ...trajectories.flatMap(t => [t.before, ...t.points].filter(Boolean).map(p => p.source_reference)),
      ...(chain.urine_before?.source_references ?? []), ...(chain.urine_after?.source_references ?? [])]);
    const drugLabel = REF.drugs.find(d => d.id === event.drug_id)?.aliases.find(a => /[\u4e00-\u9fff]/.test(a)) ?? '液体干预';
    const fmt = n => Number(n.toFixed(3)); // presentation only; checks use unrounded values
    const names = { k: 'K+', scr: '肌酐', pct: 'PCT', wbc: 'WBC', crp: 'CRP', temperature: '体温' };
    const details = trajectories.filter(t => t.delta.status === 'calculated').map(t => `${names[t.metric]} ${fmt(t.before.value)}→${fmt(t.after.value)} ${t.unit}`);
    if (chain.urine_after) details.unshift(chain.urine_after.coverage_complete
      ? `随后6h已记录尿量 ${chain.urine_after.total_ml} mL` : '随后6h尿量区间不完整，合计未知');
    const dose = event.actual_dose != null && event.actual_dose >= 0 && event.dose_unit ? ` ${event.actual_dose} ${event.dose_unit}` : '';
    chain.summary = `${drugLabel}${dose} ${event.kind === 'administration' ? '执行' : event.event_subtype === 'source_reported_escalation' ? '来源标记升级' : '开立'}记录 ${event.timestamp}；${details.length ? details.join('；') : '配对测量不足'}。仅表示时间关联。`;
    result.interventions.push(chain);
  }

  for (const [ruleId, rule] of Object.entries(REF.delta_rules)) {
    const series = points.filter(p => p.metric === rule.metric);
    const current = unambiguous(series, 'last');
    if (!current || Date.parse(current.timestamp) < cutoff) {
      result.delta_checks.push({ rule_id: ruleId, status: 'not_evaluable', triggered: null, reason: 'CURRENT_MEASUREMENT_MISSING_OR_AMBIGUOUS' }); continue;
    }
    const prior = series.filter(p => Date.parse(p.timestamp) < Date.parse(current.timestamp) && Date.parse(current.timestamp) - Date.parse(p.timestamp) <= rule.max_hours * HOUR);
    // KDIGO absolute change scans measured prior pairs, not only the most recent
    // sample (which could hide a slow rise). Scores use consecutive measurements.
    const baselines = ruleId === 'creatinine_48h' ? prior : [unambiguous(prior, 'last')].filter(Boolean);
    const checks = baselines.filter(b => b.comparison_key === current.comparison_key && series.filter(p => Date.parse(p.timestamp) === Date.parse(b.timestamp)).length === 1)
      .map(before => ({ ...evaluateTemporalDelta(ruleId, before, current), before, after: current,
        source_references: [before.source_reference, current.source_reference] }));
    const triggered = checks.filter(c => c.triggered === true);
    const chosen = triggered.at(-1) ?? checks.at(-1) ?? { rule_id: ruleId, status: 'not_evaluable', triggered: null, reason: 'COMPARABLE_BASELINE_MISSING' };
    const check = { ...chosen, pairs_evaluated: checks.length, triggered_pairs: triggered.length,
      rule_scope: ruleId === 'creatinine_48h' ? 'absolute_creatinine_component_only_no_AKI_exclusion' : 'engineering_delta_candidate',
      clinical_alerts_enabled: false, provenance: TEMPORAL_PROVENANCE };
    result.delta_checks.push(check);
    if (check.triggered) result.candidate_alerts.push({ ...check, id: `RULE-DELTA-${shortId([ruleId, check.source_references])}`,
      category: 'RULE_ALERT', tag: '【规则提醒候选】', diagnosis: null, clinical_action: null,
      summary: `${rule.metric} 记录变化 ${check.before.value} → ${check.after.value} ${check.after.unit}；满足 ${ruleId} 计算条件，待复核，未作诊断或疗效归因。` });
  }

  const nodes = new Map(), edges = new Map();
  for (const chain of result.interventions) {
    nodes.set(chain.id, { id: chain.id, kind: chain.kind, timestamp: chain.timestamp, source_references: chain.source_references.slice(0, chain.kind === 'administration' ? 2 : 1) });
    for (const ref of chain.source_references.slice(chain.kind === 'administration' ? 2 : 1)) {
      const id = `measurement-${shortId(ref)}`;
      nodes.set(id, { id, kind: 'measurement', timestamp: ref.timestamp, source_references: [ref] });
      const key = `${chain.id}:${id}`;
      edges.set(key, { id: key, from: chain.id, to: id, relation: Date.parse(ref.timestamp) > Date.parse(chain.timestamp) ? 'observed_after'
        : Date.parse(ref.timestamp) < Date.parse(chain.timestamp) ? 'baseline_before' : 'coincident', causal: false });
    }
  }
  result.graph = { nodes: [...nodes.values()], edges: [...edges.values()] };
  result.data_gaps = [...new Map(result.data_gaps.map(g => [canonicalJson(g), g])).values()];
  return result;
}
