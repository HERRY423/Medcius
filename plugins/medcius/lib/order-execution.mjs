// Source workflow facts, not prescribing logic. Local numeric codes must be
// translated by a versioned site mapping before reaching this module.
import { resolveRecordVersions, classifyRecordLifecycle } from './record-lifecycle.mjs';

export const ORDER_KINDS = Object.freeze(['long_term', 'temporary', 'unknown']);
export const EXECUTION_STATES = Object.freeze(['ordered', 'nurse_unverified', 'nurse_verified',
  'pharmacy_reviewed', 'dispensed', 'pharmacy_returned', 'administered', 'stopped', 'voided', 'unknown']);
const stateOf = value => EXECUTION_STATES.includes(value) ? value : 'unknown';
const transitions = {
  ordered: ['nurse_unverified', 'nurse_verified', 'stopped', 'voided'],
  nurse_unverified: ['nurse_verified', 'stopped', 'voided'],
  nurse_verified: ['pharmacy_reviewed', 'pharmacy_returned', 'administered', 'stopped', 'voided'],
  pharmacy_reviewed: ['dispensed', 'pharmacy_returned', 'stopped', 'voided'],
  dispensed: ['administered', 'pharmacy_returned', 'stopped', 'voided'],
  pharmacy_returned: ['nurse_verified', 'pharmacy_reviewed', 'stopped', 'voided'],
  administered: ['administered', 'pharmacy_reviewed', 'dispensed', 'pharmacy_returned', 'stopped', 'voided'],
  stopped: [], voided: [], unknown: [],
};
// Used only when both endpoints of a transition are explicitly supplied.
// A partial source snapshot never fabricates all preceding workflow stages.
export function transitionOrderState(previous, next) {
  if (!EXECUTION_STATES.includes(previous) || !EXECUTION_STATES.includes(next)) return 'unknown';
  return previous === next || transitions[previous].includes(next) ? next : 'unknown';
}
function time(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const t = Date.parse(value);
  const day = value.slice(0, 10), check = Date.parse(`${day}T00:00:00Z`);
  return Number(value.slice(11,13)) <= 23 && Number.isFinite(t) && Number.isFinite(check)
    && new Date(check).toISOString().slice(0, 10) === day ? t : null;
}
export function actualFluidRecord(record) {
  const kind = record.record_kind ?? 'nursing_measurement'; // legacy NIS contract: measured nursing rows
  if (kind === 'order' || kind === 'planned_infusion') return false;
  if (record.execution_status != null && stateOf(record.execution_status) !== 'administered') return false;
  if (kind === 'administration') return stateOf(record.execution_status) === 'administered'
    && Boolean(record.administration_id || record.id) && Boolean(record.order_id)
    && time(record.performed_at ?? record.event_time ?? record.timestamp) != null;
  return kind === 'nursing_measurement';
}
export function normalizeOrderExecution(item, { now = new Date(), timezoneOffset = null } = {}) {
  const orderKind = ORDER_KINDS.includes(item.order_kind) ? item.order_kind : 'unknown';
  let state = stateOf(item.execution_status);
  const gaps = [];
  if (item.previous_execution_status != null && transitionOrderState(item.previous_execution_status, state) === 'unknown') {
    state = 'unknown'; gaps.push('ORDER_TRANSITION_UNPROVEN');
  }
  const administrations = [], raw = item.administrations ?? [];
  if (!Array.isArray(raw) || raw.length > 10000) throw new Error('ORDER_ADMINISTRATION_FEED_INVALID');
  const eligible = [];
  for (const event of raw) {
    if (!event || typeof event !== 'object' || !event.id || !item.id || event.order_id !== item.id) {
      gaps.push('ADMINISTRATION_ORDER_BINDING_UNKNOWN'); continue;
    }
    if (['patient_id', 'encounter_id', 'tenant_id'].some(k => event[k] != null && event[k] !== item[k])) {
      throw new Error('ADMINISTRATION_IDENTITY_MISMATCH');
    }
    eligible.push({ ...event, event_time: event.performed_at ?? null });
  }
  const resolved = resolveRecordVersions(eligible, { sourceType: 'administration', now });
  if (resolved.entries.some(e => e.selection_status === 'conflict')) gaps.push('ADMINISTRATION_VERSION_CONFLICT');
  for (const event of resolved.current_records) {
    const t = time(event.performed_at);
    if (t == null || t > new Date(now).getTime()) { gaps.push('ADMINISTRATION_TIME_UNKNOWN'); continue; }
    const lifecycle = classifyRecordLifecycle(event, { now });
    if (['cancelled', 'entered_in_error'].includes(lifecycle.result_status) || event.execution_status !== 'administered') continue;
    administrations.push({ id: event.id, order_id: item.id, version_id: event.version_id ?? null,
      performed_at: event.performed_at, execution_status: 'administered',
      // Quantities must be actual measured values; planned dosage is never copied here.
      administered_volume_ml: typeof event.administered_volume_ml === 'number' && Number.isFinite(event.administered_volume_ml)
        && event.administered_volume_ml >= 0 ? event.administered_volume_ml : null,
      _source: event._source ?? item._source ?? null });
  }
  const offset = typeof timezoneOffset === 'string' && /^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(timezoneOffset)
    && !/^[+-]14:(?!00)/.test(timezoneOffset) ? (timezoneOffset[0] === '-' ? -1 : 1)
      * (Number(timezoneOffset.slice(1,3))*60 + Number(timezoneOffset.slice(4))) : null;
  const days = offset == null ? null : [...new Set(administrations.map(e => new Date(Date.parse(e.performed_at) + offset*60000).toISOString().slice(0,10)))].sort();
  return { order_kind: orderKind, execution_status: item.execution_status == null ? null : state,
    execution_status_basis: item.execution_status == null ? 'not_provided' : state === 'unknown' ? 'unmapped_or_conflicted' : 'source_explicit',
    // An order-review clock can continue for legacy feeds, but is never a treatment-duration clock.
    eligible_for_order_age_review: item.execution_status == null || ['nurse_verified', 'pharmacy_reviewed', 'dispensed', 'administered'].includes(state),
    administrations, observed_administration_days: days?.length ?? null, administration_dates: days,
    administration_coverage: 'unknown', treatment_duration_days: null, gaps: [...new Set(gaps)] };
}
