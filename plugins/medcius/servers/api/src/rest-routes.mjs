import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PatientEvolutionEngine } from "../../../lib/patient-evolution-engine.mjs";
import { CDS_SERVICES, handleCdsHookRequest } from "./cds-hooks.mjs";
import { HANDLERS as auditHandlers } from "../../audit/src/tools.mjs";
import { extractAuthContext, authorizeRequest, ROLES, generateToken } from "./auth-middleware.mjs";
import { globalGovernance } from "../../../lib/governance-mode.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function routeRequest(req, res, body) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  const auth = extractAuthContext(req);
  const isProduction = process.env.NODE_ENV === "production" || process.env.MEDCIUS_PROFILE === "production";
  const isDemoProfile =
    process.env.MEDCIUS_PROFILE === "demo" ||
    url.searchParams.get("profile") === "demo" ||
    url.searchParams.get("demo") === "true";

  // Helper JSON sender
  const sendJson = (status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-Tenant-ID, X-Hospital-Token",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
    });
    res.end(JSON.stringify(data, null, 2));
  };

  // Helper HTML sender
  const sendHtml = (status, html) => {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(html);
  };

  // ----------------------------------------------------
  // CORS Preflight
  // ----------------------------------------------------
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-Tenant-ID, X-Hospital-Token",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
    });
    return res.end();
  }

  // ----------------------------------------------------
  // FLAGSHIP UI: Inpatient Pre-Round EHR Sidebar (HTML)
  // ----------------------------------------------------
  if (method === "GET" && (pathname === "/" || pathname === "/sidebar" || pathname === "/preround" || pathname === "/index.html")) {
    const sidebarPath = join(__dirname, "ui", "preround-sidebar.html");
    if (existsSync(sidebarPath)) {
      const html = readFileSync(sidebarPath, "utf8");
      return sendHtml(200, html);
    }
    return sendJson(404, { error: "Sidebar UI not found" });
  }

  // ----------------------------------------------------
  // Health & Readiness Endpoints
  // ----------------------------------------------------
  if (method === "GET" && (pathname === "/health" || pathname === "/api/v1/health")) {
    const chainStatus = auditHandlers.verify_chain({});
    const govStage = globalGovernance.getCurrentStage();

    return sendJson(200, {
      status: "ok",
      version: "0.2.0-pilot",
      product: "Medcius Inpatient Pre-Round Evolution Summary Plugin",
      profile: isDemoProfile ? "demo" : "production",
      governance_stage: govStage,
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      production_gate: {
        audit_chain_verified: chainStatus.ok,
        fail_closed_mode: true,
        zero_synthetic_spans: true,
        dynamic_lis_ranges: true,
      },
    });
  }

  // ----------------------------------------------------
  // CDS Hooks 2.0: Service Discovery Catalog
  // ----------------------------------------------------
  if (method === "GET" && pathname === "/cds-services") {
    return sendJson(200, { services: CDS_SERVICES });
  }

  // ----------------------------------------------------
  // CDS Hooks 2.0: Hook Execution Endpoint
  // ----------------------------------------------------
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
  // Auth Token Minting (Development & Test Only)
  // ----------------------------------------------------
  if (method === "POST" && pathname === "/api/v1/auth/token") {
    if (isProduction) {
      return sendJson(403, { error: "PROD_SECURITY_REJECT: Direct token issuance endpoint is disabled in production." });
    }
    const token = generateToken(body || {});
    return sendJson(200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
  }

  // ----------------------------------------------------
  // FLAGSHIP: Inpatient Pre-Round Patient Evolution Summary (No Demo Fallback)
  // ----------------------------------------------------
  if ((method === "GET" || method === "POST") && pathname === "/api/v1/patient/evolution-summary") {
    const authCheck = authorizeRequest(auth, "round:summary");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    const timeWindow = url.searchParams.get("time_window") || body?.time_window || "24h";
    const patientId = url.searchParams.get("patient_id") || body?.patient_id || body?.patient?.id;

    // Strict Fail-Closed: patient context or patient_id is mandatory
    if (!patientId && !body?.patient) {
      return sendJson(400, {
        error: "INVALID_PATIENT_CONTEXT: Missing required patient context or patient_id parameter.",
      });
    }

    const patientObj = body?.patient || {
      id: patientId,
      name: `患者 (ID: ${patientId})`,
      gender: "未知",
      age: null,
      bed_number: "未分配床位",
      primary_diagnosis: "待录入主诊断",
    };

    try {
      const summary = PatientEvolutionEngine.analyzePatientEvolution({
        patient: patientObj,
        timeWindow,
        notes: body?.notes || [],
        observations: body?.observations || [],
        medications: body?.medications || [],
        diagnosticReports: body?.diagnosticReports || [],
        orders: body?.orders || [],
        allergies: body?.allergies || null,
      });

      return sendJson(200, summary);
    } catch (err) {
      return sendJson(500, { error: `Patient evolution analysis failed: ${err.message}` });
    }
  }

  // ----------------------------------------------------
  // FLAGSHIP: Insert Selected Summary into Progress Note Draft
  // ----------------------------------------------------
  if (method === "POST" && pathname === "/api/v1/patient/progress-note-draft") {
    const authCheck = authorizeRequest(auth, "round:draft_generate");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    if (!body?.summaryData || !Array.isArray(body?.selectedItemIds)) {
      return sendJson(400, {
        error: "INVALID_DRAFT_REQUEST: Missing required summaryData object or selectedItemIds array.",
      });
    }

    try {
      const draft = PatientEvolutionEngine.generateProgressNoteDraft({
        summaryData: body.summaryData,
        selectedItemIds: body.selectedItemIds,
        doctorId: auth.user || body?.doctorId || "DOC-8021",
        doctorName: body?.doctorName || "查房医师",
        customAdditions: body?.customAdditions || "",
      });
      return sendJson(200, draft);
    } catch (err) {
      return sendJson(400, { error: `Progress note draft generation failed: ${err.message}` });
    }
  }

  // ----------------------------------------------------
  // Audit Verification Endpoint
  // ----------------------------------------------------
  if (method === "GET" && (pathname === "/api/v1/audit/verify" || pathname === "/api/v1/audit/status")) {
    const authCheck = authorizeRequest(auth, "audit:verify");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    const verification = auditHandlers.verify_chain({});
    return sendJson(200, {
      chain_intact: verification.ok,
      verification,
      audited_at: new Date().toISOString(),
    });
  }

  // 404 Fallback
  return sendJson(404, {
    error: `Route not found: ${method} ${pathname}`,
    flagship_available_routes: [
      "GET  /",
      "GET  /sidebar",
      "GET  /health",
      "GET  /cds-services",
      "POST /cds-services/medcius-patient-evolution",
      "GET  /api/v1/patient/evolution-summary",
      "POST /api/v1/patient/progress-note-draft",
      "GET  /api/v1/audit/verify",
      "POST /api/v1/auth/token",
    ],
  });
}
