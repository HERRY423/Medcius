import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";

const ALLOWED_KINDS = new Set(["patient", "encounter", "notes", "nis", "lis", "pacs", "his", "financial_access"]);
const WRITE_CAPABILITY_NAMES = new Set(["write", "create", "update", "delete", "patch", "execute", "order", "create_resource", "update_resource", "delete_resource", "write_back"]);
const WRITE_METHOD_PREFIX_RE = /^(?:write|create|update|delete|patch|put|post|remove|execute|order|create_resource|update_resource|delete_resource|write_back)/i;

function requireContext(context) {
  for (const field of ["tenant_id", "doctor_id", "patient_id", "encounter_id"]) {
    if (typeof context?.[field] !== "string" || !context[field].trim()) {
      throw new Error(`BRIDGE_FAIL_CLOSED_CONTEXT: ${field} is required`);
    }
  }
}

function validateConnector(connector) {
  if (!connector || typeof connector !== "object") throw new Error("BRIDGE_CONNECTOR_OBJECT_REQUIRED");
  if (typeof connector.id !== "string" || !connector.id.trim()) throw new Error("BRIDGE_CONNECTOR_ID_REQUIRED");
  if (!ALLOWED_KINDS.has(connector.kind)) throw new Error(`BRIDGE_UNSUPPORTED_SOURCE_KIND: ${connector.kind}`);
  if (typeof connector.readPatient !== "function") throw new Error(`BRIDGE_READ_METHOD_REQUIRED: ${connector.id}`);
  const capabilities = Array.isArray(connector.capabilities) ? connector.capabilities.map((value) => String(value).toLowerCase()) : [];
  if (!capabilities.includes("read") || capabilities.some((value) => WRITE_CAPABILITY_NAMES.has(value))) {
    throw new Error(`BRIDGE_READ_ONLY_CAPABILITY_REQUIRED: ${connector.id}`);
  }
  const inspected = new Set();
  for (let candidate = connector; candidate && candidate !== Object.prototype; candidate = Object.getPrototypeOf(candidate)) {
    for (const property of Reflect.ownKeys(candidate)) {
      if (typeof property !== "string" || inspected.has(property)) continue;
      inspected.add(property);
      if (property !== "readPatient" && WRITE_METHOD_PREFIX_RE.test(property) && typeof connector[property] === "function") {
        throw new Error(`BRIDGE_WRITE_METHOD_REJECTED: ${connector.id}.${property}`);
      }
    }
  }
}

function validateEnvelope(envelope, connector, context) {
  if (!envelope || typeof envelope !== "object") throw new Error(`BRIDGE_INVALID_ENVELOPE: ${connector.id}`);
  if (envelope.tenant_id !== context.tenant_id) throw new Error(`BRIDGE_TENANT_MISMATCH: ${connector.id}`);
  if (envelope.patient_id !== context.patient_id) throw new Error(`BRIDGE_PATIENT_MISMATCH: ${connector.id}`);
  if (envelope.encounter_id !== context.encounter_id) throw new Error(`BRIDGE_ENCOUNTER_MISMATCH: ${connector.id}`);
  if (!Array.isArray(envelope.records)) throw new Error(`BRIDGE_RECORDS_ARRAY_REQUIRED: ${connector.id}`);
  if (!envelope.fetched_at || Number.isNaN(new Date(envelope.fetched_at).getTime())) throw new Error(`BRIDGE_FETCHED_AT_REQUIRED: ${connector.id}`);
  if (envelope.source_system && envelope.source_system !== connector.id) throw new Error(`BRIDGE_SOURCE_SYSTEM_MISMATCH: ${connector.id}`);
}

function withProvenance(record, connector, envelope) {
  const sourceRecordId = record?.id || record?.resource_id || null;
  return {
    ...record,
    _source: {
      system: connector.id,
      kind: connector.kind,
      record_id: sourceRecordId,
      fetched_at: envelope.fetched_at,
      source_version: envelope.source_version || null,
      read_only: true,
    },
  };
}

export class ReadOnlyHospitalDataBridge {
  constructor({ connectors = [], requiredKinds = ["patient", "encounter"] } = {}) {
    if (!Array.isArray(connectors) || connectors.length === 0) throw new Error("BRIDGE_CONNECTORS_REQUIRED");
    connectors.forEach(validateConnector);
    const ids = connectors.map((connector) => connector.id);
    if (new Set(ids).size !== ids.length) throw new Error("BRIDGE_CONNECTOR_IDS_MUST_BE_UNIQUE");
    this.connectors = [...connectors];
    this.requiredKinds = new Set(requiredKinds);
  }

  async readPatientSnapshot(context) {
    requireContext(context);
    const feeds = {
      patient: null,
      encounter: null,
      notes: [],
      nis: [],
      lis: [],
      pacs: [],
      his_orders: [],
      allergies: null,
      financial_access: [],
    };
    const sourceManifest = [];
    const unavailable = [];

    for (const connector of this.connectors) {
      let envelope;
      try {
        envelope = await connector.readPatient({
          tenant_id: context.tenant_id,
          doctor_id: context.doctor_id,
          patient_id: context.patient_id,
          encounter_id: context.encounter_id,
        });
        validateEnvelope(envelope, connector, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        unavailable.push({ connector_id: connector.id, kind: connector.kind, error: message });
        if (this.requiredKinds.has(connector.kind)) {
          throw new Error(`BRIDGE_REQUIRED_SOURCE_UNAVAILABLE: ${connector.kind}/${connector.id}: ${message}`);
        }
        continue;
      }

      const records = envelope.records.map((record) => withProvenance(record, connector, envelope));
      for (const record of records) {
        if (record.patient_id && record.patient_id !== context.patient_id) throw new Error(`BRIDGE_RECORD_PATIENT_MISMATCH: ${connector.id}`);
        if (record.encounter_id && record.encounter_id !== context.encounter_id) throw new Error(`BRIDGE_RECORD_ENCOUNTER_MISMATCH: ${connector.id}`);
      }

      if (connector.kind === "patient") {
        if (records.length !== 1 || records[0].id !== context.patient_id) throw new Error(`BRIDGE_PATIENT_CARDINALITY_OR_ID_MISMATCH: ${connector.id}`);
        feeds.patient = records[0];
      } else if (connector.kind === "encounter") {
        if (records.length !== 1 || records[0].id !== context.encounter_id) throw new Error(`BRIDGE_ENCOUNTER_CARDINALITY_OR_ID_MISMATCH: ${connector.id}`);
        feeds.encounter = records[0];
      } else if (connector.kind === "his") {
        feeds.his_orders.push(...records);
      } else {
        feeds[connector.kind].push(...records);
      }

      sourceManifest.push({
        connector_id: connector.id,
        kind: connector.kind,
        fetched_at: envelope.fetched_at,
        source_version: envelope.source_version || null,
        record_count: records.length,
        payload_sha256: sha256Hex(canonicalJson(envelope.records)),
        read_only: true,
      });
    }

    for (const kind of this.requiredKinds) {
      if (!sourceManifest.some((entry) => entry.kind === kind)) throw new Error(`BRIDGE_REQUIRED_KIND_MISSING: ${kind}`);
    }

    return {
      schema_version: "medcius.read-only-source-envelope.v1",
      context: {
        tenant_id: context.tenant_id,
        doctor_id: context.doctor_id,
        patient_id: context.patient_id,
        encounter_id: context.encounter_id,
      },
      dataFeeds: feeds,
      source_manifest: sourceManifest,
      unavailable_sources: unavailable,
      completeness: unavailable.length === 0 ? "complete_for_configured_connectors" : "partial_with_explicit_unavailable_sources",
      security_contract: {
        read_only_enforced: true,
        model_safe: false,
        note: "Raw hospital data remain inside the bounded workflow until PHI Guard and output policy checks complete.",
      },
    };
  }
}
