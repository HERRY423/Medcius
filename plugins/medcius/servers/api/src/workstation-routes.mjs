// Doctor Workstation Routes (医生端内网工作台 REST 面 · 缺口三).
//
// The independent intranet web workstation is the doctor-facing entry that does
// NOT depend on EHR vendors (fastest compliant path per the gap analysis).
// Every workflow endpoint:
//   - requires an authenticated session with the mapped permission (default-closed RBAC);
//   - wraps the engine report with { workflow, payload, payload_digest } so the
//     clinician can sign the EXACT bytes they reviewed (CA adapter);
//   - is governance-stage aware: signing is only possible at Level >= 3
//     (advisory mode), per the D6 release ladder — Level 1/2 get an explicit
//     STAGE_FORBIDDEN instead of a silent success.
// Demo ward data (synthetic cardiology sandbox) is refused outright in production.
// Reports contain only what the engines emit; no PHI is written to the audit
// chain through this layer (signers are pseudonymized by the audit guard).

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PatientEvolutionEngine } from "../../../lib/patient-evolution-engine.mjs";
import { ShiftHandoverEngine } from "../../../lib/shift-handover-engine.mjs";
import { ConsultPreparationEngine } from "../../../lib/consult-preparation-engine.mjs";
import { DischargeReadinessEngine } from "../../../lib/discharge-readiness-engine.mjs";
import { buildRecordQualityReport } from "../../../lib/nhsa-record-quality-engine.mjs";
import { createCaSignatureAdapter } from "../../../lib/ca-signature-adapter.mjs";
import { globalGovernance } from "../../../lib/governance-mode.mjs";
import { HANDLERS as auditHandlers } from "../../audit/src/tools.mjs";
import { computeDecisionDigest } from "../../shared/digital-signature.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProduction = () => process.env.NODE_ENV === "production" || process.env.MEDCIUS_PROFILE === "production";

/** Deployment injection points (hospital directory adapter / CA provider / governance instance). */
let configuredDirectoryAuth = null;
let configuredGovernance = globalGovernance;
let configuredCaAdapter = null;
// Workstation-issued session revocation (logout). The shared JWT verifier cannot
// know about directory revocation, so the workstation layer enforces it here.
const revokedTokens = new Set();

function bearerOf(req) {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

function tokenFingerprint(token) {
  return createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
}

export function setWorkstationDirectoryAuth(directoryAuth) {
  configuredDirectoryAuth = directoryAuth ?? null;
}
export function setWorkstationGovernance(governance) {
  configuredGovernance = governance ?? globalGovernance;
}
export function setWorkstationCaAdapter(adapter) {
  configuredCaAdapter = adapter ?? null;
}

function requireSession(auth, sendJson) {
  if (!auth?.isAuthenticated) {
    sendJson(401, { error: "AUTHENTICATION_REQUIRED: workstation requires a clinician session token." });
    return null;
  }
  return auth;
}

function sandboxFeeds({ bed }) {
  // eslint-disable-next-line import/no-dynamic-require -- fixed synthetic path
  return import("../../../servers/fhir/sandbox/hospital-cardiology-sandbox.mjs").then((mod) => {
    const beds = mod.getCardiologyMultiSourceFeeds();
    if (bed) {
      const match = beds.find((feed) => feed.patient?.bed_number === bed || feed.patient?.id === bed);
      if (!match) throw Object.assign(new Error(`DEMO_BED_NOT_FOUND: ${bed}`), { code: "DEMO_BED_NOT_FOUND" });
      return match;
    }
    return beds[0];
  });
}

async function resolveFeeds(body, sendJson) {
  if (body?.demo_ward) {
    if (isProduction()) {
      sendJson(403, { error: "DEMO_DISABLED_IN_PRODUCTION: synthetic ward feeds are refused in production deployments." });
      return null;
    }
    try {
      return { ...(await sandboxFeeds({ bed: body.bed })), ...pickExplicit(body) };
    } catch (err) {
      sendJson(400, { error: err.message });
      return null;
    }
  }
  if (!body?.patient?.id && !body?.patient_id) {
    sendJson(400, { error: "WORKSTATION_PATIENT_CONTEXT_REQUIRED: provide patient context/feed or demo_ward=true (non-production only)." });
    return null;
  }
  return body;
}

function pickExplicit(body) {
  // Explicit caller-provided arrays override the synthetic feed per key.
  const keys = ["patient", "encounter", "notes", "allergies", "lis", "nis", "pacs", "his_orders", "medications", "diagnosticReports", "orders", "observations"];
  const out = {};
  for (const key of keys) if (body?.[key] !== undefined) out[key] = body[key];
  return out;
}

function reportEnvelope(workflow, payload) {
  return {
    workflow,
    payload,
    payload_digest: computeDecisionDigest(payload),
    signable: true,
    note: "payload_digest 绑定医生所见报告的精确字节；签核即确认该摘要。",
  };
}

const defaultCa = createCaSignatureAdapter();

export function createWorkstationHandler({ directoryAuth = null, governance = null, caAdapter = null } = {}) {
  const ca = () => caAdapter ?? configuredCaAdapter ?? defaultCa;
  const gov = () => governance ?? configuredGovernance ?? globalGovernance;

  return async function handleWorkstationRequest(req, res, { pathname, method, body, auth, sendJson, sendHtml, guardedAuthorize }) {
    // ---- Workstation-issued session revocation gate (logout enforcement) ----
    const bearer = bearerOf(req);
    if (bearer && revokedTokens.has(tokenFingerprint(bearer)) && pathname !== "/workstation/logout") {
      sendJson(401, { error: "AUTH_TOKEN_REVOKED: this workstation session has been logged out." });
      return true;
    }

    // ---- Static workstation UI (pre-auth) ----
    if (method === "GET" && (pathname === "/workstation" || pathname === "/workstation/")) {
      const htmlPath = join(__dirname, "ui", "workstation.html");
      if (existsSync(htmlPath)) return sendHtml(200, readFileSync(htmlPath, "utf8"));
      return sendJson(404, { error: "Workstation UI not found" });
    }

    // ---- Login (pre-auth) ----
    if (method === "POST" && pathname === "/workstation/login") {
      const directory = directoryAuth ?? configuredDirectoryAuth;
      if (!directory) {
        return sendJson(501, { error: "WORKSTATION_DIRECTORY_NOT_CONFIGURED: hospital must inject its directory adapter (see integrations/doctor-workstation/README.md)." });
      }
      try {
        const { session, audit_event } = await directory.login({
          username: body?.username,
          password: body?.password,
          tenantId: body?.tenant_id ?? auth?.tenantId ?? "default",
        });
        try {
          auditHandlers.record_event({ actor: "workstation", action: audit_event.action, subject_ref: audit_event.subject_ref, payload: audit_event.payload });
        } catch { /* audit chain must never block identity decisions */ }
        return sendJson(200, session);
      } catch (err) {
        if (err.audit_event) {
          try {
            auditHandlers.record_event({ actor: "workstation", action: err.audit_event.action, subject_ref: err.audit_event.subject_ref, payload: err.audit_event.payload });
          } catch { /* ignore */ }
        }
        const status = err.code === "AUTH_LOCKED" ? 429 : err.code === "AUTH_DIRECTORY_UNAVAILABLE" ? 503 : 401;
        return sendJson(status, { error: err.message, code: err.code ?? "AUTH_LOGIN_FAILED" });
      }
    }

    // ---- Session introspection (any authenticated clinician) ----
    if (method === "GET" && pathname === "/workstation/session") {
      if (!requireSession(auth, sendJson)) return;
      const stage = gov().getCurrentStage();
      return sendJson(200, {
        clinician: { id: auth.user, roles: auth.roles, tenant_id: auth.tenantId },
        governance: {
          stage_id: stage.id,
          stage_name: stage.name_cn,
          stage_level: stage.level,
          description: stage.description,
          can_sign_reports: stage.level >= 3,
          allows_his_writeback: stage.allows_his_writeback,
          boundary: "Level ≤2 仅研究参考模式：输出仅供回顾性研究/静默比对，不向临床投放。",
        },
      });
    }

    // ---- Logout ----
    if (method === "POST" && pathname === "/workstation/logout") {
      if (bearer) revokedTokens.add(tokenFingerprint(bearer));
      if (configuredDirectoryAuth && bearer) configuredDirectoryAuth.logout(bearer);
      return sendJson(200, { logged_out: true });
    }

    // ---- Governance view ----
    if (method === "GET" && pathname === "/workstation/governance") {
      if (!requireSession(auth, sendJson)) return;
      const stage = gov().getCurrentStage();
      return sendJson(200, {
        current_stage: stage,
        history_length: gov().history?.length ?? null,
        boundary: "治理阶梯由治理委员会决议推进（D6），工作站只读展示。",
      });
    }

    // ---- Workflow endpoints (permission-gated, feed-resolved) ----
    const workflowDefs = [
      {
        path: "/workstation/evolution",
        permission: "round:summary",
        run: (feeds, extra) => PatientEvolutionEngine.analyzePatientEvolution({
          patient: feeds.patient,
          timeWindow: extra.time_window || "24h",
          notes: feeds.notes || [],
          observations: feeds.observations || feeds.lis || [],
          medications: feeds.medications || (feeds.his_orders || []).filter((o) => o.is_medication),
          diagnosticReports: feeds.diagnosticReports || feeds.pacs || [],
          orders: feeds.orders || feeds.his_orders || [],
          allergies: feeds.allergies ?? null,
          nursingFeed: feeds.nursingFeed || feeds.nis || [],
          pacsFeed: feeds.pacsFeed || feeds.pacs || [],
          lisFeed: feeds.lisFeed || feeds.lis || [],
        }),
      },
      {
        path: "/workstation/shift-handover",
        permission: "round:summary",
        run: (feeds, extra) => ShiftHandoverEngine.analyzePatientHandover({
          patient: feeds.patient,
          encounter: feeds.encounter || {},
          notes: feeds.notes || [],
          vitals: feeds.vitals || { vitals_summary: feeds.nis?.vitals_summary, fluid_balance: feeds.nis?.fluid_balance },
          observations: feeds.observations || feeds.lis || [],
          medications: feeds.medications || (feeds.his_orders || []),
          orders: feeds.orders || feeds.his_orders || [],
          allergies: feeds.allergies ?? null,
          shiftType: extra.shift_type,
        }),
      },
      {
        path: "/workstation/consult-preparation",
        permission: "round:summary",
        run: (feeds, extra) => ConsultPreparationEngine.prepareConsultDossier({
          patient: feeds.patient,
          encounter: feeds.encounter || {},
          consultRequest: extra.consult_request || {},
          notes: feeds.notes || [],
          observations: feeds.observations || feeds.lis || [],
          diagnosticReports: feeds.diagnosticReports || feeds.pacs || [],
          medications: feeds.medications || feeds.his_orders || [],
          allergies: feeds.allergies ?? null,
        }),
      },
      {
        path: "/workstation/discharge-readiness",
        permission: "round:summary",
        run: (feeds) => DischargeReadinessEngine.evaluateDischargeReadiness({
          patient: feeds.patient,
          encounter: feeds.encounter || {},
          diagnosticReports: feeds.diagnosticReports || feeds.pacs || [],
          inpatientMedications: feeds.medications || (feeds.his_orders || []).filter((o) => o.is_medication),
          dischargeMedications: feeds.dischargeMedications || [],
          notes: feeds.notes || [],
          allergies: feeds.allergies ?? null,
          financialAccessRecords: feeds.financialAccessRecords || [],
        }),
      },
    ];

    const workflowDef = workflowDefs.find((def) => method === "POST" && pathname === def.path);
    if (workflowDef) {
      if (!requireSession(auth, sendJson)) return;
      const authCheck = guardedAuthorize(workflowDef.permission);
      if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });
      const feeds = await resolveFeeds(body, sendJson);
      if (!feeds) return;
      try {
        const payload = workflowDef.run(feeds, body ?? {});
        return sendJson(200, reportEnvelope(workflowDef.path.replace("/workstation/", ""), payload));
      } catch (err) {
        return sendJson(400, { error: `WORKFLOW_FAILED: ${err.message}`, code: "WORKFLOW_FAILED" });
      }
    }

    // ---- Record quality (病案/结算清单要素核对) ----
    if (method === "POST" && pathname === "/workstation/record-quality") {
      if (!requireSession(auth, sendJson)) return;
      const authCheck = guardedAuthorize("note:extract");
      if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });
      if (typeof body?.note_text !== "string" || !body.note_text.trim()) {
        return sendJson(400, { error: "WORKSTATION_NOTE_TEXT_REQUIRED" });
      }
      try {
        const payload = buildRecordQualityReport(body.note_text, { diagnosis_codes: body.diagnosis_codes ?? [] });
        return sendJson(200, reportEnvelope("record-quality", payload));
      } catch (err) {
        return sendJson(400, { error: `WORKFLOW_FAILED: ${err.message}` });
      }
    }

    // ---- Signoff (CA adapter + governance ladder) ----
    if (method === "POST" && pathname === "/workstation/signoff") {
      if (!requireSession(auth, sendJson)) return;
      const authCheck = guardedAuthorize("workstation:signoff");
      if (!authCheck.allowed) return sendJson(authCheck.status, { error: authCheck.error });
      const stage = gov().getCurrentStage();
      if (stage.level < 3) {
        return sendJson(403, {
          error: `STAGE_FORBIDDEN: 当前治理阶段「${stage.name_cn}」(Level ${stage.level}) 不允许签核投放；仅 Level≥3（建议模式）可对报告完成可验证签核。`,
          code: "STAGE_FORBIDDEN",
          current_stage: stage.id,
        });
      }
      if (!body?.workflow || !body?.payload || !body?.payload_digest) {
        return sendJson(400, { error: "SIGNOFF_REQUEST_INVALID: workflow, payload and payload_digest are required." });
      }
      const digest = computeDecisionDigest(body.payload);
      if (digest !== body.payload_digest) {
        return sendJson(400, { error: "PAYLOAD_DIGEST_MISMATCH: 签核对象与所见报告不一致，拒绝签核。", code: "PAYLOAD_DIGEST_MISMATCH" });
      }
      try {
        const { signature_record, audit_event } = await ca().createSignatureRecord({
          workflow: body.workflow,
          payload: body.payload,
          signerId: auth.user,
          role: (auth.roles ?? [])[0] ?? "clinician",
          tenantId: auth.tenantId ?? "default",
          signerNote: body.signer_note ?? null,
        });
        try {
          auditHandlers.record_event({ actor: "workstation", action: audit_event.action, subject_ref: audit_event.subject_ref, payload: audit_event.payload });
        } catch { /* audit availability must not block verification evidence */ }
        return sendJson(200, signature_record);
      } catch (err) {
        return sendJson(400, { error: `SIGNOFF_FAILED: ${err.message}` });
      }
    }

    // ---- Verify a signature record ----
    if (method === "POST" && pathname === "/workstation/signoff/verify") {
      if (!requireSession(auth, sendJson)) return;
      if (!body?.signature_record) return sendJson(400, { error: "SIGNATURE_RECORD_REQUIRED" });
      const result = await ca().verifySignatureRecord({ record: body.signature_record, payload: body.payload ?? null });
      return sendJson(200, { ...result, verified_at: new Date().toISOString() });
    }

    return false; // not handled → rest-routes continues (404 fallback)
  };
}

export const workstationHandler = createWorkstationHandler();
