// Secondary intended use: clinician/coder review, never a diagnostic or payment decision.
import { assertPatientSourceSnapshot } from './patient-source-snapshot.mjs';
import { extractConTextAssertions } from './cn-assertions.mjs';
import { parseCnNote } from './parse-cn-note.mjs';
import { createTextAnchor } from './evidence-anchors.mjs';
import { normalizeOrderExecution } from './order-execution.mjs';
import { canonicalJson, sha256Hex } from '../servers/shared/crypto.mjs';
import { deepFreeze } from '../servers/shared/immutable.mjs';
import { validDate } from './terminology-crosswalk.mjs';

const hash = v => sha256Hex(canonicalJson(v));
const madeHere = new WeakSet();
const kinds = ['notes', 'observations', 'diagnosticReports', 'orders'];
const str = v => typeof v === 'string' && v.trim().length > 0;
const instant = v => typeof v === 'string' && validDate(v.slice(0, 10))
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(v)
  && !/[+-]14:(?!00)/.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);

export function validateRecordReviewPolicy(p) {
  const fail = () => { throw new Error('RECORD_REVIEW_POLICY_INVALID'); };
  if (p?.schema_version !== 'medcius.record-review-policy.v1' || !str(p.id) || !str(p.version)
      || !['reference', 'sample', 'site_reviewed'].includes(p.data_class) || !str(p.source)
      || !Array.isArray(p.sources) || !p.sources.length || !Array.isArray(p.conditions) || p.conditions.length > 100) fail();
  if (p.sources.some(s => !kinds.includes(s.kind) || !str(s.system))) fail();
  if (new Set(p.sources.map(s => `${s.kind}/${s.system}`)).size !== p.sources.length) fail();
  if (new Set(p.conditions.map(c => c.id)).size !== p.conditions.length) fail();
  for (const c of p.conditions) {
    if (!str(c.id) || !Array.isArray(c.terms) || !c.terms.length || !c.terms.every(str)
        || !Array.isArray(c.objective) || !c.objective.length || !Array.isArray(c.treatments) || !c.treatments.every(str)) fail();
    if (!p.sources.some(s => s.kind === 'notes') || c.treatments.length && !p.sources.some(s => s.kind === 'orders')) fail();
    if (c.diagnosis_codes != null && (!Array.isArray(c.diagnosis_codes)
        || c.diagnosis_codes.some(d => ![d.code, d.system, d.version].every(str)))) fail();
    for (const g of c.objective) {
      if (!str(g.id) || !['observations', 'diagnosticReports'].includes(g.kind) || !str(g.system)
          || !p.sources.some(s => s.kind === g.kind && s.system === g.system)
          || !Array.isArray(g.concepts) || !g.concepts.length || !g.concepts.every(str)
          || !Array.isArray(g.context_keys) || !g.context_keys.every(str) || !str(g.source_locator)) fail();
      if (g.kind === 'observations' && !str(g.unit)) fail();
      if (g.context_allowed != null && (typeof g.context_allowed !== 'object'
          || Object.values(g.context_allowed).some(v => !Array.isArray(v) || !v.length || !v.every(str)))) fail();
      if (g.context_ranges != null && (typeof g.context_ranges !== 'object'
          || Object.values(g.context_ranges).some(v => !Number.isFinite(v.min) || !Number.isFinite(v.max) || v.min > v.max))) fail();
      if (g.signal && (!['lt', 'lte', 'gt', 'gte', 'critical_low'].includes(g.signal.operator)
          || g.signal.operator !== 'critical_low' && !Number.isFinite(g.signal.value))) fail();
    }
  }
  return p;
}

function inPeriod(entry, start, end) {
  const time = instant(entry.lifecycle.event_time);
  return entry.eligible && time != null && time >= start && time <= end
    && !['cancelled', 'entered_in_error'].includes(entry.lifecycle.result_status);
}
function matchSignal(r, signal) {
  if (!signal) return false;
  if (signal.operator === 'critical_low') return r.critical === true && r.result_direction === 'low';
  return ({ lt: r.value < signal.value, lte: r.value <= signal.value,
    gt: r.value > signal.value, gte: r.value >= signal.value })[signal.operator];
}
function frontTerms(front) {
  const p = parseCnNote(front.text);
  return [p.discharge_diagnosis_primary, p.discharge_diagnosis_other].flatMap(f => String(f?.value ?? '')
    .split(/[;；]/).map(v => v.trim()).filter(Boolean));
}
function refsForTerms(entry, terms, presences = ['positive']) {
  const results = [];
  for (const clause of extractConTextAssertions(entry.record.text ?? '')) for (const m of clause.mentions) {
    // Coding review must also retain explicit diagnostic exclusions. A bare
    // suffix “除外” is often a rule-out query, so it cannot become affirmative.
    const presence = m.presence !== 'positive' ? m.presence
      : /^(?:(?:目前|现|已|已经|可以)\s*)*(?:排除|除外)/.test(m.text) ? 'negative'
      : /排除|除外/.test(m.text) ? 'uncertain' : m.presence;
    if (!presences.includes(presence) || m.temporality !== 'current' || m.experiencer !== 'patient') continue;
    if (!terms.some(term => m.text.includes(term))) continue;
    const anchor = createTextAnchor(entry.record, { start: m.start, end: m.end });
    if (anchor) results.push({ ...entry.evidence, text_anchor: anchor, assertion: `documented_${presence}_current`,
      diagnostic_truth: 'NOT_ADJUDICATED' });
  }
  return results;
}

export function reconcileRecordEvidence({ snapshot, front_sheet_id, policy } = {}) {
  assertPatientSourceSnapshot(snapshot);
  validateRecordReviewPolicy(policy);
  if (Object.values(snapshot.records).reduce((n, rows) => n + rows.length, 0) > 20000
      || snapshot.records.notes.some(e => (e.record.text?.length ?? 0) > 200000)) throw new Error('RECORD_REVIEW_INPUT_LIMIT');
  const start = instant(snapshot.encounter.admission_time), end = instant(snapshot.encounter.discharge_time);
  if (start == null || end == null || end < start || end > instant(snapshot.as_of)) throw new Error('RECONCILIATION_COMPLETE_ENCOUNTER_PERIOD_REQUIRED');
  const sheets = snapshot.records.notes.filter(e => e.record.id === front_sheet_id && inPeriod(e, start, end)
    && e.record.document_kind === 'front_sheet' && ['final', 'revised'].includes(e.lifecycle.result_status));
  if (sheets.length !== 1 || typeof sheets[0].record.text !== 'string') throw new Error('RECONCILIATION_UNIQUE_FINAL_FRONT_SHEET_REQUIRED');
  const front = sheets[0], terms = frontTerms(front.record);
  const coverage = policy.sources.map(source => {
    const receipts = snapshot.source_availability.filter(s => s.kind === source.kind && s.source_system === source.system);
    const receipt = receipts.length === 1 ? receipts[0] : null;
    const unresolved = snapshot.records[source.kind].some(e => !e.record.source_system || e.record.source_system === source.system
      && (!e.record.id || e.selection_status === 'conflict' || e.lifecycle.event_time == null || instant(e.lifecycle.event_time) == null
        || ['unknown', 'preliminary', 'partial'].includes(e.lifecycle.result_status)));
    const complete = receipt?.status === 'complete' && equal(receipt.context, snapshot.context)
      && instant(receipt.from) != null && instant(receipt.to) != null && instant(receipt.watermark) != null
      && instant(receipt.from) <= start && instant(receipt.to) >= end
      && instant(receipt.watermark) >= end && instant(receipt.watermark) <= instant(snapshot.as_of) && !unresolved;
    return { ...source, status: complete ? 'complete' : 'unknown',
      reason: complete ? 'DECLARED_SOURCE_COVERAGE_FOR_ENCOUNTER' : unresolved ? 'UNRESOLVED_SOURCE_RECORDS' : 'COVERAGE_NOT_ESTABLISHED',
      // This is a connector attestation, not proof the hospital captured every record.
      receipt_digest: receipt ? hash(receipt) : null };
  });
  const complete = source => coverage.filter(s => source(s)).length > 0 && coverage.filter(s => source(s)).every(s => s.status === 'complete');
  const usable = kind => snapshot.records[kind].filter(e => inPeriod(e, start, end));
  const findings = [], conditions = [];
  for (const condition of policy.conditions) {
    const onSheet = terms.some(t => condition.terms.includes(t)) || (front.record.diagnoses ?? []).some(d =>
      (condition.diagnosis_codes ?? []).some(c => c.code === d.code && c.system === d.code_system && c.version === d.code_version));
    const claimEvidence = onSheet ? refsForTerms(front, condition.terms) : [];
    if (onSheet && !claimEvidence.length) claimEvidence.push({ ...front.evidence, text_anchor: null, basis: 'structured_front_sheet_diagnoses' });
    const clinicalNotes = usable('notes').filter(e => e.record.id !== front_sheet_id
      && policy.sources.some(s => s.kind === 'notes' && s.system === e.record.source_system)
      && ['progress', 'admission', 'consultation', 'discharge_summary'].includes(e.record.document_kind)
      && e.record.author_role === 'clinician' && e.record.signed === true
      && ['final', 'revised'].includes(e.lifecycle.result_status) && e.record.text !== front.record.text);
    const documentation = clinicalNotes.flatMap(e => refsForTerms(e, condition.terms));
    const documentation_opposing = clinicalNotes.flatMap(e => refsForTerms(e, condition.terms, ['negative', 'uncertain']));
    const objective = condition.objective.map(group => {
      const rows = usable(group.kind).filter(e => e.record.source_system === group.system && group.concepts.includes(e.record.concept_code));
      const unknownRows = rows.filter(e => !['final', 'revised'].includes(e.lifecycle.result_status)
        || group.kind === 'diagnosticReports' && !['text', 'findings', 'impression', 'conclusion', 'assessment_result'].some(k => str(e.record[k]))
        || group.context_keys.some(k => e.record.measurement_context?.[k] == null)
        || Object.entries(group.context_allowed ?? {}).some(([k, allowed]) => !allowed.includes(e.record.measurement_context?.[k]))
        || Object.entries(group.context_ranges ?? {}).some(([k, range]) => {
          const v = e.record.measurement_context?.[k]; return typeof v !== 'number' || !Number.isFinite(v) || v < range.min || v > range.max;
        })
        || group.kind === 'observations' && (typeof e.record.value !== 'number' || !Number.isFinite(e.record.value) || e.record.unit !== group.unit));
      const good = rows.filter(e => !unknownRows.includes(e));
      return { id: group.id, status: good.length ? 'present' : unknownRows.length ? 'unknown'
        : complete(s => s.kind === group.kind && s.system === group.system) ? 'not_found_in_covered_sources' : 'unknown',
        evidence: good.map(e => ({ ...e.evidence, value: e.record.value ?? null, unit: e.record.unit ?? null,
          measurement_context: e.record.measurement_context ?? null, signal: matchSignal(e.record, group.signal) })),
        unevaluable_evidence: unknownRows.map(e => e.evidence), source_locator: group.source_locator };
    });
    // A stopped order can retain genuine administrations from earlier in this admission.
    const treatment = snapshot.records.orders.filter(e => e.eligible && e.lifecycle.result_status !== 'entered_in_error'
      && condition.treatments.includes(e.record.concept_code)
      && policy.sources.some(s => s.kind === 'orders' && s.system === e.record.source_system)).map(e => {
      const execution = normalizeOrderExecution(e.record, { now: snapshot.as_of });
      const administrations = execution.administrations.filter(a => instant(a.performed_at) >= start && instant(a.performed_at) <= end);
      return { ...e.evidence, execution_status: execution.execution_status,
        administrations, administered: administrations.length > 0 };
    });
    const hasObjective = objective.some(g => g.status === 'present');
    const evidence = { front_sheet: claimEvidence, documentation, documentation_opposing, objective, treatment };
    const add = (code, message) => findings.push({ code, condition_id: condition.id, severity: 'REVIEW', message,
      evidence, mcc_cc: 'NOT_ASSESSED', recommended_owner: '主管医师与病案编码人员', modifies_diagnosis: false });
    if (documentation_opposing.length && (documentation.length || onSheet)) add('DIAGNOSIS_ASSERTION_CONFLICT',
      '诊断记载与否定/疑似记载并存；保留两侧证据交临床复核，不能自动补写诊断。');
    else if (!onSheet && documentation.length) add('DOCUMENTED_DIAGNOSIS_NOT_ON_FRONT_SHEET',
      '住院病程有肯定诊断记载，拟出院诊断中未匹配到对应原词；请核对同义词、纳入条件与诊断列表，工具不补诊断或选码。');
    else if (!onSheet && objective.some(g => g.evidence.some(e => e.signal))) add('ABNORMAL_EVIDENCE_REVIEW',
      '有结构化异常线索，尚未匹配到明确诊断记录；请临床复核，检验异常本身不构成诊断或漏编结论。');
    if (onSheet && !documentation.length) add(complete(s => s.kind === 'notes') ? 'DATA_GAP' : 'SOURCE_COVERAGE_UNKNOWN',
      '首页诊断尚未关联到独立的已签署病程诊断记载；请核对外院/既往依据、同义词及文书来源，不据此判定高编。');
    if (onSheet && !hasObjective) add(objective.every(g => g.status === 'not_found_in_covered_sources') ? 'DATA_GAP' : 'SOURCE_COVERAGE_UNKNOWN',
      '配置的检查/评估资料尚未与首页诊断关联；DATA_GAP 仅限已声明完整的院内来源，不能推断诊断错误。');
    if (onSheet && condition.treatments.length && !treatment.some(t => t.administered)) add('TREATMENT_CONTEXT_REVIEW',
      '未关联到对应已执行治疗记录；开立、退药与执行分开列示，未治疗不等于诊断不成立。');
    conditions.push({ condition_id: condition.id, on_front_sheet: onSheet, evidence });
  }
  const result = { schema_version: 'medcius.record-evidence-reconciliation.v1', snapshot_id: snapshot.snapshot_id,
    context: snapshot.context, front_sheet_id, front_sheet_record_digest: hash(front.record), front_sheet_text_sha256: sha256Hex(front.record.text),
    front_sheet_codes: [...(front.record.diagnoses ?? []), ...(front.record.procedures ?? [])].map(d => ({ code: d.code ?? null,
      code_system: d.code_system ?? null, code_version: d.code_version ?? null, kind: d.kind ?? null, role: d.role ?? null })),
    grouping_fields: Object.fromEntries(['age_years', 'sex', 'stay_days', 'discharge_method', 'birth_weight_g', 'admission_weight_g', 'ventilation_hours']
      .map(k => { const v = front.record.grouping_fields?.[k]; return [k, k === 'sex' ? ['male', 'female', 'unknown'].includes(v) ? v : null
        : k === 'discharge_method' ? ['1','2','3','4','5','9'].includes(v) ? v : null : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null]; })),
    policy: { id: policy.id, version: policy.version, digest: hash(policy), data_class: policy.data_class, source: policy.source },
    period: { from: snapshot.encounter.admission_time, to: snapshot.encounter.discharge_time }, coverage,
    status: findings.length ? 'review_required' : coverage.every(s => s.status === 'complete') ? 'no_discrepancy_in_configured_scope' : 'coverage_unknown',
    findings, conditions, production_ready: false, diagnostic_validity: 'NOT_ADJUDICATED',
    boundary: { auto_add_diagnosis: false, automatic_code_selection: false, adjudicates_violation: false,
      predicts_payment: false, clinical_validation: 'NOT_ESTABLISHED' } };
  result.digest = hash(result); deepFreeze(result); madeHere.add(result); return result;
}

export function assertRecordEvidenceReview(review, { text } = {}) {
  if (!madeHere.has(review)) throw new Error('RECORD_EVIDENCE_REVIEW_BOUND_RESULT_REQUIRED');
  if (text != null && sha256Hex(text) !== review.front_sheet_text_sha256) throw new Error('RECORD_EVIDENCE_FRONT_SHEET_MISMATCH');
  return review;
}
