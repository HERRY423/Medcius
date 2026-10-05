// Shared patient, encounter, time, and structured-identifier boundary.
// Every connector and workflow entry uses these checks before normalization.
// A mismatch is rejected. A missing source identity or source time is an
// explicit gap. Request context is never copied onto a record to fill either.

import { canonicalJson, hmacHex } from "../servers/shared/crypto.mjs";
import { containsRawPhi, pseudonymizeText, scanText } from "../servers/phiguard/src/lib.mjs";

export const STRUCTURED_IDENTIFIER_KEYS = new Set([
  "name",
  "patient_name",
  "birthDate",
  "birth_date",
  "medical_record_number",
  "mrn",
  "phone",
  "address",
  "id_card",
  "identifier",
  "identifiers", "patientName", "full_name", "birthdate", "dob",
  "medicalRecordNumber", "telephone", "mobile", "email", "telecom",
  "contact", "contacts", "bed_number", "bed", "ward", "ward_name",
  "doctor_name", "author_name", "family_name", "given_name",
]);
const normalizedIdentifierKeys = new Set([...STRUCTURED_IDENTIFIER_KEYS].map((key) => key.replace(/[_\s-]/g, "").toLowerCase()));

export function referenceTail(reference) {
  if (typeof reference !== "string" || !reference.trim()) return null;
  const parts = reference.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * Bind a record to its source identity.
 * policy "source_required": missing patient or required encounter stays unverified
 * and is not filled from the request.
 * policy "query_scoped": a parameterized read may omit the column; the gap is
 * labeled query_scoped instead of being presented as a verified source id.
 * An explicit id that disagrees with the request always throws.
 */
export function bindSourceOwnership(context, record, source = {}, {
  requirePatient = true,
  requireEncounter = true,
  policy = "source_required",
} = {}) {
  const sourcePatient = source.patient_id ?? null;
  const sourceEncounter = source.encounter_id ?? null;
  const sourceTenant = source.tenant_id ?? null;
  if (sourceTenant && sourceTenant !== context.tenant_id) {
    throw new Error(`CONNECTOR_TENANT_MISMATCH: ${sourceTenant} != ${context.tenant_id}`);
  }
  if (sourcePatient && sourcePatient !== context.patient_id) {
    throw new Error(`CONNECTOR_PATIENT_MISMATCH: ${sourcePatient} != ${context.patient_id}`);
  }
  if (sourceEncounter && sourceEncounter !== context.encounter_id) {
    throw new Error(`CONNECTOR_ENCOUNTER_MISMATCH: ${sourceEncounter} != ${context.encounter_id}`);
  }

  const next = { ...record };
  next.source_patient_id = sourcePatient;
  next.source_encounter_id = sourceEncounter;
  next.source_subject_reference = source.subject_reference ?? null;
  next.source_encounter_reference = source.encounter_reference ?? null;

  if (!sourcePatient && requirePatient) {
    next.patient_id = null;
    next.encounter_id = sourceEncounter;
    next.ownership_status = policy === "query_scoped" ? "query_scoped" : "source_subject_absent";
    return next;
  }
  if (!sourceEncounter && requireEncounter) {
    next.patient_id = sourcePatient;
    next.encounter_id = null;
    next.ownership_status = policy === "query_scoped" ? "query_scoped" : "source_encounter_absent";
    return next;
  }

  next.patient_id = sourcePatient;
  next.encounter_id = sourceEncounter;
  next.ownership_status = "verified";
  return next;
}

export function ownershipAccepted(record) {
  return record?.ownership_status === "verified" || record?.ownership_status === "query_scoped";
}

/** Reject a feed record whose own ids disagree with the active context. */
export function assertExplicitFeedOwnership(context, records, label) {
  for (const record of records || []) {
    if (!record || typeof record !== "object") continue;
    if (record.patient_id && record.patient_id !== context.patient_id) {
      throw new Error(`FAIL_CLOSED_PATIENT_MISMATCH: ${label} ${record.id || ""} belongs to ${record.patient_id}, not ${context.patient_id}`);
    }
    if (record.encounter_id && record.encounter_id !== context.encounter_id) {
      throw new Error(`FAIL_CLOSED_ENCOUNTER_MISMATCH: ${label} ${record.id || ""} belongs to ${record.encounter_id}, not ${context.encounter_id}`);
    }
    if (record.tenant_id && record.tenant_id !== context.tenant_id) {
      throw new Error(`FAIL_CLOSED_TENANT_MISMATCH: ${label} ${record.id || ""} belongs to ${record.tenant_id}, not ${context.tenant_id}`);
    }
  }
}

/**
 * Classify one source timestamp against a single as-of instant and cutoff.
 * Unknown and future times are never treated as "now".
 */
export function classifySourceTime(timestamp, { nowMs, cutoffMs }) {
  if (timestamp == null || timestamp === "") {
    return { status: "unknown", timeMs: null };
  }
  const timeMs = new Date(timestamp).getTime();
  if (!Number.isFinite(timeMs)) return { status: "invalid", timeMs: null };
  if (timeMs > nowMs) return { status: "future", timeMs };
  if (timeMs < cutoffMs) return { status: "stale", timeMs };
  return { status: "in_window", timeMs };
}

export function isRawStructuredIdentifier(value) {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return false;
  if (typeof value !== "string") return true;
  return !/^(?:\[ID:[A-Za-z0-9_-]+:(?:[a-f0-9]{32}|REDACTED)\]|\[PSN:(?:[a-f0-9]{8}|[a-f0-9]{32}|[a-f0-9]{64})\])$/.test(value.trim());
}

/** Stable only within the configured salt domain. Without a key, remove the value entirely. */
export function sealIdentifier(value, field, { salt = process.env.CLAUDE_MEDCIUS_PHI_SALT } = {}) {
  if (salt != null && (typeof salt !== "string" || salt.length < 8)) throw new Error("PHI_IDENTIFIER_SALT_INVALID");
  const safeField = String(field).replace(/[^A-Za-z0-9_-]/g, "_");
  return `[ID:${safeField}:${salt ? hmacHex(salt, `structured|${safeField}|${canonicalJson(value)}`, 32) : "REDACTED"}]`;
}

function isIdentityKey(record, key) {
  const normalized = key.replace(/[_\s-]/g, "").toLowerCase();
  if (!normalizedIdentifierKeys.has(normalized)) return false;
  if (normalized !== "name") return true;
  // A bare name is an identity field. Only explicit clinical shapes retain it.
  const demographic = ["gender", "sex", "age", "birth_date", "birthDate", "medical_record_number", "mrn", "bed_number"]
    .some((item) => record[item] != null) || ["Patient", "Practitioner", "RelatedPerson", "Person"].includes(record.resourceType);
  const clinical = ["unit", "valueQuantity", "modality", "amount_ml", "medication_code", "drug_code"].some((item) => record[item] != null)
    || (record.code != null && record.resourceType !== "Patient");
  return demographic || !clinical;
}

/** Seal entire structured identifiers, including FHIR HumanName/Identifier arrays. */
export function sealIdentityRecord(record, options = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const next = { ...record };
  for (const [key, value] of Object.entries(record)) {
    if (!isIdentityKey(record, key)) continue;
    if (!isRawStructuredIdentifier(value)) continue;
    next[key] = sealIdentifier(value, key, options);
  }
  return next;
}

/** Field-aware detector shared by transform and assert-only exits. Never returns raw values. */
export function containsRawStructuredPhi(value) {
  if (typeof value === "string" || typeof value === "number") return containsRawPhi(String(value));
  if (!value || typeof value !== "object") return { hit: false };
  for (const [key, item] of Object.entries(value)) {
    const keyHit = containsRawPhi(key);
    if (keyHit.hit) return keyHit;
    if (!Array.isArray(value) && isIdentityKey(value, key) && isRawStructuredIdentifier(item)) return { hit: true, type: "structured_identifier", field: key };
    const nested = containsRawStructuredPhi(item);
    if (nested.hit) return nested;
  }
  return { hit: false };
}

/** Model-safe copy. Unknown structured identities are removed; no unsalted identifier hashes. */
export function toModelSafe(value, { salt = process.env.CLAUDE_MEDCIUS_PHI_SALT } = {}) {
  if (typeof value === "number" && containsRawPhi(String(value)).hit) return toModelSafe(String(value), { salt });
  if (typeof value === "string") {
    if (salt != null) return pseudonymizeText(value, { salt }).text;
    let output = value;
    for (const finding of scanText(value).findings.reverse()) output = output.slice(0, finding.start) + `[REDACTED:${finding.type}]` + output.slice(finding.end);
    return output;
  }
  if (Array.isArray(value)) return value.map((item) => toModelSafe(item, { salt }));
  if (value && typeof value === "object") {
    const sealed = sealIdentityRecord(value, { salt });
    const out = {};
    for (const [key, item] of Object.entries(sealed)) out[key] = toModelSafe(item, { salt });
    return out;
  }
  return value;
}
