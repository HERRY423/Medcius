// Explicitly enabled local-model integration checks. Fixtures are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createLocalChineseNer } from '../plugins/medcius/lib/local-cn-ner.mjs';
import { EnhancedPhiGuard } from '../plugins/medcius/lib/enhanced-phi-guard.mjs';
import { createPhiEntitySession } from '../plugins/medcius/lib/phi-entity-session.mjs';
import { createPatientSourceSnapshotAsync } from '../plugins/medcius/lib/patient-source-snapshot.mjs';
import { createBertTokenizer } from '../plugins/medcius/runtimes/cn-phi-ner/bert-tokenizer.mjs';
import { readFile } from 'node:fs/promises';
import { sha256Hex } from '../plugins/medcius/servers/shared/crypto.mjs';

test('actual pinned ONNX model: CPU, independent bare names, addresses, full-window coverage and negative control',
  { skip: process.env.MEDCIUS_CN_NER_MODEL_DIR ? false : 'NOT_RUN: set MEDCIUS_CN_NER_MODEL_DIR to verified local assets' }, async () => {
    const modelDirectory=resolve(process.env.MEDCIUS_CN_NER_MODEL_DIR);
    const detector=await createLocalChineseNer({modelDirectory,maxTokens:64,overlap:16});
    const context={tenant_id:'site',patient_id:'p',encounter_id:'e'};
    const session=createPhiEntitySession({context,patient:{id:'p',name:'赵宁'},encounter:{id:'e'}});
    try {
      assert.equal(detector.device,'cpu');
      // Neither name is in the session dictionary or contextual-regex template.
      for(const text of ['王建国因胸痛入院，昨日行冠脉造影。','林志明主诉咳嗽，居住于和平路28号3栋602室。']) {
        const result=await EnhancedPhiGuard.sanitizeDual(text,{entitySession:session,context,detector});
        assert.doesNotMatch(result.sanitized,/王建国|林志明|和平路|28号|602室/);
        assert.equal(result.receipt.assurance,'dual_track_executed');
        assert.equal(result.complete_deidentification,'NOT_ESTABLISHED');
      }
      const clean='患者无发热、咳嗽、胸闷，偶有咳痰。';
      assert.equal((await EnhancedPhiGuard.sanitizeDual(clean,{entitySession:session,context,detector})).sanitized,clean);
      for(const prefix of ['合成病程：'+'呼吸平稳。'.repeat(10),'😀'+clean.repeat(18)]) {
        const text=prefix+'林志明主诉咳嗽。';
        const result=await detector.detect(text);
        assert.equal(result.complete,true); assert.equal(result.text_sha256,sha256Hex(text));
        assert.ok(result.spans.some(s=>s.start<=text.indexOf('林志明')&&s.end>=text.indexOf('林志明')+3&&s.label==='PERSON'));
      }
      const snapshot=await createPatientSourceSnapshotAsync({context,patient:{id:'p',name:'赵宁'},encounter:{id:'e'},asOf:'2026-11-02T12:00:00Z',
        notes:[{id:'note',patient_id:'p',encounter_id:'e',timestamp:'2026-11-02T11:00:00Z',text:'王建国因胸痛入院。'}]}, {detector});
      assert.doesNotMatch(JSON.stringify(snapshot),/王建国|赵宁/);
      assert.equal(snapshot.phi_guard.ner_status,'EXECUTED');
      const controller=new AbortController(); controller.abort();
      await assert.rejects(detector.detect('王建国',{signal:controller.signal}),/ABORTED/);
      await assert.rejects(detector.detect('文'.repeat(100001)),/TEXT_INVALID/);
      await assert.rejects(createLocalChineseNer({modelDirectory:resolve('output/nonexistent-ner-assets')}),/ASSETS_OR_RUNTIME_UNAVAILABLE/);
      const tokenizer=createBertTokenizer(JSON.parse(await readFile(resolve(modelDirectory,'tokenizer.json'),'utf8')));
      for(const token of tokenizer.encode('😀王建国[REDACTED:LOCAL_ENTITY] 林志明')) {
        assert.ok('😀王建国[REDACTED:LOCAL_ENTITY] 林志明'.slice(token.start,token.end).isWellFormed());
        assert.ok(token.end<=5||token.start>=29);
      }
    } finally { session.dispose(); await detector.close(); }
    await assert.rejects(detector.detect('王建国'),/NOT_AVAILABLE/);
  });
