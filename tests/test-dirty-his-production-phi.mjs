import test from 'node:test';
import assert from 'node:assert/strict';
import { guardPatientSourceInput } from '../plugins/medcius/lib/patient-source-phi.mjs';
import { resolvePhiDetector } from '../plugins/medcius/lib/phi-runtime.mjs';
import { HospitalAgentAdapter, getPreRoundResearchSnapshot } from '../plugins/medcius/lib/hospital-agent-adapter.mjs';
import { ReadOnlyHospitalDataBridge } from '../plugins/medcius/lib/read-only-hospital-data-bridge.mjs';
import { withPhiExitGuard } from '../plugins/medcius/lib/connectors/phi-exit-guard.mjs';

test('actual local CPU NER sees decoded synthetic rich text before source output', async () => {
  assert.ok(process.env.MEDCIUS_CN_NER_MODEL_DIR, 'locked local NER model required');
  const context = { tenant_id: 'synthetic-t', doctor_id: 'synthetic-d', patient_id: 'synthetic-p',
    encounter_id: 'synthetic-e', profile: 'production', as_of: '2026-11-05T12:00:00Z' };
  const raw = '<p>病程记录：&#x738B;&#x4F1F;诉胸闷。</p>';
  const input = { context, patient: { id: context.patient_id, name: '王伟' }, encounter: { id: context.encounter_id },
    notes: [{ id: 'synthetic-note', patient_id: context.patient_id, encounter_id: context.encounter_id,
      tenant_id: context.tenant_id, timestamp: '2026-11-05T10:00:00Z', text: raw }],
    synthetic_extra: { expected_specimens: ['serum', 'plasma', '血浆&#x738B;&#x4F1F;'] } };
  const detector = await resolvePhiDetector({ context });
  const result = await guardPatientSourceInput(input, { detector });
  try {
    assert.equal(result.receipt.assurance, 'dual_track_executed');
    assert.ok(result.receipt.passes_completed > 0);
    assert.deepEqual(result.input.synthetic_extra.expected_specimens.slice(0, 2), ['serum', 'plasma']);
    assert.doesNotMatch(JSON.stringify(result.input), /王伟|&#x738B;|&#x4F1F;|<p>/);
    assert.equal(result.input.notes[0].rich_text_normalization.status, 'normalized_mapping_unavailable');
  } finally { result.session.dispose(); }
  const workflow = await HospitalAgentAdapter.executePreRoundWorkflowAsync({ host: 'his_embed', context, dataFeeds: input, localPhiDetector: detector });
  const research = getPreRoundResearchSnapshot(workflow);
  assert.equal(workflow.phi_guard.assurance, 'dual_track_executed');
  assert.doesNotMatch(JSON.stringify(research), /王伟|&#x738B;|&#x4F1F;|<p>/);
  assert.match(JSON.stringify(research), /胸闷/);
  const connector = (kind, records) => ({ id: `synthetic-${kind}`, kind, capabilities: ['read'], async readPatient(c) {
    return { ...c, source_system: this.id, records, fetched_at: context.as_of }; } });
  const connectors = [connector('patient', [input.patient]), connector('encounter', [input.encounter]), connector('notes', input.notes)]
    .map(c => withPhiExitGuard(c, { salt: 'synthetic-only-salt' }));
  const bridge = new ReadOnlyHospitalDataBridge({ connectors, localPhiDetector: detector });
  const bridged = await bridge.readPatientSnapshot(context);
  assert.equal(bridged.phi_guard.ner_status, 'EXECUTED');
  assert.doesNotMatch(JSON.stringify(bridged), /王伟|&#x738B;|&#x4F1F;|<p>/);
  assert.equal(bridged.dataFeeds.notes[0].rich_text_normalization.status, 'normalized_mapping_unavailable');
});
