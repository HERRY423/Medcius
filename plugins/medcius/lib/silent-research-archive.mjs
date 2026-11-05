// Tenant-bound, immutable research records for the silent hospital path.
// These are pseudonymized local replay artifacts, not a clinical evidence claim.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { replayPreRoundResearchSnapshot, replayPreRoundResearchSnapshotAsync } from "./hospital-agent-adapter.mjs";
import { containsRawStructuredPhi } from "./clinical-boundary.mjs";
import { assertSyncPhiAllowed } from './production-phi-policy.mjs';
import { guardPatientSourceInput } from './patient-source-phi.mjs';

export const FROZEN_RECORD_SCHEMA = "medcius.frozen-research-record.v2";
export const CODE_VERSION = JSON.parse(readFileSync(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8")).version;
const digest = (value) => sha256Hex(canonicalJson(value));

function loadedAlgorithmIdentity() {
  const root = new URL("../", import.meta.url);
  const files = new Map();
  function visit(url) {
    if (files.has(url.href)) return;
    if (!url.href.startsWith(root.href)) throw new Error("FROZEN_RECORD_ALGORITHM_OUTSIDE_PLUGIN");
    const source = readFileSync(url, "utf8");
    files.set(url.href, { path: decodeURIComponent(url.href.slice(root.href.length)), sha256: sha256Hex(source) });
    for (const match of source.matchAll(/\bfrom\s+["'](\.[^"']+\.mjs)["']/g)) visit(new URL(match[1], url));
  }
  visit(new URL("./hospital-agent-adapter.mjs", import.meta.url));
  visit(new URL("./silent-research-archive.mjs", import.meta.url));
  const sources = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return Object.freeze({ schema: "medcius.replay-algorithm.v1", node_version: process.versions.node,
    sources_sha256: digest(sources), sources });
}
// Bind to the process's loaded implementation. A later code/runtime change
// preserves the record for review but cannot claim an identical replay.
const LOADED_ALGORITHM = loadedAlgorithmIdentity();

function archiveDir(tenantId) {
  if (typeof tenantId !== "string" || !tenantId.trim() || tenantId === "default") throw new Error("FROZEN_RECORD_TENANT_REQUIRED");
  const parent = process.env.CLAUDE_MEDCIUS_DATA
    ?? join(process.env.HOME ?? process.env.USERPROFILE ?? homedir() ?? ".", ".claude", "data", "medcius");
  return join(parent, "research-archive", digest(tenantId));
}

function identity(record) {
  return {
    schema_version: record.schema_version, code_version: record.code_version, algorithm_identity: record.algorithm_identity,
    tenant_id: record.tenant_id, patient_id: record.patient_id, encounter_id: record.encounter_id,
    as_of: record.as_of, governance_stage: record.governance_stage, source_mode: record.source_mode,
    source_manifest: record.source_manifest, unavailable_sources: record.unavailable_sources,
    ...(Object.hasOwn(record, "source_availability") ? { source_availability: record.source_availability } : {}),
    degraded_records: record.degraded_records, failures: record.failures,
    input_sha256: record.input_sha256, replay_input_sha256: record.replay_input_sha256,
    output_sha256: record.output_sha256,
  };
}

function assertIntegrity(record, caseId, tenantId) {
  const { record_sha256: storedDigest, ...unsigned } = record || {};
  if (record?.schema_version !== FROZEN_RECORD_SCHEMA || record.tenant_id !== tenantId || record.case_id !== caseId
      || digest(unsigned) !== storedDigest || digest(record.engine_input) !== record.input_sha256
      || digest(record.replay_input) !== record.replay_input_sha256 || digest(record.annotation_output) !== record.output_sha256
      || `frr-${digest(identity(record)).slice(0, 20)}` !== caseId
      || record.replay_input?.context?.tenant_id !== tenantId || record.replay_input?.context?.as_of !== record.as_of
      || record.replay_input?.context?.patient_id !== record.patient_id || record.replay_input?.context?.encounter_id !== record.encounter_id
      || record.engine_input?.context?.tenant_id !== tenantId
      || digest(record.source_availability || []) !== digest(record.engine_input?.sourceAvailability || [])
      || digest(record.source_availability || []) !== digest(record.replay_input?.sourceAvailability || [])
      || (record.annotation_output?.blocks?.source_availability != null
        && digest(record.source_availability || []) !== digest(record.annotation_output.blocks.source_availability))
      || record.engine_input?.now !== record.as_of) {
    throw new Error("FROZEN_RECORD_INTEGRITY_FAILED");
  }
  // Scan chart/context/source content, not independently recomputed digest
  // metadata: hexadecimal hashes can coincidentally contain phone-like runs.
  const guardedContent = {
    tenant_id: record.tenant_id, patient_id: record.patient_id, encounter_id: record.encounter_id,
    as_of: record.as_of, source_mode: record.source_mode,
    source_manifest: record.source_manifest, unavailable_sources: record.unavailable_sources,
    source_availability: record.source_availability || [],
    degraded_records: record.degraded_records, failures: record.failures,
    engine_input: record.engine_input, replay_input: record.replay_input, annotation_output: record.annotation_output,
  };
  // The structured detector also scans keys and serialized JSON children.
  // Flattening again would lose the validated integrity-field semantics.
  if (containsRawStructuredPhi(guardedContent).hit) throw new Error("FROZEN_RECORD_PHI_REJECTED");
  return record;
}

function prepareRecord({ tenantId, patientId, encounterId, asOf, governanceStage, sourceMode,
  sourceManifest = [], unavailableSources = [], degradedRecords = [], engineInput, engineOutput, replayInput,
  sourceAvailability = replayInput?.sourceAvailability ?? engineInput?.sourceAvailability ?? [], failures = [] } = {}) {
  archiveDir(tenantId);
  if (!engineInput || !engineOutput || !replayInput) throw new Error("FROZEN_RECORD_OUTPUT_REQUIRED");
  if (!patientId || !encounterId || !Number.isFinite(Date.parse(asOf))) throw new Error("FROZEN_RECORD_CONTEXT_REQUIRED");
  // Freeze the actual JSON representation before hashing or replaying it.
  // JavaScript fixtures may contain explicit undefined members; these must
  // become explicit missing values, never invalid `undefined` JSON on disk.
  ({ engineInput, engineOutput, replayInput, sourceManifest, sourceAvailability, unavailableSources, degradedRecords, failures } = JSON.parse(JSON.stringify(
    { engineInput, engineOutput, replayInput, sourceManifest, sourceAvailability, unavailableSources, degradedRecords, failures },
    (_key, value) => value === undefined ? null : value,
  )));
  const record = {
    schema_version: FROZEN_RECORD_SCHEMA, code_version: CODE_VERSION, algorithm_identity: LOADED_ALGORITHM,
    tenant_id: tenantId, patient_id: patientId, encounter_id: encounterId, as_of: asOf,
    governance_stage: governanceStage, source_mode: sourceMode,
    source_manifest: sourceManifest, unavailable_sources: unavailableSources, degraded_records: degradedRecords,
    source_availability: sourceAvailability,
    input_sha256: digest(engineInput), engine_input: engineInput,
    replay_input_sha256: digest(replayInput), replay_input: replayInput,
    annotation_output: engineOutput, output_sha256: digest(engineOutput), failures, replayable: true,
  };
  const caseId = `frr-${digest(identity(record)).slice(0, 20)}`;
  record.case_id = caseId;
  record.created_at = new Date().toISOString();
  record.record_sha256 = digest(record);
  assertIntegrity(record, caseId, tenantId);
  return record;
}

function persistRecord(record) {
  const { case_id: caseId, tenant_id: tenantId } = record;
  const dir = archiveDir(tenantId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let saved = record;
  try {
    writeFileSync(join(dir, `${caseId}.json`), canonicalJson(record), { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw new Error("FROZEN_RECORD_WRITE_FAILED");
    saved = loadFrozenRecord(caseId, { tenantId });
    if (!saved || canonicalJson(identity(saved)) !== canonicalJson(identity(record))) throw new Error("FROZEN_RECORD_COLLISION");
  }
  return { case_id: caseId, record_sha256: saved.record_sha256, output_sha256: saved.output_sha256,
    input_sha256: saved.input_sha256, replayable: true };
}

function loadFrozenRecord(caseId, { tenantId } = {}) {
  const dir = archiveDir(tenantId);
  if (!caseId || !/^frr-[a-f0-9]{20}$/.test(caseId)) return null;
  try {
    return assertIntegrity(JSON.parse(readFileSync(join(dir, `${caseId}.json`), "utf8")), caseId, tenantId);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("FROZEN_RECORD_INTEGRITY_FAILED");
  }
}

export function saveFrozenResearchRecord(args = {}) {
  assertSyncPhiAllowed(args.replayInput?.context);
  const record = prepareRecord(args);
  if (digest(replayPreRoundResearchSnapshot(record.replay_input)) !== record.output_sha256) throw new Error('FROZEN_RECORD_REPLAY_MISMATCH');
  return persistRecord(record);
}

export function readFrozenResearchRecord(caseId, options = {}) {
  assertSyncPhiAllowed();
  return loadFrozenRecord(caseId, options);
}

// Verify the exact frozen representation; never re-anchor or silently rewrite
// an old record when a newer guard finds additional PHI.
async function assertDualGuardedRecord(record, { localPhiDetector, signal } = {}) {
  const context = record.replay_input.context;
  const { input, session } = await guardPatientSourceInput({ context,
    patient: { id: context.patient_id }, encounter: { id: context.encounter_id },
    archive: { engine_input: record.engine_input, replay_input: record.replay_input,
      annotation_output: record.annotation_output, source_manifest: record.source_manifest,
      source_availability: record.source_availability, unavailable_sources: record.unavailable_sources,
      degraded_records: record.degraded_records, failures: record.failures, source_mode: record.source_mode } },
    { detector: localPhiDetector, signal });
  try {
    for (const [key, value] of Object.entries(input.archive)) {
      if (digest(value) !== digest(record[key])) throw new Error('FROZEN_RECORD_PHI_REJECTED');
    }
  } finally { session.dispose(); }
}

export async function saveFrozenResearchRecordAsync(args = {}, options = {}) {
  const record = prepareRecord(args);
  await assertDualGuardedRecord(record, options);
  if (digest(await replayPreRoundResearchSnapshotAsync(record.replay_input, options)) !== record.output_sha256) throw new Error('FROZEN_RECORD_REPLAY_MISMATCH');
  return persistRecord(record);
}

export async function readFrozenResearchRecordAsync(caseId, options = {}) {
  const record = loadFrozenRecord(caseId, options);
  if (record) await assertDualGuardedRecord(record, options);
  return record;
}

export function replayFrozenResearchRecord(caseId, { tenantId } = {}) {
  const record = readFrozenResearchRecord(caseId, { tenantId });
  if (!record) throw new Error("FROZEN_RECORD_NOT_FOUND");
  if (digest(record.algorithm_identity) !== digest(LOADED_ALGORITHM)) throw new Error("FROZEN_RECORD_ALGORITHM_MISMATCH");
  const outputSha = digest(replayPreRoundResearchSnapshot(record.replay_input));
  return { case_id: caseId, replayable: true, match: outputSha === record.output_sha256,
    output_sha256: outputSha, expected_sha256: record.output_sha256, record_sha256: record.record_sha256 };
}

export async function replayFrozenResearchRecordAsync(caseId, options = {}) {
  const record = loadFrozenRecord(caseId, options);
  if (!record) throw new Error('FROZEN_RECORD_NOT_FOUND');
  if (digest(record.algorithm_identity) !== digest(LOADED_ALGORITHM)) throw new Error('FROZEN_RECORD_ALGORITHM_MISMATCH');
  await assertDualGuardedRecord(record, options);
  const outputSha = digest(await replayPreRoundResearchSnapshotAsync(record.replay_input, options));
  return { case_id: caseId, replayable: true, match: outputSha === record.output_sha256,
    output_sha256: outputSha, expected_sha256: record.output_sha256, record_sha256: record.record_sha256 };
}
