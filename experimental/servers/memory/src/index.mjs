#!/usr/bin/env node
// Medcius Agent Memory & Adaptive Learning MCP server entry point.

import { serve } from "../../shared/rpc.mjs";
import { TOOLS } from "./schemas.mjs";
import { HANDLERS } from "./tools.mjs";

serve({
  serverInfo: { name: "mcp-server-memory", version: "0.1.0" },
  instructions:
    "Agent 记忆与自适应学习服务：提供机构/科室/医师长期经验存储 (remember/recall)、药师签核纠偏提取 (learn_from_override) 与自适应知识演进分析。",
  tools: TOOLS,
  handlers: HANDLERS,
});
