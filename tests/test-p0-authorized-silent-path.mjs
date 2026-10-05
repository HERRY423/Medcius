// Synthetic adversarial acceptance checks. No hospital or external service is contacted.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.CLAUDE_MEDCIUS_DATA = mkdtempSync(join(tmpdir(), "medcius-authorized-path-"));
process.env.CLAUDE_MEDCIUS_PHI_SALT = Buffer.alloc(16, 0x5a).toString("hex");
process.env.MEDCIUS_PROFILE = "production";
process.env.MEDCIUS_GOVERNANCE_STAGE = "silent_pilot";
process.env.MEDCIUS_JWT_SECRET = Buffer.alloc(32, 0x5a).toString("hex");
delete process.env.MEDCIUS_CLINICAL_LANDING;
delete process.env.MEDCIUS_LIVE_HOSPITAL_DATA;
delete process.env.MEDCIUS_HOSPITAL_SOURCE_MODULE;

const { setAuthorizedHospitalSource, clearAuthorizedHospitalSource, assembleAuthorizedHospitalSourceFromEnv, resolveAuthorizedHospitalSource } = await import("../plugins/medcius/lib/authorized-hospital-source.mjs");
const { HospitalAgentAdapter, getPreRoundResearchSnapshot } = await import("../plugins/medcius/lib/hospital-agent-adapter.mjs");
const { executeHisEmbedPreRound } = await import("../plugins/medcius/lib/his-embed-adapter.mjs");
const { saveFrozenResearchRecord, readFrozenResearchRecord, replayFrozenResearchRecord } = await import("../plugins/medcius/lib/silent-research-archive.mjs");
const { generateToken, extractAuthContext } = await import("../plugins/medcius/servers/api/src/auth-middleware.mjs");
const { routeRequest, resetTransportEdgeGuards } = await import("../plugins/medcius/servers/api/src/rest-routes.mjs");
const { HANDLERS: audit } = await import("../plugins/medcius/servers/audit/src/tools.mjs");
const { getCardiologyMultiSourceFeeds } = await import("../plugins/medcius/servers/fhir/sandbox/hospital-cardiology-sandbox.mjs");
const { loadSpecialtyRulePack } = await import("../plugins/medcius/lib/specialty-rule-pack.mjs");
const AS_OF = "2026-10-04T00:00:00.000Z";
const TENANT = "tenant-synthetic-a";
const requestContext = { patient_id: "synthetic-patient-a", encounter_id: "synthetic-encounter-a" };
const auth = { isAuthenticated: true, tenantId: TENANT, user: "synthetic-doctor-a" };
let readCount = 0;
let lastContext;
const owned = { tenant_id: TENANT, ...requestContext };
const feeds = {
  patient: { id: requestContext.patient_id, tenant_id: TENANT, name: "合成张三", gender: "male" },
  encounter: { id: requestContext.encounter_id, ...owned },
  notes: [{ id: "synthetic-note-a", ...owned, timestamp: "2026-10-03T12:00:00Z", text: "病程记录：患者咳嗽，气促。" }],
  nis: [{ id: "synthetic-nis-a", ...owned, timestamp: "2026-10-03T13:00:00Z", temperature: 37.1 }],
  lis: [], pacs: [], his_orders: [],
};
const bridge = {
  async readPatientSnapshot(context) {
    readCount++;
    lastContext = structuredClone(context);
    return { schema_version: "synthetic-v1", completeness: "complete", source_manifest: [{ connector_id: "synthetic-readonly", kind: "patient" }],
      unavailable_sources: [], degraded_records: [], security_contract: { read_only_enforced: true }, dataFeeds: structuredClone(feeds) };
  },
};
const configure = (overrides = {}) => setAuthorizedHospitalSource({ bridge, tenantId: TENANT, clock: () => AS_OF,
  authorizeContext: async (context) => context.patient_id === requestContext.patient_id && context.encounter_id === requestContext.encounter_id,
  ...overrides });
const physician = generateToken({ sub: auth.user, tenant_id: TENANT, roles: ["physician"] });
const auditor = generateToken({ sub: "synthetic-auditor-a", tenant_id: TENANT, roles: ["auditor"] });
const otherAuditor = generateToken({ sub: "synthetic-auditor-b", tenant_id: "tenant-synthetic-b", roles: ["auditor"] });
async function call(method, url, token, body, tenant = TENANT) {
  resetTransportEdgeGuards();
  const output = {};
  const req = { method, url, headers: { host: "localhost", authorization: `Bearer ${token}`, "x-tenant-id": tenant } };
  await routeRequest(req, { setHeader() {}, writeHead(status) { output.status = status; }, end(value) { output.json = JSON.parse(value); } }, body);
  return output;
}

configure();
for (const [patch, error] of [
  [{ tenant_id: "tenant-synthetic-b" }, "TENANT_ID_MISMATCH"],
  [{ doctor_id: "synthetic-impostor" }, "DOCTOR_ID_MISMATCH"],
  [{ as_of: "2099-01-01T00:00:00Z" }, "SERVER_CONTROLLED_CONTEXT"],
  [{ now: AS_OF }, "SERVER_CONTROLLED_CONTEXT"],
  [{ time_window: "72h" }, "SERVER_CONTROLLED_CONTEXT"],
  [{ specialty_rule_pack_id: "unapproved" }, "SERVER_CONTROLLED_CONTEXT"],
  [{ patient_id: "other-patient" }, "AUTHORIZED_PATIENT_ACCESS_DENIED"],
]) {
  const result = await call("POST", "/api/v1/his/embed/silent-capture", physician, { context: { ...requestContext, ...patch } });
  assert.equal(result.status, 400);
  assert.ok(result.json.error.includes(error), result.json.error);
}
assert.equal(readCount, 0, "denials must happen before reading patient data");
const injection = await call("POST", "/api/v1/his/embed/silent-capture", physician, { context: requestContext, dataFeeds: feeds });
assert.equal(injection.json.error, "CALLER_FEEDS_FORBIDDEN");
configure({ authorizeContext: undefined });
assert.match((await call("POST", "/api/v1/his/embed/silent-capture", physician, { context: requestContext })).json.error, /POLICY_REQUIRED/);
configure({ bridge: { async readPatientSnapshot() { throw new Error("UPSTREAM_UNAVAILABLE: 姓名：张三 电话13800138000"); } } });
assert.equal((await call("POST", "/api/v1/his/embed/silent-capture", physician, { context: requestContext })).json.error, "UPSTREAM_UNAVAILABLE");
configure();
const captured = await call("POST", "/api/v1/his/embed/silent-capture", physician, { context: requestContext });
assert.equal(captured.status, 200, JSON.stringify(captured.json));
assert.equal(captured.json.summary, null);
assert.equal(captured.json.draft, null);
assert.deepEqual(captured.json.cards, []);
assert.equal(captured.json.annotation_summary, undefined);
assert.equal(captured.json.source_bridge.dataFeeds, undefined);
assert.equal(lastContext.doctor_id, auth.user);
assert.equal(lastContext.tenant_id, TENANT);
assert.equal(lastContext.as_of, AS_OF);
assert.equal(lastContext.time_window, "24h");
const caseId = captured.json.research_record_id;
const record = readFrozenResearchRecord(caseId, { tenantId: TENANT });
assert.equal(record.engine_input.now, AS_OF);
assert.equal(record.replay_input.context.as_of, AS_OF);
assert.ok(record.algorithm_identity.sources.some((source) => source.path === "lib/patient-evolution-engine.mjs"));
assert.match(record.algorithm_identity.sources_sha256, /^[a-f0-9]{64}$/);
assert.ok(record.annotation_output.blocks.what_changed.nursing_vitals_summary);
assert.equal(JSON.stringify(record).includes("合成张三"), false);
assert.equal(replayFrozenResearchRecord(caseId, { tenantId: TENANT }).match, true);
const originalNodeVersion = process.versions.node;
let differentRuntimeArchive;
try {
  Object.defineProperty(process.versions, "node", { value: "synthetic-different-runtime", configurable: true });
  differentRuntimeArchive = await import("../plugins/medcius/lib/silent-research-archive.mjs?synthetic-runtime-change");
} finally {
  Object.defineProperty(process.versions, "node", { value: originalNodeVersion, configurable: true });
}
assert.throws(() => differentRuntimeArchive.replayFrozenResearchRecord(caseId, { tenantId: TENANT }), /ALGORITHM_MISMATCH/);
assert.throws(() => readFrozenResearchRecord(caseId), /TENANT_REQUIRED/);
assert.equal(readFrozenResearchRecord(caseId, { tenantId: "tenant-synthetic-b" }), null);
assert.equal((await call("GET", `/api/v1/research/frozen-record?case_id=${caseId}`, physician)).status, 403);
assert.equal((await call("GET", `/api/v1/research/frozen-record?case_id=${caseId}`, otherAuditor, null, "tenant-synthetic-b")).status, 404);
assert.equal((await call("GET", `/api/v1/research/frozen-record?case_id=${caseId}`, auditor)).status, 200);
assert.equal((await call("POST", "/api/v1/research/frozen-record/replay", auditor, { case_id: caseId })).json.match, true);
const repeated = await call("POST", "/api/v1/his/embed/silent-capture", physician, { context: requestContext });
assert.equal(repeated.json.research_record_id, caseId);
assert.equal(readFrozenResearchRecord(caseId, { tenantId: TENANT }).created_at, record.created_at);
assert.equal(repeated.json.record_sha256, captured.json.record_sha256);
const otherResearch = getPreRoundResearchSnapshot(HospitalAgentAdapter.executePreRoundWorkflow({ host: "his_embed",
  context: { ...lastContext, tenant_id: "tenant-synthetic-b" }, dataFeeds: JSON.parse(JSON.stringify(feeds).replaceAll(TENANT, "tenant-synthetic-b")) }));
const savedOther = saveFrozenResearchRecord({ tenantId: "tenant-synthetic-b", patientId: record.patient_id, encounterId: record.encounter_id,
  asOf: AS_OF, governanceStage: record.governance_stage, sourceMode: record.source_mode, sourceManifest: record.source_manifest,
  ...otherResearch });
assert.notEqual(savedOther.case_id, caseId, "identical clinical content in different tenants must not share an archive id");
assert.equal((await call("GET", `/api/v1/research/frozen-record?case_id=${savedOther.case_id}`, otherAuditor, null, "tenant-synthetic-b")).json.error,
  "FROZEN_RECORD_AUDIT_ANCHOR_REQUIRED", "uncommitted archive files cannot be exported");
const model = HospitalAgentAdapter.executePreRoundWorkflow({ host: "his_embed", context: lastContext, dataFeeds: feeds });
assert.equal(model.engine_input, undefined);
assert.equal(model.engine_output, undefined);
assert.equal(model.annotation_summary, undefined);
assert.equal(JSON.stringify(model).includes("合成张三"), false);
const pacsTimed = HospitalAgentAdapter.executePreRoundWorkflow({ host: "his_embed", context: lastContext,
  dataFeeds: { ...feeds, pacs: [
    { id: "pacs-future", ...owned, modality: "CT", name: "胸部CT", status: "final", ordered_at: "2026-10-03T12:00:00Z", study_time: "2099-01-01T00:00:00Z", impression: "未来影像印象不可进入摘要" },
    { id: "pacs-unknown", ...owned, modality: "CT", name: "胸部CT", status: "final", impression: "未知时间印象不可进入摘要" },
    { id: "pacs-current", ...owned, modality: "CT", name: "胸部CT", status: "final", ordered_at: "2026-10-03T12:00:00Z", study_time: "2026-10-03T13:00:00Z", impression: "本窗口影像印象" },
  ] } });
assert.equal(JSON.stringify(pacsTimed.summary.blocks.what_changed).includes("未来影像印象"), false);
assert.equal(JSON.stringify(pacsTimed.summary.blocks.what_changed).includes("未知时间印象"), false);
assert.ok(pacsTimed.summary.blocks.what_changed.imaging_impressions.some((item) => item.impression_summary === "本窗口影像印象"));

// Regression for the complete existing cardiology fixtures: `his_orders.name`
// is a clinical title, and antibiotic-rule names must survive frozen PHI exits.
const sandboxRules = loadSpecialtyRulePack("cardiology-inpatient-sandbox", { production: false });
const cardiologyFixtures = getCardiologyMultiSourceFeeds();
for (const fixture of cardiologyFixtures) {
  const context = { tenant_id: "synthetic-cardiology-regression", doctor_id: "synthetic-doctor", patient_id: fixture.patient.id,
    encounter_id: fixture.encounter?.id || "synthetic-cardiology-encounter", as_of: new Date().toISOString(), clinical_landing: true };
  const computed = HospitalAgentAdapter.executePreRoundWorkflow({ host: "his_embed", context, dataFeeds: fixture, frozenRulePack: sandboxRules });
  const snapshot = getPreRoundResearchSnapshot(computed);
  const frozenFixture = saveFrozenResearchRecord({ tenantId: context.tenant_id, patientId: context.patient_id, encounterId: context.encounter_id,
    asOf: context.as_of, governanceStage: "silent_pilot", sourceMode: "synthetic_replay", ...snapshot });
  assert.equal(replayFrozenResearchRecord(frozenFixture.case_id, { tenantId: context.tenant_id }).match, true);
  if (fixture.his_orders.some((order) => order.name === "24小时动态心电图")) {
    assert.ok(computed.summary.blocks.whats_pending.pending_orders.some((order) => order.order_name === "24小时动态心电图"));
  }
  if (fixture.his_orders.some((order) => order.drug_name === "注射用美罗培南")) {
    assert.ok(computed.summary.blocks.what_changed.antibiotic_duration_alerts.some((alert) => alert.drug_name === "注射用美罗培南"));
  }
}
await assert.rejects(() => executeHisEmbedPreRound({ context: requestContext, authContext: auth }), /AUDIT_REQUIRED/);
await assert.rejects(() => executeHisEmbedPreRound({ context: requestContext, authContext: auth, auditAppend: async () => { throw new Error("synthetic audit unavailable"); } }), /synthetic audit unavailable/);
for (const route of ["/api/v1/patient/evolution-summary", "/api/v1/patient/progress-note-draft", "/workstation/evolution", "/workstation/shift-handover", "/workstation/record-quality"]) {
  assert.equal((await call("POST", route, physician, { patient: feeds.patient, encounter_id: requestContext.encounter_id })).status, 403, route);
}
const defaultTenant = generateToken({ sub: "synthetic", tenant_id: "default", roles: ["auditor"] });
assert.equal(extractAuthContext({ headers: { authorization: `Bearer ${defaultTenant}`, "x-tenant-id": TENANT } }).isAuthenticated, false);
assert.equal(audit.verify_chain({}).ok, true);

const archiveRoot = join(process.env.CLAUDE_MEDCIUS_DATA, "research-archive");
const recordPath = readdirSync(archiveRoot).map((dir) => join(archiveRoot, dir, `${caseId}.json`)).find((path) => { try { readFileSync(path); return true; } catch { return false; } });
const tampered = JSON.parse(readFileSync(recordPath, "utf8"));
tampered.annotation_output.patient.name = "synthetic-tamper";
writeFileSync(recordPath, JSON.stringify(tampered));
assert.throws(() => readFrozenResearchRecord(caseId, { tenantId: TENANT }), /INTEGRITY_FAILED/);
assert.throws(() => replayFrozenResearchRecord(caseId, { tenantId: TENANT }), /INTEGRITY_FAILED/);
assert.equal((await call("GET", `/api/v1/research/frozen-record?case_id=${caseId}`, auditor)).status, 400);
assert.equal((await call("POST", "/api/v1/his/embed/silent-capture", physician, { context: requestContext })).status, 400, "existing corrupted capture is never overwritten");
clearAuthorizedHospitalSource();
assert.equal(await assembleAuthorizedHospitalSourceFromEnv(), null);
process.env.MEDCIUS_LIVE_HOSPITAL_DATA = "1";
await assert.rejects(() => assembleAuthorizedHospitalSourceFromEnv(), /MODULE_REQUIRED/);
delete process.env.MEDCIUS_LIVE_HOSPITAL_DATA;
const bindingsPath = join(process.env.CLAUDE_MEDCIUS_DATA, "synthetic-site-bindings.mjs");
writeFileSync(bindingsPath, `export async function createHospitalSourceBindings() { return {
 siteActivation: { hospital_id: "synthetic-hospital", tenant_id: "${TENANT}", ward_id: "synthetic-ward", irb_protocol_id: "SYNTHETIC-NOT-APPROVAL", data_agreement_sha256: "${"a".repeat(64)}", clinical_surface: "his_embed", governance_stage: "silent_pilot", readonly_account: { username: "synthetic-read", capabilities: ["read"], system: "view-library" } },
 dependencies: { channel: "view-library", queryView: async () => [] }, authorizeContext: async () => false
}; }`);
process.env.MEDCIUS_HOSPITAL_SOURCE_MODULE = bindingsPath;
await assembleAuthorizedHospitalSourceFromEnv();
assert.equal(resolveAuthorizedHospitalSource().tenantId, TENANT);
assert.equal(typeof resolveAuthorizedHospitalSource().bridge.readPatientSnapshot, "function");
clearAuthorizedHospitalSource();
console.log("PASS: authorized silent path, tenant-bound immutable replay archive, and server-owned source assembly (synthetic only; clinical evidence blocked)");
