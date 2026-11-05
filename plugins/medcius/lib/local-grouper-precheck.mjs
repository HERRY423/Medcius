// Explicitly injected LOCAL grouper, never a replacement grouping algorithm.
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../servers/shared/crypto.mjs';
import { assertRecordEvidenceReview } from './record-evidence-reconciliation.mjs';
import { validDate } from './terminology-crosswalk.mjs';

const hash = x => sha256Hex(canonicalJson(x));
const code = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(v);
const str = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 128;
const boundary = { read_only: true, auto_add_diagnosis: false, modifies_codes: false, predicts_payment: false,
  adjudicates_violation: false, clinical_validation: 'NOT_ESTABLISHED', production_ready: false };

export function validateGrouperProfile(p) {
  const missing = [];
  if (p?.schema_version !== 'medcius.local-grouper-profile.v1') missing.push('schema_version');
  for (const k of ['id', 'version', 'grouping_version', 'adapter_id', 'rule_source']) if (!str(p?.[k])) missing.push(k);
  if (!['drg', 'dip'].includes(p?.scheme)) missing.push('scheme');
  if (p?.province !== 'CN-32' || !/^CN-32(?:0[1-9]|1[0-3])$/.test(p?.region)) missing.push('jiangsu_pooling_area');
  if (!validDate(p?.effective_from) || !validDate(p?.effective_until) || p.effective_from > p.effective_until) missing.push('effective_interval');
  if (!['sample', 'site_reviewed'].includes(p?.data_class)) missing.push('data_class');
  if (!/^[a-f0-9]{64}$/.test(p?.rule_digest)) missing.push('rule_digest');
  for (const kind of ['diagnosis', 'procedure']) if (!str(p?.code_releases?.[kind]?.system) || !str(p?.code_releases?.[kind]?.version)) missing.push(`${kind}_release`);
  if (!Array.isArray(p?.required_fields) || !p.required_fields.length
      || p.required_fields.some(k => !['age_years', 'sex', 'stay_days', 'discharge_method', 'birth_weight_g', 'admission_weight_g', 'ventilation_hours'].includes(k))) missing.push('required_fields');
  return { configured: !missing.length, missing };
}

export function createLocalGrouperPrecheck({ profile, adapter, validateCode, authorize, mode = 'replay', timeout_ms = 5000 } = {}) {
  if (!['replay', 'local'].includes(mode) || !Number.isInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 30000) throw new Error('GROUPER_OPTIONS_INVALID');
  const pinned = structuredClone(profile ?? {}), profileDigest = hash(pinned);
  let inFlight = false;
  return async function precheck({ review, items, as_of } = {}) {
    assertRecordEvidenceReview(review);
    const out = (status, extra = {}) => ({ schema_version: 'medcius.local-grouper-precheck.v1', status,
      mode, profile_digest: profileDigest, review_digest: review.digest, snapshot_id: review.snapshot_id, ...extra, boundary });
    const config = validateGrouperProfile(pinned);
    if (!config.configured || !adapter) return out('NOT_CONFIGURED', { missing: [...config.missing, ...(!adapter ? ['local_adapter'] : [])] });
    if (inFlight) return out('BUSY');
    inFlight = true;
    let started = false;
    try {
    items = structuredClone(items);
    if (adapter.id !== pinned.adapter_id || adapter.transport !== 'local' || typeof adapter.check !== 'function') return out('ADAPTER_BINDING_REJECTED');
    if (mode === 'local' && (pinned.data_class !== 'site_reviewed' || review.policy.data_class !== 'site_reviewed'
        || typeof authorize !== 'function' || await authorize({ profile_digest: profileDigest, review_digest: review.digest }) !== true)) return out('SITE_ACCEPTANCE_REQUIRED');
    if (mode === 'replay' && pinned.data_class !== 'sample') return out('REPLAY_PROFILE_REQUIRED');
    if (!validDate(as_of) || as_of < pinned.effective_from || as_of > pinned.effective_until
        || as_of !== review.period.to.slice(0, 10)) return out('OUTSIDE_PROFILE_PERIOD');
    for (const field of pinned.required_fields) {
      const value = review.grouping_fields[field];
      if (field === 'sex' ? !['male', 'female', 'unknown'].includes(value)
        : field === 'discharge_method' ? !['1', '2', '3', '4', '5', '9'].includes(value)
        : typeof value !== 'number' || !Number.isFinite(value) || value < 0) return out('MISSING_GROUPING_FIELDS', { field });
    }
    if (!Array.isArray(items) || !items.length || items.length > 500
        || items.filter(i => i.kind === 'diagnosis' && i.role === 'discharge_primary').length !== 1) return out('CODE_INPUT_INVALID');
    const selected = [];
    for (const item of items) {
      const release = pinned.code_releases[item.kind];
      if (!release || !code(item.code) || item.code_system !== release.system || item.code_version !== release.version
          || !['discharge_primary', 'discharge_other', 'procedure'].includes(item.role)
          || (item.kind === 'procedure') !== (item.role === 'procedure')) return out('CODE_RELEASE_MISMATCH');
      if (!review.front_sheet_codes.some(c => ['code', 'code_system', 'code_version', 'kind', 'role'].every(k => c[k] === item[k]))) return out('CODE_NOT_BOUND_TO_FRONT_SHEET');
      if (mode === 'local') {
        if (typeof validateCode !== 'function') return out('CODE_VALIDATION_REQUIRED');
        const result = await validateCode({ code: item.code, code_system: item.code_system, code_version: item.code_version, as_of });
        if (result?.validation_status !== 'valid' || result.code_version !== item.code_version || result.code !== item.code
            || result.code_system !== item.code_system || (result.data_class ?? result.detail?.data_class) !== 'official'
            || !validDate(result.effective_date) || !validDate(result.effective_until)
            || result.effective_date > as_of || result.effective_until < as_of
            || item.role === 'discharge_primary' && (result.is_main_diag_allowed ?? result.detail?.is_main_diag_allowed) !== true) return out('CODE_VALIDATION_REQUIRED');
      }
      selected.push({ code: item.code, code_system: item.code_system, code_version: item.code_version, kind: item.kind, role: item.role });
    }
    if (new Set(selected.map(i => `${i.kind}/${i.code}`)).size !== selected.length) return out('DUPLICATE_CODE_INPUT');
    const request_id = randomUUID();
    const request = { schema_version: 'medcius.local-grouper-request.v1', request_id, profile_digest: profileDigest,
      encounter_token: hash([request_id, review.context]), review_digest: review.digest, as_of,
      region: pinned.region, scheme: pinned.scheme, grouping_version: pinned.grouping_version,
      rule_digest: pinned.rule_digest, code_releases: pinned.code_releases, grouping_fields: review.grouping_fields, items: selected };
    request.digest = hash(request);
    const controller = new AbortController(); let timer;
    // Do not free the slot on timeout: a non-cooperating provider may still be running.
    started = true;
    const operation = Promise.resolve().then(() => adapter.check({ request: structuredClone(request), signal: controller.signal }))
      .then(value => ({ value }), () => ({ error: 'PROVIDER_FAILURE' })).finally(() => { inFlight = false; });
    const finished = await Promise.race([operation, new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ error: 'TIMEOUT' }); }, timeout_ms);
    })]);
    clearTimeout(timer);
    if (finished.error) return out(finished.error, { request_id, request_digest: request.digest });
    const r = finished.value;
    const reject = reason => out('RESPONSE_REJECTED', { reason, request_id, request_digest: request.digest });
    if (!r || r.request_id !== request_id || r.request_digest !== request.digest || r.profile_digest !== profileDigest
        || r.region !== pinned.region || r.scheme !== pinned.scheme || r.grouping_version !== pinned.grouping_version
        || r.rule_digest !== pinned.rule_digest) return reject('REQUEST_OR_VERSION_MISMATCH');
    if (!['grouped', 'ungroupable'].includes(r.status) || r.status === 'grouped' && !code(r.group_code)
        || r.status === 'ungroupable' && r.group_code != null || !Array.isArray(r.mcc_cc)) return reject('RESPONSE_SCHEMA_INVALID');
    const classifications = [];
    for (const c of r.mcc_cc) {
      if (!['MCC', 'CC', 'none', 'excluded'].includes(c.classification)
          || !selected.some(i => i.kind === 'diagnosis' && i.code === c.code && i.code_system === c.code_system && i.code_version === c.code_version)
          || classifications.some(i => i.code === c.code)) return reject('MCC_CC_INPUT_MISMATCH');
      classifications.push({ code: c.code, code_system: c.code_system, code_version: c.code_version, classification: c.classification });
    }
    return out(mode === 'replay' ? 'REPLAY_ONLY' : 'LOCAL_RESPONSE_BOUND', { request_id, request_digest: request.digest,
      result: { status: r.status, group_code: r.group_code ?? null, mcc_cc: classifications },
      quality_status: review.status, review_finding_count: review.findings.length,
      settlement_accepted: false, payment_impact: 'NOT_ASSESSED' });
    } catch {
      return out('PRECHECK_VALIDATION_FAILED');
    } finally {
      if (!started) inFlight = false;
    }
  };
}
