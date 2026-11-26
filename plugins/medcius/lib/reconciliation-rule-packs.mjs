// Explicit, research-only rule pack inspection. This is not a grouper,
// diagnosis/coding assistant, payment calculation or compliance adjudicator.
import { readFileSync } from 'node:fs';
import { canonicalJson, sha256Hex } from '../servers/shared/crypto.mjs';
import { deepFreeze } from '../servers/shared/immutable.mjs';
import { assertRecordEvidenceReview } from './record-evidence-reconciliation.mjs';
import { validDate } from './terminology-crosswalk.mjs';
import { requiresProductionPhi } from './production-phi-policy.mjs';

const registryBytes = readFileSync(new URL('../config/groupers/regional-rule-registry.v1.json', import.meta.url));
const registry = JSON.parse(registryBytes);
const hash = x => sha256Hex(canonicalJson(x));
const assessments = new WeakSet();
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exactKeys = (x, keys) => isObj(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const synth = s => typeof s === 'string' && /^SYNTH-[A-Z0-9][A-Z0-9-]{0,63}$/.test(s);
const safe = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(s);
const isSyntheticContext = c => ['tenant_id', 'patient_id', 'encounter_id'].every(k =>
  typeof c?.[k] === 'string' && /^synthetic-[a-z0-9][a-z0-9-]{0,63}$/.test(c[k]));

export function validateRegionalRuleRegistry(value) {
  const bad = () => { throw new Error('REGIONAL_RULE_REGISTRY_INVALID'); };
  if (!exactKeys(value, ['schema_version', 'status', 'profiles'])
      || value.schema_version !== 'medcius.regional-rule-registry.v1'
      || value.status !== 'REFERENCE_ONLY_NOT_CONFIGURED'
      || !Array.isArray(value.profiles) || !value.profiles.length || value.profiles.length > 50) bad();
  const ids = new Set();
  for (const p of value.profiles) {
    if (!exactKeys(p, ['id','scheme','published_version','pooling_area','effective_from','effective_until','status','rule_data','source_url'])
        || !safe(p.id) || ids.has(p.id) || ![null, 'drg', 'dip', 'drg_dip'].includes(p.scheme)
        || ![null, '2.0', '3.0'].includes(p.published_version)
        || p.pooling_area !== null || p.effective_from !== null || p.effective_until !== null
        || p.status !== 'NOT_CONFIGURED' || p.rule_data !== 'NOT_INGESTED'
        || p.source_url !== null && (typeof p.source_url !== 'string' || !/^https:\/\/www\.nhsa\.gov\.cn\//.test(p.source_url))) bad();
    ids.add(p.id);
  }
  return true;
}
validateRegionalRuleRegistry(registry);
export function inspectRegionalRuleRegistry() {
  return deepFreeze({ ...structuredClone(registry), source_sha256: sha256Hex(registryBytes),
    automatically_selects_local_rules: false, clinical_classification: 'NOT_ASSESSED' });
}

export function validateSyntheticExclusionPack(p) {
  const bad = () => { throw new Error('SYNTHETIC_EXCLUSION_PACK_INVALID'); };
  if (!exactKeys(p, ['schema_version','id','version','status','scope','source','rules'])
      || p.schema_version !== 'medcius.synthetic-exclusion-pack.v1' || p.status !== 'SYNTHETIC_ONLY'
      || !/^synthetic-[a-z0-9-]{1,64}$/.test(p.id ?? '') || !/^fixture-[a-z0-9-]{1,32}$/.test(p.version ?? '')
      || !exactKeys(p.scope, ['tenant_id','scheme','pooling_area','grouping_version','diagnosis_system','diagnosis_version','valid_from','valid_until'])
      || !/^synthetic-[a-z0-9-]{1,64}$/.test(p.scope.tenant_id ?? '') || p.scope.scheme !== 'drg'
      || ![p.scope.pooling_area,p.scope.grouping_version,p.scope.diagnosis_system,p.scope.diagnosis_version].every(synth)
      || !validDate(p.scope.valid_from) || !validDate(p.scope.valid_until) || p.scope.valid_from > p.scope.valid_until
      || !exactKeys(p.source, ['kind','id','version']) || p.source.kind !== 'SYNTHETIC_FIXTURE'
      || !synth(p.source.id) || p.source.version !== p.version
      || !Array.isArray(p.rules) || p.rules.length > 500) bad();
  const ids = new Set(), pairs = new Set();
  for (const row of p.rules) {
    if (!exactKeys(row, ['id','primary_code','secondary_code','source_locator'])
        || ![row.id,row.primary_code,row.secondary_code].every(synth)
        || !/^fixture-row-[1-9][0-9]{0,5}$/.test(row.source_locator ?? '')
        || ids.has(row.id) || pairs.has(`${row.primary_code}/${row.secondary_code}`)) bad();
    ids.add(row.id); pairs.add(`${row.primary_code}/${row.secondary_code}`);
  }
  return true;
}

// A hit means one row exists in an invented, partial fixture. No-hit means
// only that this fixture does not contain the pair. Neither is a classification.
export function evaluateSyntheticExclusion({ review, pack = null, selection = null } = {}) {
  assertRecordEvidenceReview(review);
  assertSyntheticReviewContext(review.context);
  const base = { schema_version: 'medcius.synthetic-exclusion-screen.v1',
    snapshot_id: review.snapshot_id, review_digest: review.digest, front_sheet_id: review.front_sheet_id,
    front_sheet_record_digest: review.front_sheet_record_digest, status: 'NOT_CONFIGURED', reason: null,
    match: null, source: null, pack_digest: null, clinical_classification: 'NOT_ASSESSED',
    grouping_affected: null, payment_impact: 'NOT_ASSESSED', auto_modify_diagnosis: false,
    clinical_use_authorized: false, scope: 'SYNTHETIC_REPLAY_ONLY' };
  const finish = values => { const result = deepFreeze({ ...base, ...values }); assessments.add(result); return result; };
  if (pack == null) return finish({ reason: 'REGIONAL_RULE_PACK_NOT_CONFIGURED' });
  const pinned = structuredClone(pack); validateSyntheticExclusionPack(pinned);
  const packDigest = hash(pinned), fail = reason => finish({ status: 'NOT_EVALUABLE', reason, pack_digest: packDigest });
  const keys = ['tenant_id','scheme','pooling_area','grouping_version','diagnosis_system','diagnosis_version','as_of','secondary_code'];
  if (!exactKeys(selection, keys) || !validDate(selection.as_of) || !synth(selection.secondary_code)) return fail('EXPLICIT_SCOPE_REQUIRED');
  if (selection.tenant_id !== review.context.tenant_id || selection.tenant_id !== pinned.scope.tenant_id) return fail('TENANT_MISMATCH');
  if (['scheme','pooling_area','grouping_version','diagnosis_system','diagnosis_version'].some(k => selection[k] !== pinned.scope[k])) return fail('RULE_SCOPE_OR_RELEASE_MISMATCH');
  if (selection.as_of !== review.period.to.slice(0, 10) || selection.as_of < pinned.scope.valid_from || selection.as_of > pinned.scope.valid_until) return fail('RULE_PERIOD_MISMATCH');
  const diagnoses = review.front_sheet_codes.filter(c => c.kind === 'diagnosis');
  const primary = diagnoses.filter(c => c.role === 'discharge_primary');
  const secondary = diagnoses.filter(c => c.role === 'discharge_other' && c.code === selection.secondary_code);
  if (primary.length !== 1 || secondary.length !== 1
      || ![primary[0],secondary[0]].every(c => synth(c.code) && c.code_system === selection.diagnosis_system && c.code_version === selection.diagnosis_version)) return fail('CODES_NOT_BOUND_TO_FRONT_SHEET');
  const row = pinned.rules.find(r => r.primary_code === primary[0].code && r.secondary_code === secondary[0].code);
  return finish({ status: row ? 'SYNTHETIC_ROW_MATCH' : 'SYNTHETIC_NO_LISTED_MATCH', reason: null, pack_digest: packDigest,
    match: row ? { rule_id: row.id, source_locator: row.source_locator } : null,
    source: { ...pinned.source, pack_id: pinned.id, pack_version: pinned.version },
    selection: { ...selection }, coverage: 'PARTIAL_SYNTHETIC_FIXTURE_ONLY' });
}

export function assertSyntheticExclusionAssessment(value) {
  if (!assessments.has(value)) throw new Error('SYNTHETIC_ASSESSMENT_BOUND_RESULT_REQUIRED');
  return value;
}

export function assertSyntheticReviewContext(context) {
  assertSyntheticRuntime(context);
  if (!isSyntheticContext(context)) throw new Error('SYNTHETIC_CONTEXT_REQUIRED');
}

export function assertSyntheticRuntime(context) {
  if (requiresProductionPhi(context)) throw new Error('SYNTHETIC_REPLAY_PRODUCTION_FORBIDDEN');
}
