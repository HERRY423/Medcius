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
  // FLAGSHIP: Inpatient Pre-Round Patient Evolution Summary
  // ----------------------------------------------------
  if ((method === "GET" || method === "POST") && pathname === "/api/v1/patient/evolution-summary") {
    const authCheck = authorizeRequest(auth, "prescription:review");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    const timeWindow = url.searchParams.get("time_window") || body?.time_window || "24h";
    const patientId = url.searchParams.get("patient_id") || body?.patient_id || "IP-2026-90812";

    try {
      const summary = PatientEvolutionEngine.analyzePatientEvolution({
        patient: body?.patient || {
          id: patientId,
          name: "张** (脱敏)",
          gender: "男",
          age: 65,
          bed_number: "床位 12",
          admission_date: "2026-08-21",
          primary_diagnosis: "冠心病，急性冠脉综合征，2型糖尿病",
        },
        timeWindow,
        notes: body?.notes || [
          {
            id: "note-01",
            title: "病程记录",
            timestamp: new Date().toISOString(),
            text: "病程记录：今日晨起诉胸闷好转，无心悸，体温最高 37.8℃。急诊生化：血肌酐 142 μmol/L，血钾 4.1 mmol/L。",
          },
        ],
        observations: body?.observations || [
          {
            name: "Scr",
            code: "scr",
            value: 142,
            unit: "μmol/L",
            effective_time: new Date().toISOString(),
            report_name: "急诊生化八项",
            referenceRange: [{ low: { value: 59, unit: "μmol/L" }, high: { value: 104, unit: "μmol/L" } }],
            span: "血肌酐 142 μmol/L",
          },
          {
            name: "Scr",
            code: "scr",
            value: 88,
            unit: "μmol/L",
            effective_time: new Date(Date.now() - 48 * 3600000).toISOString(),
            report_name: "入院生化",
            referenceRange: [{ low: { value: 59, unit: "μmol/L" }, high: { value: 104, unit: "μmol/L" } }],
          },
          {
            name: "K",
            code: "k",
            value: 4.1,
            unit: "mmol/L",
            effective_time: new Date().toISOString(),
            report_name: "急诊生化八项",
            referenceRange: [{ low: { value: 3.5, unit: "mmol/L" }, high: { value: 5.3, unit: "mmol/L" } }],
            span: "血钾 4.1 mmol/L",
          },
        ],
        medications: body?.medications || [
          { drug_name: "注射用头孢曲松钠", dosage: "2.0g", route: "ivgtt", frequency: "qd", change_type: "added", authored_on: new Date().toISOString() },
          { drug_name: "呋塞米片", dosage: "20mg", route: "po", frequency: "bid", change_type: "discontinued", end_date: new Date().toISOString(), stop_reason: "水肿消退，停用利尿剂" },
          { drug_name: "硝苯地平控释片", dosage: "60mg", route: "po", frequency: "qd", previous_dosage: "30mg qd", change_type: "adjusted", authored_on: new Date().toISOString() },
        ],
        diagnosticReports: body?.diagnosticReports || [
          { name: "胸部 CT 平扫", status: "preliminary", ordered_at: new Date(Date.now() - 12 * 3600000).toISOString() },
          { name: "血液细菌培养及药敏", status: "registered", ordered_at: new Date(Date.now() - 36 * 3600000).toISOString() },
        ],
        orders: body?.orders || [
          { title: "24小时动态心电图 (Holter)", status: "draft", scheduled_time: "今日 09:30" },
          { title: "肾内科床旁会诊", order_type: "consult", department: "肾内科", purpose: "评估急性肾功能恶化原因", status: "active" },
        ],
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
    const authCheck = authorizeRequest(auth, "prescription:review");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    try {
      const draft = PatientEvolutionEngine.generateProgressNoteDraft({
        summaryData: body?.summaryData || {},
        selectedItemIds: body?.selectedItemIds || [],
        doctorId: auth.user || body?.doctorId || "DOC-8021",
        doctorName: body?.doctorName || "林德明 (主任医师)",
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
