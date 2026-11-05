// Frozen MCP tool contract for mcp-server-phiguard. Stateless server.

/** @typedef {import("../../shared/rpc.mjs").ToolDef} ToolDef */

/** @type {ToolDef[]} */
export const TOOLS = [
  {
    name: "scan",
    description: "Scan text for PHI. Production requires verified local CPU NER plus the session dictionary and rules; returns a change flag and execution receipt. Development uses heuristic spans. A clean scan does not establish complete de-identification.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: 200000 } },
      required: ["text"],
    },
  },
  {
    name: "redact",
    description: "Redact PHI before free text enters logs, prompts, or exports. Production requires verified local CPU NER plus dictionary and rules, always fully removes identifiers and ignores partial mask/keep_last options. Development supports mask/hash modes. Missing or failed production NER blocks the call.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 200000 },
        mode: { type: "string", enum: ["mask", "hash"] },
        keep_last: { type: "integer", minimum: 0, maximum: 4 },
      },
      required: ["text"],
    },
  },
  {
    name: "pseudonymize",
    description: "Production uses mandatory dual-track full redaction (stable=false); it does not promise stable HMAC tokens. Development supports salt-keyed HMAC-SHA256 pseudonyms. A verified local CPU NER model is mandatory in production; missing or failed NER blocks the call.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 200000 },
        salt: { type: "string", minLength: 8, maxLength: 256 },
      },
      required: ["text"],
    },
  },
  {
    name: "status",
    description: "Production verifies local CPU NER readiness and reports detection algorithms and assurance limits; fails closed if the model is unavailable. Development reports salt source, heuristic algorithms and known limitations.",
    inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: {} },
  },
];
