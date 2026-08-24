#!/usr/bin/env node
// Medcius Audit Chain MCP server entry point.

import { serve } from "../../shared/rpc.mjs";
import { TOOLS } from "./schemas.mjs";
import { HANDLERS } from "./tools.mjs";

serve({
  serverInfo: { name: "mcp-server-audit", version: "0.0.1" },
  instructions:
    "本地审计链：append-only 哈希链 + 药师/医师签核。判定类事件（如 rx_review_verdict）必须记录；含身份证/手机号原文会被 PHI 守卫拒绝——先用 phiguard 脱敏。",
  tools: TOOLS,
  handlers: HANDLERS,
});
