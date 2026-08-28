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

function assertReadOnlyMethod(method) {
  if (String(method).toUpperCase() !== "GET") {
    throw new Error(`CONNECTOR_HTTP_METHOD_FORBIDDEN: only GET is permitted, got ${method}`);
  }
}

async function fetchFhirJson({ baseUrl, path, query = {}, fetchImpl, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  assertReadOnlyMethod("GET");
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(path.replace(/^\//, ""), base);
  for (const [key, value] of Object.entries(query)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/fhir+json", ...headers },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`CONNECTOR_FHIR_HTTP_ERROR: GET ${url.pathname} responded ${response.status}`);
  }
  return response.json();
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
 */
export function createFhirR4Connectors({
  baseUrl,
  fetchImpl = globalThis.fetch,
  headers = {},
  sourceVersion = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!baseUrl || typeof baseUrl !== "string") throw new Error("CONNECTOR_BASE_URL_REQUIRED");
  if (typeof fetchImpl !== "function") throw new Error("CONNECTOR_FETCH_IMPL_REQUIRED");
  const settings = { baseUrl, fetchImpl, headers, timeoutMs };

  return [
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
        const payload = await fetchFhirJson({
          ...settings,
          path: "Observation",
          query: { patient: context.patient_id, encounter: context.encounter_id, category: "laboratory", _count: 200 },
        });
        const records = resourcesOf(payload)
          .filter((resource) => resource.resourceType === "Observation")
          .map((resource) => mapObservation(resource, context));
        return buildEnvelope("fhir-r4-lis", "lis", context, records, sourceVersion);
      },
    },
    {
      id: "fhir-r4-his",
      kind: "his",
      capabilities: ["read"],
      async readPatient(context) {
        const payload = await fetchFhirJson({
          ...settings,
          path: "MedicationRequest",
          query: { patient: context.patient_id, encounter: context.encounter_id, _count: 200 },
        });
        const records = resourcesOf(payload)
          .filter((resource) => resource.resourceType === "MedicationRequest")
          .map((resource) => mapMedicationRequest(resource, context));
        return buildEnvelope("fhir-r4-his", "his", context, records, sourceVersion);
      },
    },
  ];
}

