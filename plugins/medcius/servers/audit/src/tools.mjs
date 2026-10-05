// Handlers for mcp-server-audit. Append-only, hash-chained, PHI-guarded.

import { db, tx, chainHash, eventDigest, signoffDigest, GENESIS } from "./db.mjs";
import { canonicalJson, sha256Hex } from "../../shared/crypto.mjs";
import { containsRawPhi } from "../../phiguard/src/lib.mjs";
import { containsRawStructuredPhi } from "../../../lib/clinical-boundary.mjs";
import { buildSignoffEnvelope, getPublicKey, verifySignoffEnvelope } from "../../shared/digital-signature.mjs";

function phiNoun(type) {
  if (type === "id_card") return "身份证号";
  if (type === "bank_card") return "银行卡号";
  if (type === "phone_cn_mobile" || type === "phone_cn_fixed") return "手机号";
  if (type === "email") return "邮箱";
  return "敏感字段";
}

function guardNoPhi(text) {
  const hit = typeof text === "object" ? containsRawStructuredPhi(text) : containsRawPhi(String(text));
  if (hit.hit) {
    throw new Error(
      `PHI guard: 检测到疑似${phiNoun(hit.type)}原文。` +
        `禁止记录明文 PHI，请先调用 mcp-server-phiguard 的 redact/pseudonymize 进行脱敏/假名化。`,
    );
  }
}

// Generated digest metadata uses a byte representation so the strict PHI scan
// does not mistake numeric runs in hex for patient identifiers. This is not a
// PHI exemption: callers' ordinary strings are always scanned without changes.
export function encodeAuditDigest(hex) {
  if (typeof hex !== "string" || !/^[a-f0-9]{64}$/.test(hex)) throw new Error("AUDIT_DIGEST_INVALID");
  return Array.from(Buffer.from(hex, "hex"));
}

export function decodeAuditDigest(bytes) {
  if (!Array.isArray(bytes) || bytes.length !== 32 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error("AUDIT_DIGEST_INVALID");
  return Buffer.from(bytes).toString("hex");
}

export function encodeAuditResearchReference(caseId) {
  if (typeof caseId !== "string" || !/^frr-[a-f0-9]{20}$/.test(caseId)) throw new Error("AUDIT_RESEARCH_REFERENCE_INVALID");
  return `frr:${caseId.slice(4).match(/.{2}/g).join(":")}`;
}

export function decodeAuditResearchReference(reference) {
  if (typeof reference !== "string" || !/^frr:(?:[a-f0-9]{2}:){9}[a-f0-9]{2}$/.test(reference)) throw new Error("AUDIT_RESEARCH_REFERENCE_INVALID");
  return `frr-${reference.slice(4).replaceAll(":", "")}`;
}

function guardVerifiedSignoffEnvelope(envelope, expected) {
  if (canonicalJson(envelope) !== canonicalJson(expected)) throw new Error("SIGNOFF_ENVELOPE_INCOMPLETE");
  // These two fields were just matched to server-recomputed digests. The
  // signature and stored envelope keep the original canonical hex strings.
  guardNoPhi({ ...envelope, event_digest: encodeAuditDigest(expected.event_digest), reason_digest: encodeAuditDigest(expected.reason_digest) });
}

function guardEventForRelease(event, signoffs = []) {
  for (const field of [event.actor, event.action, event.subject_ref, event.tenant_id]) guardNoPhi(field);
  let payload;
  try { payload = JSON.parse(event.payload_json); } catch { throw new Error("AUDIT_PAYLOAD_JSON_INVALID"); }
  guardNoPhi(payload);
  guardNoPhi(event.payload_json);
  for (const signoff of signoffs) {
    for (const field of [signoff.signer, signoff.role, signoff.decision, signoff.reason, signoff.tenant_id, signoff.key_id, signoff.replay_id, signoff.signed_at]) guardNoPhi(field);
    if (signoff.envelope_json) {
      let envelope;
      try { envelope = JSON.parse(signoff.envelope_json); } catch { throw new Error("SIGNOFF_ENVELOPE_JSON_INVALID"); }
      const { envelope: expected } = buildSignoffEnvelope({ eventId: event.id, eventDigest: eventDigest(event), tenantId: event.tenant_id,
        signer: signoff.signer, role: signoff.role, decision: signoff.decision, reason: signoff.reason, signedAt: signoff.signed_at, replayId: signoff.replay_id });
      guardVerifiedSignoffEnvelope(envelope, expected);
    }
  }
  return payload;
}

const head = () => db.prepare("SELECT seq, chain_hash FROM audit_events ORDER BY seq DESC LIMIT 1").get() ?? null;
const signoffHead = () => db.prepare("SELECT signoff_seq, chain_hash FROM audit_signoffs WHERE chain_version = 2 ORDER BY signoff_seq DESC LIMIT 1").get() ?? null;

/** Independent verification of exported rows; it never mutates storage or disables triggers. */
export function verifyAuditRows(rows, signoffs, { expectedHead, expectedSignoffHead } = {}) {
  const bad = (reason, row = null) => ({ ok: false, checked: rows.length, first_bad_seq: row?.seq ?? null, reason });
  let expectedPrev = GENESIS;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.chain_version !== 2) return bad("LEGACY_EVENT_INTEGRITY_UNVERIFIABLE", row);
    if (row.seq !== index + 1) return bad("AUDIT_SEQUENCE_GAP", row);
    if (sha256Hex(row.payload_json) !== row.payload_hash) return bad("AUDIT_PAYLOAD_HASH_MISMATCH", row);
    if (eventDigest(row) !== row.event_digest) return bad("AUDIT_EVENT_DIGEST_MISMATCH", row);
    if (row.prev_hash !== expectedPrev || chainHash(row.prev_hash, row.seq, row.event_digest, row.ts) !== row.chain_hash) return bad("AUDIT_CHAIN_MISMATCH", row);
    expectedPrev = row.chain_hash;
  }
  let expectedSignoffPrev = GENESIS;
  for (let index = 0; index < signoffs.length; index++) {
    const row = signoffs[index];
    if (row.chain_version !== 2) return bad("LEGACY_SIGNOFF_INTEGRITY_UNVERIFIABLE");
    if (row.signoff_seq !== index + 1 || row.prev_hash !== expectedSignoffPrev || signoffDigest(row) !== row.content_hash
      || chainHash(row.prev_hash, row.signoff_seq, row.content_hash, row.signed_at) !== row.chain_hash) return bad("AUDIT_SIGNOFF_CHAIN_MISMATCH");
    const event = rows.find((event) => event.id === row.event_id);
    if (!event || event.tenant_id !== row.tenant_id || event.event_digest !== row.event_digest || sha256Hex(row.reason) !== row.reason_digest) return bad("AUDIT_SIGNOFF_EVENT_BINDING_MISMATCH");
    if (row.signature) {
      try {
        const { envelope, envelope_hash } = buildSignoffEnvelope({ eventId: row.event_id, eventDigest: row.event_digest, tenantId: row.tenant_id,
          signer: row.signer, role: row.role, decision: row.decision, reason: row.reason, signedAt: row.signed_at, replayId: row.replay_id });
        if (row.envelope_json !== canonicalJson(envelope) || row.envelope_hash !== envelope_hash || row.signed_hash !== envelope_hash
          || row.signature_algorithm !== "ECDSA_P256_SHA256" || !row.signer_public_key
          || !verifySignoffEnvelope({ envelope, signature: row.signature, publicKeyPem: row.signer_public_key }).valid) return bad("AUDIT_SIGNOFF_SIGNATURE_MISMATCH");
      } catch { return bad("AUDIT_SIGNOFF_SIGNATURE_MISMATCH"); }
    }
    expectedSignoffPrev = row.chain_hash;
  }
  if ((expectedHead != null && expectedHead !== expectedPrev) || (expectedSignoffHead != null && expectedSignoffHead !== expectedSignoffPrev)) return bad("AUDIT_CHECKPOINT_MISMATCH");
  return { ok: true, checked: rows.length, checked_signoffs: signoffs.length, head: expectedPrev, signoff_head: expectedSignoffPrev,
    integrity_version: 2, checkpoint_status: "not_independently_attested" };
}

/** @type {Record<string, (a: Record<string, unknown>) => unknown>} */
export const HANDLERS = {
  record_event({ actor, action, subject_ref, payload, tenant_id = "default" }) {
    // Strict PHI Guard: NO bypass path allowed.
    for (const field of [actor, action, subject_ref, tenant_id]) guardNoPhi(field);
    if ([actor, action, subject_ref, tenant_id].some((field) => typeof field !== "string" || !field.trim())) throw new Error("AUDIT_CONTEXT_REQUIRED");
    guardNoPhi(payload ?? {});
    const payloadJson = canonicalJson(payload ?? {});
    guardNoPhi(payloadJson);
    const payloadHash = sha256Hex(payloadJson);

    return tx(() => {
      const h = head();
      const seq = (h?.seq ?? 0) + 1;
      const id = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM audit_events").get().id;
      const prev = h?.chain_hash ?? GENESIS;
      const ts = db.prepare("SELECT datetime('now') AS t").get().t;
      const material = { id, seq, tenant_id: String(tenant_id), actor: String(actor), action: String(action), subject_ref: String(subject_ref), payload_hash: payloadHash, ts, phi_guard: "enforced" };
      const digest = eventDigest(material);
      const ch = chainHash(prev, seq, digest, ts);
      const ins = db
        .prepare(
          `INSERT INTO audit_events (id, seq, tenant_id, actor, action, subject_ref, payload_json, payload_hash, prev_hash, chain_hash, ts, phi_guard, event_digest, chain_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enforced', ?, 2)`,
        )
        .run(id, seq, String(tenant_id), String(actor), String(action), String(subject_ref), payloadJson, payloadHash, prev, ch, ts, digest);
      return { event_id: Number(ins.lastInsertRowid), seq, tenant_id, event_digest: digest, integrity_version: 2, prev_hash: prev, chain_hash: ch, ts };
    });
  },

  get_event({ event_id }) {
    const r = db.prepare("SELECT * FROM audit_events WHERE id = ?").get(event_id);
    if (!r) return { error: "event not found", event_id };
    const signs = db
      .prepare(
        "SELECT * FROM audit_signoffs WHERE event_id = ? ORDER BY id ASC",
      )
      .all(event_id);
    return { ...r, payload: guardEventForRelease(r, signs), signoffs: signs };
  },

  query_events({ actor, action, subject_ref, tenant_id, since, until, limit }) {
    const lim = Math.max(1, Math.min(200, Number(limit ?? 20)));
    const where = [];
    const params = [];
    if (actor) { where.push("actor = ?"); params.push(actor); }
    if (action) { where.push("action = ?"); params.push(action); }
    if (subject_ref) { where.push("subject_ref = ?"); params.push(subject_ref); }
    if (tenant_id) { where.push("tenant_id = ?"); params.push(tenant_id); }
    if (since) { where.push("ts >= ?"); params.push(since); }
    if (until) { where.push("ts <= ?"); params.push(until); }
    const sql = `SELECT id, seq, tenant_id, ts, actor, action, subject_ref, payload_hash, chain_hash FROM audit_events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, lim);
    for (const row of rows) for (const field of [row.actor, row.action, row.subject_ref, row.tenant_id]) guardNoPhi(field);
    return { events: rows, count: rows.length };
  },

  signoff({
    event_id,
    signer,
    role,
    decision,
    reason,
    signature = null,
    signature_algorithm = "ECDSA_P256_SHA256",
    key_id = null,
    signed_hash = null,
    tenant_id = "default",
    public_key = null,
    envelope = null,
    signed_at = null,
    replay_id = null,
  }) {
    for (const field of [reason, signer, role, decision, tenant_id, key_id, replay_id, signed_at]) guardNoPhi(field);
    if (typeof reason !== "string" || !reason.trim() || typeof signer !== "string" || !signer.trim()) throw new Error("SIGNOFF_ENVELOPE_INCOMPLETE");
    if (!["pharmacist", "physician", "admin", "auditor"].includes(role) || !["agree", "override", "reject"].includes(decision)) throw new Error("SIGNOFF_ENVELOPE_INCOMPLETE");
    if (signature && !envelope) throw new Error("SIGNOFF_ENVELOPE_INCOMPLETE");
    return tx(() => {
      const ev = db.prepare("SELECT * FROM audit_events WHERE id = ?").get(event_id);
      if (!ev) throw new Error("SIGNOFF_EVENT_NOT_FOUND");
      if (ev.tenant_id !== tenant_id) throw new Error("SIGNOFF_TENANT_MISMATCH");
      if (ev.chain_version !== 2) throw new Error("SIGNOFF_LEGACY_EVENT_UNVERIFIABLE");
      if (sha256Hex(ev.payload_json) !== ev.payload_hash || eventDigest(ev) !== ev.event_digest
        || chainHash(ev.prev_hash, ev.seq, ev.event_digest, ev.ts) !== ev.chain_hash) throw new Error("SIGNOFF_EVENT_DIGEST_MISMATCH");
      let registered = null;
      let envelopeHash = null;
      if (signature) {
        if (envelope.event_digest !== ev.event_digest) throw new Error("SIGNOFF_EVENT_DIGEST_MISMATCH");
        if (envelope.tenant_id !== tenant_id) throw new Error("SIGNOFF_TENANT_MISMATCH");
        const built = buildSignoffEnvelope({ eventId: event_id, eventDigest: ev.event_digest, tenantId: tenant_id, signer, role, decision,
          reason, signedAt: envelope.signed_at, replayId: envelope.replay_id });
        if (canonicalJson(envelope) !== canonicalJson(built.envelope)
          || (signed_at != null && signed_at !== envelope.signed_at) || (replay_id != null && replay_id !== envelope.replay_id)
          || (signed_hash != null && signed_hash !== built.envelope_hash)) throw new Error("SIGNOFF_ENVELOPE_INCOMPLETE");
        guardVerifiedSignoffEnvelope(envelope, built.envelope);
        if (signature_algorithm !== "ECDSA_P256_SHA256") throw new Error("SIGNOFF_SIGNATURE_ALGORITHM_INVALID");
        registered = getPublicKey(key_id);
        if (!registered || registered.signerId !== signer || (public_key != null && public_key !== registered.publicKey)) throw new Error("SIGNOFF_UNTRUSTED_SIGNER_KEY");
        const verified = verifySignoffEnvelope({ envelope, signature, publicKeyPem: registered.publicKey, keyId: key_id });
        if (!verified.valid) throw new Error(`Digital signature verification failed: ${verified.reason}`);
        if (db.prepare("SELECT id FROM audit_signoffs WHERE replay_id = ? OR signature = ?").get(envelope.replay_id, signature)) throw new Error("SIGNOFF_REPLAY");
        envelopeHash = verified.envelope_hash;
      } else if (envelope || key_id || signed_hash || replay_id || public_key) {
        throw new Error("SIGNOFF_SIGNATURE_REQUIRED");
      }
      const previous = signoffHead();
      const row = {
        id: db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM audit_signoffs").get().id,
        event_id: Number(event_id), tenant_id, signer, role, decision, reason,
        signature, signature_algorithm: signature ? signature_algorithm : null, key_id: signature ? key_id : null, signed_hash: envelopeHash,
        reason_digest: sha256Hex(reason), event_digest: ev.event_digest, replay_id: signature ? envelope.replay_id : null,
        envelope_hash: envelopeHash, envelope_json: signature ? canonicalJson(envelope) : null, signer_public_key: registered?.publicKey ?? null,
        signed_at: signature ? envelope.signed_at : new Date().toISOString(), chain_version: 2,
        signoff_seq: (previous?.signoff_seq ?? 0) + 1, prev_hash: previous?.chain_hash ?? GENESIS,
      };
      row.content_hash = signoffDigest(row);
      row.chain_hash = chainHash(row.prev_hash, row.signoff_seq, row.content_hash, row.signed_at);
      const columns = Object.keys(row);
      const ins = db.prepare(`INSERT INTO audit_signoffs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => row[column]));
      return {
        signoff_id: Number(ins.lastInsertRowid),
        event_id,
        tenant_id,
        signer,
        role,
        decision,
        signature_verified: Boolean(signature),
        replay_id: row.replay_id,
        signoff_seq: row.signoff_seq,
        chain_hash: row.chain_hash,
      };
    });
  },

  verify_chain({}) {
    return verifyAuditRows(db.prepare("SELECT * FROM audit_events ORDER BY seq ASC").all(), db.prepare("SELECT * FROM audit_signoffs ORDER BY id ASC").all());
  },

  export_batch({ since, until, limit }) {
    const lim = Math.max(1, Math.min(1000, Number(limit ?? 500)));
    const rows = db
      .prepare(`SELECT * FROM audit_events WHERE (? IS NULL OR ts >= ?) AND (? IS NULL OR ts <= ?) ORDER BY seq ASC LIMIT ?`)
      .all(since ?? null, since ?? null, until ?? null, until ?? null, lim);
    const signoffs = rows.flatMap((row) => {
      const signs = db.prepare("SELECT * FROM audit_signoffs WHERE event_id = ? ORDER BY id ASC").all(row.id);
      guardEventForRelease(row, signs);
      return signs;
    }).sort((a, b) => a.id - b.id);
    return {
      count: rows.length,
      head_hash: head()?.chain_hash ?? GENESIS,
      signoff_head_hash: signoffHead()?.chain_hash ?? GENESIS,
      events: rows,
      signoffs,
      verification: HANDLERS.verify_chain({}),
      verification_scope: "entire_local_store_not_filtered_export",
      note: "完整独立复核需要全部有序事件和签收行；头哈希须另存于可信检查点。本地链未获得独立见证。",
    };
  },
};
