import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PatientEvolutionEngine } from "../../../lib/patient-evolution-engine.mjs";
import { CDS_SERVICES, handleCdsHookRequest } from "./cds-hooks.mjs";
import { HANDLERS as auditHandlers } from "../../audit/src/tools.mjs";
import { extractAuthContext, authorizeRequest, ROLES, generateToken } from "./auth-middleware.mjs";
import { globalGovernance } from "../../../lib/governance-mode.mjs";
import { createRateLimiter, createBruteForceGuard, clientKey } from "./security-hardening.mjs";
import { workstationHandler } from "./workstation-routes.mjs";
import { executeHisEmbedPreRound } from "../../../lib/his-embed-adapter.mjs";
import { isClinicalLandingEnabled, isLiveHospitalDataEnabled } from "../../../lib/clinical-landing-policy.mjs";
import { loadSiteActivationFromEnv } from "../../../lib/site-activation-gate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Transport-edge hardening singletons (see docs/compliance/SECURITY-ARCHITECTURE.md §4).
const apiRateLimiter = createRateLimiter({});
const tokenBruteGuard = createBruteForceGuard({});

/** Operational/test hook: clear transport-edge state without restarting. */
export function resetTransportEdgeGuards() {
  apiRateLimiter.reset();
  tokenBruteGuard.reset();
}

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

  // Determine allowed origin for CORS
  const requestOrigin = req.headers.origin;
  const allowedOrigins = (process.env.MEDCIUS_ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:8000,http://127.0.0.1:3000,http://127.0.0.1:8000,http://localhost:5173").split(",");
  let corsOrigin = "null";
  if (requestOrigin && (allowedOrigins.includes(requestOrigin) || allowedOrigins.includes("*") || requestOrigin.startsWith("http://localhost:") || requestOrigin.startsWith("http://127.0.0.1:"))) {
    corsOrigin = requestOrigin;
  } else if (!requestOrigin) {
    corsOrigin = "http://localhost:8000";
  }

  // Helper JSON sender
  const sendJson = (status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-Tenant-ID, X-Hospital-Token",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
    });
    res.end(JSON.stringify(data, null, 2));
  };

  // Helper HTML sender
  const sendHtml = (status, html) => {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": corsOrigin,
    });
    res.end(html);
  };

  // ----------------------------------------------------
  // CORS Preflight
  // ----------------------------------------------------
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-Tenant-ID, X-Hospital-Token",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
    });
    return res.end();
  }

  // ----------------------------------------------------
  // REFERENCE WORKFLOW UI: Inpatient Pre-Round EHR Sidebar (HTML)
  // ----------------------------------------------------
  if (method === "GET" && (pathname === "/" || pathname === "/sidebar" || pathname === "/preround" || pathname === "/index.html")) {
    if (isClinicalLandingEnabled()) {
      return sendJson(403, {
        error: "P0_CLINICIAN_SURFACE_SUPPRESSED: doctor-facing sidebar is disabled on the clinical landing surface; use /his/embed silent pilot",
      });
    }
    const sidebarPath = join(__dirname, "ui", "preround-sidebar.html");
    if (existsSync(sidebarPath)) {
      const html = readFileSync(sidebarPath, "utf8");
      return sendHtml(200, html);
    }
    return sendJson(404, { error: "Sidebar UI not found" });
  }

  if (method === "GET" && (pathname === "/his/embed" || pathname === "/his-embed")) {
    const embedPath = join(__dirname, "ui", "his-embed.html");
    if (!existsSync(embedPath)) return sendJson(404, { error: "HIS embed UI not found" });
    const html = readFileSync(embedPath, "utf8");
    const ancestors = process.env.MEDCIUS_HIS_FRAME_ANCESTORS || "'self'";
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `frame-ancestors ${ancestors}`,
      "Access-Control-Allow-Origin": corsOrigin,
    });
    return res.end(html);
  }

  // ----------------------------------------------------
  // Rate limiting & brute-force lockout (health/OPTIONS exempt)
  // ----------------------------------------------------
  const client = clientKey(req, auth);
  if (method !== "OPTIONS" && !(method === "GET" && pathname === "/health")) {
    if (tokenBruteGuard.isLocked(client).locked) {
      const { remainingLockSec } = tokenBruteGuard.isLocked(client);
      res.setHeader("Retry-After", String(remainingLockSec));
      return sendJson(429, {
        error: `BRUTE_FORCE_LOCKOUT: Too many authorization failures. Retry after ${remainingLockSec}s.`,
      });
    }
    const limit = apiRateLimiter.check(client);
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSec));
      return sendJson(429, {
        error: "RATE_LIMIT_EXCEEDED: too many requests in the current window.",
        retry_after_seconds: limit.retryAfterSec,
      });
    }
  }

  // Helper for guarded authorization that feeds the brute-force guard.
  const guardedAuthorize = (action) => {
    const result = authorizeRequest(auth, action);
    if (result.allowed) tokenBruteGuard.recordSuccess(client);
    else tokenBruteGuard.recordFailure(client);
    return result;
  };

  // ----------------------------------------------------
  // Health & Readiness Endpoints
  // ----------------------------------------------------
  if (method === "GET" && (pathname === "/health" || pathname === "/api/v1/health")) {
    const chainStatus = auditHandlers.verify_chain({});
    const govStage = globalGovernance.getCurrentStage();

    return sendJson(200, {
      status: "ok",
      version: "0.7.0-pilot",
      product: "Medcius Inpatient Pre-Round Evolution Summary Plugin",
      profile: isDemoProfile ? "demo" : (process.env.MEDCIUS_PROFILE || (isProduction ? "production" : "development")),
      governance_stage: govStage,
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      production_gate: {
        audit_chain_verified: chainStatus.ok,
        fail_closed_mode: true,
        zero_synthetic_spans: chainStatus.ok,
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
    const authCheck = guardedAuthorize("cds:hook");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

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
    // Brute-force discipline: malformed issuance attempts count as failures.
    if (!body?.sub && !body?.user) {
      const failure = tokenBruteGuard.recordFailure(client);
      return sendJson(400, {
        error: "INVALID_TOKEN_REQUEST: subject (sub/user) is required.",
        failures_recorded: failure.failures,
        locked: failure.locked,
      });
    }
    tokenBruteGuard.recordSuccess(client);
    const token = generateToken(body);
    return sendJson(200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
  }

  // ----------------------------------------------------
  // REFERENCE WORKFLOW: Inpatient Pre-Round Patient Evolution Summary (No Demo Fallback)
  // ----------------------------------------------------
  if (method === "GET" && pathname === "/api/v1/patient/evolution-summary") {
    return sendJson(405, {
      error: "METHOD_NOT_ALLOWED: GET queries carrying patient_id or PHI parameters in URL query strings are prohibited. Use POST with JSON request body.",
    });
  }

  if (method === "POST" && pathname === "/api/v1/patient/evolution-summary") {
    const authCheck = guardedAuthorize("round:summary");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });
    if (isClinicalLandingEnabled()) {
      return sendJson(403, {
        error: "P0_CLINICIAN_SURFACE_SUPPRESSED: evolution-summary clinician payload is disabled on the clinical landing surface; use /api/v1/his/embed/silent-capture",
      });
    }

    const timeWindow = body?.time_window || "24h";
    const patientId = body?.patient_id || body?.patient?.id;
    const encounterId = body?.encounter_id || body?.encounter?.id;

    // Strict Fail-Closed: patient context & encounter_id are mandatory
    if (!patientId && !body?.patient) {
      return sendJson(400, {
        error: "INVALID_PATIENT_CONTEXT: Missing required patient context or patient_id parameter in request body.",
      });
    }
    if (!encounterId) {
      return sendJson(400, {
        error: "INVALID_ENCOUNTER_CONTEXT: Missing required encounter_id parameter under fail-closed security contract.",
      });
    }

    const patientObj = body?.patient ? {
      id: body.patient.id || patientId,
      name: body.patient.name || null,
      gender: body.patient.gender || body.patient.sex_cn || null,
      age: body.patient.age ?? null,
      bed_number: body.patient.bed_number || null,
      primary_diagnosis: body.patient.primary_diagnosis || body.patient.diagnosis || null,
      egfr: body.patient.egfr ?? null,
    } : {
      id: patientId,
      name: null,
      gender: null,
      age: null,
      bed_number: null,
      primary_diagnosis: null,
      egfr: null,
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
        nursingFeed: body?.nursingFeed || body?.nursing || [],
        pacsFeed: body?.pacsFeed || body?.pacs || [],
        lisFeed: body?.lisFeed || body?.lis || [],
      });

      return sendJson(200, summary);
    } catch (err) {
      return sendJson(500, { error: `Patient evolution analysis failed: ${err.message}` });
    }
  }

  // ----------------------------------------------------
  // REFERENCE WORKFLOW: Insert Selected Summary into Progress Note Draft
  // ----------------------------------------------------
  if (method === "POST" && pathname === "/api/v1/his/embed/silent-capture") {
    const authCheck = guardedAuthorize("round:summary");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });
    try {
      const siteActivation = isLiveHospitalDataEnabled() ? loadSiteActivationFromEnv() : null;
      const capture = await executeHisEmbedPreRound({
        host: body?.host === "hospital_sso" ? "hospital_sso" : "his_embed",
        message: body,
        context: body?.context,
        dataFeeds: body?.dataFeeds,
        governance: globalGovernance,
        siteActivation,
        auditAppend: async (event) => {
          auditHandlers.record_event({
            actor: "his-embed",
            action: event.event_type,
            subject_ref: `Encounter/${event.encounter_id}`,
            payload: {
              item_count: event.item_count,
              governance_stage: event.governance_stage,
              envelope_sha256: event.envelope_sha256,
            },
            tenant_id: event.tenant_id,
          });
        },
      });
      return sendJson(200, capture);
    } catch (err) {
      return sendJson(400, { error: err.message, silent: true, cards: [] });
    }
  }

  if (method === "POST" && pathname === "/api/v1/patient/progress-note-draft") {
    const authCheck = guardedAuthorize("round:draft_generate");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });
    if (isClinicalLandingEnabled()) {
      return sendJson(403, {
        error: "P0_DRAFT_SUPPRESSED_SILENT_PILOT: clinician-facing progress-note draft is disabled on the clinical landing surface",
      });
    }

    if (!body?.summaryData || !Array.isArray(body?.selectedItemIds)) {
      return sendJson(400, {
        error: "INVALID_DRAFT_REQUEST: Missing required summaryData object or selectedItemIds array.",
      });
    }

    const resolvedDoctorId = (auth.user && auth.user !== "anonymous") ? auth.user : (body?.doctorId && String(body.doctorId).trim());
    if (!resolvedDoctorId) {
      return sendJson(400, {
        error: "INVALID_DOCTOR_CONTEXT: Missing required doctorId or authenticated physician context under fail-closed audit policy.",
      });
    }
    const resolvedDoctorName = body?.doctorName || auth.payload?.name || resolvedDoctorId;

    try {
      const draft = PatientEvolutionEngine.generateProgressNoteDraft({
        summaryData: body.summaryData,
        selectedItemIds: body.selectedItemIds,
        doctorId: resolvedDoctorId,
        doctorName: resolvedDoctorName,
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
    const authCheck = guardedAuthorize("audit:verify");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    const verification = auditHandlers.verify_chain({});
    return sendJson(200, {
      chain_intact: verification.ok,
      verification,
      audited_at: new Date().toISOString(),
    });
  }

  // ----------------------------------------------------
  // Doctor Workstation (医生端内网工作台 · 缺口三): UI, directory login,
  // governance-aware workflow reports, CA signature signoff.
  // ----------------------------------------------------
  if (pathname === "/workstation" || pathname.startsWith("/workstation/")) {
    const handled = await workstationHandler(req, res, { pathname, method, body, auth, url, sendJson, sendHtml, guardedAuthorize });
    if (handled !== false) return;
  }

  // 404 Fallback
  const referenceWorkflowRoutes = [
    "GET  /",
    "GET  /sidebar",
    "GET  /workstation",
    "GET  /his/embed",
    "POST /api/v1/his/embed/silent-capture",
    "GET  /health",
    "GET  /cds-services",
    "POST /cds-services/medcius-patient-evolution",
    "POST /api/v1/patient/evolution-summary",
    "POST /api/v1/patient/progress-note-draft",
    "GET  /api/v1/audit/verify",
    "POST /api/v1/auth/token",
    "POST /workstation/login",
    "GET  /workstation/session",
    "POST /workstation/evolution",
    "POST /workstation/record-quality",
    "POST /workstation/signoff",
  ];
  return sendJson(404, {
    error: `Route not found: ${method} ${pathname}`,
    reference_workflow_routes: referenceWorkflowRoutes,
    // Backward-compatible response key for existing API consumers.
    flagship_available_routes: referenceWorkflowRoutes,
  });
}
