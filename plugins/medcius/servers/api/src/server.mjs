// Medcius HTTP / REST / CDS Hooks Server Entrypoint
// Zero third-party dependencies; uses node:http standard library.

import { createServer as createHttpServer } from "node:http";
import { routeRequest } from "./rest-routes.mjs";

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB limit

export function createServer(options = {}) {
  const server = createHttpServer(async (req, res) => {
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
  });

  return server;
}

export function startServer(port = 8080, host = "0.0.0.0") {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" ? addr.port : port;
      console.log(`[Medcius API] Server listening on http://${host}:${actualPort}`);
      console.log(`[Medcius API] CDS Hooks Discovery: http://${host}:${actualPort}/cds-services`);
      console.log(`[Medcius API] Health Check: http://${host}:${actualPort}/health`);
      resolve({ server, port: actualPort, host });
    });
    server.on("error", reject);
  });
}
