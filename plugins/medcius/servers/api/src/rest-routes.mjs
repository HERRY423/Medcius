import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ClinicalSupervisor } from "../../../orchestrator/supervisor.mjs";
import { PatientEvolutionEngine } from "../../../lib/patient-evolution-engine.mjs";
import { CDS_SERVICES, handleCdsHookRequest } from "./cds-hooks.mjs";
import { HANDLERS as auditHandlers } from "../../audit/src/tools.mjs";
import { HANDLERS as chinaCodesHandlers } from "../../china-codes/src/tools.mjs";
import { HANDLERS as drugHandlers } from "../../drug-labels/src/tools.mjs";
import { HANDLERS as memoryHandlers } from "../../memory/src/tools.mjs";
import { AnalyticsEngine } from "./analytics-engine.mjs";
import { qcMonitor } from "./qc-monitor.mjs";
import { getTrace, listRecentTraces, AgentTracer, saveTrace } from "./agent-trace.mjs";
import { learningEngine } from "./learning-engine.mjs";
import { extractAuthContext, authorizeRequest, ROLES, generateToken } from "./auth-middleware.mjs";
import { globalGovernance } from "../../../lib/governance-mode.mjs";
import { verifyDecisionSignature } from "../../shared/digital-signature.mjs";
import { checkProduction } from "../../../lib/production-guard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const supervisor = new ClinicalSupervisor();
const analytics = new AnalyticsEngine();

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
  // Inpatient Pre-Round EHR Sidebar & Workbench UI (HTML)
  // ----------------------------------------------------
  if (method === "GET" && (pathname === "/" || pathname === "/sidebar" || pathname === "/preround" || pathname === "/index.html")) {
    const sidebarPath = join(__dirname, "ui", "preround-sidebar.html");
    if (existsSync(sidebarPath)) {
      const html = readFileSync(sidebarPath, "utf8");
      return sendHtml(200, html);
    }
  }

  if (method === "GET" && pathname === "/workbench") {
    const uiPath = join(__dirname, "ui", "workbench.html");
    if (existsSync(uiPath)) {
      const html = readFileSync(uiPath, "utf8");
      return sendHtml(200, html);
    }
  }

  // ----------------------------------------------------
  // Health & Readiness Endpoints
  // ----------------------------------------------------
  if (method === "GET" && (pathname === "/health" || pathname === "/api/v1/health")) {
    const codeStatus = chinaCodesHandlers.corpus_status();
    const drugStatus = drugHandlers.corpus_status();
    const chainStatus = auditHandlers.verify_chain({});
    const govStage = globalGovernance.getCurrentStage();

    return sendJson(200, {
      status: "ok",
      version: "0.2.0",
      product: "Medcius Clinical Intelligence & Assessment Engine",
      profile: isDemoProfile ? "demo" : "production",
      governance_stage: govStage,
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      production_gate: {
        china_codes_ready: codeStatus.production_ready,
        drug_labels_ready: drugStatus.production_ready,
        audit_chain_verified: chainStatus.ok,
        official_counts: {
          codes: codeStatus.counts?.codes?.official ?? 0,
          drug_labels: drugStatus.counts?.official ?? 0,
        },
      },
    });
  }

  // ----------------------------------------------------
  // Agent SSE Streaming Endpoint (Demo vs Production Stream)
  // ----------------------------------------------------
  if (method === "GET" && pathname === "/api/v1/agent/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const sendEvent = (type, data) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const drugsParam = url.searchParams.get("drugs") || "头孢曲松钠,阿奇霉素";
    const drugs = drugsParam.split(",").map((s) => s.trim()).filter(Boolean);

    if (isDemoProfile) {
      // Explicit Demo Profile SSE Simulation
      sendEvent("profile", { mode: "demo", note: "演示模式模拟推理步骤" });
      sendEvent("thinking", { step: "1/5", message: "启动 PHI 隐私卫士，扫描患者个人敏感信息..." });
      await new Promise((r) => setTimeout(r, 100));

      sendEvent("tool_call", { server: "phiguard", tool: "scan", args: { context: "inpatient_order" } });
      await new Promise((r) => setTimeout(r, 100));
      sendEvent("tool_result", { server: "phiguard", findings: 0, status: "CLEAR_PSEUDONYMIZED" });

      sendEvent("thinking", { step: "2/5", message: "执行 Gate 1 患者参数完备性检查 (年龄/体重/肌酐/过敏史)..." });
      await new Promise((r) => setTimeout(r, 150));
      sendEvent("decision", { gate: "G1", status: "PASS", rationale: "成人患者，肌酐及过敏史要素完整" });

      sendEvent("thinking", { step: "3/5", message: `检索药品标签版本库: ${drugs.join(", ")}...` });
      await new Promise((r) => setTimeout(r, 150));
      sendEvent("tool_call", { server: "drug-labels", tool: "search_labels", args: { drugs } });
      sendEvent("tool_result", { server: "drug-labels", matched: drugs.length, snapshot_hash: "9f82d1c0..." });

      sendEvent("thinking", { step: "4/5", message: "执行 Gate 3 安全性矩阵筛查 (DDI/过敏/器官剂量/重复用药)..." });
      await new Promise((r) => setTimeout(r, 150));
      sendEvent("tool_call", { server: "drug-labels", tool: "safety_screen", args: { drugs } });
      sendEvent("tool_result", { server: "drug-labels", verdict: "PASS", flags: [] });

      sendEvent("thinking", { step: "5/5", message: "写入不可篡改审计链并生成结构化临床决策卡片..." });
      await new Promise((r) => setTimeout(r, 100));
      sendEvent("tool_call", { server: "audit", tool: "record_event", args: { action: "rx_review_verdict" } });

      sendEvent("verdict", {
        verdict: "PASS",
        confidence: 0.99,
        summary: "处方审核通过，未检出配伍禁忌、严重相互作用或器官功能不匹配",
        timestamp: new Date().toISOString(),
      });
    } else {
      // Production Real Inference Event Stream
      sendEvent("profile", { mode: "production", note: "生产模式实时推理流" });
      sendEvent("start", { drugs, tenant_id: auth.tenantId, timestamp: new Date().toISOString() });
      try {
        const pharmaRes = await supervisor.pharmaWorker.run({
          drugs,
          include_samples: false,
          tenant_id: auth.tenantId,
        });
        sendEvent("verdict", {
          verdict: pharmaRes.verdict,
          issues_count: pharmaRes.issues?.length || 0,
          g_gates: pharmaRes.g_gates,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        sendEvent("error", { message: err.message });
      }
    }

    res.write("event: done\ndata: {}\n\n");
    return res.end();
  }

  // ----------------------------------------------------
  // Agent Observability & Trace Endpoints
  // ----------------------------------------------------
  if (method === "GET" && pathname === "/api/v1/agent/traces") {
    const traces = listRecentTraces(20);
    return sendJson(200, { total: traces.length, traces });
  }

  if (method === "GET" && pathname === "/api/v1/agent/trace") {
    const id = url.searchParams.get("id");
    const trace = id ? getTrace(id) : null;
    if (!trace) return sendJson(404, { error: `Trace not found: ${id}` });
    return sendJson(200, trace);
  }

  // ----------------------------------------------------
  // Proactive Quality Control Endpoints
  // ----------------------------------------------------
  if (method === "GET" && pathname === "/api/v1/qc/anomalies") {
    const authCheck = authorizeRequest(auth, "qc:view");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    try {
      const hours = Number.parseInt(url.searchParams.get("hours") || "72", 10);
      const result = await qcMonitor.scanForAnomalies({ timeWindowHours: hours });
      return sendJson(200, result);
    } catch (err) {
      return sendJson(500, { error: err.message });
    }
  }

  if (method === "GET" && pathname === "/api/v1/qc/doctor-drift") {
    const authCheck = authorizeRequest(auth, "qc:view");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    try {
      const doc = url.searchParams.get("doctor_id") || "DOC-882";
      const result = await qcMonitor.doctorDriftAlert(doc);
      return sendJson(200, result);
    } catch (err) {
      return sendJson(500, { error: err.message });
    }
  }

  if (method === "GET" && pathname === "/api/v1/qc/recommendations") {
    const authCheck = authorizeRequest(auth, "qc:view");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    try {
      const result = await qcMonitor.generateProactiveRecommendations();
      return sendJson(200, result);
    } catch (err) {
      return sendJson(500, { error: err.message });
    }
  }

  // ----------------------------------------------------
  // Memory & Adaptive Learning Endpoints
  // ----------------------------------------------------
  if (method === "GET" && pathname === "/api/v1/memory/stats") {
    try {
      const result = memoryHandlers.learning_stats();
      return sendJson(200, result);
    } catch (err) {
      return sendJson(500, { error: err.message });
    }
  }

  if (method === "GET" && pathname === "/api/v1/learning/rule-proposals") {
    const authCheck = authorizeRequest(auth, "learning:view");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    try {
      const result = await learningEngine.suggestRuleUpdates();
      return sendJson(200, result);
    } catch (err) {
      return sendJson(500, { error: err.message });
    }
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
          { name: "Scr", code: "scr", value: 142, effective_time: new Date().toISOString(), report_name: "急诊生化八项" },
          { name: "Scr", code: "scr", value: 88, effective_time: new Date(Date.now() - 48 * 3600000).toISOString(), report_name: "入院生化" },
          { name: "K", code: "k", value: 4.1, effective_time: new Date().toISOString(), report_name: "急诊生化八项" },
          { name: "K", code: "k", value: 3.2, effective_time: new Date(Date.now() - 48 * 3600000).toISOString(), report_name: "入院生化" },
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
  // REST API: Prescription Review
  // ----------------------------------------------------
  if (method === "POST" && pathname === "/api/v1/prescription/review") {
    const authCheck = authorizeRequest(auth, "prescription:review");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    const requestedSample = Boolean(body?.include_samples || body?.includeSamples || url.searchParams.get("allow_sample") === "true");
    if (isProduction && requestedSample) {
      return sendJson(403, {
        error: "PROD_SECURITY_REJECT",
        message: "Request cannot enable sample data (include_samples: true) in production environment.",
      });
    }

    const allowSample = !isProduction && requestedSample;
    if (!allowSample) {
      const gate = await checkProduction({ requireLabels: true, requireCodes: false });
      if (!gate.ready) {
        return sendJson(428, {
          error: "PRODUCTION_GATE_HALT",
          message: gate.halt,
          detail: gate,
          hint: "Set include_samples: true for dev/pipeline testing.",
        });
      }
    }

    try {
      const result = await supervisor.reviewPrescription({
        ...body,
        include_samples: allowSample,
        tenant_id: auth.tenantId,
      });
      return sendJson(200, result);
    } catch (err) {
      return sendJson(400, { error: err.message });
    }
  }

  // ----------------------------------------------------
  // REST API: NHSA Coding Resolution
  // ----------------------------------------------------
  if (method === "POST" && pathname === "/api/v1/coding/resolve") {
    const authCheck = authorizeRequest(auth, "coding:resolve");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    const requestedSample = Boolean(body?.include_samples || body?.includeSamples || url.searchParams.get("allow_sample") === "true");
    if (isProduction && requestedSample) {
      return sendJson(403, {
        error: "PROD_SECURITY_REJECT",
        message: "Request cannot enable sample data (include_samples: true) in production environment.",
      });
    }

    const allowSample = !isProduction && requestedSample;
    if (!allowSample) {
      const gate = await checkProduction({ requireLabels: false, requireCodes: true });
      if (!gate.ready) {
        return sendJson(428, {
          error: "PRODUCTION_GATE_HALT",
          message: gate.halt,
          detail: gate,
          hint: "Set include_samples: true for dev/pipeline testing.",
        });
      }
    }

    try {
      const result = await supervisor.resolveCoding({
        ...body,
        include_samples: allowSample,
        tenant_id: auth.tenantId,
      });
      return sendJson(200, result);
    } catch (err) {
      return sendJson(400, { error: err.message });
    }
  }

  // ----------------------------------------------------
  // REST API: Note Extraction
  // ----------------------------------------------------
  if (method === "POST" && pathname === "/api/v1/note/extract") {
    const authCheck = authorizeRequest(auth, "note:extract");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

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
    const authCheck = authorizeRequest(auth, "encounter:process");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    const requestedSample = Boolean(body?.include_samples || body?.includeSamples || url.searchParams.get("allow_sample") === "true");
    if (isProduction && requestedSample) {
      return sendJson(403, {
        error: "PROD_SECURITY_REJECT",
        message: "Request cannot enable sample data (include_samples: true) in production environment.",
      });
    }

    const allowSample = !isProduction && requestedSample;
    if (!allowSample) {
      const gate = await checkProduction({ requireLabels: true, requireCodes: true });
      if (!gate.ready) {
        return sendJson(428, {
          error: "PRODUCTION_GATE_HALT",
          message: gate.halt,
          detail: gate,
          hint: "Set includeSamples: true for dev/pipeline testing.",
        });
      }
    }

    try {
      const result = await supervisor.processEncounter({
        ...body,
        includeSamples: allowSample,
        tenant_id: auth.tenantId,
      });
      return sendJson(200, result);
    } catch (err) {
      return sendJson(400, { error: err.message });
    }
  }

  // ----------------------------------------------------
  // REST API: Audit Chain, Signoff, Verification
  // ----------------------------------------------------
  if (method === "GET" && pathname === "/api/v1/audit/verify") {
    const authCheck = authorizeRequest(auth, "audit:verify");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    try {
      const result = auditHandlers.verify_chain({});
      return sendJson(200, result);
    } catch (err) {
      return sendJson(500, { error: err.message });
    }
  }

  if (method === "POST" && pathname === "/api/v1/audit/verify-signature") {
    try {
      const result = verifyDecisionSignature(body || {});
      return sendJson(200, result);
    } catch (err) {
      return sendJson(400, { error: err.message });
    }
  }

  if (method === "POST" && pathname === "/api/v1/audit/signoff") {
    const authCheck = authorizeRequest(auth, "audit:signoff");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    try {
      const result = auditHandlers.signoff({
        ...body,
        tenant_id: auth.tenantId,
      });
      // Also notify learning engine if override or reject
      if (body?.decision && body.decision !== "agree") {
        learningEngine.processSignoffFeedback({
          auditSeq: result.event_id || 0,
          doctorId: body.doctor_id || auth.user || "DOC-CURRENT",
          department: body.department || "临床科室",
          originalVerdict: body.original_verdict || "FLAG",
          pharmacistVerdict: body.pharmacist_verdict || "PASS",
          signoffType: body.decision,
          rationale: body.reason || "药师临床专业评估放行",
          ruleAffected: body.rule_affected || "GENERAL_RULE",
        }).catch(() => {});
      }
      return sendJson(200, result);
    } catch (err) {
      return sendJson(400, { error: err.message });
    }
  }

  if (method === "GET" && pathname === "/api/v1/audit/events") {
    const authCheck = authorizeRequest(auth, "audit:query");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    try {
      const limit = url.searchParams.get("limit") || 50;
      const action = url.searchParams.get("action") || undefined;
      const actor = url.searchParams.get("actor") || undefined;
      const tenant_id = url.searchParams.get("tenant_id") || (auth.tenantId !== "default" ? auth.tenantId : undefined);
      const result = auditHandlers.query_events({ limit, action, actor, tenant_id });
      return sendJson(200, result);
    } catch (err) {
      return sendJson(500, { error: err.message });
    }
  }

  // ----------------------------------------------------
  // Governance & Stage Progression Endpoints
  // ----------------------------------------------------
  if (method === "GET" && pathname === "/api/v1/governance/status") {
    return sendJson(200, {
      current_stage: globalGovernance.getCurrentStage(),
      history: globalGovernance.history,
    });
  }

  if (method === "POST" && pathname === "/api/v1/governance/advance") {
    const authCheck = authorizeRequest(auth, "governance:advance");
    if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });

    try {
      const result = globalGovernance.advanceStage(body || {});
      return sendJson(200, result);
    } catch (err) {
      return sendJson(400, { error: err.message });
    }
  }

  // ----------------------------------------------------
  // REST API: Doctor Analytics, Benchmarking & CME
  // ----------------------------------------------------
  if (method === "GET" && pathname === "/api/v1/analytics/doctor-quality") {
    try {
      const doctorId = url.searchParams.get("doctor_id") || "DOC-8021";
      const department = url.searchParams.get("department") || "心血管内科";
      const result = analytics.getDoctorQualityMetrics({ doctorId, department });
      return sendJson(200, { ...result, profile: isDemoProfile ? "demo" : "production" });
    } catch (err) {
      return sendJson(400, { error: err.message });
    }
  }

  if (method === "GET" && pathname === "/api/v1/analytics/department-benchmark") {
    try {
      const result = analytics.getDepartmentBenchmarks();
      return sendJson(200, { ...result, profile: isDemoProfile ? "demo" : "production" });
    } catch (err) {
      return sendJson(500, { error: err.message });
    }
  }

  if (method === "GET" && pathname === "/api/v1/analytics/recommendations") {
    try {
      const doctorId = url.searchParams.get("doctor_id") || "DOC-8021";
      const result = analytics.getContinuousImprovementRecommendations({ doctorId });
      return sendJson(200, { ...result, profile: isDemoProfile ? "demo" : "production" });
    } catch (err) {
      return sendJson(400, { error: err.message });
    }
  }

  if (method === "GET" && pathname === "/api/v1/training/cases") {
    try {
      const result = analytics.getTrainingCases();
      return sendJson(200, { ...result, profile: isDemoProfile ? "demo" : "production" });
    } catch (err) {
      return sendJson(500, { error: err.message });
    }
  }

  if (method === "POST" && pathname === "/api/v1/training/submit") {
    try {
      const result = analytics.submitAssessment(body || {});
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
  });
}
