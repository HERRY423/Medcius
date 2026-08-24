// Handlers for mcp-server-audit. Append-only, hash-chained, PHI-guarded.

import { db, tx, chainHash, GENESIS } from "./db.mjs";
import { canonicalJson, sha256Hex } from "../../shared/crypto.mjs";
import { containsRawPhi } from "../../phiguard/src/lib.mjs";

function guardNoPhi(text) {
  const hit = containsRawPhi(String(text));
  if (hit.hit) {
    throw new Error(
      `PHI guard: 检测到疑似${hit.type === "id_card" ? "身份证号" : "手机号"}原文。` +
        `请先调用 mcp-server-phiguard 的 redact/pseudonymize，再记录；或显式 phi_guard='acknowledged'（将留痕为已知晓风险）。`,
    );
  }
}

const head = () => db.prepare("SELECT seq, chain_hash FROM audit_events ORDER BY seq DESC LIMIT 1").get() ?? null;

/** @type {Record<string, (a: Record<string, unknown>) => unknown>} */
export const HANDLERS = {
  record_event({ actor, action, subject_ref, payload, phi_guard }) {
    if (phi_guard !== "acknowledged") guardNoPhi(`${subject_ref}`);
    const payloadJson = canonicalJson(payload ?? {});
    if (phi_guard !== "acknowledged") guardNoPhi(payloadJson);
    const payloadHash = sha256Hex(payloadJson);
    return tx(() => {
      const h = head();
      const seq = (h?.seq ?? 0) + 1;
      const prev = h?.chain_hash ?? GENESIS;
      const ts = db.prepare("SELECT datetime('now') AS t").get().t;
      const ch = chainHash(prev, seq, payloadHash, ts);
      const ins = db
        .prepare(
          `INSERT INTO audit_events (seq, actor, action, subject_ref, payload_json, payload_hash, prev_hash, chain_hash, ts, phi_guard)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(seq, String(actor), String(action), String(subject_ref), payloadJson, payloadHash, prev, ch, ts, phi_guard === "acknowledged" ? "acknowledged" : "enforced");
      return { event_id: Number(ins.lastInsertRowid), seq, prev_hash: prev, chain_hash: ch, ts };
    });
  },

  get_event({ event_id }) {
    const r = db.prepare("SELECT * FROM audit_events WHERE id = ?").get(event_id);
    if (!r) return { error: "event not found", event_id };
    const signs = db.prepare("SELECT signer, role, decision, reason, signed_at FROM audit_signoffs WHERE event_id = ? ORDER BY signed_at ASC").all(event_id);
    return { ...r, payload: JSON.parse(r.payload_json), signoffs: signs };
  },

  query_events({ actor, action, subject_ref, since, until, limit }) {
    const lim = Math.max(1, Math.min(200, Number(limit ?? 20)));
    const where = [];
    const params = [];
    if (actor) { where.push("actor = ?"); params.push(actor); }
    if (action) { where.push("action = ?"); params.push(action); }
    if (subject_ref) { where.push("subject_ref = ?"); params.push(subject_ref); }
    if (since) { where.push("ts >= ?"); params.push(since); }
    if (until) { where.push("ts <= ?"); params.push(until); }
    const sql = `SELECT id, seq, ts, actor, action, subject_ref, payload_hash, chain_hash FROM audit_events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, lim);
    return { events: rows, count: rows.length };
  },

  signoff({ event_id, signer, role, decision, reason }) {
    return tx(() => {
      const ins = db
        .prepare("INSERT INTO audit_signoffs (event_id, signer, role, decision, reason) VALUES (?, ?, ?, ?, ?)")
        .run(event_id, String(signer), role, decision, String(reason));
      return { signoff_id: Number(ins.lastInsertRowid), event_id, signer, role, decision };
    });
  },

  verify_chain({}) {
    const rows = db.prepare("SELECT seq, ts, payload_hash, prev_hash, chain_hash FROM audit_events ORDER BY seq ASC").all();
    let expectedPrev = GENESIS;
    for (const r of rows) {
      if (r.prev_hash !== expectedPrev)
        return { ok: false, checked: r.seq - 1, first_bad_seq: r.seq, reason: "prev_hash 链接断裂" };
      if (chainHash(r.prev_hash, r.seq, r.payload_hash, r.ts) !== r.chain_hash)
        return { ok: false, checked: r.seq - 1, first_bad_seq: r.seq, reason: "chain_hash 重算不一致（内容或顺序被篡改）" };
      expectedPrev = r.chain_hash;
    }
    // gaps check
    for (let i = 1; i < rows.length; i++)
      if (rows[i].seq !== rows[i - 1].seq + 1)
        return { ok: false, checked: i, first_bad_seq: rows[i].seq, reason: "seq 出现缺口" };
    return { ok: true, checked: rows.length, head: head()?.chain_hash ?? GENESIS };
  },

  export_batch({ since, until, limit }) {
    const lim = Math.max(1, Math.min(1000, Number(limit ?? 500)));
    const rows = db
      .prepare(`SELECT * FROM audit_events WHERE (? IS NULL OR ts >= ?) AND (? IS NULL OR ts <= ?) ORDER BY seq ASC LIMIT ?`)
      .all(since ?? null, since ?? null, until ?? null, until ?? null, lim);
    return {
      count: rows.length,
      head_hash: head()?.chain_hash ?? GENESIS,
      events: rows,
      note: "归档时同时保存 head_hash；接收方可用 verify 逻辑独立复核链条。",
    };
  },
};
