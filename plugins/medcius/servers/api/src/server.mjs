// Medcius HTTP / HTTPS / REST / CDS Hooks Server Entrypoint
// Zero third-party dependencies; uses node:http and node:https standard libraries.
// Security: Mandatory TLS in production mode; strict prohibition of silent HTTP downgrade.

import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { routeRequest } from "./rest-routes.mjs";

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB limit

export function createServer(options = {}) {
  const isProduction = process.env.NODE_ENV === "production" || process.env.MEDCIUS_PROFILE === "production";

  const requestHandler = async (req, res) => {
    let bodyBuffer = "";
    let bodyLength = 0;

    req.on("data", (chunk) => {
      bodyLength += chunk.length;
      if (bodyLength > MAX_BODY_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large (limit: 10MB)" }));
        req.destroy();
        return;
      }
      bodyBuffer += chunk;
    });

    req.on("end", async () => {
      let body = null;
      if (bodyBuffer.trim()) {
        try {
          body = JSON.parse(bodyBuffer);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Invalid JSON in request body" }));
        }
      }

      try {
        await routeRequest(req, res, body);
      } catch (err) {
        console.error("routeRequest unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Internal Server Error: ${err.message}` }));
        }
      }
    });

    req.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Request Error: ${err.message}` }));
      }
    });
  };

  // Determine TLS / HTTPS options
  const tlsConfig = options.tls || getEnvTlsConfig();

  // Enforce mandatory TLS in production mode
  if (isProduction && !tlsConfig) {
    throw new Error(
      "FATAL_PROD_SECURITY_ERROR: TLS is mandatory in production environment. " +
      "MEDCIUS_TLS_KEY and MEDCIUS_TLS_CERT must be configured. Plain HTTP downgrade is strictly prohibited.",
    );
  }

  if (tlsConfig) {
    return createHttpsServer(tlsConfig, requestHandler);
  }

  return createHttpServer(requestHandler);
}

function getEnvTlsConfig() {
  const keyPath = process.env.MEDCIUS_TLS_KEY;
  const certPath = process.env.MEDCIUS_TLS_CERT;
  if (keyPath && certPath && existsSync(keyPath) && existsSync(certPath)) {
    return {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    };
  }
  return null;
}

export function startServer(port = 8080, host = "0.0.0.0", options = {}) {
  const server = createServer(options);
  const isTls = Boolean(options.tls || getEnvTlsConfig());
  const protocol = isTls ? "https" : "http";

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" ? addr.port : port;
      console.log(`[Medcius API] Server listening on ${protocol}://${host}:${actualPort}`);
      console.log(`[Medcius API] CDS Hooks Discovery: ${protocol}://${host}:${actualPort}/cds-services`);
      console.log(`[Medcius API] Health Check: ${protocol}://${host}:${actualPort}/health`);
      resolve({ server, port: actualPort, host, isTls, protocol });
    });
    server.on("error", reject);
  });
}
