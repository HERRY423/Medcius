// P3 View-library / intermediate-table read-only connector.
// Chinese inpatient HIS estates typically expose NIS + LIS + orders as
// information-department read-only views, not FHIR. This connector never
// issues INSERT/UPDATE/DELETE and never opens a SQL client of its own:
// deployments inject queryView() or a GET-only fetchImpl.

const DEFAULT_TIMEOUT_MS = 10000;
const TRANSIENT_STATUSES = new Set([502, 503, 504, 429]);
// Strict allowlist: deployment views must live under the v_medcius_ namespace
// with a safe alphabet. This rejects both mutating names AND smuggled SQL
// (semicolons, comments, UNION/SELECT keywords, whitespace) at construction.
const VIEW_NAME_RE = /^v_medcius_[a-z0-9_]{1,48}$/;
const WRITE_WORD_RE = /\b(?:insert|update|delete|merge|upsert|exec(?:ute)?|write|truncate|drop|alter|create|grant|revoke|union|select)\b/i;
const SQL_METACHAR_RE = /[;\s\-/\\*'"]/;

export const DEFAULT_VIEW_NAMES = Object.freeze({
  patient: "v_medcius_patient",
  encounter: "v_medcius_encounter",
  nis: "v_medcius_nis_vitals",
  lis: "v_medcius_lis_results",
  his: "v_medcius_his_orders",
  pacs: "v_medcius_pacs_reports",
  notes: "v_medcius_notes",
});

// 最小必要字段：未知列在映射前剥离，防止视图多返回的标识符进入管线。
const FIELD_ALLOWLISTS = Object.freeze({
  patient: new Set(["id", "patient_id", "name", "patient_name", "gender", "sex", "age", "birth_date", "birthDate", "bed_number", "bed", "patient_id_tenant", "tenant_id", "encounter_id"]),
  encounter: new Set(["id", "encounter_id", "status", "class", "encounter_class", "period_start", "admit_time", "period_end", "discharge_time", "patient_id", "tenant_id"]),
  nis: new Set(["id", "patient_id", "encounter_id", "tenant_id", "temperature", "temp_c", "systolic_bp", "sbp", "diastolic_bp", "dbp", "heart_rate", "hr", "spo2", "oral_intake_ml", "intake_oral_ml", "iv_intake_ml", "intake_iv_ml", "intake_ml", "urine_output_ml", "urine_ml", "drain_output_ml", "drain_ml", "drain_name", "drain_desc", "stool_count", "timestamp", "recorded_at", "sample_time"]),
  lis: new Set(["id", "result_id", "patient_id", "encounter_id", "tenant_id", "order_id", "test_code", "code", "test_name", "name", "result_value", "value", "unit", "status", "sample_time", "effective_time", "reference_range_text", "ref_text", "ref_low", "reference_low", "ref_high", "reference_high", "interpretation", "is_critical"]),
  his: new Set(["id", "order_id", "patient_id", "encounter_id", "tenant_id", "is_medication", "drug_name", "dosage", "route", "frequency", "authored_on", "order_time", "change_type", "status", "title", "order_title", "order_type", "department", "purpose", "stop_reason", "previous_dosage"]),
  pacs: new Set(["id", "report_id", "patient_id", "encounter_id", "tenant_id", "name", "study_name", "modality", "status", "report_status", "ordered_at", "study_time", "impression", "impression_text", "findings", "code", "study_code", "priority", "urgency", "order_id", "service_request_id", "based_on_id", "scheduled_time", "resulted_at", "issued", "acknowledged_at"]),
  notes: new Set(["id", "document_id", "patient_id", "encounter_id", "tenant_id", "title", "content_type", "text", "body", "narrative"]),
});

function projectFields(kind, row) {
  const allowlist = FIELD_ALLOWLISTS[kind];
  if (!row || typeof row !== "object" || Array.isArray(row)) return {};
  if (!allowlist) return {};
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (allowlist.has(key)) out[key] = value;
  }
  return out;
}

function assertReadOnlyMethod(method) {
  if (String(method).toUpperCase() !== "GET") {
    throw new Error(`CONNECTOR_HTTP_METHOD_FORBIDDEN: only GET is permitted, got ${method}`);
  }
}

function assertViewName(viewName) {
  if (typeof viewName !== "string" || !viewName.trim()) {
    throw new Error("CONNECTOR_VIEW_NAME_REQUIRED");
  }
  const trimmed = viewName.trim();
  if (!VIEW_NAME_RE.test(trimmed) || WRITE_WORD_RE.test(trimmed) || SQL_METACHAR_RE.test(trimmed)) {
    throw new Error(`CONNECTOR_VIEW_NAME_WRITE_REJECTED: '${trimmed}' is not an allowlisted read-only view (expected v_medcius_<name>)`);
  }
  return trimmed;
}

export function assertHttpsViewBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("CONNECTOR_VIEW_BASE_URL_INVALID");
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
  if (parsed.protocol === "http:" && !isLoopback) {
    throw new Error(`CONNECTOR_HTTP_PLAINTEXT_REJECTED: refusing plaintext http for '${host}'; use https or a loopback sandbox`);
  }
  return true;
}

function stamp(context, record) {
  if (!record.patient_id) record.patient_id = context.patient_id;
  if (!record.encounter_id) record.encounter_id = context.encounter_id;
  return record;
}

function buildEnvelope(connectorId, context, records, sourceVersion) {
  return {
    source_system: connectorId,
    tenant_id: context.tenant_id,
    patient_id: context.patient_id,
    encounter_id: context.encounter_id,
    fetched_at: new Date().toISOString(),
    source_version: sourceVersion,
    records,
  };
}

function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.records)) return payload.records;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

async function fetchViewJson({ baseUrl, viewName, query = {}, fetchImpl, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  assertReadOnlyMethod("GET");
  assertHttpsViewBaseUrl(baseUrl);
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(`views/${encodeURIComponent(viewName)}`, base);
  for (const [key, value] of Object.entries(query)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { accept: "application/json", ...headers },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === "AbortError") {
        throw new Error(`CONNECTOR_VIEW_LIBRARY_TIMEOUT: GET ${url.pathname} exceeded ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) return response.json();
    if (TRANSIENT_STATUSES.has(response.status) && attempt === 0) {
      lastError = new Error(`CONNECTOR_VIEW_LIBRARY_HTTP_ERROR: GET ${url.pathname} responded ${response.status}`);
      continue;
    }
    throw new Error(`CONNECTOR_VIEW_LIBRARY_HTTP_ERROR: GET ${url.pathname} responded ${response.status}`);
  }
  throw lastError;
}

function makeQueryView({ queryView, baseUrl, fetchImpl, headers, timeoutMs }) {
  if (typeof queryView === "function") {
    return async (viewName, params) => queryView(assertViewName(viewName), params);
  }
  if (baseUrl && typeof fetchImpl === "function") {
    return async (viewName, params) => {
      const payload = await fetchViewJson({
        baseUrl,
        viewName,
        query: params,
        fetchImpl,
        headers,
        timeoutMs,
      });
      return rowsOf(payload);
    };
  }
  throw new Error("CONNECTOR_VIEW_LIBRARY_QUERY_REQUIRED: inject queryView or GET-only fetchImpl + baseUrl");
}

function mapPatient(row, context) {
  return stamp(context, {
    id: row.id || row.patient_id || context.patient_id,
    name: row.name || row.patient_name || null,
    gender: row.gender || row.sex || null,
    age: row.age != null ? Number(row.age) : null,
    birth_date: row.birth_date || row.birthDate || null,
    bed_number: row.bed_number || row.bed || null,
  });
}

function mapEncounter(row, context) {
  return stamp(context, {
    id: row.id || row.encounter_id || context.encounter_id,
    status: row.status || "in-progress",
    class: row.class || row.encounter_class || "inpatient",
    period_start: row.period_start || row.admit_time || null,
    period_end: row.period_end || row.discharge_time || null,
  });
}

function mapNis(row, context) {
  return stamp(context, {
    id: row.id || null,
    temperature: row.temperature ?? row.temp_c ?? null,
    systolic_bp: row.systolic_bp ?? row.sbp ?? null,
    diastolic_bp: row.diastolic_bp ?? row.dbp ?? null,
    heart_rate: row.heart_rate ?? row.hr ?? null,
    spo2: row.spo2 ?? null,
    oral_intake_ml: row.oral_intake_ml ?? row.intake_oral_ml ?? null,
    iv_intake_ml: row.iv_intake_ml ?? row.intake_iv_ml ?? null,
    urine_output_ml: row.urine_output_ml ?? row.urine_ml ?? null,
    drain_output_ml: row.drain_output_ml ?? row.drain_ml ?? null,
    timestamp: row.timestamp || row.recorded_at || row.sample_time || null,
  });
}

function mapLis(row, context) {
  const low = row.ref_low ?? row.reference_low ?? null;
  const high = row.ref_high ?? row.reference_high ?? null;
  return stamp(context, {
    id: row.id || row.result_id || null,
    order_id: row.order_id || null,
    code: row.test_code || row.code || null,
    test_code: row.test_code || row.code || null,
    name: row.test_name || row.name || null,
    test_name: row.test_name || row.name || null,
    result_value: row.result_value ?? row.value ?? null,
    unit: row.unit || null,
    status: row.status || "final",
    sample_time: row.sample_time || row.effective_time || null,
    reference_range_text: row.reference_range_text || row.ref_text || null,
    referenceRange: (low != null || high != null)
      ? [{ low: low != null ? { value: Number(low), unit: row.unit } : undefined, high: high != null ? { value: Number(high), unit: row.unit } : undefined }]
      : null,
    is_critical: row.is_critical === true || String(row.interpretation || "").toUpperCase() === "LL" || String(row.interpretation || "").toUpperCase() === "HH",
  });
}

function mapHis(row, context) {
  const isMedication = row.is_medication === true || Boolean(row.drug_name);
  return stamp(context, {
    id: row.id || row.order_id || null,
    is_medication: isMedication,
    drug_name: row.drug_name || null,
    dosage: row.dosage || null,
    route: row.route || null,
    frequency: row.frequency || null,
    authored_on: row.authored_on || row.order_time || null,
    change_type: row.change_type || row.status || null,
    title: row.title || row.order_title || row.drug_name || null,
    status: row.status || "active",
    order_type: row.order_type || (isMedication ? "medication" : "order"),
  });
}

function createKindConnector({ id, kind, viewName, mapRow, query, sourceVersion }) {
  const safeName = assertViewName(viewName);
  return {
    id,
    kind,
    capabilities: ["read"],
    view_name: safeName,
    async readPatient(context) {
      const rows = await query(safeName, {
        tenant_id: context.tenant_id,
        patient_id: context.patient_id,
        encounter_id: context.encounter_id,
      });
      if (!Array.isArray(rows)) {
        throw new Error(`CONNECTOR_VIEW_LIBRARY_ROWS_REQUIRED: ${safeName}`);
      }
      const records = rows.map((row) => mapRow(projectFields(kind, row), context));
      return buildEnvelope(id, context, records, sourceVersion);
    },
  };
}

function mapPacs(row, context) {
  const status = row.status || (row.report_status === "final" ? "final" : "preliminary");
  return stamp(context, {
    id: row.id || row.report_id || null,
    name: row.name || row.study_name || "影像检查",
    modality: row.modality || "影像检查",
    status,
    ordered_at: row.ordered_at || row.study_time || null,
    impression: row.impression || row.impression_text || row.findings || "",
    code: row.code || row.study_code || null,
    priority: row.priority || row.urgency || null,
    order_id: row.order_id || row.service_request_id || row.based_on_id || null,
    scheduled_time: row.scheduled_time || null,
    resulted_at: row.resulted_at || row.issued || null,
    acknowledged_at: row.acknowledged_at || null,
  });
}

function mapNotes(row, context) {
  const text = row.text || row.body || row.narrative || "";
  return stamp(context, {
    id: row.id || row.document_id || null,
    document_id: row.document_id || row.id || null,
    title: row.title || String(text).split("\n")[0] || "病程记录",
    content_type: row.content_type || "text/plain",
    text,
    source_format: "view-library",
  });
}

const EXTRA_VIEW_BUILDERS = {
  pacs: (names, query, sourceVersion) => createKindConnector({
    id: "view-library-pacs", kind: "pacs", viewName: names.pacs, mapRow: mapPacs, query, sourceVersion,
  }),
  notes: (names, query, sourceVersion) => createKindConnector({
    id: "view-library-notes", kind: "notes", viewName: names.notes, mapRow: mapNotes, query, sourceVersion,
  }),
};

/**
 * Create NIS + LIS + HIS (+ patient/encounter) view-library connectors.
 * PACS/notes stay opt-in via `extraViews` so the P0 five-connector surface
 * is unchanged unless a site activation explicitly requires them.
 */
export function createViewLibraryConnectors({
  queryView,
  baseUrl,
  fetchImpl = globalThis.fetch,
  headers = {},
  sourceVersion = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  viewNames = {},
  extraViews = [],
} = {}) {
  const names = { ...DEFAULT_VIEW_NAMES, ...viewNames };
  // Validate every configured name up front, including unused extras.
  for (const name of Object.values(names)) assertViewName(name);
  if (baseUrl) assertHttpsViewBaseUrl(baseUrl);
  const query = makeQueryView({ queryView, baseUrl, fetchImpl, headers, timeoutMs });

  const connectors = [
    createKindConnector({
      id: "view-library-patient",
      kind: "patient",
      viewName: names.patient,
      mapRow: mapPatient,
      query,
      sourceVersion,
    }),
    createKindConnector({
      id: "view-library-encounter",
      kind: "encounter",
      viewName: names.encounter,
      mapRow: mapEncounter,
      query,
      sourceVersion,
    }),
    createKindConnector({
      id: "view-library-nis",
      kind: "nis",
      viewName: names.nis,
      mapRow: mapNis,
      query,
      sourceVersion,
    }),
    createKindConnector({
      id: "view-library-lis",
      kind: "lis",
      viewName: names.lis,
      mapRow: mapLis,
      query,
      sourceVersion,
    }),
    createKindConnector({
      id: "view-library-his",
      kind: "his",
      viewName: names.his,
      mapRow: mapHis,
      query,
      sourceVersion,
    }),
  ];

  for (const kind of extraViews) {
    const builder = EXTRA_VIEW_BUILDERS[kind];
    if (!builder) throw new Error(`CONNECTOR_VIEW_EXTRA_UNKNOWN: '${kind}' (expected pacs | notes)`);
    if (connectors.some((entry) => entry.kind === kind)) {
      throw new Error(`CONNECTOR_VIEW_EXTRA_DUPLICATE: '${kind}'`);
    }
    connectors.push(builder(names, query, sourceVersion));
  }
  return connectors;
}
