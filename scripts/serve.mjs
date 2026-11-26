#!/usr/bin/env node
// CLI script to launch the Medcius HTTP / REST / CDS Hooks Server.
// Usage: node scripts/serve.mjs [--port 8080] [--host 0.0.0.0]

const args = process.argv.slice(2);
if (args[0] === "--precompute-ward") {
  if (args.length !== 1) throw new Error("WARD_JOB_ARGUMENT_INVALID");
  await import("./precompute-ward.mjs");
} else {
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
    const { startServer } = await import("../plugins/medcius/servers/api/src/server.mjs");
    const { assembleAuthorizedHospitalSourceFromEnv } = await import("../plugins/medcius/lib/authorized-hospital-source.mjs");
    await assembleAuthorizedHospitalSourceFromEnv();
    await startServer(port, host);
  } catch (err) {
    console.error(`[Medcius API] Failed to start server: ${err.message}`);
    process.exit(1);
  }
}
