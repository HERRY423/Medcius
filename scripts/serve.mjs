#!/usr/bin/env node
// CLI script to launch the Medcius HTTP / REST / CDS Hooks Server.
// Usage: node scripts/serve.mjs [--port 8080] [--host 0.0.0.0]

import { startServer } from "../plugins/medcius/servers/api/src/server.mjs";

const args = process.argv.slice(2);
let port = Number(process.env.PORT || 8080);
let host = process.env.HOST || "0.0.0.0";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) {
    port = Number(args[i + 1]);
    i++;
  } else if (args[i] === "--host" && args[i + 1]) {
    host = args[i + 1];
    i++;
  }
}

try {
  await startServer(port, host);
} catch (err) {
  console.error(`[Medcius API] Failed to start server: ${err.message}`);
  process.exit(1);
}
