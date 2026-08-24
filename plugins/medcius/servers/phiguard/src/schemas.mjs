// Frozen MCP tool contract for mcp-server-phiguard. Stateless server.

/** @typedef {import("../../shared/rpc.mjs").ToolDef} ToolDef */

/** @type {ToolDef[]} */
export const TOOLS = [
  {
    name: "scan",
    description: "Detect PHI candidates in text (CN resident ID w/ checksum, mobile phone, email, labeled MRN, label-context names). Returns spans + masked samples. Name detection is heuristic (label-context only).",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: 200000 } },
      required: ["text"],
    },
  },
  {
    name: "redact",
    description: "Redact detected PHI. mode='mask' keeps edge chars; mode='hash' replaces with [type:sha8]. Run before ANY free text enters logs, prompts, or exports.",
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
    description: "Stable pseudonymization: identifiers → [PSN:hmac8] keyed by salt. Same value maps to same token within a salt domain. Salt resolution: arg > env CLAUDE_MEDCIUS_PHI_SALT > ephemeral (warns: unstable across restarts).",
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
    description: "Salt source (env|ephemeral|none), algorithms in use, known limitations.",
    inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: {} },
  },
];
