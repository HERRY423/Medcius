// Medcius RESTful API Routes & Handlers
// Lightweight, pure Node.js HTTP route dispatcher.

import { ClinicalSupervisor } from "../../../orchestrator/supervisor.mjs";
import { CDS_SERVICES, handleCdsHookRequest } from "./cds-hooks.mjs";
import { HANDLERS as auditHandlers } from "../../audit/src/tools.mjs";
import { HANDLERS as chinaCodesHandlers } from "../../china-codes/src/tools.mjs";
import { HANDLERS as drugHandlers } from "../../drug-labels/src/tools.mjs";

const supervisor = new ClinicalSupervisor();

export async function routeRequest(req, res, body) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  // Helper JSON sender
  const sendJson = (status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
    });
    res.end(JSON.stringify(data, null, 2));
  };

  // ----------------------------------------------------
  // CORS Preflight
  // ----------------------------------------------------
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
    });
    return res.end();
  }

  // ----------------------------------------------------
  // Health & Readiness Endpoints
  // ----------------------------------------------------
  if (method === "GET" && (pathname === "/health" || pathname === "/api/v1/health")) {
    const codeStatus = chinaCodesHandlers.corpus_status();
    const drugStatus = drugHandlers.corpus_status();
    const chainStatus = auditHandlers.verify_chain({});

    return sendJson(200, {
      status: "ok",
      version: "0.1.0",
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      production_gate: {
        china_codes_ready: codeStatus.production_ready,
        drug_labels_ready: drugStatus.production_ready,
        audit_chain_verified: chainStatus.ok,
      },
    });
  }

  // ----------------------------------------------------
  // CDS Hooks Endpoints (HL7 FHIR CDS Hooks 1.0/2.0)
  // ----------------------------------------------------
  if (method === "GET" && pathname === "/cds-services") {
    return sendJson(200, { services: CDS_SERVICES });
  }

  if (method === "POST" && pathname.startsWith("/cds-services/")) {
    const serviceId = pathname.replace("/cds-services/", "");
    try {
      const response = await handleCdsHookRequest(serviceId, body);
      return sendJson(200, response);
    } catch (err) {
      return sendJson(500, { error: `CDS Hook execution failed: ${err.message}` });
    }
  }

  // ----------------------------------------------------
  // REST API: Prescription Review
  // ----------------------------------------------------
  if (method === "POST" && pathname === "/api/v1/prescription/review") {
    try {
      const result = await supervisor.reviewPrescription(body || {});
      return sendJson(200, result);
    } catch (err) {
      return sendJson(400, { error: err.message });
    }
  }

  // ----------------------------------------------------
  // REST API: NHSA Coding Resolution
  // ----------------------------------------------------
  if (method === "POST" && pathname === "/api/v1/coding/resolve") {
    try {
      const result = await supervisor.resolveCoding(body || {});
      return sendJson(200, result);
    } catch (err) {
      return sendJson(400, { error: err.message });
    }
  }

  // ----------------------------------------------------
  // REST API: Note Extraction
  // ----------------------------------------------------
  if (method === "POST" && pathname === "/api/v1/note/extract") {
    try {
      const result = await supervisor.extractNote(body || {});
      return sendJson(200, result);
    } catch (err) {
      return sendJson(400, { error: err.message });
    }
  }

  // ----------------------------------------------------
  // REST API: End-to-End Clinical Encounter
  // ----------------------------------------------------
  if (method === "POST" && pathname === "/api/v1/encounter/process") {
    try {
      const result = await supervisor.processEncounter(body || {});
      return sendJson(200, result);
    } catch (err) {
      return sendJson(400, { error: err.message });
    }
  }

  // ----------------------------------------------------
  // REST API: Audit Chain & Signoff
  // ----------------------------------------------------
  if (method === "GET" && pathname === "/api/v1/audit/verify") {
    try {
      const result = auditHandlers.verify_chain({});
      return sendJson(200, result);
    } catch (err) {
      return sendJson(500, { error: err.message });
    }
  }

  if (method === "POST" && pathname === "/api/v1/audit/signoff") {
    try {
      const result = auditHandlers.signoff(body || {});
      return sendJson(200, result);
    } catch (err) {
      return sendJson(400, { error: err.message });
    }
  }

  // ----------------------------------------------------
  // 404 Not Found
  // ----------------------------------------------------
  return sendJson(404, {
    error: `Endpoint not found: ${method} ${pathname}`,
    available_endpoints: [
      "GET /health",
      "GET /cds-services",
      "POST /cds-services/{serviceId}",
      "POST /api/v1/prescription/review",
      "POST /api/v1/coding/resolve",
      "POST /api/v1/note/extract",
      "POST /api/v1/encounter/process",
      "GET /api/v1/audit/verify",
      "POST /api/v1/audit/signoff",
    ],
  });
}
