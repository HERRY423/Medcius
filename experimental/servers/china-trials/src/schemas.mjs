/** @type {import("../../shared/rpc.mjs").ToolDef[]} */
export const TOOLS = [
  {
    name: "search_trials",
    description: "Search the LOCAL China clinical-trial corpus by CTR, drug, indication, or sponsor. not_in_corpus ≠ not registered nationally.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        include_samples: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_trial",
    description: "Fetch one local trial by CTR. Invalid format or missing row does not invent a protocol.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { ctr: { type: "string", minLength: 1 } },
      required: ["ctr"],
    },
  },
  {
    name: "validate_ctr_format",
    description: "Format-only CTR check. exists is never claimed.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { ctr: { type: "string", minLength: 1 } },
      required: ["ctr"],
    },
  },
  {
    name: "corpus_status",
    description: "Local trial corpus health.",
    inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: {} },
  },
];
