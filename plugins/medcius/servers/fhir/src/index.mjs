#!/usr/bin/env node
// Medcius FHIR MCP server entry point.
//
// Wires the frozen 19-tool contract (schemas.mjs) to the handlers
// (tools.mjs) on the shared stdio transport, and sweeps leftover document
// temp files from earlier crashes before serving.

import { serve } from "../../shared/rpc.mjs";
import { sweepStaleDocuments } from "./documents.mjs";
import { TOOLS } from "./schemas.mjs";
import { HANDLERS } from "./tools.mjs";

sweepStaleDocuments();
serve({
  serverInfo: { name: "mcp-server-fhir", version: "0.0.1" },
  tools: TOOLS,
  handlers: HANDLERS,
});
