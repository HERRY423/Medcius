import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

process.env.CLAUDE_MEDCIUS_DATA = mkdtempSync(join(tmpdir(), "medcius-ward-preround-"));
const { setAuthorizedHospitalSource } = await import("../plugins/medcius/lib/authorized-hospital-source.mjs");
const { precomputeWardPreRound } = await import("../plugins/medcius/lib/ward-preround.mjs");
const { ReadOnlyHospitalDataBridge } = await import("../plugins/medcius/lib/read-only-hospital-data-bridge.mjs");
const { GOVERNANCE_STAGES } = await import("../plugins/medcius/lib/governance-mode.mjs");
const { readFrozenResearchRecordAsync } = await import("../plugins/medcius/lib/silent-research-archive.mjs");
const { appendSilentCaptureAudit, appendWardPrecomputeAudit, wardPublicationBeforeDeadline } = await import("../plugins/medcius/servers/audit/src/silent-capture.mjs");
const { HANDLERS: audit, decodeAuditResearchReference } = await import("../plugins/medcius/servers/audit/src/tools.mjs");

const cutoff = "2026-10-04T22:30:00.000Z";
const scope = { tenant_id: "synthetic-tenant", ward_id: "synthetic-ward" };
const member = suffix => ({ ...scope, patient_id: `synthetic-patient-${suffix}`, encounter_id: `synthetic-encounter-${suffix}` });
const roster = (members, asOf = cutoff) => ({ ...scope, as_of: asOf, status: "complete", read_only_enforced: true,
  source_id: "synthetic-his-census", source_version: "fixture-v1", fetched_at: asOf, synchronized_through: asOf, members });
const governance = { getCurrentStage: () => GOVERNANCE_STAGES.SILENT_PILOT };
const siteActivation = { ...scope, hospital_id: "synthetic-hospital", irb_protocol_id: "synthetic-protocol",
  clinical_surface: "his_embed", governance_stage: "silent_pilot", data_agreement_sha256: "f".repeat(64),
  readonly_account: { username: "synthetic-reader", capabilities: ["read"] } };
const auth = { user: "synthetic-round-job", isAuthenticated: true, tenantId: scope.tenant_id };
const setup = (members, options = {}) => ({ siteActivation, governance, auth, timeZone: "Asia/Shanghai", clock: () => cutoff,
  authorizeWard: async arg => arg.ward_id === scope.ward_id,
  loadRoster: async arg => roster(members, arg.as_of), auditAppend: e => appendSilentCaptureAudit(e, "ward-preround"), ...options });

function configure({ reads = [], policy = () => true, onRead = () => {} } = {}) {
  setAuthorizedHospitalSource({ tenantId: scope.tenant_id, authorizeContext: policy,
    clock: () => { throw new Error("Expected the pinned ward clock"); },
    bridge: { async readPatientSnapshot(context) {
      reads.push(context);
      onRead(context);
      const patient = { id: context.patient_id, name: "合成患者姓名" };
      const encounter = { id: context.encounter_id, class: "IMP", status: context.patient_id.endsWith("-closed") ? "finished" : "in-progress",
        ward_id: context.patient_id.endsWith("-outside") ? "different-ward" : scope.ward_id };
      const lis = [{ id: "synthetic-obs", test_name: "血钾", value: 2.6, unit: "mmol/L", status: "final",
        version_id: "v1", is_critical: true, sample_time: "2026-10-04T22:00:00Z", resulted_at: "2026-10-04T22:10:00Z" }];
      return { security_contract: { read_only_enforced: true }, dataFeeds: { patient, encounter, lis }, source_availability: [] };
    } },
  });
}

test("a full ward uses one cutoff and retains source-linked changes and unclosed results in audited records", async () => {
  const reads = [];
  configure({ reads });
  const members = Array.from({ length: 30 }, (_, index) => ({...member(`bed-${index + 1}`),bed_number:String(index+1).padStart(2,"0")}));
  const result = await precomputeWardPreRound(setup(members));
  assert.equal(result.status, "captured");
  assert.equal(result.ward_date, "2026-10-05");
  assert.equal(result.before_deadline, true);
  assert.equal(result.counts.captured, 30);
  assert.equal(result.counts.incomplete_or_unknown_coverage, 30);
  assert.deepEqual([...new Set(reads.map(item => item.as_of))], [cutoff]);
  const entry = result.entries[0];
  assert.match(entry.bed_binding_sha256,/^[0-9a-f]{64}$/);
  assert.equal(entry.bed_number,undefined);
  const output = (await readFrozenResearchRecordAsync(entry.research_record_id, { tenantId: scope.tenant_id })).annotation_output;
  assert.ok(output.blocks.record_changes.items.some(item => item.source_id === "synthetic-obs"));
  assert.ok(output.blocks.high_risk_followup.items.some(item => item.closure_status !== "closed"
    && item.evidence.some(e => e.source_id === "synthetic-obs")));
  assert.equal(entry.worklist_counts.record_changes.new_result, 1);
  assert.ok(entry.worklist_counts.followup_open_or_unknown >= 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-patient|合成患者姓名/);
  const event = await appendWardPrecomputeAudit(result);
  const stored = await audit.get_event({ event_id: event.event_id });
  assert.equal(stored.action, "ward_preround_precompute");
  assert.equal(decodeAuditResearchReference(stored.payload.entries[0].research_record_id), entry.research_record_id);
  assert.equal((await audit.verify_chain({})).ok, true);
});

test("authorization, live-encounter or connector failures are isolated without serializing source errors", async () => {
  const reads = [];
  configure({ reads, policy: member => !member.patient_id.endsWith("-denied"), onRead: member => {
    if (member.patient_id.endsWith("-broken")) throw new Error("source exception: synthetic-sensitive-details");
  } });
  const result = await precomputeWardPreRound(setup([member("denied"), member("broken"), member("closed"), member("outside"), member("ok")]));
  assert.equal(result.status, "partial");
  assert.equal(reads.some(row => row.patient_id === member("denied").patient_id), false);
  assert.deepEqual(result.entries.map(row => row.reason ?? row.status), [
    "AUTHORIZED_PATIENT_ACCESS_DENIED", "WARD_CAPTURE_FAILED", "WARD_ACTIVE_ENCOUNTER_REQUIRED", "WARD_ENCOUNTER_LOCATION_MISMATCH", "captured",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive-details/);
});

test("a stale, partial or cross-ward roster is rejected before patient reads", async () => {
  const reads = [];
  configure({ reads });
  await assert.rejects(precomputeWardPreRound(setup([], { authorizeWard: () => false,
    loadRoster: () => assert.fail("authorization must precede census lookup") })), /WARD_ACCESS_DENIED/);
  for (const receipt of [
    { ...roster([]), status: "partial" }, { ...roster([]), synchronized_through: "2026-10-04T22:29:59Z" },
    roster([{ ...member("a"), ward_id: "other-ward" }]), roster([member("a"), member("a")]),
  ]) await assert.rejects(precomputeWardPreRound(setup([], { loadRoster: () => receipt })), /WARD_ROSTER/);
  assert.equal(reads.length, 0);
  const empty = await precomputeWardPreRound(setup([]));
  assert.equal(empty.status, "captured");
  assert.equal(empty.counts.roster, 0);
});

test("local deadline stops new reads and distinguishes late completion; audit failure prevents capture", async () => {
  let clock = cutoff;
  configure({ onRead: () => { clock = "2026-10-04T23:00:00Z"; } });
  const options = setup([member("a"), member("b")], { clock: () => clock });
  const late = await precomputeWardPreRound(options);
  assert.equal(late.status, "deadline_missed");
  assert.equal(late.before_deadline, false);
  assert.equal(late.entries[1].status, "not_processed");
  await assert.rejects(precomputeWardPreRound(options), /OUTSIDE_MORNING_WINDOW/);
  configure();
  const noAudit = await precomputeWardPreRound(setup([member("no-audit")], { auditAppend() { throw new Error("write failed"); } }));
  assert.equal(noAudit.counts.captured, 0);
  assert.equal(noAudit.entries[0].research_record_id, undefined);
});

test("the ward stops new reads at 07:00 and distinguishes late publication", async () => {
  let clock = cutoff;
  configure();
  await assert.rejects(precomputeWardPreRound(setup([], {
    clock: () => clock,
    authorizeWard: async () => { clock = "2026-10-04T23:00:00Z"; return true; },
    loadRoster: () => assert.fail("no roster read at or after the deadline"),
  })), /WARD_JOB_OUTSIDE_MORNING_WINDOW/);
  const reads = [];
  clock = cutoff;
  configure({ reads, policy: async () => { clock = "2026-10-04T23:00:00Z"; return true; } });
  const late = await precomputeWardPreRound(setup([member("late")], { clock: () => clock }));
  assert.equal(late.status, "deadline_missed");
  assert.equal(late.entries[0].reason, "WARD_JOB_OUTSIDE_MORNING_WINDOW");
  assert.equal(reads.length, 0);

  clock = cutoff;
  const patient = { id: "patient", kind: "patient", capabilities: ["read"], async readPatient(context) {
    clock = "2026-10-04T23:00:00Z";
    return { ...context, source_system: "patient", fetched_at: clock, source_version: "v1", records: [{ id: context.patient_id }] };
  } };
  const encounter = { id: "encounter", kind: "encounter", capabilities: ["read"], async readPatient() {
    reads.push("encounter");
    assert.fail("no second connector read at or after the deadline");
  } };
  setAuthorizedHospitalSource({ tenantId: scope.tenant_id, authorizeContext: () => true,
    bridge: new ReadOnlyHospitalDataBridge({ connectors: [patient, encounter], requiredKinds: ["patient", "encounter"] }) });
  const atCutoff = await precomputeWardPreRound(setup([member("cutoff")], { clock: () => clock }));
  assert.equal(atCutoff.entries[0].reason, "WARD_JOB_OUTSIDE_MORNING_WINDOW");
  assert.equal(atCutoff.status, "deadline_missed");
  assert.deepEqual(reads, []);
  const batch = await precomputeWardPreRound(setup([]));
  assert.equal(wardPublicationBeforeDeadline(batch, "2026-10-04T22:59:59.999Z"), true);
  assert.equal(wardPublicationBeforeDeadline(batch, "2026-10-04T23:00:00Z"), false);
  assert.equal(wardPublicationBeforeDeadline(batch, "2026-10-05T22:30:00Z"), false);
  assert.equal(wardPublicationBeforeDeadline(batch, "2026-10-04T22:29:59Z"), false);
});

test("the live command fails closed without site activation", () => {
  const result = spawnSync(process.execPath, ["scripts/serve.mjs", "--precompute-ward"], {
    env: { ...process.env, MEDCIUS_LIVE_HOSPITAL_DATA: "0" }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WARD_JOB_ACTIVATED_SITE_REQUIRED/);
  assert.equal(result.stdout, "");
});

test("the production-shaped research route checks the batch, chart hashes, role and tenant before release", async () => {
  const oldProfile = process.env.MEDCIUS_PROFILE;
  process.env.MEDCIUS_PROFILE = "production";
  process.env.MEDCIUS_JWT_SECRET = Buffer.alloc(32, 0x44).toString("hex");
  process.env.CLAUDE_MEDCIUS_PHI_SALT = Buffer.alloc(16, 0x5a).toString("hex");
  try {
    configure();
    const batch = await precomputeWardPreRound(setup([member("research-a")]));
    assert.equal(batch.status, "captured");
    const { event_id } = await appendWardPrecomputeAudit(batch);
    const { generateToken } = await import("../plugins/medcius/servers/api/src/auth-middleware.mjs");
    const { routeRequest, resetTransportEdgeGuards } = await import("../plugins/medcius/servers/api/src/rest-routes.mjs");
    async function request(tenant, role, id = event_id) {
      resetTransportEdgeGuards();
      const token = generateToken({ sub: "synthetic-reviewer", tenant_id: tenant, roles: [role] });
      const req = { method: "GET", url: `/api/v1/research/ward-preround?audit_event_id=${id}`,
        headers: { host: "localhost", authorization: `Bearer ${token}`, "x-tenant-id": tenant } };
      const res = {};
      await routeRequest(req, { setHeader() {}, writeHead(status) { res.status = status; }, end(body) { res.body = JSON.parse(body); } });
      return res;
    }
    const { getTodayWardOverview, getWardPreRoundWorklistAsync } = await import("../plugins/medcius/lib/research-review-workflow.mjs");
    const reviewer = { ...auth, roles: ["auditor"] };
    const today = { tenantId:scope.tenant_id, wardId:scope.ward_id, timeZone:"Asia/Shanghai", now:new Date(cutoff) };
    const overview = await getTodayWardOverview(reviewer,today);
    assert.equal(overview.audit_event_id,event_id);
    assert.equal(overview.entries[0].facts,undefined);
    assert.equal(overview.before_deadline,true);
    assert.equal(overview.audit_recorded_before_deadline,false);
    assert.equal(overview.audit_recorded_at,(await audit.get_event({event_id})).ts.replace(" ","T")+"Z");
    await assert.rejects(getTodayWardOverview(reviewer,{...today,now:new Date("2026-10-04T15:59:00Z")}),/NOT_FOUND/);
    const chart = {patient_id:member("research-a").patient_id,encounter_id:member("research-a").encounter_id};
    assert.equal((await getWardPreRoundWorklistAsync(event_id,reviewer,{patientContext:chart})).entries[0].context_match,true);
    await assert.rejects(getWardPreRoundWorklistAsync(event_id,reviewer,{patientContext:{...chart,encounter_id:"foreign"}}),/NOT_FOUND/);
    assert.equal((await request(scope.tenant_id, "physician")).status, 403);
    assert.equal((await request("other-tenant", "auditor")).status, 404);
    const response = await request(scope.tenant_id, "auditor");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.research_only, true);
    assert.ok(response.body.entries[0].facts.some(fact => fact.evidence.source_id === "synthetic-obs"));
    assert.ok(response.body.entries[0].worklist.unclosed_followup.some(item => item.evidence.some(e => e.source_id === "synthetic-obs")));
    assert.doesNotMatch(JSON.stringify(response.body), /合成患者姓名/);
  } finally {
    if (oldProfile === undefined) delete process.env.MEDCIUS_PROFILE;
    else process.env.MEDCIUS_PROFILE = oldProfile;
  }
});
