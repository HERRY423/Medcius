// P1 FHIR R4 Read-Only Connector (REG-ACTION-TRACKER R26 PoC).
//
// Implements the ReadOnlyHospitalDataBridge connector contract:
//   capabilities: ["read"] and readPatient(context) -> six-field envelope.
// Only HTTP GET is ever issued — any other verb throws before the request is
// built. Every failure surfaces as a CONNECTOR_* error so the bridge can apply
// its own fail-closed / degrade-by-requiredKinds policy. This module never
// writes, never caches PHI, and never points at a production EHR write API.
// Codex manifests must keep excluding create_resource/update_resource
// (AGENTS.md red line — this connector does not soften that boundary).

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_BUNDLE_PAGES = 3;
const TRANSIENT_STATUSES = new Set([502, 503, 504, 429]);

function assertReadOnlyMethod(method) {
  if (String(method).toUpperCase() !== "GET") {
    throw new Error(`CONNECTOR_HTTP_METHOD_FORBIDDEN: only GET is permitted, got ${method}`);
  }
}

/**
 * Plaintext-PHI guard: production FHIR endpoints must speak TLS.
 * Loopback / *.local sandbox hosts stay allowed for synthetic replay.
 */
export function assertHttpsBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("CONNECTOR_BASE_URL_INVALID");
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
  if (parsed.protocol === "http:" && !isLoopback) {
    throw new Error(`CONNECTOR_HTTP_PLAINTEXT_REJECTED: refusing plaintext http for '${host}'; use https or a loopback sandbox`);
  }
  return true;
}

async function fetchFhirJson({ baseUrl, path, query = {}, fetchImpl, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  assertReadOnlyMethod("GET");
  assertHttpsBaseUrl(baseUrl);
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(path.replace(/^\//, ""), base);
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
        headers: { accept: "application/fhir+json", ...headers },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === "AbortError") {
        throw new Error(`CONNECTOR_FHIR_TIMEOUT: GET ${url.pathname} exceeded ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) return response.json();
    // Transient 5xx/429: one bounded retry, then fail closed. 4xx fails immediately.
    if (TRANSIENT_STATUSES.has(response.status) && attempt === 0) {
      lastError = new Error(`CONNECTOR_FHIR_HTTP_ERROR: GET ${url.pathname} responded ${response.status}`);
      continue;
    }
    throw new Error(`CONNECTOR_FHIR_HTTP_ERROR: GET ${url.pathname} responded ${response.status}`);
  }
  throw lastError;
}

/** Fetch a FHIR search Bundle, following `link.relation=next` up to MAX_BUNDLE_PAGES. */
async function fetchFhirBundlePages(settings, path, query) {
  const pages = [];
  let nextPath = path;
  let nextQuery = query;
  for (let page = 0; page < MAX_BUNDLE_PAGES; page++) {
    const payload = await fetchFhirJson({ ...settings, path: nextPath, query: nextQuery });
    pages.push(payload);
    const nextLink = payload?.resourceType === "Bundle"
      ? (payload.link || []).find((entry) => entry?.relation === "next" && typeof entry?.url === "string")
      : null;
    if (!nextLink) break;
    try {
      const nextUrl = new URL(nextLink.url, settings.baseUrl.endsWith("/") ? settings.baseUrl : `${settings.baseUrl}/`);
      const basePath = new URL(settings.baseUrl.endsWith("/") ? settings.baseUrl : `${settings.baseUrl}/`).pathname;
      nextPath = nextUrl.pathname.startsWith(basePath)
        ? nextUrl.pathname.slice(basePath.length)
        : nextUrl.pathname.replace(/^\//, "");
      nextQuery = Object.fromEntries(nextUrl.searchParams.entries());
    } catch {
      break;
    }
  }
  return pages;
}

/** Normalize a FHIR reply that may be a single resource or a Bundle. */
function resourcesOf(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (payload.resourceType === "Bundle") {
    return (payload.entry || []).map((entry) => entry?.resource).filter(Boolean);
  }
  return [payload];
}

function displayName(fhirName) {
  if (!fhirName) return null;
  if (typeof fhirName.text === "string" && fhirName.text.trim()) return fhirName.text.trim();
  const parts = [...(fhirName.family ? [fhirName.family] : []), ...(fhirName.given || [])];
  return parts.length ? parts.join("") : null;
}

function buildEnvelope(connectorId, kind, context, records, sourceVersion) {
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

function stamp(context, record) {
  // Bridge re-checks these; stamping keeps downstream provenance self-describing.
  if (!record.patient_id) record.patient_id = context.patient_id;
  if (!record.encounter_id) record.encounter_id = context.encounter_id;
  return record;
}

function mapPatient(resource, context) {
  if (!resource || resource.resourceType !== "Patient") {
    throw new Error("CONNECTOR_FHIR_RESOURCE_TYPE_MISMATCH: expected Patient");
  }
  return stamp(context, {
    id: resource.id,
    name: displayName(Array.isArray(resource.name) ? resource.name[0] : resource.name),
    gender: resource.gender || null,
    birth_date: resource.birthDate || null,
  });
}

function mapEncounter(resource, context) {
  if (!resource || resource.resourceType !== "Encounter") {
    throw new Error("CONNECTOR_FHIR_RESOURCE_TYPE_MISMATCH: expected Encounter");
  }
  return stamp(context, {
    id: resource.id,
    status: resource.status || null,
    class: resource.class?.display || resource.class?.code || null,
    period_start: resource.period?.start || null,
    period_end: resource.period?.end || null,
  });
}

const CRITICAL_INTERPRETATION_CODES = new Set(["CR", "HH", "LL", "critical"]);

function mapObservation(resource, context) {
  const quantity = resource.valueQuantity;
  const interpretation = (resource.interpretation || [])
    .flatMap((entry) => entry.coding || [])
    .find((coding) => CRITICAL_INTERPRETATION_CODES.has(String(coding.code || "").toUpperCase()));
  const referenceRange = (resource.referenceRange || [])[0];
  // Preserve numeric bounds: downstream engines judge 高/低 from these.
  // Text-only ranges degrade to 趋势呈现, so both forms travel together.
  const refLow = referenceRange?.low?.value ?? null;
  const refHigh = referenceRange?.high?.value ?? null;
  return stamp(context, {
    id: resource.id,
    order_id: resource.basedOn?.[0]?.reference?.replace(/^.*\//, "") || null,
    code: resource.code?.coding?.[0]?.code || resource.code?.text || null,
    name: resource.code?.text || resource.code?.coding?.[0]?.display || null,
    result_value: quantity?.value ?? resource.valueString ?? resource.valueInteger ?? null,
    unit: quantity?.unit || quantity?.code || null,
    status: resource.status || null,
    sample_time: resource.effectiveDateTime || resource.effectiveInstant || null,
    reference_range_text: referenceRange?.text || null,
    referenceRange: resource.referenceRange || null,
    ref_low: refLow,
    ref_high: refHigh,
    is_critical: Boolean(interpretation),
  });
}

function mapMedicationRequest(resource, context) {
  const instruction = (resource.dosageInstruction || [])[0] || {};
  const dose = (instruction.doseAndRate || [])[0]?.doseQuantity;
  const repeat = instruction.timing?.repeat;
  let frequency = null;
  if (repeat?.frequency && repeat?.periodUnit) frequency = `q${repeat.period}${repeat.periodUnit}/${repeat.frequency}次`;
  return stamp(context, {
    id: resource.id,
    is_medication: true,
    drug_name: resource.medicationCodeableConcept?.text
      || resource.medicationCodeableConcept?.coding?.[0]?.display
      || resource.medicationReference?.display
      || null,
    dosage: dose ? `${dose.value}${dose.unit || ""}` : null,
    route: instruction.route?.coding?.[0]?.display || instruction.route?.coding?.[0]?.code || null,
    frequency,
    authored_on: resource.authoredOn || null,
    change_type: resource.status === "active" ? "active" : resource.status || null,
  });
}

function mapDiagnosticReport(resource, context) {
  return stamp(context, {
    id: resource.id,
    name: resource.code?.text || resource.code?.coding?.[0]?.display || "影像/检查报告",
    modality: resource.category?.[0]?.coding?.[0]?.display || resource.category?.[0]?.text || "影像检查",
    status: resource.status === "final" ? "final" : "preliminary",
    ordered_at: resource.effectiveDateTime || resource.issued || null,
    impression: resource.conclusion || (resource.conclusionCode || []).map((entry) => entry?.text).filter(Boolean).join("；") || "",
    code: resource.code?.coding?.[0]?.code || null,
    order_id: resource.basedOn?.[0]?.reference?.replace(/^.*\//, "") || null,
    resulted_at: resource.issued || null,
  });
}

function mapDocumentReference(resource, context) {
  const attachment = resource.content?.[0]?.attachment || {};
  return stamp(context, {
    id: resource.id,
    document_id: resource.id,
    title: resource.description || resource.type?.text || "病程记录",
    content_type: attachment.contentType || "text/plain",
    text: typeof attachment.data === "string" ? attachment.data : (resource.description || ""),
    source_format: "fhir-documentreference",
  });
}

/** Collect Observation resources across paginated Bundle pages. */
async function collectObservations(settings, context, query) {
  const pages = await fetchFhirBundlePages(settings, "Observation", query);
  return pages.flatMap(resourcesOf)
    .filter((resource) => resource.resourceType === "Observation")
    .map((resource) => mapObservation(resource, context));
}

/** Collect MedicationRequest resources across paginated Bundle pages. */
async function collectMedicationRequests(settings, context, query) {
  const pages = await fetchFhirBundlePages(settings, "MedicationRequest", query);
  return pages.flatMap(resourcesOf)
    .filter((resource) => resource.resourceType === "MedicationRequest")
    .map((resource) => mapMedicationRequest(resource, context));
}

const EXTRA_KIND_BUILDERS = {
  // NIS 体征：复用 Observation vital-signs 类别，走同一参考区间保留逻辑。
  nis: (settings, sourceVersion) => ({
    id: "fhir-r4-nis",
    kind: "nis",
    capabilities: ["read"],
    async readPatient(context) {
      const pages = await fetchFhirBundlePages(settings, "Observation", {
        patient: context.patient_id, encounter: context.encounter_id, category: "vital-signs", _count: 200,
      });
      const records = pages.flatMap(resourcesOf)
        .filter((resource) => resource.resourceType === "Observation")
        .map((resource) => {
          const mapped = mapObservation(resource, context);
          const code = String(resource.code?.coding?.[0]?.code || "");
          const vitalMap = { "8310-5": "temperature", "8480-6": "systolic_bp", "8462-4": "diastolic_bp", "8867-4": "heart_rate", "2708-6": "spo2" };
          return { ...mapped, vital_code: vitalMap[code] || code, timestamp: mapped.sample_time };
        });
      return buildEnvelope("fhir-r4-nis", "nis", context, records, sourceVersion);
    },
  }),
  // PACS 影像：DiagnosticReport 最终/初步状态直通未闭环追踪。
  pacs: (settings, sourceVersion) => ({
    id: "fhir-r4-pacs",
    kind: "pacs",
    capabilities: ["read"],
    async readPatient(context) {
      const pages = await fetchFhirBundlePages(settings, "DiagnosticReport", {
        patient: context.patient_id, encounter: context.encounter_id, _count: 100,
      });
      const records = pages.flatMap(resourcesOf)
        .filter((resource) => resource.resourceType === "DiagnosticReport")
        .map((resource) => mapDiagnosticReport(resource, context));
      return buildEnvelope("fhir-r4-pacs", "pacs", context, records, sourceVersion);
    },
  }),
  // 病程文本：DocumentReference content 解码后供 span 绑定（大文本截断并标记）。
  notes: (settings, sourceVersion) => ({
    id: "fhir-r4-notes",
    kind: "notes",
    capabilities: ["read"],
    async readPatient(context) {
      const pages = await fetchFhirBundlePages(settings, "DocumentReference", {
        patient: context.patient_id, encounter: context.encounter_id, _count: 100,
      });
      const records = pages.flatMap(resourcesOf)
        .filter((resource) => resource.resourceType === "DocumentReference")
        .map((resource) => mapDocumentReference(resource, context));
      return buildEnvelope("fhir-r4-notes", "notes", context, records, sourceVersion);
    },
  }),
};

/**
 * Create the four read-only FHIR R4 connectors consumed by
 * ReadOnlyHospitalDataBridge. `fetchImpl` defaults to global fetch; tests and
 * synthetic replay harnesses inject their own (see fixtures/connectors).
 *
 * @param {object} options
 * @param {string} options.baseUrl - Hospital FHIR R4 endpoint (read-only account).
 * @param {Function} [options.fetchImpl]
 * @param {Object<string,string>} [options.headers] - e.g. SMART/OIDC bearer token injected by deployment.
 * @param {string} [options.sourceVersion]
 * @param {number} [options.timeoutMs]
 * @param {string[]} [options.extraKinds] - opt-in: subset of ['nis','pacs','notes'].
 *   Default [] keeps the P0 four-connector surface unchanged.
 */
export function createFhirR4Connectors({
  baseUrl,
  fetchImpl = globalThis.fetch,
  headers = {},
  sourceVersion = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  extraKinds = [],
} = {}) {
  if (!baseUrl || typeof baseUrl !== "string") throw new Error("CONNECTOR_BASE_URL_REQUIRED");
  if (typeof fetchImpl !== "function") throw new Error("CONNECTOR_FETCH_IMPL_REQUIRED");
  assertHttpsBaseUrl(baseUrl);
  const settings = { baseUrl, fetchImpl, headers, timeoutMs };

  const connectors = [
    {
      id: "fhir-r4-patient",
      kind: "patient",
      capabilities: ["read"],
      async readPatient(context) {
        const payload = await fetchFhirJson({ ...settings, path: `Patient/${encodeURIComponent(context.patient_id)}` });
        return buildEnvelope("fhir-r4-patient", "patient", context, [mapPatient(payload, context)], sourceVersion);
      },
    },
    {
      id: "fhir-r4-encounter",
      kind: "encounter",
      capabilities: ["read"],
      async readPatient(context) {
        const payload = await fetchFhirJson({ ...settings, path: `Encounter/${encodeURIComponent(context.encounter_id)}` });
        return buildEnvelope("fhir-r4-encounter", "encounter", context, [mapEncounter(payload, context)], sourceVersion);
      },
    },
    {
      id: "fhir-r4-lis",
      kind: "lis",
      capabilities: ["read"],
      async readPatient(context) {
        const records = await collectObservations(settings, context, {
          patient: context.patient_id, encounter: context.encounter_id, category: "laboratory", _count: 200,
        });
        return buildEnvelope("fhir-r4-lis", "lis", context, records, sourceVersion);
      },
    },
    {
      id: "fhir-r4-his",
      kind: "his",
      capabilities: ["read"],
      async readPatient(context) {
        const records = await collectMedicationRequests(settings, context, {
          patient: context.patient_id, encounter: context.encounter_id, _count: 200,
        });
        return buildEnvelope("fhir-r4-his", "his", context, records, sourceVersion);
      },
    },
  ];

  for (const kind of extraKinds) {
    const builder = EXTRA_KIND_BUILDERS[kind];
    if (!builder) throw new Error(`CONNECTOR_FHIR_EXTRA_KIND_UNKNOWN: '${kind}' (expected nis | pacs | notes)`);
    if (connectors.some((entry) => entry.kind === kind)) {
      throw new Error(`CONNECTOR_FHIR_EXTRA_KIND_DUPLICATE: '${kind}'`);
    }
    connectors.push(builder(settings, sourceVersion));
  }
  return connectors;
}

