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

const WRITE_TOOL_NAMES = new Set(["create_resource", "update_resource"]);
const isProduction = process.env.NODE_ENV === "production" || process.env.MEDCIUS_PROFILE === "production";
const readOnly = isProduction || process.env.MEDCIUS_FHIR_READ_ONLY !== "false";
const tools = readOnly ? TOOLS.filter((tool) => !WRITE_TOOL_NAMES.has(tool.name)) : TOOLS;
const handlers = readOnly
  ? Object.fromEntries(Object.entries(HANDLERS).filter(([name]) => !WRITE_TOOL_NAMES.has(name)))
  : HANDLERS;

sweepStaleDocuments();
serve({
  serverInfo: { name: "mcp-server-fhir", version: "0.0.1" },
  instructions: readOnly
    ? "This Codex connection is read-only. Do not attempt to create or update EHR resources."
    : undefined,
  tools,
  handlers,
});
