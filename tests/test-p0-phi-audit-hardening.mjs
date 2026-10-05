// Synthetic negative-path acceptance. No patient data, clinical evidence, or external calls.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

process.env.CLAUDE_MEDCIUS_DATA = mkdtempSync(join(tmpdir(), "medcius-p0-phi-audit-"));
const salt = "synthetic-phi-domain-a-2026";
process.env.CLAUDE_MEDCIUS_PHI_SALT = salt;
const { toModelSafe, sealIdentifier, containsRawStructuredPhi } = await import("../plugins/medcius/lib/clinical-boundary.mjs");
const { withPhiExitGuard } = await import("../plugins/medcius/lib/connectors/phi-exit-guard.mjs");
const { HANDLERS, verifyAuditRows, encodeAuditDigest, decodeAuditDigest, encodeAuditResearchReference, decodeAuditResearchReference } = await import("../plugins/medcius/servers/audit/src/tools.mjs");
const { containsRawPhi } = await import("../plugins/medcius/servers/phiguard/src/lib.mjs");
const { db, chainHash, signoffDigest } = await import("../plugins/medcius/servers/audit/src/db.mjs");
const { canonicalJson, sha256Hex } = await import("../plugins/medcius/servers/shared/crypto.mjs");
const { generateKeyPair, registerPublicKey, buildSignoffEnvelope, signSignoffEnvelope, signDecision } = await import("../plugins/medcius/servers/shared/digital-signature.mjs");

const phiRecord = {
  resourceType: "Patient", id: "synthetic-patient",
  name: [{ family: "合成姓", given: ["合成名"], text: "合成姓名" }],
  identifier: [{ system: "urn:synthetic:mrn", value: "MRN-PRIVATE-001" }],
  birthDate: "1990-01-01", telecom: [{ system: "phone", value: "555-PRIVATE-100" }],
  address: [{ city: "合成市", line: ["合成路一号"] }],
  contact: [{ name: { family: "合成家属" } }],
  bed_number: 42, patientName: "合成姓名", text: "姓名：张三，病程记录：咳嗽。",
};
const connector = { id: "synthetic", readPatient: async () => ({ records: [phiRecord] }) };
const guarded = withPhiExitGuard(connector, { salt });
const first = await guarded.readPatient({});
const again = await guarded.readPatient({});
assert.deepEqual(first.records, again.records);
assert.equal(containsRawStructuredPhi(first.records).hit, false);
for (const raw of ["合成姓", "MRN-PRIVATE-001", "1990-01-01", "555-PRIVATE-100", "合成路一号", "张三"]) assert.equal(JSON.stringify(first.records).includes(raw), false, raw);
assert.equal(phiRecord.name[0].family, "合成姓", "local source remains unmodified");
const otherDomain = await withPhiExitGuard(connector, { salt: "synthetic-phi-domain-b-2026" }).readPatient({});
assert.notEqual(first.records[0].name, otherDomain.records[0].name);
await assert.rejects(() => withPhiExitGuard(connector, { salt, mode: "assert" }).readPatient({}), /PHI_EXIT_GUARD_RAW_PHI_BLOCKED/);
for (const value of [{ name: "Unlabeled Synthetic Person" }, { identifier: [{ value: "opaque-id" }] }, { mrn: 123456 }, { name: "[ID:name:pretend]" }, { contact_number: 13800138000 }]) {
  assert.equal(containsRawStructuredPhi(value).hit, true);
  assert.equal(containsRawStructuredPhi(toModelSafe(value)).hit, false);
}
const clinical = toModelSafe({ name: "Potassium", code: "2823-3", value: 4.1, unit: "mmol/L" });
assert.equal(clinical.name, "Potassium");
assert.equal(sealIdentifier("synthetic-person", "name", { salt: null }), "[ID:name:REDACTED]");
assert.equal(JSON.stringify(toModelSafe(phiRecord, { salt: null })).includes("合成姓"), false);
assert.match(toModelSafe("姓名：张三", { salt: null }), /REDACTED/);
assert.throws(() => sealIdentifier("synthetic-person", "name", { salt: "short" }), /SALT_INVALID/);
console.log("PASS structured FHIR PHI, numeric identifiers, assertion parity, salt-domain stability, and no-key redaction");

const eventArgs = { actor: "synthetic-reviewer", action: "synthetic_review", subject_ref: "Encounter/synthetic-1", payload: { value: "synthetic" }, tenant_id: "tenant-synthetic" };
for (const key of ["actor", "action", "subject_ref", "tenant_id"]) assert.throws(() => HANDLERS.record_event({ ...eventArgs, [key]: "姓名：张三" }), /PHI guard/);
for (const payload of [{ name: "合成姓名" }, { patient: { identifier: [{ value: "opaque-mrn" }] } }, { nested: { birthDate: "1990-01-01" } }]) assert.throws(() => HANDLERS.record_event({ ...eventArgs, payload }), /PHI guard/);
const event = HANDLERS.record_event(eventArgs);
const stored = HANDLERS.get_event({ event_id: event.event_id });
assert.notEqual(stored.event_digest, stored.payload_hash);
const keys = generateKeyPair("SIGNER-SYNTHETIC");
const args = { event_id: event.event_id, signer: keys.signerId, role: "physician", decision: "agree", reason: "Synthetic review complete", tenant_id: eventArgs.tenant_id };
const built = buildSignoffEnvelope({ eventId: args.event_id, eventDigest: stored.event_digest, tenantId: args.tenant_id, signer: args.signer,
  role: args.role, decision: args.decision, reason: args.reason, signedAt: "2026-10-04T00:00:00Z", replayId: "replay-synthetic-001" });
const signed = signSignoffEnvelope({ envelope: built.envelope, privateKeyPem: keys.privateKey, keyId: keys.keyId });
const signedArgs = { ...args, signature: signed.signature, signature_algorithm: signed.signature_algorithm, signed_hash: signed.signed_hash, key_id: keys.keyId, envelope: built.envelope };
for (const field of ["reason", "signer", "tenant_id"]) assert.throws(() => HANDLERS.signoff({ ...args, [field]: "姓名：张三" }), /PHI guard/);
assert.throws(() => HANDLERS.signoff({ ...args, tenant_id: "other-tenant" }), /SIGNOFF_TENANT_MISMATCH/);
assert.throws(() => HANDLERS.signoff({ ...signedArgs, signed_hash: "0".repeat(64) }), /SIGNOFF_ENVELOPE_INCOMPLETE/);
assert.throws(() => HANDLERS.signoff({ ...signedArgs, envelope: { ...built.envelope, event_digest: stored.payload_hash } }), /SIGNOFF_EVENT_DIGEST_MISMATCH/);
assert.throws(() => HANDLERS.signoff({ ...signedArgs, signature_algorithm: "unverified-algorithm" }), /SIGNOFF_SIGNATURE_ALGORITHM_INVALID/);
const untrusted = generateKeyPair("OTHER-SIGNER");
assert.throws(() => HANDLERS.signoff({ ...signedArgs, public_key: untrusted.publicKey }), /SIGNOFF_UNTRUSTED_SIGNER_KEY/);
assert.throws(() => HANDLERS.signoff({ ...signedArgs, key_id: untrusted.keyId }), /SIGNOFF_UNTRUSTED_SIGNER_KEY/);
assert.throws(() => registerPublicKey(keys.keyId, keys.signerId, untrusted.publicKey), /SIGNER_KEY_ALREADY_REGISTERED/);
const legacySig = signDecision({ payload: stored.payload, privateKeyPem: keys.privateKey, keyId: keys.keyId, signer: keys.signerId, role: args.role });
assert.throws(() => HANDLERS.signoff({ ...signedArgs, signature: legacySig.signature }), /verification failed/);
assert.throws(() => buildSignoffEnvelope({ ...built.envelope }), /SIGNOFF_ENVELOPE_INCOMPLETE/);
assert.equal(HANDLERS.signoff(signedArgs).signature_verified, true);
assert.throws(() => HANDLERS.signoff(signedArgs), /SIGNOFF_REPLAY/);
assert.equal(HANDLERS.signoff({ ...args, decision: "reject", reason: "Unsigned synthetic review" }).signature_verified, false);
assert.equal(HANDLERS.verify_chain({}).ok, true);
console.log("PASS all-field audit PHI, tenant binding, registered signer, decision envelope, legacy-signature refusal, and replay rejection");

const allEvents = db.prepare("SELECT * FROM audit_events ORDER BY seq").all();
const allSignoffs = db.prepare("SELECT * FROM audit_signoffs ORDER BY id").all();
for (const key of ["id", "actor", "action", "tenant_id", "subject_ref", "ts", "payload_json", "phi_guard"]) {
  const changed = structuredClone(allEvents); changed[0][key] = key === "id" ? 9999 : "tampered";
  assert.equal(verifyAuditRows(changed, allSignoffs).ok, false, `event ${key}`);
}
for (const key of ["id", "event_id", "reason", "decision", "signer", "role", "tenant_id", "signed_at", "signature", "key_id", "envelope_json", "signer_public_key", "replay_id"]) {
  const changed = structuredClone(allSignoffs); changed[0][key] = ["id", "event_id"].includes(key) ? 9999 : "tampered";
  assert.equal(verifyAuditRows(allEvents, changed).ok, false, `signoff ${key}`);
}
const rehashed = structuredClone(allSignoffs.slice(0, 1));
rehashed[0].decision = "reject";
rehashed[0].content_hash = signoffDigest(rehashed[0]);
rehashed[0].chain_hash = chainHash(rehashed[0].prev_hash, rehashed[0].signoff_seq, rehashed[0].content_hash, rehashed[0].signed_at);
assert.equal(verifyAuditRows(allEvents, rehashed).reason, "AUDIT_SIGNOFF_SIGNATURE_MISMATCH");
for (const table of ["audit_events", "audit_signoffs"]) {
  assert.throws(() => db.exec(`UPDATE ${table} SET tenant_id='other'`), /immutable/);
  assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable/);
}
const exported = HANDLERS.export_batch({});
assert.equal(exported.signoffs.length, 2);
assert.equal(verifyAuditRows(exported.events, exported.signoffs).ok, true);
assert.equal(verifyAuditRows(exported.events, [], { expectedHead: exported.head_hash, expectedSignoffHead: exported.signoff_head_hash }).reason, "AUDIT_CHECKPOINT_MISMATCH");
assert.equal(exported.verification.checkpoint_status, "not_independently_attested");
console.log("PASS full event/signoff integrity, independent export replay, and unchanged append-only protections");

// Fixed real SHA-256 counterexample: the digest includes a phone-looking run.
// Only trusted metadata serialization changes; arbitrary strings still fail.
const fixedDigestReason = "synthetic-digest-3";
const phoneLikeDigest = sha256Hex(fixedDigestReason);
assert.equal(phoneLikeDigest, "16c2e99b642c48602f57c3e3c299d1f0c78ce4f17331144897dd705a88e132b2");
assert.equal(containsRawPhi(phoneLikeDigest).type, "phone_cn_mobile");
assert.throws(() => HANDLERS.record_event({ ...eventArgs, payload: { record_sha256: phoneLikeDigest } }), /PHI guard/);
assert.throws(() => HANDLERS.record_event({ ...eventArgs, payload: { record_sha256: encodeAuditDigest(phoneLikeDigest), note: "Call 13800138000" } }), /PHI guard/);
assert.throws(() => encodeAuditDigest("13800138000"), /AUDIT_DIGEST_INVALID/);
assert.throws(() => decodeAuditDigest([256]), /AUDIT_DIGEST_INVALID/);
const phoneLikeCaseId = `frr-${"a17331144897".padEnd(20, "d")}`;
assert.equal(containsRawPhi(phoneLikeCaseId).hit, true);
const safeReference = encodeAuditResearchReference(phoneLikeCaseId);
assert.equal(decodeAuditResearchReference(safeReference), phoneLikeCaseId);
assert.equal(containsRawPhi(safeReference).hit, false);
const digestEvent = HANDLERS.record_event({ ...eventArgs, subject_ref: safeReference, payload: { record_sha256: encodeAuditDigest(phoneLikeDigest) } });
const readDigestEvent = HANDLERS.get_event({ event_id: digestEvent.event_id });
assert.equal(decodeAuditDigest(readDigestEvent.payload.record_sha256), phoneLikeDigest);
const fixedDigestEnvelope = buildSignoffEnvelope({ eventId: digestEvent.event_id, eventDigest: readDigestEvent.event_digest, tenantId: args.tenant_id, signer: args.signer,
  role: args.role, decision: args.decision, reason: fixedDigestReason, signedAt: "2026-10-04T00:00:00Z", replayId: "replay-synthetic-fixed-digest" });
assert.equal(fixedDigestEnvelope.envelope.reason_digest, phoneLikeDigest);
const fixedDigestSignature = signSignoffEnvelope({ envelope: fixedDigestEnvelope.envelope, privateKeyPem: keys.privateKey, keyId: keys.keyId });
const fixedDigestSignoff = { ...args, event_id: digestEvent.event_id, reason: fixedDigestReason, envelope: fixedDigestEnvelope.envelope,
  signature: fixedDigestSignature.signature, key_id: keys.keyId, signed_hash: fixedDigestSignature.signed_hash };
assert.throws(() => HANDLERS.signoff({ ...fixedDigestSignoff, envelope: { ...fixedDigestEnvelope.envelope, reason_digest: "0".repeat(64) } }), /SIGNOFF_ENVELOPE_INCOMPLETE/);
assert.equal(HANDLERS.signoff(fixedDigestSignoff).signature_verified, true);
assert.equal(HANDLERS.get_event({ event_id: digestEvent.event_id }).signoffs[0].reason_digest, phoneLikeDigest);
assert.equal(HANDLERS.export_batch({}).verification.ok, true);
console.log("PASS fixed phone-looking hash metadata and signed reason digest without weakening ordinary PHI scans");

// A real additive v1 -> v2 migration in an isolated synthetic store. No historical rewrites.
const legacyDir = mkdtempSync(join(tmpdir(), "medcius-audit-legacy-"));
mkdirSync(join(legacyDir, "audit"));
const legacyDb = new DatabaseSync(join(legacyDir, "audit", "audit.sqlite"));
legacyDb.exec(`CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL UNIQUE, tenant_id TEXT NOT NULL DEFAULT 'default', ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, subject_ref TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, prev_hash TEXT NOT NULL, chain_hash TEXT NOT NULL, phi_guard TEXT NOT NULL DEFAULT 'enforced');
CREATE TABLE audit_signoffs (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES audit_events(id), tenant_id TEXT NOT NULL DEFAULT 'default', signer TEXT NOT NULL, role TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL, signed_at TEXT NOT NULL);
PRAGMA user_version=1;`);
const payloadJson = canonicalJson({ synthetic: true });
const oldHash = chainHash("GENESIS", 1, sha256Hex(payloadJson), "2026-10-03 00:00:00");
legacyDb.prepare("INSERT INTO audit_events VALUES (1,1,'tenant-synthetic','2026-10-03 00:00:00','legacy','review','Encounter/synthetic-1',?,?,'GENESIS',?,'enforced')").run(payloadJson, sha256Hex(payloadJson), oldHash);
const historicalPhi = canonicalJson({ patient: { name: "合成姓名" } });
legacyDb.prepare("INSERT INTO audit_events VALUES (2,2,'tenant-synthetic','2026-10-03 01:00:00','legacy','review','Encounter/synthetic-2',?,?,?,?,'enforced')").run(historicalPhi, sha256Hex(historicalPhi), oldHash, chainHash(oldHash, 2, sha256Hex(historicalPhi), "2026-10-03 01:00:00"));
legacyDb.close();
const moduleUrl = new URL("../plugins/medcius/servers/audit/src/tools.mjs", import.meta.url).href;
const migration = spawnSync(process.execPath, ["--input-type=module", "-e", `import assert from 'node:assert/strict'; import {HANDLERS} from ${JSON.stringify(moduleUrl)}; const event=HANDLERS.get_event({event_id:1}); assert.equal(event.chain_hash, ${JSON.stringify(oldHash)}); assert.equal(event.chain_version,1); assert.equal(event.event_digest,null); assert.equal(HANDLERS.verify_chain({}).reason,'LEGACY_EVENT_INTEGRITY_UNVERIFIABLE'); assert.throws(()=>HANDLERS.signoff({event_id:1,tenant_id:'tenant-synthetic',signer:'legacy',role:'physician',decision:'agree',reason:'Synthetic'}),/SIGNOFF_LEGACY_EVENT_UNVERIFIABLE/); assert.throws(()=>HANDLERS.get_event({event_id:2}),/PHI guard/); assert.throws(()=>HANDLERS.export_batch({}),/PHI guard/); console.log('legacy preserved');`], { env: { ...process.env, CLAUDE_MEDCIUS_DATA: legacyDir }, encoding: "utf8" });
assert.equal(migration.status, 0, migration.stderr);
assert.match(migration.stdout, /legacy preserved/);
console.log("PASS additive legacy migration preserves historical hashes and refuses unsupported integrity upgrades");
db.close();
console.log("P0 PHI / AUDIT HARDENING PASSED — engineering and synthetic validation only; clinical evidence remains blocked.");
