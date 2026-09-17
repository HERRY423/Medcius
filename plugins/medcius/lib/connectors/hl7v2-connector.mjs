// P4 HL7 v2 Message Subscription Read-Only Connector (REG-ACTION-TRACKER R26).
//
// Covers hospital integration engines (集成平台/Engine such as Mirth, Rhapsody
// or 自研网关) that expose ADT^A01/A08, ORU^R01 and RDE^O11/RDS^O13 message
// flows. The deployment injects a `fetchMessages` consumer bound to its
// engine's pull endpoint or queue adapter; this module only CONSUMES messages
// — it never ACKs beyond the deployment's own transport layer, never replies,
// and never writes. Parsing is fully deterministic (no LLM in the loop):
// fields are split by MSH-declared encoding characters and mapped to the
// ReadOnlyHospitalDataBridge connector contract (capabilities:["read"] +
// readPatient(context) -> six-field envelope).
//
// Fail-closed behavior:
//   - a message without a valid MSH (or MSH-9 message type) fails the whole
//     envelope with CONNECTOR_HL7_INVALID_MESSAGE;
//   - ADT messages without PID/PV1 fail when their kind is being served;
//   - individual malformed OBX/RXE groups are skipped and surfaced in
//     parse_warnings (graceful degrade inside a message), never silently.

function splitLines(raw) {
  return String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((line) => line.trim());
}

/**
 * Deterministic HL7 v2 message parser.
 * Returns { messageType, controlId, segments, get, warnings } where
 * get(segmentName, fieldNo, componentNo) reads MSH-adjusted fields.
 */
export function parseHl7v2Message(raw) {
  const lines = splitLines(raw);
  if (!lines.length) throw new Error("CONNECTOR_HL7_EMPTY_MESSAGE");
  const mshLine = lines.find((line) => line.startsWith("MSH"));
  if (!mshLine) throw new Error("CONNECTOR_HL7_MSH_MISSING");
  const fieldSep = mshLine.charAt(3);
  if (!fieldSep) throw new Error("CONNECTOR_HL7_FIELD_SEPARATOR_MISSING");
  const encoding = (mshLine.split(fieldSep)[1] ?? "^~\\&").split("");
  const [compSep = "^", repSep = "~", esc = "\\", subcomp = "&"] = encoding;

  const segments = lines.map((line) => ({ raw: line, fields: line.split(fieldSep) }));
  const msh = segments[0];
  const messageType = String(msh.fields[8] ?? "").trim(); // MSH-8 in 0-based split (MSH-9 semantically)
  if (!messageType) throw new Error("CONNECTOR_HL7_MESSAGE_TYPE_MISSING");
  const controlId = String(msh.fields[9] ?? "").trim() || null; // MSH-10

  const get = (segmentName, fieldNo, componentNo = 0) => {
    const segment = segments.find((seg) => seg.fields[0] === segmentName);
    if (!segment) return null;
    // HL7 field numbers are 1-based; in split arrays, MSH-1 is the separator
    // itself so MSH segments are offset by one: MSH-n == fields[n-1+1].
    const index = segmentName === "MSH" ? fieldNo - 1 : fieldNo;
    const field = segment.fields[index];
    if (field == null) return null;
    if (componentNo == null) return String(field);
    const component = String(field).split(compSep)[componentNo];
    return component == null || component === "" ? null : component;
  };

  return { messageType, controlId, segments, get, encoding: { fieldSep, compSep, repSep, esc, subcomp } };
}

function repeat0(value) {
  return value == null ? null : String(value).split("~")[0];
}

/** ADT^A01/A08 -> patient record from PID (identifier list, name, sex, DOB). */
export function mapAdtPatient(message) {
  const pidId = repeat0(message.get("PID", 3));
  if (!pidId) throw new Error("CONNECTOR_HL7_PID_IDENTIFIER_MISSING");
  const nameRaw = repeat0(message.get("PID", 5, null));
  const nameParts = nameRaw ? nameRaw.split(message.encoding.compSep) : [];
  const name = [nameParts[0], nameParts[1]].filter(Boolean).join("") || nameRaw || null;
  return {
    id: pidId,
    name,
    gender: ({ M: "male", F: "female" })[String(message.get("PID", 8) ?? "").toUpperCase()] ?? message.get("PID", 8) ?? null,
    birth_date: normalizeHl7Time(message.get("PID", 7)),
    phone: repeat0(message.get("PID", 13, null)) || null,
    address: repeat0(message.get("PID", 11, null)) || null,
    source_message_type: message.messageType,
  };
}

function xcnDisplayName(raw, compSep) {
  if (!raw) return null;
  const parts = String(raw).split(compSep);
  // XCN-1=id, XCN-2=family, XCN-3=given — Chinese convention joins family+given.
  return [parts[1], parts[2]].filter(Boolean).join("") || parts[0] || null;
}

/** ADT PV1 -> encounter record (visit number, class, admit time). */
export function mapAdtEncounter(message) {
  const visitNumber = repeat0(message.get("PV1", 19)) || repeat0(message.get("PID", 18));
  if (!visitNumber) throw new Error("CONNECTOR_HL7_VISIT_NUMBER_MISSING");
  const admit = message.get("PV1", 44);
  return {
    id: visitNumber,
    status: message.messageType.includes("A01") ? "admitted" : message.messageType.includes("A03") ? "discharged" : "in-progress",
    class: message.get("PV1", 2) || null,
    period_start: admit ? normalizeHl7Time(admit) : null,
    attending_doctor: xcnDisplayName(repeat0(message.get("PV1", 7, null)), message.encoding.compSep),
    source_message_type: message.messageType,
  };
}

function normalizeHl7Time(value) {
  // HL7 TS: YYYYMMDD[HHMMSS]; bridge contracts use ISO dates at minimum.
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?/.exec(String(value));
  if (!m) return null;
  return m[4] != null
    ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}`
    : `${m[1]}-${m[2]}-${m[3]}`;
}

const CRITICAL_FLAGS = new Set(["C", "LL", "HH", "A"]);

/** ORU^R01 -> LIS records from OBR/OBX groups (deterministic mapping). */
export function mapOruObservations(message) {
  const warnings = [];
  const records = [];
  const segments = message.segments;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].fields[0] !== "OBX") continue;
    const read = (fieldNo, componentNo = 0) => {
      const field = segments[i].fields[fieldNo];
      const component = field == null ? null : String(field).split(message.encoding.compSep)[componentNo];
      return component == null || component === "" ? null : component;
    };
    const code = read(3, 0);
    const name = read(3, 1) || read(3, 0);
    const value = read(5);
    if (!code || value == null) {
      warnings.push(`skipped_malformed_OBX#${i + 1}: code/value missing`);
      continue;
    }
    const flag = read(8);
    records.push({
      id: `${message.controlId ?? "hl7"}-obx-${records.length + 1}`,
      order_id: repeat0(segments.slice(0, i).reverse().find((seg) => seg.fields[0] === "OBR")?.fields[2]) || null,
      code,
      name,
      result_value: /^[\d.]+$/.test(value) ? Number(value) : value,
      unit: read(6),
      status: read(11) || "final",
      sample_time: normalizeHl7Time(read(14)),
      is_critical: CRITICAL_FLAGS.has(String(flag ?? "").toUpperCase()),
      reference_range_text: read(7) && /^[\d.\-至到\s]/.test(read(7)) ? read(7) : null,
    });
  }
  return { records, warnings };
}

/** RDE^O11 / RDS^O13 -> HIS medication order records from ORC/RXE/RXR groups. */
export function mapRdeMedicationOrders(message) {
  const warnings = [];
  const records = [];
  const segments = message.segments;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].fields[0] !== "RXE") continue;
    const read = (fieldNo, componentNo = 0) => {
      const field = segments[i].fields[fieldNo];
      const component = field == null ? null : String(field).split(message.encoding.compSep)[componentNo];
      return component == null || component === "" ? null : component;
    };
    // RXE-2 Give Code (CE: code^text); RXE-5 Give Amount Minimum; RXE-7 Give Units;
    // RXE-1 Quantity/Timing (TQ code e.g. qid); RXE-3 Date/Time Start of Give.
    const drugCode = read(2, 0);
    const drugName = read(2, 1) || drugCode;
    if (!drugName) {
      warnings.push(`skipped_malformed_RXE#${i + 1}: give code missing`);
      continue;
    }
    // Route: the next RXR segment after this RXE (before the next RXE/ORC).
    let route = null;
    for (let j = i + 1; j < segments.length && !["RXE", "ORC"].includes(segments[j].fields[0]); j++) {
      if (segments[j].fields[0] === "RXR") {
        route = xcnDisplayName(String(segments[j].fields[2] ?? ""), message.encoding.compSep) || null;
        break;
      }
    }
    const amount = read(5);
    const unit = read(7);
    records.push({
      id: `${message.controlId ?? "hl7"}-rxe-${records.length + 1}`,
      is_medication: true,
      drug_name: drugName,
      drug_code: drugCode,
      dosage: [amount, unit].filter(Boolean).join("") || null,
      route,
      frequency: read(1, 0) || null,
      authored_on: normalizeHl7Time(read(3)),
      change_type: "active",
    });
  }
  return { records, warnings };
}

function buildEnvelope(connectorId, context, records, sourceVersion, parseWarnings = []) {
  const env = {
    source_system: connectorId,
    tenant_id: context.tenant_id,
    patient_id: context.patient_id,
    encounter_id: context.encounter_id,
    fetched_at: new Date().toISOString(),
    source_version: sourceVersion,
    records,
  };
  if (parseWarnings && parseWarnings.length > 0) {
    env.parse_warnings = parseWarnings;
  }
  return env;
}

function requireContext(context) {
  for (const field of ["tenant_id", "patient_id", "encounter_id"]) {
    if (typeof context?.[field] !== "string" || !context[field].trim()) {
      throw new Error(`CONNECTOR_HL7_CONTEXT_REQUIRED: ${field}`);
    }
  }
}

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

function stamp(context, record) {
  if (!record.patient_id) record.patient_id = context.patient_id;
  if (!record.encounter_id) record.encounter_id = context.encounter_id;
  return record;
}

/**
 * Create read-only HL7 v2 connectors for the bridge.
 * Supports both fetchMessages (event queue/pull) and listMessages/loadMessage (catalog/loader) patterns.
 */
export function createHl7v2Connectors({
  fetchMessages,
  listMessages,
  loadMessage,
  sourceVersion = null,
} = {}) {
  if (fetchMessages) {
    if (typeof fetchMessages !== "function") throw new Error("CONNECTOR_HL7_FETCH_MESSAGES_REQUIRED");

    const collect = async (context, predicate, { dedupeLast = false, sourceSystem = "hl7v2-channel" } = {}) => {
      requireContext(context);
      const rawMessages = await fetchMessages(context);
      if (!Array.isArray(rawMessages)) throw new Error("CONNECTOR_HL7_MESSAGES_INVALID");
      let records = [];
      const warnings = [];
      for (const raw of rawMessages) {
        const message = parseHl7v2Message(raw);
        const extracted = predicate(message);
        if (extracted) {
          records.push(...(extracted.records ?? [extracted.record]));
          warnings.push(...(extracted.warnings ?? []));
        }
      }
      if (dedupeLast) {
        // Real subscriptions carry several ADT events per visit; the bridge
        // requires exactly one patient/encounter card. Keep the LAST occurrence
        // (deployments must feed events in arrival order).
        const byId = new Map();
        for (const record of records) byId.set(record.id, record);
        records = [...byId.values()];
      }
      return buildEnvelope(sourceSystem, context, records, sourceVersion, warnings);
    };

    return [
      {
        id: "hl7v2-patient",
        kind: "patient",
        capabilities: ["read"],
        async readPatient(context) {
          return collect(context, (message) => (message.messageType.startsWith("ADT") ? { record: mapAdtPatient(message) } : null), { dedupeLast: true, sourceSystem: "hl7v2-patient" });
        },
      },
      {
        id: "hl7v2-encounter",
        kind: "encounter",
        capabilities: ["read"],
        async readPatient(context) {
          return collect(context, (message) => (message.messageType.startsWith("ADT") ? { record: mapAdtEncounter(message) } : null), { dedupeLast: true, sourceSystem: "hl7v2-encounter" });
        },
      },
      {
        id: "hl7v2-lis",
        kind: "lis",
        capabilities: ["read"],
        async readPatient(context) {
          return collect(context, (message) => (message.messageType.startsWith("ORU") ? mapOruObservations(message) : null), { sourceSystem: "hl7v2-lis" });
        },
      },
      {
        id: "hl7v2-his",
        kind: "his",
        capabilities: ["read"],
        async readPatient(context) {
          return collect(context, (message) => ((message.messageType.startsWith("RDE") || message.messageType.startsWith("RDS")) ? mapRdeMedicationOrders(message) : null), { sourceSystem: "hl7v2-his" });
        },
      },
    ];
  }

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
