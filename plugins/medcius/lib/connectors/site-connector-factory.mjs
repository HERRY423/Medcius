// Site connector factory — one validated entry point from site activation
// to a PHI-guarded, read-only connector set for the first-hospital pilot.
//
// Why this exists: deployments previously assembled connectors ad hoc (baseUrl
// here, view names there, salt hardcoded in tests). Every ad-hoc assembly is
// a chance to forget the PHI exit guard, mis-declare requiredKinds, or point
// a token at the wrong origin. This factory makes the safe assembly the only
// assembly: site activation -> channel connectors -> exit guard -> bridge.

import { ReadOnlyHospitalDataBridge } from "../read-only-hospital-data-bridge.mjs";
import { createFhirR4Connectors } from "./fhir-r4-connector.mjs";
import { createCdaDocumentConnector } from "./cda-document-connector.mjs";
import { createViewLibraryConnectors } from "./view-library-connector.mjs";
import { createViewDbConnectors } from './viewdb-connector.mjs';
import { createMappedViewConnectors } from './site-view-mapping.mjs';
import { createHl7v2Connectors } from "./hl7v2-connector.mjs";
import { withPhiExitGuard } from "./phi-exit-guard.mjs";
import { assertSiteActivated } from "../site-activation-gate.mjs";
import { PREROUND_REQUIRED_KINDS } from "../clinical-landing-policy.mjs";

const SYNTHETIC_SALT = "synthetic-exit-guard-salt-0123456789";

function resolveSalt({ salt, live } = {}) {
  const resolved = salt || process.env.CLAUDE_MEDCIUS_PHI_SALT || (live ? null : SYNTHETIC_SALT);
  if (!resolved || typeof resolved !== "string" || resolved.length < 8) {
    throw new Error("SITE_FACTORY_SALT_REQUIRED: set CLAUDE_MEDCIUS_PHI_SALT (>= 8 chars) or pass an explicit salt");
  }
  return resolved;
}

/**
 * Build a guarded connector set for one activated site.
 *
 * @param {object} siteActivation - validated by assertSiteActivated.
 * @param {object} deps - channel bindings injected by deployment:
 *   channel 'fhir-r4' needs { baseUrl, fetchImpl?, headers?, extraKinds? };
 *   channel 'view-library' needs { baseUrl?, queryView?, viewNames?, extraViews? };
 *   channel 'cda' needs { listDocuments, loadDocument };
 *   channel 'hl7v2' needs { listMessages, loadMessage }.
 * @returns {{ site, connectors, requiredKinds, saltFingerprintNote }}
 */
export function createSiteConnectors(siteActivation, deps = {}) {
  const site = assertSiteActivated(siteActivation);
  const live = site.live_hospital_data === true;
  const salt = resolveSalt({ salt: deps.salt, live });
  const sourceVersion = deps.sourceVersion || `site-${site.hospital_id}-v1`;
  const channel = deps.channel || site.readonly_account.system || "view-library";

  if (channel === 'hybrid') {
    if (!Array.isArray(deps.sources) || !deps.sources.length || deps.sources.length > 8
      || deps.sources.some(s => !['viewdb', 'cda', 'hl7v2', 'fhir-r4', 'view-library'].includes(s?.channel))) {
      throw new Error('SITE_FACTORY_HYBRID_SOURCES_INVALID');
    }
    const parts = deps.sources.map(source => createSiteConnectors(siteActivation,
      { ...source.bindings, channel: source.channel, salt, sourceVersion: source.bindings?.sourceVersion || sourceVersion }));
    const connectors = parts.flatMap(p => p.connectors);
    if (new Set(connectors.map(c => c.id)).size !== connectors.length) throw new Error('SITE_FACTORY_DUPLICATE_CONNECTOR');
    const requiredKinds = [...(deps.requiredKinds || PREROUND_REQUIRED_KINDS)];
    if (requiredKinds.some(kind => !connectors.some(c => c.kind === kind))) throw new Error('SITE_FACTORY_REQUIRED_KIND_UNCOVERED');
    return { site, connectors, requiredKinds, channel, sourceVersion, guard: { mode: 'pseudonymize', each_source_guarded: true } };
  }

  let connectors;
  if (channel === "fhir-r4" || channel === "fhir") {
    if (!deps.baseUrl) throw new Error("SITE_FACTORY_FHIR_BASE_URL_REQUIRED");
    connectors = createFhirR4Connectors({
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl,
      headers: deps.headers || {},
      sourceVersion,
      timeoutMs: deps.timeoutMs,
      extraKinds: deps.extraKinds || [],
    });
  } else if (channel === "view-library" || channel === "views") {
    connectors = createViewLibraryConnectors({
      queryView: deps.queryView,
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl,
      headers: deps.headers || {},
      sourceVersion,
      timeoutMs: deps.timeoutMs,
      viewNames: deps.viewNames || {},
      extraViews: deps.extraViews || [],
    });
  } else if (channel === 'viewdb') {
    connectors = deps.mapping ? createMappedViewConnectors({ ...deps, fixedTenantId: site.tenant_id, live })
      : createViewDbConnectors({ ...deps, sourceVersion, fixedTenantId: site.tenant_id });
  } else if (channel === "cda" || channel === "documents") {
    if (live && (!deps.cdaOptions?.patientIdRoot || !deps.cdaOptions?.encounterIdRoot
      || deps.documentMode === 'legacy_narrative')) throw new Error('SITE_FACTORY_CDA_IDENTITY_PROFILE_REQUIRED');
    connectors = [createCdaDocumentConnector({
      listDocuments: deps.listDocuments,
      loadDocument: deps.loadDocument,
      sourceVersion,
      fixedTenantId: site.tenant_id,
      cdaOptions: deps.cdaOptions,
      mode: deps.documentMode,
      timeoutMs: deps.timeoutMs,
      maxDocuments: deps.maxDocuments,
      maxConcurrency: deps.maxConcurrency,
    })];
  } else if (channel === "hl7v2") {
    connectors = createHl7v2Connectors({
      listMessages: deps.listMessages,
      loadMessage: deps.loadMessage,
      sourceVersion,
    });
  } else {
    throw new Error(`SITE_FACTORY_CHANNEL_UNKNOWN: '${channel}' (expected fhir-r4 | view-library | viewdb | cda | hl7v2 | hybrid)`);
  }

  const guarded = connectors.map((connector) => withPhiExitGuard(connector, { salt }));
  const requiredKinds = [...(deps.requiredKinds || PREROUND_REQUIRED_KINDS)]
    .filter((kind) => guarded.some((connector) => connector.kind === kind));

  return {
    site,
    connectors: guarded,
    requiredKinds,
    channel,
    sourceVersion,
    guard: { mode: "pseudonymize", saltFromEnv: !deps.salt && Boolean(process.env.CLAUDE_MEDCIUS_PHI_SALT) },
  };
}

/**
 * Convenience: site activation -> guarded bridge in one call.
 * The bridge still enforces its own fail-closed / required-kind policy.
 */
export function createSiteBridge(siteActivation, deps = {}) {
  const { connectors, requiredKinds, site, channel } = createSiteConnectors(siteActivation, deps);
  const bridge = new ReadOnlyHospitalDataBridge({
    connectors,
    requiredKinds: deps.requiredKinds || requiredKinds,
  });
  return { bridge, site, channel, requiredKinds, connectors };
}
