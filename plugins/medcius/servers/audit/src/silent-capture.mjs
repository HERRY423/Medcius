import { HANDLERS, encodeAuditDigest, encodeAuditResearchReference } from "./tools.mjs";
import { canonicalJson, sha256Hex } from "../../shared/crypto.mjs";
import { createWardMorningClock, wardInstant } from "../../../lib/ward-roster.mjs";

export function appendSilentCaptureAudit(event, actor = "his-embed") {
  const record = encodeAuditResearchReference(event.research_record_id);
  return HANDLERS.record_event({ actor, action: event.event_type, subject_ref: record, tenant_id: event.tenant_id,
    payload: {
      item_count: event.item_count, governance_stage: event.governance_stage,
      envelope_sha256: event.envelope_sha256 == null ? null : encodeAuditDigest(event.envelope_sha256),
      research_record_id: record, output_sha256: encodeAuditDigest(event.output_sha256),
      input_sha256: encodeAuditDigest(event.input_sha256), record_sha256: encodeAuditDigest(event.record_sha256),
    } });
}

export function wardAuditSubject(tenantId, wardId, date) {
  return "ward:" + sha256Hex(canonicalJson([tenantId, wardId, date])).match(/.{2}/g).join(":");
}

export function wardPublicationBeforeDeadline(batch, timestamp) {
  const published = wardInstant(timestamp);
  const finished = wardInstant(batch.finished_at);
  if (published == null || finished == null || published < finished) return false;
  const time = createWardMorningClock(batch.time_zone).at(published);
  return batch.before_deadline === true && time.date === batch.ward_date && time.beforeDeadline;
}

export async function latestWardEvent({ tenantId, wardId, timeZone, now = new Date() }) {
  if (!tenantId || tenantId === "default" || !wardId || !timeZone) throw new Error("WARD_WORKLIST_NOT_FOUND");
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const found = await HANDLERS.query_events({ tenant_id: tenantId, subject_ref: wardAuditSubject(tenantId, wardId, date),
    actor: "ward-preround", action: "ward_preround_precompute", order: "ward_cutoff", ward_as_of: new Date(now).toISOString(), limit: 1 });
  return found.events[0]?.id ?? null;
}

export function appendWardPrecomputeAudit(batch) {
  const { tenant_id, ward_id, as_of } = batch.scope;
  return HANDLERS.record_event({ actor: "ward-preround", action: "ward_preround_precompute", tenant_id,
    subject_ref: wardAuditSubject(tenant_id, ward_id, batch.ward_date),
    payload: { as_of, ward_date: batch.ward_date, time_zone: batch.time_zone, finished_at: batch.finished_at,
      roster_sha256: encodeAuditDigest(batch.roster_sha256), status: batch.status, counts: batch.counts,
      before_deadline: batch.before_deadline, entries: batch.entries.map(({ bed_number, bed_binding_sha256, context_hash, research_record_id, record_sha256, output_sha256, ...entry }) =>
        ({ ...entry, ...(context_hash ? { context_hash: encodeAuditDigest(context_hash) } : {}),
          ...(bed_binding_sha256 ? { bed_binding_sha256: encodeAuditDigest(bed_binding_sha256) } : {}),
          ...(research_record_id == null ? {} : { research_record_id: encodeAuditResearchReference(research_record_id),
            record_sha256: encodeAuditDigest(record_sha256), output_sha256: encodeAuditDigest(output_sha256) }) })) } });
}
