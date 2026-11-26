import { CLINICAL_LANDING_SKILL, assertHospitalGovernanceCap } from "./clinical-landing-policy.mjs";
import { resolveAuthorizedHospitalSource } from "./authorized-hospital-source.mjs";
import { assertSiteActivated } from "./site-activation-gate.mjs";
import { globalGovernance } from "./governance-mode.mjs";
import { executeHisEmbedPreRound } from "./his-embed-adapter.mjs";
import { createWardMorningClock, readWardRoster, wardInstant } from "./ward-roster.mjs";
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { deepFreeze } from "../servers/shared/immutable.mjs";

const captureFailures = new Set(["AUTHORIZED_PATIENT_ACCESS_DENIED", "WARD_ACTIVE_ENCOUNTER_REQUIRED", "WARD_ENCOUNTER_LOCATION_MISMATCH",
  "WARD_JOB_OUTSIDE_MORNING_WINDOW"]);

// Opt-in batch for the hospital's scheduled process. The host supplies the
// read-only census, authenticated job identity, and existing audit sink.
export async function precomputeWardPreRound({ siteActivation, auth, authorizeWard, loadRoster, timeZone,
  auditAppend, governance = globalGovernance, clock = () => new Date().toISOString(), localPhiDetector, signal } = {}) {
  const site = assertSiteActivated(siteActivation);
  const stage = governance.getCurrentStage();
  assertHospitalGovernanceCap(stage);
  if (stage.id !== site.governance_stage || stage.allows_live_alerts) throw new Error("WARD_GOVERNANCE_STAGE_MISMATCH");
  const source = resolveAuthorizedHospitalSource();
  if (auth?.isAuthenticated !== true || typeof auth.user !== "string" || !auth.user.trim()
      || auth.tenantId !== site.tenant_id || source.tenantId !== site.tenant_id || site.tenant_id === "default") {
    throw new Error("WARD_JOB_IDENTITY_REQUIRED");
  }
  if ([authorizeWard, loadRoster, auditAppend].some(fn => typeof fn !== "function")) throw new Error("WARD_JOB_BINDINGS_REQUIRED");
  const localTime = createWardMorningClock(timeZone);
  const readClock = () => {
    const ms = wardInstant(clock());
    if (ms == null) throw new Error("WARD_JOB_CLOCK_INVALID");
    return ms;
  };
  const started = readClock();
  const businessDate = localTime.at(started).date;
  const beforeDeadline = ms => {
    const time = localTime.at(ms);
    return ms >= started && time.date === businessDate && time.beforeDeadline;
  };
  const assertReadWindow = (now = readClock()) => {
    signal?.throwIfAborted();
    if (!beforeDeadline(now)) throw new Error("WARD_JOB_OUTSIDE_MORNING_WINDOW");
  };
  assertReadWindow(started);

  const scope = { tenant_id: site.tenant_id, ward_id: site.ward_id, as_of: new Date(started).toISOString() };
  if (await authorizeWard({ ...scope }, auth, { signal }) !== true) throw new Error("WARD_ACCESS_DENIED");
  assertReadWindow();
  const roster = await loadRoster({ ...scope }, auth, { signal });
  const members = readWardRoster(roster, scope);
  // Roster digests and case references can be stored without raw member IDs.
  const rosterDigest = sha256Hex(canonicalJson({ ...scope, source_id: roster.source_id,
    version: roster.source_version, synchronized_through: roster.synchronized_through, members }));
  const entries = [];
  for (const [index, member] of members.entries()) {
    const chart = [scope.tenant_id, member.patient_id, member.encounter_id];
    const coordinate = { position: index + 1, context_hash: sha256Hex(canonicalJson(chart)),
      ...(member.bed_number ? { bed_binding_sha256: sha256Hex(canonicalJson(["medcius.ward-bed.v1", ...chart, scope.as_of, member.bed_number])) } : {}) };
    if (signal?.aborted || !beforeDeadline(readClock())) {
      entries.push({ ...coordinate, status: "not_processed" });
      continue;
    }
    let worklistCounts;
    try {
      const captured = await executeHisEmbedPreRound({ host: site.clinical_surface, context: member, governance, siteActivation: site,
        authContext: auth, captureAsOf: scope.as_of, localPhiDetector, signal,
        beforeSourceRead: assertReadWindow,
        auditAppend: async event => { await auditAppend(event); worklistCounts = event.worklist_counts; } });
      entries.push({ ...coordinate, status: "captured", research_record_id: captured.research_record_id,
        record_sha256: captured.record_sha256, output_sha256: captured.output_sha256, worklist_counts: worklistCounts,
        source_coverage: captureCoverage(captured.source_bridge?.source_availability, started) });
    } catch (error) {
      entries.push({ ...coordinate, status: "capture_failed", reason: captureFailures.has(error?.message) ? error.message : "WARD_CAPTURE_FAILED" });
    }
  }
  const finished = readClock();
  const counts = { roster: members.length, captured: entries.filter(e => e.status === "captured").length,
    failed: entries.filter(e => e.status === "capture_failed").length, not_processed: entries.filter(e => e.status === "not_processed").length,
    incomplete_or_unknown_coverage: entries.filter(e => e.source_coverage === "incomplete_or_unknown").length };
  const status = signal?.aborted ? "interrupted" : !beforeDeadline(finished) ? "deadline_missed" :
    counts.captured === counts.roster ? "captured" : "partial";
  return deepFreeze({ schema_version: "medcius.ward-preround-precompute.v1", skill_id: CLINICAL_LANDING_SKILL,
    scope, roster_sha256: rosterDigest, ward_date: businessDate, time_zone: localTime.timeZone,
    finished_at: new Date(finished).toISOString(), before_deadline: beforeDeadline(finished), status, counts, entries,
    silent: true, writeback: false });
}

function captureCoverage(sources, cutoff) {
  const complete = sources?.length && sources.every(source => {
    const synchronized = wardInstant(source.synchronized_through), fetched = wardInstant(source.fetched_at);
    return ["available", "available_empty"].includes(source.status) && source.query_read_complete === true
      && synchronized != null && fetched != null && synchronized >= cutoff && fetched >= synchronized;
  });
  return complete ? "connector_reported" : "incomplete_or_unknown";
}
