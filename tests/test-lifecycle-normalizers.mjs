import test from "node:test";
import assert from "node:assert/strict";
import { HospitalDataAdapter } from "../plugins/medcius/lib/hospital-data-adapter.mjs";
import { classifyRecordLifecycle } from "../plugins/medcius/lib/record-lifecycle.mjs";

const now = "2026-10-04T12:00:00Z";
const cutoffTime = "2026-10-03T12:00:00Z";
const oldTime = "2026-09-29T08:00:00Z";
const inWindow = "2026-10-04T08:00:00Z";
const rulePack = { clinical_rules: { restricted_antibiotics: [{ name: "Synthetic antibiotic", class: "synthetic", level: "synthetic", review_after_days: 3 }] } };

test("PACS preserves order and study clocks; a recent order does not make an old study current", () => {
  const data = HospitalDataAdapter.normalizePacsFeed([{ id: "report-1", status: "final", ordered_at: inWindow,
    study_time: oldTime, recorded_at: inWindow, resulted_at: inWindow, impression: "Synthetic old finding" }], { now, cutoffTime });
  assert.equal(data.diagnostic_reports[0].ordered_at, inWindow);
  assert.equal(data.diagnostic_reports[0].study_time, oldTime);
  assert.equal(data.diagnostic_reports[0].event_time, oldTime);
  assert.equal(data.imaging_impressions.length, 0);
  assert.equal(classifyRecordLifecycle(data.diagnostic_reports[0], { sourceType: "diagnostic_report", now, cutoffTime }).arrival_status, "late_record");
});

test("PACS study can be current without known order time; order alone cannot replace study time", () => {
  const current = HospitalDataAdapter.normalizePacsFeed([{ id: "report-study", status: "final", study_time: inWindow, impression: "Synthetic finding" }], { now, cutoffTime });
  assert.equal(current.diagnostic_reports[0].ordered_at, null);
  assert.equal(current.imaging_impressions.length, 1);
  assert.equal(current.imaging_impressions[0].study_time, inWindow);
  const orderOnly = HospitalDataAdapter.normalizePacsFeed([{ id: "report-order", status: "final", ordered_at: inWindow, impression: "Synthetic finding" }], { now, cutoffTime });
  assert.equal(orderOnly.imaging_impressions.length, 0);
  assert.equal(orderOnly.time_gaps[0].gap_type, "IMAGING_TIME_UNKNOWN");
});

test("PACS revised, cancelled and erroneous versions cannot leave superseded impressions current", () => {
  const base = { id: "report-version", status: "final", study_time: inWindow, resulted_at: inWindow,
    updated_at: "2026-10-04T08:30:00Z", impression: "Original finding" };
  for (const status of ["cancelled", "entered-in-error"]) {
    const data = HospitalDataAdapter.normalizePacsFeed([base, { ...base, status, updated_at: "2026-10-04T09:00:00Z" }], { now, cutoffTime });
    assert.equal(data.history_records.length, 2);
    assert.equal(data.imaging_impressions.length, 0);
  }
  const revised = HospitalDataAdapter.normalizePacsFeed([base, { ...base, status: "corrected", updated_at: "2026-10-04T09:00:00Z", impression: "Revised finding" }], { now, cutoffTime });
  assert.equal(revised.imaging_impressions.length, 1, "missing explicit version IDs must not make both representations current");
  assert.equal(revised.imaging_impressions[0].impression_summary, "Revised finding");
  const unknown = HospitalDataAdapter.normalizePacsFeed([{ ...base, status: null }], { now, cutoffTime });
  assert.equal(unknown.imaging_impressions.length, 0);
});

const medication = { id: "medication-order-1", drug_name: "Synthetic antibiotic", dosage: "1 synthetic unit", is_medication: true,
  authored_on: oldTime, status: "active", version_id: "v1", updated_at: "2026-10-01T08:00:00Z" };
test("HIS resolves every original version before duration reminders and keeps cancellation history", () => {
  for (const status of ["cancelled", "entered-in-error", "stopped", "completed", "on-hold"]) {
    const revised = { ...medication, status, version_id: "v2", updated_at: inWindow, changed_at: inWindow };
    const data = HospitalDataAdapter.normalizeHisOrders([medication, revised], { now, rulePack });
    assert.equal(data.medications.length, 2);
    assert.equal(data.history_records.length, 2);
    assert.equal(data.current_medications.length, 0, `${status} must not be represented as active medication`);
    assert.equal(data.antibiotic_alerts.length, 0);
    assert.ok(data.medications.every(record => record.antibiotic_info === null));
  }
});

test("HIS unknown, conflicting or ended orders never become ongoing use or duration reminders", () => {
  const cases = [
    [{ ...medication, status: null, change_type: "active" }],
    [{ ...medication, version_id: "same" }, { ...medication, version_id: "same", status: "cancelled", updated_at: inWindow }],
    [{ ...medication, version_id: "same" }, { ...medication, version_id: "same", dosage: "2 synthetic units", updated_at: inWindow }],
    [{ ...medication, end_date: inWindow }],
    [{ ...medication, stopped_at: inWindow }],
    [{ ...medication, end_date: "invalid" }],
  ];
  for (const rows of cases) {
    const data = HospitalDataAdapter.normalizeHisOrders(rows, { now, rulePack });
    assert.equal(data.medications.length, rows.length);
    assert.equal(data.current_medications.length, 0);
    assert.equal(data.antibiotic_alerts.length, 0);
  }
});

test("HIS current active order has one bounded elapsed-order reminder, without claiming actual administration", () => {
  const revised = { ...medication, version_id: "v2", updated_at: inWindow };
  const data = HospitalDataAdapter.normalizeHisOrders([medication, revised], { now, rulePack });
  assert.equal(data.medications.length, 2);
  assert.equal(data.current_medications.length, 1);
  assert.equal(data.antibiotic_alerts.length, 1);
  assert.equal(data.medications[0].antibiotic_info, null);
  assert.equal(data.antibiotic_alerts[0].duration_basis, "elapsed_since_order_authored_not_administration");
  assert.match(data.antibiotic_alerts[0].alert_message, /实际给药天数未确认/);
  assert.doesNotMatch(data.antibiotic_alerts[0].alert_message, /已使用/);
  const orders = HospitalDataAdapter.normalizeHisOrders([{ id: "exam-1", title: "Synthetic exam", status: "active", authored_on: oldTime },
    { id: "exam-1", title: "Synthetic exam", status: "cancelled", authored_on: oldTime, updated_at: inWindow }], { now, rulePack });
  assert.equal(orders.orders.length, 2);
  assert.equal(orders.current_orders.length, 1);
  assert.equal(orders.current_orders[0].status, "cancelled");
});
