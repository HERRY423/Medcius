import { assessCriticalVisibility } from "./critical-visibility.mjs";
import { createTextAnchor } from "./evidence-anchors.mjs";
// One immutable, PHI-guarded source snapshot for bounded clinical workflow views.
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { deepFreeze as freeze } from "../servers/shared/immutable.mjs";
import { assertExplicitFeedOwnership, referenceTail } from "./clinical-boundary.mjs";
import { scanStructuredValue } from "../servers/phiguard/src/lib.mjs";
import { resolveRecordVersions, lifecycleTime } from "./record-lifecycle.mjs";
import { createPhiEntitySession, assertPhiEntitySession, guardSessionValue } from './phi-entity-session.mjs';
import { guardPatientSourceInput, isProductionGuardedSource } from './patient-source-phi.mjs';
import { assertSyncPhiAllowed, requiresProductionPhi } from './production-phi-policy.mjs';

const hash = (value) => sha256Hex(canonicalJson(value));
const madeHere = new WeakSet();
const snapshotSessions = new WeakMap();
const productionSnapshots = new WeakSet();
const kinds = { notes: "note", observations: "observation", diagnosticReports: "report", medications: "medication", orders: "order", nursing: "nursing" };

function buildSnapshot({ context = {}, patient = {}, encounter = {}, asOf,
  notes = [], observations = [], diagnosticReports = [], medications = [], orders = [], nursing = [], allergies = null, sourceAvailability = [], chinaClinical = null }, session, receipt) {
  for (const key of ["tenant_id", "patient_id", "encounter_id"]) {
    if (typeof context[key] !== "string" || !context[key].trim()) throw new Error(`FAIL_CLOSED: Missing ${key}`);
  }
  if (patient.id !== context.patient_id || encounter.id !== context.encounter_id) throw new Error("FAIL_CLOSED: Patient/encounter snapshot mismatch");
  assertExplicitFeedOwnership(context, [patient, encounter], "context");
  if (lifecycleTime(asOf) == null || typeof asOf !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(asOf)) throw new Error("FAIL_CLOSED: Missing or invalid snapshot as_of");
  if (!Array.isArray(sourceAvailability)) throw new Error("FAIL_CLOSED: Invalid source availability");
  const feeds = { notes, observations, diagnosticReports, medications, orders, nursing };
  const safe = value => guardSessionValue(value, { session, context });
  const snapshot = { schema_version: "medcius.patient-source-snapshot.v1", context: safe(context),
    as_of: new Date(asOf).toISOString(), patient: safe(patient), encounter: safe(encounter),
    source_availability: safe(sourceAvailability), allergies: safe(allergies), china_clinical: safe(chinaClinical), records: {}, excluded: [], phi_guard: receipt };
  for (const [key, rows] of Object.entries(feeds)) {
    if (!Array.isArray(rows)) throw new Error(`FAIL_CLOSED: Invalid ${key} feed`);
    assertExplicitFeedOwnership(context, rows, key);
    const normalized = rows.map((row) => {
      if (!row || typeof row !== "object") throw new Error("FAIL_CLOSED: Invalid source record");
      if (scanStructuredValue(row).total > 0) throw new Error("FAIL_CLOSED_PHI_VIOLATION: Source record requires PHI Guard");
      assertExplicitFeedOwnership(context, [{ patient_id: row.source_patient_id || referenceTail(row.subject?.reference),
        encounter_id: row.source_encounter_id || referenceTail(row.encounter?.reference), tenant_id: row.source_tenant_id }], key);
      const { name, ...rest } = structuredClone(row);
      const nameKey = ({ medications: "drug_name", observations: "test_name", diagnosticReports: "study_name" })[key] || "title";
      return safe({ ...rest, ...(name ? { [nameKey]: rest[nameKey] || name } : {}) });
    });
    const resolved = resolveRecordVersions(normalized, { sourceType: kinds[key], now: asOf });
    snapshot.records[key] = resolved.entries.map((entry) => {
      const { record, lifecycle, selection_status } = entry;
      const recordId = lifecycle.source_id;
      const time = lifecycleTime(lifecycle.event_time ?? lifecycle.change_time ?? record.ordered_at);
      const timeKnown = time != null;
      const invalidTime = [lifecycle.event_time, lifecycle.change_time, lifecycle.source_updated_at, lifecycle.recorded_at, record.ordered_at]
        .some(value => value != null && lifecycleTime(value) == null);
      const future = time > lifecycleTime(asOf);
      const eligible = entry.is_current && recordId != null && timeKnown && !invalidTime && !future;
      const evidence = { source_type: kinds[key], source_id: recordId, source_system: lifecycle.source_system,
        version_id: lifecycle.version_id, content_sha256: hash(record), hash_basis: "guarded_source_record", event_time: lifecycle.event_time,
        source_updated_at: lifecycle.source_updated_at, recorded_at: lifecycle.recorded_at,
        ownership_basis: record.patient_id && record.encounter_id ? "source_record" : "feed_context",
        locator: recordId == null ? null : `${kinds[key]}/${encodeURIComponent(recordId)}` };
      if (key === "notes") {
        evidence.text_anchor = createTextAnchor(record, { start: 0, end: record.text?.length });
        evidence.span = evidence.text_anchor;
      }
      if (!eligible) snapshot.excluded.push({ evidence, reason: !recordId ? "SOURCE_ID_MISSING" : invalidTime ? "SOURCE_TIME_INVALID" : !timeKnown ? "SOURCE_TIME_MISSING" : future ? "future" : selection_status });
      return { record, lifecycle, selection_status, selection_reasons: entry.selection_reasons, eligible, evidence };
    }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  }
  snapshot.excluded.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  snapshot.source_visibility = assessCriticalVisibility({ sources: snapshot.source_availability, asOf: snapshot.as_of });
  snapshot.snapshot_id = hash(snapshot);
  freeze(snapshot);
  madeHere.add(snapshot);
  snapshotSessions.set(snapshot, session);
  return snapshot;
}

/** Compatibility synchronous path: automatic dictionary, explicitly no NER. */
export function createPatientSourceSnapshot(input, { entitySession, phiPolicy = 'dictionary' } = {}) {
  assertSyncPhiAllowed(input?.context);
  if (phiPolicy !== 'dictionary') throw new Error('PHI_ASYNC_DUAL_TRACK_REQUIRED');
  for (const key of ['tenant_id','patient_id','encounter_id']) {
    if (typeof input?.context?.[key] !== 'string' || !input.context[key].trim()) throw new Error(`FAIL_CLOSED: Missing ${key}`);
  }
  if (input.patient?.id !== input.context.patient_id || input.encounter?.id !== input.context.encounter_id) throw new Error('FAIL_CLOSED: Patient/encounter snapshot mismatch');
  const session = entitySession ?? createPhiEntitySession(input);
  assertPhiEntitySession(session, input.context);
  if (entitySession) session.inject(input);
  try { return buildSnapshot(input, session, { assurance: 'session_dictionary_and_heuristics', ner_status: 'NOT_RUN', complete_deidentification: 'NOT_ESTABLISHED' }); }
  catch (error) { if (!entitySession) session.dispose(); throw error; }
}

/** HIS boundary: both tracks finish before any source text is anchored/exported. */
export async function createPatientSourceSnapshotAsync(input, options = {}) {
  const { input: guarded, session, receipt } = await guardPatientSourceInput(input, options);
  try {
    const snapshot = buildSnapshot(guarded, session, receipt);
    if (isProductionGuardedSource(guarded)) productionSnapshots.add(snapshot);
    return snapshot;
  }
  catch (error) { if (!options.entitySession) session.dispose(); throw error; }
}

export function getPatientSnapshotPhiSession(snapshot, context) {
  assertPatientSourceSnapshot(snapshot);
  const session = snapshotSessions.get(snapshot);
  assertPhiEntitySession(session, context);
  return session;
}

export function assertPatientSourceSnapshot(snapshot) {
  if (!madeHere.has(snapshot)) throw new Error("FAIL_CLOSED: Use createPatientSourceSnapshot to bind source context and time");
  if (requiresProductionPhi(snapshot.context) && !productionSnapshots.has(snapshot)) throw new Error('PHI_PRODUCTION_VERIFIED_SNAPSHOT_REQUIRED');
  return snapshot;
}

