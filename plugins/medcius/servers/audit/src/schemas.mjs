// Frozen MCP tool contract for mcp-server-audit.

/** @typedef {import("../../shared/rpc.mjs").ToolDef} ToolDef */

/** @type {ToolDef[]} */
export const TOOLS = [
  {
    name: "record_event",
    description: "Append a tamper-evident audit event (hash-chained). subject_ref/payload MUST be pre-redacted — raw PHI (ID card, mobile phone, bank card) is strictly rejected.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        actor: { type: "string", minLength: 1, maxLength: 128 },
        action: { type: "string", minLength: 1, maxLength: 64 },
        subject_ref: { type: "string", minLength: 1, maxLength: 128 },
        payload: { type: "object" },
        tenant_id: { type: "string" },
        phi_guard: { type: "string", enum: ["enforced"] },
      },
      required: ["actor", "action", "subject_ref", "payload"],
    },
  },
  {
    name: "get_event",
    description: "Fetch one event (payload parsed) with its signoffs.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { event_id: { type: "integer", minimum: 1 } },
      required: ["event_id"],
    },
  },
  {
    name: "query_events",
    description: "Query events by actor/action/subject_ref/tenant_id/time range. Returns metadata only (no payload) by default to keep list views lean.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        actor: { type: "string" },
        action: { type: "string" },
        subject_ref: { type: "string" },
        tenant_id: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: "signoff",
    description: "Pharmacist/physician/admin/auditor sign-off on an event: agree | override | reject + reason with verifiable digital signature.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        event_id: { type: "integer", minimum: 1 },
        signer: { type: "string", minLength: 1, maxLength: 128 },
        role: { type: "string", enum: ["pharmacist", "physician", "admin", "auditor"] },
        decision: { type: "string", enum: ["agree", "override", "reject"] },
        reason: { type: "string", minLength: 1 },
        signature: { type: "string" },
        signature_algorithm: { type: "string" },
        key_id: { type: "string" },
        signed_hash: { type: "string" },
        tenant_id: { type: "string" },
      },
      required: ["event_id", "signer", "role", "decision", "reason"],
    },
  },
  {
    name: "verify_chain",
    description: "Recompute the full hash chain; reports first bad seq or OK + head hash. Run periodically and before any export is trusted.",
    inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: {} },
  },
  {
    name: "export_batch",
    description: "Export events in [since, until] with chain head hash for external archival/independent re-verification.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        since: { type: "string" },
        until: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
    },
  },
];
