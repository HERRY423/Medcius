import { readFileSync } from 'node:fs';
import { ClinicianReviewSessions } from '../../../lib/clinician-review-session.mjs';
import { PatientEvolutionEngine } from '../../../lib/patient-evolution-engine.mjs';
import { computeDecisionDigest } from '../../shared/digital-signature.mjs';
import { isClinicalLandingEnabled } from '../../../lib/clinical-landing-policy.mjs';

const URI = 'ui://medcius/clinician-review-v1.html';
const actor = Object.freeze({ isAuthenticated: true, user: 'synthetic-reviewer', tenantId: 'synthetic-only' });
const checkMode = () => {
  if (process.env.NODE_ENV === 'production' || process.env.MEDCIUS_PROFILE === 'production' || isClinicalLandingEnabled()) throw Error('REVIEW_APP_SYNTHETIC_ONLY');
};
const str = { type: 'string' };
const actionSchema = { type: 'object', additionalProperties: false,
  properties: { session_id: str, snapshot_hash: str, expected_revision: { type: 'integer', minimum: 0 }, request_id: str,
    action: { type: 'string', enum: ['mark', 'focus', 'note', 'pause', 'resume', 'request'] }, item_id: str, item_hash: str,
    status: str, reason: str, selected_ids: { type: 'array', items: str, maxItems: 12 }, note: { type: 'string', maxLength: 1000 } },
  required: ['session_id', 'snapshot_hash', 'expected_revision', 'request_id', 'action'] };
export function createReviewAppConfig() {
  const sessions = new ClinicianReviewSessions();
  const envelope = state => ({ content: [{ type: 'text', text: '已打开合成资料阅读工作区。阅读标记只是临时草稿；临床有效性与原生宿主验收均未建立。' }],
    _meta: { review_session: state } });
  const makeExample = () => {
    const patient = { id: 'synthetic-review-patient' };
    const base = { id: 'synthetic-potassium', code: 'k', name: '血钾', unit: 'mmol/L', status: 'final', version_id: 'v1', value: 2.5,
      is_critical: true, effective_time: '2026-10-06T07:30:00Z', issued: '2026-10-06T08:00:00Z' };
    const payload = PatientEvolutionEngine.analyzePatientEvolution({ patient, now: '2026-10-06T10:00:00Z',
      observations: [base, { ...base, value: 4.1, is_critical: false, status: 'corrected', version_id: 'v2', updated_at: '2026-10-06T09:00:00Z' }] });
    return sessions.create({ workflow: 'evolution', payload, payload_digest: computeDecisionDigest(payload),
      patient_context: { patient_id: patient.id, encounter_id: 'synthetic-review-encounter' } }, actor);
  };
  return {
    serverInfo: { name: 'medcius-review-app', version: '0.1.0-experimental' }, phiGuard: true,
    instructions: 'Synthetic interaction evaluation only. UI reading marks are unverified drafts, not physician decisions or clinical evidence. Do not request real patient data. Only review explicitly selected source items; keep missing evidence unknown.',
    tools: [
      { name: 'medcius_review_workspace', title: 'Medcius 资料核对', description: 'Open a synthetic clinician review workspace. No real patients, diagnosis, chart writes or clinical approval.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true },
        _meta: { ui: { resourceUri: URI }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } } },
      { name: 'medcius_review_action', description: 'Update an ephemeral reading draft; does not attest who clicked or sign a clinical review.', inputSchema: actionSchema,
        _meta: { ui: { visibility: ['app'] } } },
      { name: 'medcius_review_read', description: 'Recover current ephemeral draft after uncertain delivery.',
        inputSchema: { type: 'object', properties: { session_id: str }, required: ['session_id'], additionalProperties: false }, _meta: { ui: { visibility: ['app'] } } },
      { name: 'medcius_review_context', description: 'Prepare only selected synthetic evidence for explicit user submission.',
        inputSchema: { type: 'object', properties: { session_id: str }, required: ['session_id'], additionalProperties: false }, _meta: { ui: { visibility: ['app'] } } },
    ],
    handlers: {
      medcius_review_workspace: () => { checkMode(); return envelope(makeExample()); },
      medcius_review_action: args => { checkMode(); return envelope(sessions.act(args, actor)); },
      medcius_review_read: args => { checkMode(); return envelope(sessions.read(args.session_id, actor)); },
      medcius_review_context: args => { checkMode(); return { content: [{ type: 'text', text: '限定核对范围已准备；尚未发起模型请求。' }], _meta: { review_context: sessions.modelContext(args.session_id, actor) } }; },
    },
    resources: [{ uri: URI, name: 'Medcius 资料核对', mimeType: 'text/html;profile=mcp-app',
      text: readFileSync(new URL('./review.html', import.meta.url), 'utf8'),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } },
        'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] } } }],
  };
}
