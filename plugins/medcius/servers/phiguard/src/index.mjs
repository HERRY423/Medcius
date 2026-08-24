#!/usr/bin/env node
// Medcius PHI Guard MCP server entry point. Stateless — no data dir, no DB.

import { serve } from "../../shared/rpc.mjs";
import { TOOLS } from "./schemas.mjs";
import { HANDLERS } from "./tools.mjs";

serve({
  serverInfo: { name: "mcp-server-phiguard", version: "0.0.1" },
  instructions:
    "PHI 检测/脱敏/假名化。规则：任何自由文本进入日志、审计、导出或模型上下文之前先 scan/redact；审计链会拒绝含身份证/手机号原文的记录。",
  tools: TOOLS,
  handlers: HANDLERS,
});
