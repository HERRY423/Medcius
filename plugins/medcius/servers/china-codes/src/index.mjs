#!/usr/bin/env node
import { serve } from "../../shared/rpc.mjs";
import { TOOLS } from "./schemas.mjs";
import { HANDLERS } from "./tools.mjs";
serve({
  serverInfo: { name: "mcp-server-china-codes", version: "0.0.1" },
  instructions: "本地 NHSA 编码与药品目录库。search_codes/get_code/validate_code 供 nhsa-coding；search_drug_catalog/get_drug_catalog 供 nhsa-policy。样例仅管线验证。",
  tools: TOOLS,
  handlers: HANDLERS,
});
