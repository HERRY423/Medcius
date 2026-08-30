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
  return {
    source_system: connectorId,
    tenant_id: context.tenant_id,
    patient_id: context.patient_id,
    encounter_id: context.encounter_id,
    fetched_at: new Date().toISOString(),
    source_version: sourceVersion,
    records,
    parse_warnings: parseWarnings,
  };
}

function requireContext(context) {
  for (const field of ["tenant_id", "patient_id", "encounter_id"]) {
    if (typeof context?.[field] !== "string" || !context[field].trim()) {
      throw new Error(`CONNECTOR_HL7_CONTEXT_REQUIRED: ${field}`);
    }
  }
}

/**
 * Create read-only HL7 v2 connectors for the bridge.
 *
 * @param {object} options
 * @param {(context: object) => Promise<string[]>} options.fetchMessages - injected consumer; returns raw message strings (ADT/ORU/RDE flows).
 * @param {string} [options.sourceVersion]
 */
export function createHl7v2Connectors({ fetchMessages, sourceVersion = null } = {}) {
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
