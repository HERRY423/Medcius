// Entirely synthetic inputs; no hospital record, approval, or efficacy evidence.
export const NOW = '2026-11-05T04:00:00Z';
export const T0 = '2026-11-04T06:00:00Z';
export const CONTEXT = { patient_id: 'synthetic-patient', encounter_id: 'synthetic-encounter',
  tenant_id: 'synthetic-hospital', doctor_id: 'synthetic-doctor', timezone: 'Asia/Shanghai' };
export const owned = (id, source_system = 'synthetic-LIS') => ({ id, patient_id: CONTEXT.patient_id,
  encounter_id: CONTEXT.encounter_id, tenant_id: CONTEXT.tenant_id, source_system, status: 'final', version_id: '1' });
export const lab = (id, code, value, unit, timestamp) => ({ ...owned(id), code, value, unit,
  effective_time: timestamp, resulted_at: timestamp, specimen_type: code === 'wbc' ? 'blood' : 'serum' });
export const urine = (id, start, end, value) => ({ ...owned(id, 'synthetic-NIS'), record_kind: 'nursing_measurement',
  timestamp: end, period_start: start, period_end: end, urine_output_ml: value, volume_basis: 'interval_total' });
export const vitals = (id, timestamp, overrides = {}) => ({ ...owned(id, 'synthetic-NIS'), timestamp, news2_scale: 1,
  temperature: 37, respiratory_rate: 16, spo2: 98, supplemental_oxygen: false, systolic_bp: 120,
  heart_rate: 80, consciousness: 'A', ...overrides });
export const sofa = (id, timestamp, renal) => ({ ...owned(id, 'synthetic-NIS'), timestamp,
  sofa: { version: 'SOFA-1996', complete: true, score: renal,
    components: { respiration: 0, coagulation: 0, liver: 0, cardiovascular: 0, cns: 0, renal } } });
export function syntheticTemporalInput() {
  return { patient: { id: CONTEXT.patient_id, age: 60, gender: 'male', pregnant: false }, context: { ...CONTEXT }, now: NOW, timeWindow: '72h',
    medications: [
      { ...owned('diuretic', 'synthetic-HIS'), status: 'completed', drug_name: '呋塞米', authored_on: '2026-11-04T05:45:00Z',
        order_kind: 'temporary', execution_status: 'administered', dosage_instruction: '20mg iv',
        administrations: [{ ...owned('diuretic-admin', 'synthetic-MAR'), order_id: 'diuretic', performed_at: T0,
          execution_status: 'administered', actual_dose: 20, dose_unit: 'mg', route: 'IV' }] },
      { ...owned('antibiotic', 'synthetic-HIS'), status: 'active', drug_name: '美罗培南', authored_on: '2026-11-03T02:00:00Z',
        administrations: [{ ...owned('antibiotic-admin', 'synthetic-MAR'), order_id: 'antibiotic', performed_at: '2026-11-03T03:00:00Z', execution_status: 'administered' }] },
    ],
    observations: [
      lab('k-before', 'k', 3.9, 'mmol/L', '2026-11-04T04:00:00Z'),
      lab('k-after', 'k', 3.3, 'mmol/L', '2026-11-04T22:00:00Z'),
      lab('scr-before', 'scr', 80, 'umol/L', '2026-11-04T04:00:00Z'),
      lab('scr-after', 'scr', 110, 'umol/L', '2026-11-04T22:00:00Z'),
      lab('pct-before', 'pct', 12.4, 'ng/mL', '2026-11-03T01:00:00Z'),
      lab('pct-after', 'pct', 3.1, 'ng/mL', '2026-11-05T02:00:00Z'),
      lab('crp-before', 'crp', 100, 'mg/L', '2026-11-03T01:00:00Z'),
      lab('crp-after', 'crp', 60, 'mg/L', '2026-11-05T02:00:00Z'),
      lab('wbc-before', 'wbc', 14, '10^9/L', '2026-11-03T01:00:00Z'),
      lab('wbc-after', 'wbc', 9, '10^9/L', '2026-11-05T02:00:00Z'),
    ],
    nursingFeed: [
      urine('urine-before', '2026-11-04T00:00:00Z', T0, 300),
      urine('urine-after-a', T0, '2026-11-04T09:00:00Z', 400),
      urine('urine-after-b', '2026-11-04T09:00:00Z', '2026-11-04T12:00:00Z', 450),
      vitals('vital-before', '2026-11-03T01:00:00Z', { temperature: 39.2 }),
      vitals('vital-day1', '2026-11-03T03:30:00Z', { temperature: 39.2 }),
      vitals('vital-day2', '2026-11-04T02:00:00Z', { temperature: 38 }),
      vitals('vital-day3', '2026-11-05T02:00:00Z', { temperature: 37.6 }),
      vitals('vital-later', '2026-11-05T03:00:00Z', { temperature: 37.6, respiratory_rate: 22 }),
      sofa('sofa-before', '2026-11-05T02:00:00Z', 1),
      sofa('sofa-after', '2026-11-05T03:00:00Z', 2),
    ] };
}
