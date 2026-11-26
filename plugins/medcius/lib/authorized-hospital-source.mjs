// Deployment-owned, read-only source assembly. Request bodies never select
// connectors, tenants, identities, rules, or the capture clock.
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { isLiveHospitalDataEnabled, PREROUND_REQUIRED_KINDS } from "./clinical-landing-policy.mjs";
import { createSiteBridge } from "./connectors/site-connector-factory.mjs";
import { loadSiteActivationFromEnv } from "./site-activation-gate.mjs";
import { resolvePhiDetector } from "./phi-runtime.mjs";

let injected = null;

export function setAuthorizedHospitalSource(source) {
  if (source == null) { injected = null; return null; }
  const bridge = source.bridge || source;
  if (typeof bridge.readPatientSnapshot !== "function") throw new Error("AUTHORIZED_SOURCE_REQUIRED");
  injected = Object.freeze({
    bridge,
    tenantId: source.tenantId || source.site?.tenant_id || null,
    authorizeContext: source.authorizeContext,
    timeZone: source.timeZone ?? process.env.MEDCIUS_WARD_TIME_ZONE ?? null,
    clock: source.clock || (() => new Date().toISOString()),
    timeWindow: source.timeWindow || "24h",
    specialtyRulePackId: source.specialtyRulePackId || null,
  });
  return injected;
}

export function clearAuthorizedHospitalSource() { injected = null; }

export function isProductionProfile() {
  return process.env.NODE_ENV === "production" || process.env.MEDCIUS_PROFILE === "production";
}

export function isFormalHospitalPath(stageId, { useAuthorizedSource = false } = {}) {
  if (useAuthorizedSource || injected || isLiveHospitalDataEnabled()) return true;
  return isProductionProfile();
}

export function resolveAuthorizedHospitalSource() {
  if (injected?.bridge) return { ...injected, mode: "authorized_source" };
  throw new Error(isLiveHospitalDataEnabled() ? "AUTHORIZED_SOURCE_NOT_ASSEMBLED" : "AUTHORIZED_SOURCE_REQUIRED");
}

export async function resolveAuthorizedCaptureContext({ auth, requestedContext = {}, source = resolveAuthorizedHospitalSource(), captureAsOf }) {
  if (!auth?.isAuthenticated || !auth.user || !auth.tenantId || auth.tenantId === "default") {
    throw new Error("AUTHORIZED_CAPTURE_IDENTITY_REQUIRED");
  }
  if (!source.tenantId || source.tenantId !== auth.tenantId) throw new Error("AUTHORIZED_SOURCE_TENANT_MISMATCH");
  if (typeof source.authorizeContext !== "function") throw new Error("AUTHORIZED_CONTEXT_POLICY_REQUIRED");
  for (const [field, expected] of [["tenant_id", auth.tenantId], ["doctor_id", auth.user]]) {
    if (requestedContext[field] != null && requestedContext[field] !== expected) throw new Error(`AUTHORIZED_CAPTURE_${field.toUpperCase()}_MISMATCH`);
  }
  for (const field of ["as_of", "now", "time_window", "specialty_rule_pack_id", "profile"]) {
    if (requestedContext[field] != null) throw new Error(`SERVER_CONTROLLED_CONTEXT: ${field}`);
  }
  for (const field of ["patient_id", "encounter_id"]) {
    if (typeof requestedContext[field] !== "string" || !requestedContext[field].trim()) throw new Error(`AUTHORIZED_CAPTURE_${field.toUpperCase()}_REQUIRED`);
  }
  if (!["24h", "72h"].includes(source.timeWindow)) throw new Error("AUTHORIZED_SOURCE_TIME_WINDOW_INVALID");
  // Only the scheduled service can pin a shared cut across authorized captures.
  const asOf = captureAsOf ?? source.clock();
  if (typeof asOf !== "string" || !Number.isFinite(Date.parse(asOf))) throw new Error("AUTHORIZED_SOURCE_CLOCK_INVALID");
  const context = {
    tenant_id: auth.tenantId,
    doctor_id: auth.user,
    patient_id: requestedContext.patient_id,
    encounter_id: requestedContext.encounter_id,
    time_window: source.timeWindow,
    ...(source.timeZone ? { timezone: source.timeZone } : {}),
    specialty_rule_pack_id: source.specialtyRulePackId,
    as_of: new Date(asOf).toISOString(),
    clinical_landing: true,
  };
  if (await source.authorizeContext({ ...context }, auth) !== true) throw new Error("AUTHORIZED_PATIENT_ACCESS_DENIED");
  return context;
}

// The module path is operator-controlled environment configuration, never an
// HTTP parameter. Deployment bindings supply credentials and access checks.
export async function assembleAuthorizedHospitalSourceFromEnv() {
  const modulePath = process.env.MEDCIUS_HOSPITAL_SOURCE_MODULE;
  if (!modulePath) {
    if (isLiveHospitalDataEnabled()) throw new Error("AUTHORIZED_SOURCE_MODULE_REQUIRED");
    return null;
  }
  if (!isAbsolute(modulePath)) throw new Error("AUTHORIZED_SOURCE_MODULE_ABSOLUTE_PATH_REQUIRED");
  const siteActivation = loadSiteActivationFromEnv();
  if (siteActivation.live_hospital_data) {
    await resolvePhiDetector({ context: { tenant_id: siteActivation.tenant_id } });
  }
  const binding = await import(pathToFileURL(modulePath).href);
  if (typeof binding.createHospitalSourceBindings !== "function") throw new Error("AUTHORIZED_SOURCE_BINDINGS_REQUIRED");
  const config = await binding.createHospitalSourceBindings({ siteActivation });
  if (typeof config?.authorizeContext !== "function") throw new Error("AUTHORIZED_CONTEXT_POLICY_REQUIRED");
  const { bridge, site } = createSiteBridge(config.siteActivation || siteActivation, {
    ...config.dependencies,
    requiredKinds: [...PREROUND_REQUIRED_KINDS],
  });
  if (siteActivation.live_hospital_data && site.tenant_id !== siteActivation.tenant_id) {
    throw new Error("AUTHORIZED_SOURCE_TENANT_MISMATCH");
  }
  return setAuthorizedHospitalSource({
    bridge, site, authorizeContext: config.authorizeContext,
    timeWindow: config.timeWindow, timeZone: config.timeZone, specialtyRulePackId: config.specialtyRulePackId,
  });
}
