import test from "node:test";
import assert from "node:assert/strict";
import { PatientEvolutionEngine } from "../plugins/medcius/lib/patient-evolution-engine.mjs";
import { HospitalAgentAdapter, getPreRoundResearchSnapshot, replayPreRoundResearchSnapshotAsync } from "../plugins/medcius/lib/hospital-agent-adapter.mjs";
import { createPatientSourceSnapshotAsync } from "../plugins/medcius/lib/patient-source-snapshot.mjs";
import { CHINA_HANDLERS } from "../plugins/medcius/servers/drug-labels/src/china-tools.mjs";
import { resolvePhiDetector } from "../plugins/medcius/lib/phi-runtime.mjs";

test("new China clinical inputs retain mandatory actual CPU NER and deterministic replay", async t => {
  const modelDirectory = process.env.MEDCIUS_CN_NER_MODEL_DIR;
  assert.ok(modelDirectory, "MEDCIUS_CN_NER_MODEL_DIR required; this regression must not silently skip NER");
  const before = process.env.MEDCIUS_PROFILE;
  process.env.MEDCIUS_PROFILE = "production";
  const context = { tenant_id: "synthetic-site", patient_id: "synthetic-patient", encounter_id: "synthetic-encounter", doctor_id: "synthetic-doctor", as_of: "2026-11-02T12:00:00Z" };
  const input = { context, patient: { id: context.patient_id, age: 50, gender: "male" }, asOf: context.as_of,
    records: [{ ...context, id: "bmi-record", kind: "anthropometry", status: "final", recorded_at: "2026-11-02T10:00:00Z",
      source_reference: { source_system: "synthetic-his", resource_id: "bmi-record" },
      weight_kg: 96, height_cm: 200, pregnant_or_postpartum: false, athlete: false, narrative: "王建国住青禾路28号，今日测量体重。" }] };
  const feeds = { patient: input.patient, encounter: { id: context.encounter_id }, notes: [], nis: [], lis: [], pacs: [], his_orders: [], chinaClinical: { records: input.records } };
  let detector;
  try {
    await t.test("missing model rejects new tool before evaluating a record", async () => {
      delete process.env.MEDCIUS_CN_NER_MODEL_DIR;
      await assert.rejects(CHINA_HANDLERS.check_cn_clinical(input), /LOCAL_PHI|LOCAL_NER/);
      process.env.MEDCIUS_CN_NER_MODEL_DIR = modelDirectory;
    });
    detector = await resolvePhiDetector({ context });
    await t.test("production tool and snapshot scan bare names in new narrative fields", async () => {
      const result = await CHINA_HANDLERS.check_cn_clinical(input);
      assert.equal(result.calculations.china_adult_bmi.category, "overweight");
      const snapshot = await createPatientSourceSnapshotAsync({ ...feeds, context, asOf: context.as_of }, { detector });
      assert.equal(snapshot.phi_guard.ner_status, "EXECUTED");
      assert.ok(!JSON.stringify(snapshot).includes("王建国"));
      assert.equal(snapshot.china_clinical.records[0].kind, "anthropometry");
    });
    await t.test("guarded round cards and frozen replay preserve new measurements", async () => {
      const result = await HospitalAgentAdapter.executePreRoundWorkflowAsync({ context, dataFeeds: feeds, localPhiDetector: detector });
      assert.equal(result.summary.patient.china_adult_bmi.category, "overweight");
      const frozen = getPreRoundResearchSnapshot(result);
      assert.equal(frozen.replayInput.dataFeeds.chinaClinical.pharmacy_catalog.version, "empty");
      const oldCatalog = process.env.MEDCIUS_CN_PHARMACY_CATALOG;
      process.env.MEDCIUS_CN_PHARMACY_CATALOG = "C:\\Medcius\\output\\nonexistent-catalog-for-replay.json";
      let replay;
      try { replay = await replayPreRoundResearchSnapshotAsync(frozen.replayInput, { localPhiDetector: detector }); }
      finally { if (oldCatalog === undefined) delete process.env.MEDCIUS_CN_PHARMACY_CATALOG; else process.env.MEDCIUS_CN_PHARMACY_CATALOG = oldCatalog; }
      assert.deepEqual(replay.patient.china_adult_bmi, result.summary.patient.china_adult_bmi);
      assert.ok(!JSON.stringify(frozen).includes("王建国"));
    });
    await t.test("sync route and failed detector stay closed", async () => {
      assert.throws(() => PatientEvolutionEngine.analyzePatientEvolution({ patient: input.patient, context, chinaClinical: feeds.chinaClinical }), /PHI_PRODUCTION/);
      await detector.close();
      await assert.rejects(HospitalAgentAdapter.executePreRoundWorkflowAsync({ context, dataFeeds: feeds, localPhiDetector: detector }), /LOCAL_PHI|LOCAL_NER|PHI_SOURCE|PHI_PRODUCTION/);
    });
  } finally {
    process.env.MEDCIUS_CN_NER_MODEL_DIR = modelDirectory;
    if (before === undefined) delete process.env.MEDCIUS_PROFILE; else process.env.MEDCIUS_PROFILE = before;
    await detector?.close();
  }
});
