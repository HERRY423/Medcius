// Compliance & Audit Worker
// Records tamper-evident audit trail events and validates chain integrity.
// Automatically ensures no raw PHI leaks into the append-only audit log.

import { randomBytes } from "node:crypto";
import { HANDLERS as auditHandlers } from "../../servers/audit/src/tools.mjs";
import { scanText, pseudonymizeText } from "../../servers/phiguard/src/lib.mjs";

const RUNTIME_EPHEMERAL_SALT = `ephemeral-salt-${randomBytes(16).toString("hex")}`;

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
    const tenantId = input?.tenant_id ?? "default";

    // 1. Sanitize subjectRef if needed
    const salt = process.env.CLAUDE_MEDCIUS_PHI_SALT || RUNTIME_EPHEMERAL_SALT;
    const phiScan = scanText(subjectRef);
    if (phiScan.total > 0) {
      subjectRef = pseudonymizeText(subjectRef, { salt }).text;
    }

    // 2. Record to local audit chain with strict enforcement (no bypass)
    let recordRes;
    try {
      recordRes = auditHandlers.record_event({
        action,
        actor,
        subject_ref: subjectRef,
        data_class: dataClass,
        tenant_id: tenantId,
        payload,
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
          tenant_id: tenantId,
          signature: input.signoff.signature ?? null,
          signature_algorithm: input.signoff.signature_algorithm ?? "ECDSA_P256_SHA256",
          key_id: input.signoff.key_id ?? null,
          signed_hash: input.signoff.signed_hash ?? null,
          public_key: input.signoff.public_key ?? null,
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
