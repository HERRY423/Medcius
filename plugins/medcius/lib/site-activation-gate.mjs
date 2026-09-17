// Site activation gate for the first-hospital silent pilot.
// Live hospital data cannot flow until IRB id, signed data-agreement hash,
// and a read-only account are present. Synthetic replay never needs this gate.

import { CLINICAL_SURFACES, HOSPITAL_MAX_GOVERNANCE_STAGE, isLiveHospitalDataEnabled } from "./clinical-landing-policy.mjs";

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
const WRITE_CAPABILITIES = new Set([
  "write",
  "create",
  "update",
  "delete",
  "patch",
  "execute",
  "order",
  "create_resource",
  "update_resource",
  "delete_resource",
  "write_back",
]);

const ALLOWED_STAGES = new Set(["retrospective_study", "silent_pilot"]);

function requireString(value, code) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(code);
  }
  return value.trim();
}

function validateReadonlyAccount(account) {
  if (!account || typeof account !== "object") {
    throw new Error("SITE_ACTIVATION_READONLY_ACCOUNT_REQUIRED");
  }
  requireString(account.username, "SITE_ACTIVATION_READONLY_USERNAME_REQUIRED");
  const capabilities = Array.isArray(account.capabilities)
    ? account.capabilities.map((value) => String(value).toLowerCase())
    : [];
  if (!capabilities.includes("read")) {
    throw new Error("SITE_ACTIVATION_READONLY_READ_CAPABILITY_REQUIRED");
  }
  const writeHit = capabilities.find((value) => WRITE_CAPABILITIES.has(value));
  if (writeHit) {
    throw new Error(`SITE_ACTIVATION_WRITE_ACCOUNT_REJECTED: capability '${writeHit}' is not permitted`);
  }
  if (account.password || account.secret || account.token) {
    throw new Error("SITE_ACTIVATION_SECRET_IN_CONFIG_REJECTED: credentials must come from the hospital secret store, not the activation file");
  }
  return {
    username: account.username.trim(),
    capabilities: ["read"],
    system: account.system || "view_library",
  };
}

/**
 * Validate a site-activation packet. Does not contact the hospital.
 */
export function assertSiteActivated(config = {}) {
  const hospitalId = requireString(config.hospital_id, "SITE_ACTIVATION_HOSPITAL_ID_REQUIRED");
  const tenantId = requireString(config.tenant_id, "SITE_ACTIVATION_TENANT_ID_REQUIRED");
  const wardId = requireString(config.ward_id, "SITE_ACTIVATION_WARD_ID_REQUIRED");
  const irbProtocolId = requireString(config.irb_protocol_id, "SITE_ACTIVATION_IRB_PROTOCOL_ID_REQUIRED");
  const agreementHash = requireString(config.data_agreement_sha256, "SITE_ACTIVATION_DATA_AGREEMENT_HASH_REQUIRED");
  if (!SHA256_HEX_RE.test(agreementHash)) {
    throw new Error("SITE_ACTIVATION_DATA_AGREEMENT_HASH_INVALID: expected 64-char sha256 hex");
  }

  const surface = requireString(config.clinical_surface, "SITE_ACTIVATION_CLINICAL_SURFACE_REQUIRED");
  if (!Object.values(CLINICAL_SURFACES).includes(surface)) {
    throw new Error(
      `SITE_ACTIVATION_CLINICAL_SURFACE_INVALID: '${surface}' is not a clinical surface (his_embed | hospital_sso)`,
    );
  }

  const stage = requireString(config.governance_stage || HOSPITAL_MAX_GOVERNANCE_STAGE, "SITE_ACTIVATION_GOVERNANCE_STAGE_REQUIRED");
  if (!ALLOWED_STAGES.has(stage)) {
    throw new Error(
      `SITE_ACTIVATION_GOVERNANCE_STAGE_BLOCKED: '${stage}' exceeds silent-pilot cap for first-hospital landing`,
    );
  }

  const readonlyAccount = validateReadonlyAccount(config.readonly_account);

  return {
    ok: true,
    hospital_id: hospitalId,
    tenant_id: tenantId,
    ward_id: wardId,
    irb_protocol_id: irbProtocolId,
    data_agreement_sha256: agreementHash.toLowerCase(),
    clinical_surface: surface,
    governance_stage: stage,
    readonly_account: readonlyAccount,
    live_hospital_data: isLiveHospitalDataEnabled(),
  };
}

export function loadSiteActivationFromEnv() {
  if (!isLiveHospitalDataEnabled()) {
    return { ok: false, required: false, reason: "MEDCIUS_LIVE_HOSPITAL_DATA is not set; synthetic replay may run without site activation." };
  }
  return assertSiteActivated({
    hospital_id: process.env.MEDCIUS_HOSPITAL_ID,
    tenant_id: process.env.MEDCIUS_TENANT_ID,
    ward_id: process.env.MEDCIUS_WARD_ID,
    irb_protocol_id: process.env.MEDCIUS_IRB_PROTOCOL_ID,
    data_agreement_sha256: process.env.MEDCIUS_DATA_AGREEMENT_SHA256,
    clinical_surface: process.env.MEDCIUS_CLINICAL_SURFACE,
    governance_stage: process.env.MEDCIUS_GOVERNANCE_STAGE,
    readonly_account: {
      username: process.env.MEDCIUS_READONLY_USERNAME,
      capabilities: ["read"],
      system: process.env.MEDCIUS_READONLY_SYSTEM || "view_library",
    },
  });
}

export function assertLiveHospitalDataAllowed(config) {
  if (!isLiveHospitalDataEnabled()) {
    return { ok: true, live: false };
  }
  return { ok: true, live: true, site: assertSiteActivated(config) };
}
