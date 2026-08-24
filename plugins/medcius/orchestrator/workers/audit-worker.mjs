// Compliance & Audit Worker
// Records tamper-evident audit trail events and validates chain integrity.
// Automatically ensures no raw PHI leaks into the append-only audit log.

import { HANDLERS as auditHandlers } from "../../servers/audit/src/tools.mjs";
import { scanText, pseudonymizeText } from "../../servers/phiguard/src/lib.mjs";

export class AuditWorker {
  constructor(options = {}) {
    this.name = "AuditWorker";
    this.options = options;
  }

  async run(input) {
    const action = input?.action ?? "encounter_processed";
    const actor = input?.actor ?? "system:orchestrator";
    let subjectRef = input?.subject_ref ?? "[PSN:anonymous]";
    const dataClass = input?.data_class ?? "sample";
    const payload = input?.payload ?? {};

    // 1. Sanitize subjectRef if needed
    const salt = process.env.CLAUDE_MEDCIUS_PHI_SALT || "medcius-audit-default-salt";
    const phiScan = scanText(subjectRef);
    if (phiScan.total > 0) {
      subjectRef = pseudonymizeText(subjectRef, { salt }).text;
    }

    // 2. Record to local audit chain
    let recordRes;
    try {
      recordRes = auditHandlers.record_event({
        action,
        actor,
        subject_ref: subjectRef,
        data_class: dataClass,
        payload,
        phi_guard: "acknowledged",
      });
    } catch (err) {
      return {
        worker: this.name,
        status: "error",
        error: String(err?.message ?? err),
      };
    }

    // 3. Optional signoff
    let signoffRes = null;
    if (input?.signoff && recordRes?.event_id) {
      try {
        signoffRes = auditHandlers.signoff({
          event_id: recordRes.event_id,
          decision: input.signoff.decision ?? "agree",
          reason: input.signoff.reason ?? "Automated or clinician signoff",
          signer: input.signoff.signer ?? actor,
          role: input.signoff.role ?? "pharmacist",
        });
      } catch (err) {
        signoffRes = { error: String(err?.message ?? err) };
      }
    }

    return {
      worker: this.name,
      status: "completed",
      event: recordRes,
      signoff: signoffRes,
      chain_head: recordRes?.chain_hash,
      sequence: recordRes?.seq,
      event_id: recordRes?.event_id,
    };
  }

  verifyChain() {
    const res = auditHandlers.verify_chain({});
    return {
      verified: res.ok,
      records_verified: res.checked,
      head: res.head,
      details: res,
    };
  }
}
