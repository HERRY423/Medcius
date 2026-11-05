import test from 'node:test';
import assert from 'node:assert/strict';
import { createInferenceQueue } from '../plugins/medcius/runtimes/cn-phi-ner/inference-queue.mjs';
import { createLocalChineseNer } from '../plugins/medcius/lib/local-cn-ner.mjs';
import { createPatientSourceSnapshotAsync } from '../plugins/medcius/lib/patient-source-snapshot.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('bounded FIFO: overlapping calls queue; overflow rejects; cancelled work never runs', async () => {
  const q = createInferenceQueue({ maxPending: 2, timeoutMs: 1000 }), gate = deferred(), order = [];
  const a = q.run(async () => { order.push('a'); await gate.promise; return 'a'; });
  const controller = new AbortController();
  const b = q.run(() => { order.push('b'); }, { signal: controller.signal });
  const c = q.run(() => { order.push('c'); return 'c'; });
  await assert.rejects(q.run(() => 'overflow'), /QUEUE_FULL/);
  controller.abort(); await assert.rejects(b, /ABORTED/);
  const d = q.run(() => { order.push('d'); return 'd'; });
  gate.resolve(); assert.deepEqual(await Promise.all([a,c,d]), ['a','c','d']);
  assert.deepEqual(order, ['a','c','d']); await q.close();
  await assert.rejects(q.run(() => null), /NOT_AVAILABLE/);
});

test('timeout and abort retain the native slot until real completion; shutdown drains it', async () => {
  const q = createInferenceQueue({ maxPending: 2, timeoutMs: 30 }), gate = deferred();
  let started = 0;
  const active = q.run(async () => { started++; await gate.promise; });
  const queued = q.run(() => { started++; });
  await Promise.all([assert.rejects(active, /INFERENCE_FAILED/), assert.rejects(queued, /INFERENCE_FAILED/)]);
  assert.equal(started, 1);
  let closed = false;
  const closing = q.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  gate.resolve(); await closing; assert.equal(closed, true);
  const q2 = createInferenceQueue({ timeoutMs: 1000 }), gate2 = deferred(), abort = new AbortController();
  const aborted = q2.run(() => gate2.promise, { signal: abort.signal });
  await Promise.resolve(); abort.abort(); await assert.rejects(aborted, /ABORTED/);
  let second = false; const next = q2.run(() => { second = true; });
  await Promise.resolve(); assert.equal(second, false);
  gate2.resolve(); await next; assert.equal(second, true); await q2.close();
});

test('actual CPU NER: simultaneous patient snapshots all complete with isolated dictionaries', async () => {
  assert.ok(process.env.MEDCIUS_CN_NER_MODEL_DIR, 'complete regression requires real local model assets');
  const prior = process.env.MEDCIUS_PROFILE; process.env.MEDCIUS_PROFILE = 'production';
  const detector = await createLocalChineseNer({ modelDirectory: process.env.MEDCIUS_CN_NER_MODEL_DIR });
  try {
    const source = i => ({ context: { tenant_id:'site', doctor_id:'doctor', patient_id:`p-${i}`, encounter_id:`e-${i}` },
      patient:{ id:`p-${i}`, name:['赵宁','李芳','张华'][i] }, encounter:{id:`e-${i}`}, asOf:'2026-11-03T00:00:00Z',
      notes:[{id:`n-${i}`,patient_id:`p-${i}`,encounter_id:`e-${i}`,timestamp:'2026-11-02T23:00:00Z',
        text:`${['赵宁','李芳','张华'][i]}自述胸闷。王建国因胸痛入院。`}] });
    const results = await Promise.all([0,1,2].map(i => createPatientSourceSnapshotAsync(source(i),{detector})));
    assert.equal(results.length,3);
    for (const result of results) {
      assert.doesNotMatch(JSON.stringify(result), /王建国|赵宁|李芳|张华/);
      assert.equal(result.phi_guard.ner_status, 'EXECUTED');
    }
  } finally { await detector.close(); if (prior == null) delete process.env.MEDCIUS_PROFILE; else process.env.MEDCIUS_PROFILE=prior; }
});
