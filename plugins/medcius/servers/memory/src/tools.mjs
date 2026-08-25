// Memory MCP tool handlers
import { randomUUID } from "node:crypto";
import { db, tx } from "./db.mjs";

export const HANDLERS = {
  remember({ scope, scope_id, key, content, tags, source_ref, confidence = 1.0, expires_at }) {
    if (!scope || !key || content === undefined) {
      throw new Error("scope, key, and content are required for remember");
    }

    const contentStr = typeof content === "object" ? JSON.stringify(content) : String(content);
    const tagsStr = Array.isArray(tags) ? tags.join(",") : tags || null;
    const now = new Date().toISOString();

    return tx(() => {
      // Check if key exists for scope + scope_id
      const existing = db
        .prepare("SELECT id FROM agent_memories WHERE scope = ? AND (scope_id = ? OR (scope_id IS NULL AND ? IS NULL)) AND key = ?")
        .get(scope, scope_id ?? null, scope_id ?? null, key);

      let id = existing?.id;
      if (existing) {
        db.prepare(
          `UPDATE agent_memories 
           SET content = ?, tags = ?, source_ref = ?, confidence = ?, updated_at = ?, expires_at = ?
           WHERE id = ?`
        ).run(contentStr, tagsStr, source_ref ?? null, confidence, now, expires_at ?? null, id);
      } else {
        id = randomUUID();
        db.prepare(
          `INSERT INTO agent_memories (id, scope, scope_id, key, content, tags, source_ref, confidence, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, scope, scope_id ?? null, key, contentStr, tagsStr, source_ref ?? null, confidence, now, now, expires_at ?? null);
      }

      return {
        ok: true,
        id,
        scope,
        scope_id: scope_id ?? null,
        key,
        updated: Boolean(existing),
      };
    });
  },

  recall({ scope, scope_id, query, tags, limit = 10 }) {
    let sql = "SELECT * FROM agent_memories WHERE 1=1";
    const params = [];

    if (scope) {
      sql += " AND scope = ?";
      params.push(scope);
    }
    if (scope_id) {
      sql += " AND scope_id = ?";
      params.push(scope_id);
    }
    if (query) {
      sql += " AND (key LIKE ? OR content LIKE ?)";
      params.push(`%${query}%`, `%${query}%`);
    }

    // Exclude expired memories
    sql += " AND (expires_at IS NULL OR expires_at > ?)";
    params.push(new Date().toISOString());

    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(sql).all(...params);

    const results = rows.map((r) => {
      let parsed = r.content;
      try {
        parsed = JSON.parse(r.content);
      } catch {}
      return {
        id: r.id,
        scope: r.scope,
        scope_id: r.scope_id,
        key: r.key,
        content: parsed,
        tags: r.tags ? r.tags.split(",") : [],
        source_ref: r.source_ref,
        confidence: r.confidence,
        updated_at: r.updated_at,
      };
    });

    return {
      count: results.length,
      memories: results,
    };
  },

  learn_from_override({ event_type, audit_seq, doctor_id, department, original_verdict, pharmacist_verdict, rationale, rule_affected, suggested_action }) {
    if (!event_type || !rationale) {
      throw new Error("event_type and rationale are required");
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    tx(() => {
      db.prepare(
        `INSERT INTO agent_learning_logs (id, event_type, audit_seq, doctor_id, department, original_verdict, pharmacist_verdict, rationale, rule_affected, suggested_action, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        event_type,
        audit_seq ?? null,
        doctor_id ?? null,
        department ?? null,
        original_verdict ?? null,
        pharmacist_verdict ?? null,
        rationale,
        rule_affected ?? null,
        suggested_action ?? null,
        now
      );
    });

    return {
      ok: true,
      learning_id: id,
      event_type,
      audit_seq: audit_seq ?? null,
      recorded_at: now,
    };
  },

  learning_stats({ scope } = {}) {
    const memTotal = db.prepare("SELECT COUNT(*) as c FROM agent_memories").get().c;
    const memByScope = db.prepare("SELECT scope, COUNT(*) as count FROM agent_memories GROUP BY scope").all();
    const logsTotal = db.prepare("SELECT COUNT(*) as c FROM agent_learning_logs").get().c;
    const logsByType = db.prepare("SELECT event_type, COUNT(*) as count FROM agent_learning_logs GROUP BY event_type").all();

    const topRulesAffected = db
      .prepare("SELECT rule_affected, COUNT(*) as count FROM agent_learning_logs WHERE rule_affected IS NOT NULL GROUP BY rule_affected ORDER BY count DESC LIMIT 5")
      .all();

    return {
      total_memories: memTotal,
      memories_by_scope: memByScope,
      total_learning_events: logsTotal,
      events_by_type: logsByType,
      top_rules_affected: topRulesAffected,
    };
  },
};
