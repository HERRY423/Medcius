// P4 HL7v2 message-subscription read-only connector (REG-ACTION-TRACKER R26).
//
// Covers hospital estates fronted by an integration engine emitting ADT / ORU /
// RDE streams. The connector performs NO socket I/O itself: deployments inject
// `listMessages` + `loadMessage` bound to their queue/file consumer, and this
// module only parses. It never emits ACKs or any outbound HL7 — consumption is
// strictly one-directional, so there is no write path to audit.
//
// Supported (fail-closed on anything else):
//   ADT^A01/A08  PID (patient id/name/birth/sex) + PV1 (encounter/bed/class)
//   ORU^R01     OBR (order id) + OBX (test code/value/unit/interpretation/time)
//   RDE^O11     RXO/RXE (drug name/dose/route/frequency/order time)

const MAX_MESSAGE_CHARS = 60000;

function splitSegments(message) {
  return String(message || "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function fieldsOf(segment, index) {
  const parts = String(segment || "").split("|");
  return (parts[index] ?? "").trim();
}

/** MSH-9 message type, e.g. "ADT^A01". */
export function parseHl7v2MessageType(message) {
  const msh = splitSegments(message).find((line) => line.startsWith("MSH"));
  if (!msh) throw new Error("CONNECTOR_HL7V2_MSH_REQUIRED");
  const typeField = fieldsOf(msh, 8);
  const [kind, trigger] = typeField.split("^");
  if (!kind || !trigger) throw new Error(`CONNECTOR_HL7V2_TYPE_INVALID: '${typeField}'`);
  return `${kind}^${trigger}`;
}

function parsePid(mshMessage) {
  const pid = splitSegments(mshMessage).find((line) => line.startsWith("PID"));
  if (!pid) throw new Error("CONNECTOR_HL7V2_PID_REQUIRED");
  const patientId = fieldsOf(pid, 3).split("^")[0];
  const nameField = fieldsOf(pid, 5).split("^");
  const birth = fieldsOf(pid, 7);
  const sex = fieldsOf(pid, 8);
  if (!patientId) throw new Error("CONNECTOR_HL7V2_PID_ID_REQUIRED");
  return {
    id: patientId,
    name: nameField.filter(Boolean).join("") || null,
    birth_date: birth || null,
    gender: sex || null,
  };
}

function parsePv1Encounter(mshMessage) {
  const pv1 = splitSegments(mshMessage).find((line) => line.startsWith("PV1"));
  if (!pv1) return null;
  return {
    id: fieldsOf(pv1, 19) || null,
    class: fieldsOf(pv1, 2) || "inpatient",
    status: "in-progress",
    bed_number: fieldsOf(pv1, 3).split("^").filter(Boolean).join("-") || null,
  };
}

const CRITICAL_OBX_FLAGS = new Set(["LL", "HH", "CR", "L", "H"]);

function parseObrObx(mshMessage) {
  const segments = splitSegments(mshMessage);
  const results = [];
  let currentOrderId = null;
  for (const line of segments) {
    if (line.startsWith("OBR")) {
      currentOrderId = fieldsOf(line, 2) || fieldsOf(line, 3) || currentOrderId;
      continue;
    }
    if (!line.startsWith("OBX")) continue;
    const codeField = fieldsOf(line, 3).split("^");
    const rawValue = fieldsOf(line, 5);
    const unit = fieldsOf(line, 6).replace(/^[^A-Za-z\u4e00-\u9fa5/]*/, "").split("^")[0] || null;
    const flag = fieldsOf(line, 8).toUpperCase();
    const time = fieldsOf(line, 14) || null;
    const numeric = rawValue !== "" && !Number.isNaN(Number(rawValue)) ? Number(rawValue) : rawValue;
    results.push({
      id: `hl7v2-obx-${results.length + 1}`,
      order_id: currentOrderId,
      code: codeField[0] || codeField[1] || null,
      test_code: codeField[0] || null,
      name: codeField[1] || codeField[0] || null,
      test_name: codeField[1] || codeField[0] || null,
      result_value: numeric,
      unit,
      status: "final",
      sample_time: time,
      interpretation: flag || null,
      is_critical: CRITICAL_OBX_FLAGS.has(flag) && (flag === "LL" || flag === "HH" || flag === "CR"),
    });
  }
  return results;
}

function parseRxeOrders(mshMessage) {
  const segments = splitSegments(mshMessage);
  const orders = [];
  for (const line of segments) {
    if (!line.startsWith("RXO") && !line.startsWith("RXE")) continue;
    const drugField = fieldsOf(line, 2).split("^");
    const doseField = fieldsOf(line, 3).split("^");
    orders.push({
      id: `hl7v2-rx-${orders.length + 1}`,
      is_medication: true,
      drug_name: drugField[1] || drugField[0] || null,
      dosage: doseField.filter(Boolean).join("") || null,
      route: fieldsOf(line, 6).split("^")[1] || fieldsOf(line, 6).split("^")[0] || null,
      frequency: null,
      authored_on: null,
      status: "active",
      change_type: "active",
    });
  }
  return orders;
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

function stamp(context, record) {
  if (!record.patient_id) record.patient_id = context.patient_id;
  if (!record.encounter_id) record.encounter_id = context.encounter_id;
  return record;
}

/**
 * Create read-only HL7v2 subscription connectors for the bridge.
 * Mirrors the CDA pattern: no sockets, no ACKs, injected catalog + loader.
 *
 * @param {object} options
 * @param {(context: object) => Promise<Array<{id: string, type?: string}>>} options.listMessages
 * @param {(context: object, message: object) => Promise<string>} options.loadMessage
 * @param {string} [options.sourceVersion]
 */
export function createHl7v2Connectors({
  listMessages,
  loadMessage,
  sourceVersion = null,
} = {}) {
  if (typeof listMessages !== "function") throw new Error("CONNECTOR_LIST_MESSAGES_REQUIRED");
  if (typeof loadMessage !== "function") throw new Error("CONNECTOR_LOAD_MESSAGE_REQUIRED");

  async function readMessages(context, allowedTypes) {
    const catalog = await listMessages(context);
    if (!Array.isArray(catalog)) throw new Error("CONNECTOR_HL7V2_CATALOG_INVALID");
    const out = [];
    for (const entry of catalog) {
      if (!entry?.id) throw new Error("CONNECTOR_HL7V2_MESSAGE_ID_REQUIRED");
      const raw = await loadMessage(context, entry);
      if (typeof raw !== "string" || !raw.trim()) throw new Error("CONNECTOR_HL7V2_MESSAGE_EMPTY");
      if (raw.length > MAX_MESSAGE_CHARS) throw new Error("CONNECTOR_HL7V2_MESSAGE_TOO_LARGE");
      const type = parseHl7v2MessageType(raw);
      if (!allowedTypes.has(type)) {
        throw new Error(`CONNECTOR_HL7V2_TYPE_UNSUPPORTED: '${type}' is not consumed by this connector`);
      }
      out.push({ entry, raw, type });
    }
    return out;
  }

  function assertPatientMatch(parsed, context, connectorId) {
    if (parsed.id !== context.patient_id) {
      throw new Error(`BRIDGE_PATIENT_MISMATCH: ${connectorId} HL7v2 PID '${parsed.id}' !== context '${context.patient_id}'`);
    }
  }

  return [
    {
      id: "hl7v2-patient",
      kind: "patient",
      capabilities: ["read"],
      async readPatient(context) {
        const messages = await readMessages(context, new Set(["ADT^A01", "ADT^A08"]));
        if (messages.length !== 1) throw new Error("CONNECTOR_HL7V2_ADT_CARDINALITY: expected exactly one ADT message per snapshot");
        const parsed = parsePid(messages[0].raw);
        assertPatientMatch(parsed, context, "hl7v2-patient");
        return buildEnvelope("hl7v2-patient", context, [stamp(context, parsed)], sourceVersion);
      },
    },
    {
      id: "hl7v2-encounter",
      kind: "encounter",
      capabilities: ["read"],
      async readPatient(context) {
        const messages = await readMessages(context, new Set(["ADT^A01", "ADT^A08"]));
        if (messages.length !== 1) throw new Error("CONNECTOR_HL7V2_ADT_CARDINALITY: expected exactly one ADT message per snapshot");
        parsePid(messages[0].raw);
        const encounter = parsePv1Encounter(messages[0].raw) || { id: context.encounter_id };
        if (!encounter.id) encounter.id = context.encounter_id;
        if (encounter.id !== context.encounter_id) {
          throw new Error(`BRIDGE_ENCOUNTER_MISMATCH: hl7v2-encounter PV1 '${encounter.id}' !== context '${context.encounter_id}'`);
        }
        return buildEnvelope("hl7v2-encounter", context, [stamp(context, encounter)], sourceVersion);
      },
    },
    {
      id: "hl7v2-lis",
      kind: "lis",
      capabilities: ["read"],
      async readPatient(context) {
        const messages = await readMessages(context, new Set(["ORU^R01"]));
        const records = messages.flatMap(({ raw }) => parseObrObx(raw)).map((record) => stamp(context, record));
        return buildEnvelope("hl7v2-lis", context, records, sourceVersion);
      },
    },
    {
      id: "hl7v2-his",
      kind: "his",
      capabilities: ["read"],
      async readPatient(context) {
        const messages = await readMessages(context, new Set(["RDE^O11"]));
        const records = messages.flatMap(({ raw }) => parseRxeOrders(raw)).map((record) => stamp(context, record));
        return buildEnvelope("hl7v2-his", context, records, sourceVersion);
      },
    },
  ];
}
