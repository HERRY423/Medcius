#!/usr/bin/env node
import { serve } from "../../shared/rpc.mjs";
import { TOOLS } from "./schemas.mjs";
import { HANDLERS } from "./tools.mjs";
serve({
  serverInfo: { name: "mcp-server-china-trials", version: "0.0.1" },
  instructions:
    "本地中国药物临床试验登记摘录。search_trials / get_trial / validate_ctr_format。未命中不得编造 CTR 方案。样例仅管线验证。",
  tools: TOOLS,
  handlers: HANDLERS,
});
