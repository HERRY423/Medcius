import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HospitalAgentAdapter } from '../plugins/medcius/lib/hospital-agent-adapter.mjs';
import { guardPhiValue } from '../plugins/medcius/lib/phi-value-guard.mjs';
import { guardPatientSourceInput } from '../plugins/medcius/lib/patient-source-phi.mjs';
import { resolvePhiDetector } from '../plugins/medcius/lib/phi-runtime.mjs';
import { loadSpecialtyRulePack, rulePackDigest } from '../plugins/medcius/lib/specialty-rule-pack.mjs';
import { sha256Hex } from '../plugins/medcius/servers/shared/crypto.mjs';
import { detectManyLocalChineseNer } from '../plugins/medcius/runtimes/cn-phi-ner/detector.mjs';

const require = createRequire(new URL('../plugins/medcius/runtimes/cn-phi-ner/package.json', import.meta.url));
const { onnx } = require('onnx-proto');

// Tiny synthetic graph for the runtime contract. Its one-character labels
// exercise real CPU inference without any trained clinical model or records.
function writeFixtureModel(directory, tenantId) {
  const tags = ['O', 'S-PERSON', 'S-ADDRESS', 'S-ORGANIZATION', 'S-CONTACT', 'S-IDENTIFIER'];
  const tokens = ['[UNK]', '[CLS]', '[SEP]', '甲', '乙', '丙', '丁', '戊'];
  const tensor = (name, elemType, dims) => ({
    name, type: { tensorType: { elemType, shape: { dim: dims.map(dim =>
      typeof dim === 'number' ? { dimValue: dim } : { dimParam: dim }) } } },
  });
  const graph = {
    name: 'synthetic-phi-contract-fixture',
    input: ['input_ids', 'attention_mask', 'token_type_ids'].map(name => tensor(name, 7, [1, 'length'])),
    output: [tensor('logits', 1, [1, 'length', tags.length])],
    initializer: [{
      name: 'synthetic_logits', dims: [tokens.length, tags.length], dataType: 1,
      floatData: tokens.flatMap((_, row) => tags.map((_, col) => Number(col === Math.max(0, row - 2)))),
    }],
    node: [{ opType: 'Gather', input: ['synthetic_logits', 'input_ids'], output: ['logits'] }],
  };
  const assets = {
    'model_quantized.onnx': onnx.ModelProto.encode({ irVersion: 8, graph, opsetImport: [{ version: 13 }] }).finish(),
    'config.json': JSON.stringify({ model_type: 'bert', max_position_embeddings: 256, id2label: { ...tags } }),
    'tokenizer.json': JSON.stringify({
      normalizer: { type: 'BertNormalizer', clean_text: true, handle_chinese_chars: true, lowercase: false },
      pre_tokenizer: { type: 'BertPreTokenizer' },
      model: { type: 'WordPiece', continuing_subword_prefix: '##', max_input_chars_per_word: 100,
        vocab: Object.fromEntries(tokens.map((token, index) => [token, index])) },
    }),
  };
  for (const [name, bytes] of Object.entries(assets)) writeFileSync(join(directory, name), bytes);
  return {
    schema_version: 'medcius.cn-clinical-phi-assets.v1', model_kind: 'clinical_phi_ner', language: 'zh-Hans',
    model_id: 'synthetic-runtime-fixture', revision: 'synthetic-v1', tenant_id: tenantId,
    license: 'MIT', license_review_ref: 'fixture-only', clinical_validation_ref: 'fixture-only',
    files: Object.fromEntries(Object.entries(assets).map(([name, value]) =>
      [name, { bytes: Buffer.byteLength(value), sha256: sha256Hex(value) }])),
  };
}

test('live PHI requires the pinned tenant model and applies the approved formulary pack through pre-round', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'medcius-clinical-phi-fixture-'));
  const context = { tenant_id: 'synthetic-hospital', patient_id: 'p-one', encounter_id: 'e-one', doctor_id: 'd-one',
    as_of: '2026-11-23T16:00:00Z', profile: 'demo' };
  const saved = { ...process.env };
  const keys = ['MEDCIUS_LIVE_HOSPITAL_DATA', 'MEDCIUS_TENANT_ID', 'MEDCIUS_CN_CLINICAL_PHI_MANIFEST_SHA256',
    'MEDCIUS_CN_NER_MODEL_DIR', 'MEDCIUS_RULE_PACK_DIR', 'MEDCIUS_RULE_PACK_APPROVED_SHA256'];
  let detector;
  t.after(async () => {
    await detector?.close();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.MEDCIUS_TENANT_ID = context.tenant_id;
  process.env.MEDCIUS_CN_NER_MODEL_DIR = folder;
  process.env.MEDCIUS_LIVE_HOSPITAL_DATA = ' YES ';
  delete process.env.MEDCIUS_CN_CLINICAL_PHI_MANIFEST_SHA256;
  let reads = 0;
  await assert.rejects(HospitalAgentAdapter.executePreRoundFromBridge({
    context, bridge: { async readPatientSnapshot() { reads++; } },
  }), /PHI_CLINICAL_NER_MANIFEST_PIN_REQUIRED/);
  assert.equal(reads, 0);

  const manifest = writeFixtureModel(folder, context.tenant_id);
  const pinManifest = value => {
    const bytes = JSON.stringify(value);
    writeFileSync(join(folder, 'clinical-model-manifest.json'), bytes);
    process.env.MEDCIUS_CN_CLINICAL_PHI_MANIFEST_SHA256 = sha256Hex(bytes);
  };
  pinManifest({ ...manifest, clinical_validation_ref: '' });
  await assert.rejects(resolvePhiDetector({ context }), /LOCAL_NER_LOAD_FAILED/);
  const baseline = JSON.parse(readFileSync(new URL('../plugins/medcius/runtimes/cn-phi-ner/model-manifest.json', import.meta.url)));
  pinManifest({ ...manifest, files: { ...manifest.files, 'model_quantized.onnx': baseline.files['model_quantized.onnx'] } });
  await assert.rejects(resolvePhiDetector({ context }), /LOCAL_NER_LOAD_FAILED/);
  pinManifest({ ...manifest, license: 'GPL-3.0' });
  await assert.rejects(resolvePhiDetector({ context }), /LOCAL_NER_LOAD_FAILED/);
  pinManifest(manifest);
  const pin = process.env.MEDCIUS_CN_CLINICAL_PHI_MANIFEST_SHA256;
  process.env.MEDCIUS_CN_CLINICAL_PHI_MANIFEST_SHA256 = '0'.repeat(64);
  await assert.rejects(resolvePhiDetector({ context }), /LOCAL_NER_LOAD_FAILED/);
  process.env.MEDCIUS_CN_CLINICAL_PHI_MANIFEST_SHA256 = pin;
  detector = await resolvePhiDetector({ context });
  await assert.rejects(resolvePhiDetector({ context: { ...context, tenant_id: 'other' }, detector }), /TENANT_MISMATCH/);
  await assert.rejects(resolvePhiDetector({ context, detector: { ...detector } }), /VERIFIED_NER_REQUIRED/);
  const bulk = await detectManyLocalChineseNer(detector, ['甲胸痛', '乙丙丁戊']);
  assert.deepEqual(bulk.map(x => x.spans.map(s => s.label)), [['PERSON'], ['ADDRESS', 'ORGANIZATION', 'CONTACT', 'IDENTIFIER']]);
  for (const [index, text] of ['甲胸痛', '乙丙丁戊'].entries()) assert.deepEqual(await detector.detect(text), bulk[index]);
  assert.doesNotMatch(JSON.stringify(await guardPhiValue({ text: '甲诉胸痛，乙丙丁戊。' })), /[甲乙丙丁戊]/);
  const machine = { authored_on: '2026-11-22T16:00:00Z', dosage: '2.0g', route: 'ivgtt', frequency: 'qd',
    timeWindow: '24h', execution_status_basis: 'not_provided', report_name: '检验报告' };
  const mixed = await guardPatientSourceInput({
    context, patient: { id: context.patient_id }, encounter: { id: context.encounter_id },
    valid: machine, free_text: Object.fromEntries(Object.entries(machine).map(([key, value]) => [key, value + '甲'])),
  }, { detector });
  try {
    assert.deepEqual(mixed.input.valid, machine);
    assert.doesNotMatch(JSON.stringify(mixed.input.free_text), /甲/);
  } finally { mixed.session.dispose(); }

  const pack = structuredClone(loadSpecialtyRulePack('cardiology-inpatient-sandbox'));
  delete pack.sha256;
  const approvalBytes = 'SYNTHETIC TEST APPROVAL DOCUMENT';
  Object.assign(pack, { pack_id: 'synthetic-formulary', data_class: 'official', status: 'approved',
    authority: { organization: 'synthetic-pharmacy', hospital_scope: context.tenant_id, approved_by: 'synthetic-review-board',
      effective_from: '2000-01-01', review_due: '2099-01-01', approval_document: 'synthetic-review.txt',
      approval_sha256: sha256Hex(approvalBytes) } });
  pack.clinical_rules.restricted_antibiotics = [{ name: '合成药', nhsa_code: 'XJ01DDT001A001ABCD01001', class: '合成类', level: '复核', review_after_days: 2 }];
  writeFileSync(join(folder, pack.authority.approval_document), approvalBytes);
  writeFileSync(join(folder, pack.pack_id + '.json'), JSON.stringify(pack));
  process.env.MEDCIUS_RULE_PACK_DIR = folder;
  process.env.MEDCIUS_RULE_PACK_APPROVED_SHA256 = rulePackDigest(pack);
  const scopedContext = { ...context, timezone: 'Asia/Shanghai', specialty_rule_pack_id: pack.pack_id };
  const order = (id, drug_name, authored_on) => ({ id, drug_name, authored_on, status: 'active',
    drug_code_system: 'NHSA', drug_code: drug_name === '合成药' ? 'XJ01DDT001A001ABCD01001' : null,
    is_medication: true, patient_id: context.patient_id, encounter_id: context.encounter_id });
  const dataFeeds = { patient: { id: context.patient_id }, encounter: { id: context.encounter_id },
    his_orders: [
      order('source-his-1', '合成药', '2026-11-21T16:00:00Z'),
      order('source-his-2', '合成药', '2026-11-21T16:00:01Z'),
      order('source-his-3', '合成药不同成分', '2026-11-20T16:00:00Z'),
      { ...order('source-his-4', '合成药'), start_time: '2026-11-20T16:00:00Z' },
      order(undefined, '合成药', '2026-11-20T16:00:00Z'),
    ] };
  const result = await HospitalAgentAdapter.executePreRoundWorkflowAsync({ context: scopedContext, dataFeeds });
  assert.equal(result.phi_guard.detector_manifest_sha256, pin);
  assert.equal(result.summary.rule_provenance.sha256, rulePackDigest(pack));
  const alerts = result.summary.blocks.what_changed.antibiotic_duration_alerts;
  assert.deepEqual(alerts.map(a => [a.source_order_id, a.is_overdue]), [['source-his-1', null], ['source-his-2', null]]);
  assert.ok(alerts.every(a => a.duration_basis === 'observed_administration_calendar_days' && a.duration_days === null));
  assert.throws(() => HospitalAgentAdapter.resolveRulePack({ ...scopedContext, tenant_id: 'other' }), /HOSPITAL_SCOPE_MISMATCH/);
  const changed = structuredClone(pack);
  changed.clinical_rules.restricted_antibiotics[0].review_after_days = 3;
  await assert.rejects(HospitalAgentAdapter.executePreRoundWorkflowAsync({ context: scopedContext, dataFeeds, frozenRulePack: changed }),
    /DEPLOYMENT_DIGEST_MISMATCH/);
  writeFileSync(join(folder, pack.authority.approval_document), 'changed approval bytes');
  assert.throws(() => HospitalAgentAdapter.resolveRulePack(scopedContext), /APPROVAL_DOCUMENT_DIGEST_MISMATCH/);
});

test('the formal HIS chart reads only the authorized frozen status and never recomputes at chart open', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'medcius-clinical-status-'));
  const tenant = 'synthetic-status-hospital', ward = 'ward-fixture', patient = 'p-status', encounter = 'e-status';
  const manifest = JSON.stringify(writeFixtureModel(folder, tenant));
  writeFileSync(join(folder, 'clinical-model-manifest.json'), manifest);
  const env = { MEDCIUS_CN_NER_MODEL_DIR:folder, MEDCIUS_CN_CLINICAL_PHI_MANIFEST_SHA256:sha256Hex(manifest),
    MEDCIUS_LIVE_HOSPITAL_DATA:'1', MEDCIUS_PROFILE:'production', MEDCIUS_HOSPITAL_ID:'hospital-fixture', MEDCIUS_TENANT_ID:tenant,
    MEDCIUS_WARD_ID:ward, MEDCIUS_IRB_PROTOCOL_ID:'protocol-fixture', MEDCIUS_DATA_AGREEMENT_SHA256:'e'.repeat(64),
    MEDCIUS_CLINICAL_SURFACE:'his_embed', MEDCIUS_GOVERNANCE_STAGE:'silent_pilot', MEDCIUS_WARD_TIME_ZONE:'Asia/Shanghai',
    MEDCIUS_READONLY_USERNAME:'reader-fixture', MEDCIUS_JWT_SECRET:'d'.repeat(64),
    CLAUDE_MEDCIUS_DATA:folder, CLAUDE_MEDCIUS_PHI_SALT:'a'.repeat(32) };
  const prior = { ...process.env };
  const { setAuthorizedHospitalSource } = await import('../plugins/medcius/lib/authorized-hospital-source.mjs');
  t.after(() => {
    setAuthorizedHospitalSource(null);
    for (const key of Object.keys(env)) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key]=prior[key];
    }
  });
  Object.assign(process.env,env);
  const { canonicalJson } = await import('../plugins/medcius/servers/shared/crypto.mjs');
  const { appendWardPrecomputeAudit } = await import('../plugins/medcius/servers/audit/src/silent-capture.mjs');
  const { routeRequest, resetTransportEdgeGuards } = await import('../plugins/medcius/servers/api/src/rest-routes.mjs');
  const { generateToken } = await import('../plugins/medcius/servers/api/src/auth-middleware.mjs');
  const cutoff='2026-11-23T22:30:00.000Z';
  let chartReads=0;
  setAuthorizedHospitalSource({ tenantId:tenant,clock:()=>cutoff,authorizeContext:ctx=>ctx.patient_id===patient,
    bridge:{async readPatientSnapshot(){chartReads++;throw new Error('UNEXPECTED_CHART_FETCH');}} });
  const bedDigest=sha256Hex(canonicalJson(["medcius.ward-bed.v1",tenant,patient,encounter,cutoff,"01"]));
  const {event_id} = await appendWardPrecomputeAudit({scope:{tenant_id:tenant,ward_id:ward,as_of:cutoff},ward_date:'2026-11-24',time_zone:'Asia/Shanghai',
    finished_at:cutoff,roster_sha256:'a'.repeat(64),status:'captured',counts:{roster:1,captured:1},before_deadline:true,
    entries:[{status:'captured',position:1,bed_number:'01',bed_binding_sha256:bedDigest,context_hash:sha256Hex(canonicalJson([tenant,patient,encounter])),
      research_record_id:'frr-'+'a'.repeat(20),record_sha256:'a'.repeat(64),output_sha256:'b'.repeat(64)}] });
  const { HANDLERS:audit } = await import('../plugins/medcius/servers/audit/src/tools.mjs');
  const stored=await audit.get_event({event_id});
  assert.equal(stored.payload.entries[0].bed_number,undefined);
  const {getWardPreRoundWorklistAsync}=await import('../plugins/medcius/lib/research-review-workflow.mjs');
  const overview=await getWardPreRoundWorklistAsync(event_id,{tenantId:tenant,user:'auditor-fixture',isAuthenticated:true,roles:['auditor']},{overview:true});
  assert.equal(overview.entries[0].bed_number,null);
  assert.equal(overview.entries[0].bed_binding_sha256,bedDigest);
  await guardPhiValue(overview,{reject:true});
  const token=generateToken({sub:'doctor-fixture',tenant_id:tenant,roles:['physician']});
  async function request(patient_id,encounter_id) {
    resetTransportEdgeGuards();const reply={};
    await routeRequest({method:'POST',url:'/api/v1/his/embed/ward-status',headers:{host:'localhost',authorization:'Bearer '+token}},
      {setHeader(){},writeHead(code){reply.status=code;},end(json){reply.body=JSON.parse(json);}}, {patient_id,encounter_id});
    return reply;
  }
  assert.deepEqual(await request(patient,encounter),{status:200,body:{captured:true,silent:true,cards:[],draft:null,writeback:false}});
  assert.equal((await request(patient,'another-visit')).body.captured,false);
  assert.equal((await request('unauthorized',encounter)).status,403);
  assert.equal(chartReads,0);
});
