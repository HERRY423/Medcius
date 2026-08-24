#!/usr/bin/env node
// Medcius drug-labels MCP server entry point.
// Wires the frozen 5-tool contract (schemas.mjs) to handlers (tools.mjs) on the shared stdio transport.

import { serve } from "../../shared/rpc.mjs";
import { TOOLS } from "./schemas.mjs";
import { HANDLERS } from "./tools.mjs";

serve({
  serverInfo: { name: "mcp-server-drug-labels", version: "0.0.1" },
  instructions:
    "本地药品说明书摘录库，不是 NMPA 注册全库。无 search_drugs/get_drug_label。search_labels/get_label；check_interactions（mention_found|class_signal_found|no_mention_in_corpus）；calc_renal 默认 μmol/L；validate_approval_format 只验格式。样例禁止真实审核。",
  tools: TOOLS,
  handlers: HANDLERS,
});
