// Read-only interpretation of host-authenticated handover events. No event writes.
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { scanStructuredValue } from "../servers/phiguard/src/lib.mjs";
import { lifecycleTime } from "./record-lifecycle.mjs";

const hash = value => sha256Hex(canonicalJson(value));
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const fail = reason => { throw new Error(`FAIL_CLOSED_HANDOVER_EVENT: ${reason}`); };
const types = new Set(["plan_recorded", "plan_withdrawn", "transfer_proposed", "transfer_accepted", "transfer_declined", "transfer_withdrawn", "acceptance_revoked"]);

export function readHandoverEvents({ events = [], verifyEvent, context, session, eventsAsOf }) {
  if (!Array.isArray(events)) fail("events must be an array");
  if (events.length && typeof verifyEvent !== "function") fail("trusted host event verifier required");
  const unique = new Map();
  for (const original of events) {
    const event = structuredClone(original);
    if (!event || !nonempty(event.event_id) || !types.has(event.type)) fail("invalid event identity or type");
    if (scanStructuredValue(event).total > 0) fail("PHI Guard rejected event");
    for (const key of ["tenant_id", "patient_id", "encounter_id"]) if (event[key] !== context[key]) fail("event context mismatch");
    if (!nonempty(session.handover_id) || event.handover_id !== session.handover_id) fail("handover session mismatch");
    if (!nonempty(session.outgoing_doctor_id) || !nonempty(session.incoming_doctor_id) || session.outgoing_doctor_id === session.incoming_doctor_id) fail("distinct outgoing and incoming identities required");
    if (lifecycleTime(event.occurred_at) == null || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(event.occurred_at) || lifecycleTime(event.occurred_at) > lifecycleTime(eventsAsOf)) fail("event time invalid or after event cutoff");
    const incoming = ["transfer_accepted", "transfer_declined", "acceptance_revoked"].includes(event.type);
    if (event.actor_id !== session[incoming ? "incoming_doctor_id" : "outgoing_doctor_id"]) fail("wrong event actor");
    // A boolean field in request JSON is never authority. The deployment supplies this callback.
    const eventDigest = hash(event);
    if (verifyEvent(structuredClone(event), { digest: eventDigest, context: structuredClone(context) }) !== true) fail("host verification failed");
    const prior = unique.get(event.event_id);
    if (prior && canonicalJson(prior) !== canonicalJson(event)) fail("event ID reused with different content");
    unique.set(event.event_id, event);
  }
  const history = [...unique.values()].sort((a, b) => lifecycleTime(a.occurred_at) - lifecycleTime(b.occurred_at) || a.event_id.localeCompare(b.event_id));
  const lastClock = new Map();
  const plans = new Map();
  for (const event of history) {
    const planEvent = event.type.startsWith("plan_");
    const stream = planEvent ? `plan:${event.plan_id}` : "transfer";
    if (lastClock.get(stream) === lifecycleTime(event.occurred_at)) fail("simultaneous state transitions require unambiguous ordering");
    lastClock.set(stream, lifecycleTime(event.occurred_at));
    if (!planEvent) {
      if (!nonempty(event.packet_digest)) fail("packet digest required");
      continue;
    }
    if (!nonempty(event.plan_id)) fail("plan identity required");
    const previous = plans.get(event.plan_id);
    if (previous && event.supersedes_event_id !== previous.event_id) fail("plan revision must explicitly supersede prior event");
    if (!previous && event.supersedes_event_id != null) fail("plan predecessor missing");
    if (event.type === "plan_withdrawn" && !previous) fail("cannot withdraw absent plan");
    if (event.type === "plan_recorded" && (!nonempty(event.action_text) || (event.trigger_text != null && !nonempty(event.trigger_text)))) fail("doctor plan text required");
    plans.set(event.plan_id, event);
  }
  return { history, plans: [...plans.values()].filter(e => e.type === "plan_recorded").map(e => ({
    plan_id: e.plan_id, trigger_text: e.trigger_text ?? null, action_text: e.action_text,
    author_id: e.actor_id, recorded_at: e.occurred_at, evidence: { source_type: "host_verified_handover_event", source_id: e.event_id, content_sha256: hash(e) },
  })).sort((a, b) => a.plan_id.localeCompare(b.plan_id)) };
}

export function deriveHandoverResponsibility({ history, session, packetDigest, snapshotAsOf }) {
  let proposal = null, acceptance = null, status = "not_proposed";
  for (const event of history.filter(e => !e.type.startsWith("plan_"))) {
    if (event.type === "transfer_proposed") { proposal = event; acceptance = null; status = "awaiting_acceptance"; continue; }
    const target = event.type === "acceptance_revoked" ? acceptance : proposal;
    if (!target || event.target_event_id !== target.event_id || event.packet_digest !== target.packet_digest
      || lifecycleTime(event.occurred_at) <= lifecycleTime(target.occurred_at)) fail("transition is not bound to the current predecessor");
    if (event.type === "transfer_accepted") {
      if (status !== "awaiting_acceptance") fail("proposal no longer pending");
      acceptance = event; status = "accepted_in_source";
    } else if (event.type === "transfer_declined") {
      if (status !== "awaiting_acceptance") fail("proposal no longer pending");
      status = "declined";
    } else if (event.type === "transfer_withdrawn") { status = "withdrawn"; acceptance = null; }
    else if (event.type === "acceptance_revoked") { status = "acceptance_revoked"; acceptance = null; }
  }
  if (proposal && ["awaiting_acceptance", "accepted_in_source"].includes(status)
    && (proposal.packet_digest !== packetDigest || lifecycleTime(proposal.occurred_at) < lifecycleTime(snapshotAsOf))) status = "requires_reconfirmation";
  return { status, outgoing_doctor_id: session.outgoing_doctor_id ?? null, incoming_doctor_id: session.incoming_doctor_id ?? null,
    reported_responsible_doctor_id: status === "accepted_in_source" ? session.incoming_doctor_id : null,
    proposal_event_id: proposal?.event_id ?? null, acceptance_event_id: acceptance?.event_id ?? null,
    accepted_at: status === "accepted_in_source" ? acceptance?.occurred_at : null,
    responsibility_effect: "source_event_only_not_ehr_writeback", clinical_tasks_completed: false,
    boundary: "接班确认仅针对此资料包的责任转交，不代表结果已核对、预案已执行或临床事项完成。" };
}
