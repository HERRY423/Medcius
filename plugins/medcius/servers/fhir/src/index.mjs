#!/usr/bin/env node
// Medcius FHIR MCP server entry point.
//
// Wires the read-only tool contract (schemas.mjs) to the handlers
// (tools.mjs) on the shared stdio transport, and sweeps leftover document
// temp files from earlier crashes before serving.

import { serve } from "../../shared/rpc.mjs";
import { sweepStaleDocuments } from "./documents.mjs";
import { TOOLS } from "./schemas.mjs";
import { HANDLERS } from "./tools.mjs";

sweepStaleDocuments();
serve({
  phiGuard: true,
  serverInfo: { name: "mcp-server-fhir", version: "0.0.1" },
  instructions: "Read-only access to FHIR resources.",
  tools: TOOLS,
  handlers: HANDLERS,
});
