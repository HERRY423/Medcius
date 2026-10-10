import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { sha256Hex, canonicalJson } from '../plugins/medcius/servers/shared/crypto.mjs';
import { scanText, scanStructuredValue, redactPhiText } from '../plugins/medcius/servers/phiguard/src/lib.mjs';
import { toModelSafe, containsRawStructuredPhi } from '../plugins/medcius/lib/clinical-boundary.mjs';
import { guardToolOutput } from '../plugins/medcius/servers/shared/phi-output.mjs';
import { isIntegrityMetadata } from '../plugins/medcius/servers/shared/integrity-metadata.mjs';
import { generateKeyPair, signDecision, verifyDecisionSignature, registerPublicKey, buildSignoffEnvelope, signSignoffEnvelope } from '../plugins/medcius/servers/shared/digital-signature.mjs';
import { HospitalAgentAdapter } from '../plugins/medcius/lib/hospital-agent-adapter.mjs';
import { getCardiologyMultiSourceFeeds } from '../plugins/medcius/servers/fhir/sandbox/hospital-cardiology-sandbox.mjs';

// An actual SHA-256, not just a fabricated hash-shaped string. Old code always
// changed this digest from 64 to 79 characters with redaction enabled.
const preimage = 'synthetic-integrity-regression-111';
const digest = '3806fb08ee3d39f323cff3e1dee25cd3b6e8bcd0a7ef6a2132e9e13093590581';
const shaped = digits => 'a'.repeat(20) + digits + 'b'.repeat(44-digits.length);

test('deterministic reproduction: free-text phone detection still catches the old 64-to-79 collision',()=>{
  assert.equal(sha256Hex(preimage),digest);
  assert.equal(redactPhiText(digest).length,79);
  assert.ok(scanText(digest).findings.some(f=>f.type==='phone_cn_mobile'));
  assert.equal(toModelSafe({envelope_sha256:digest},{salt:null}).envelope_sha256,digest);
});
test('mobile, fixed phone, ID and bank-card collisions preserve exact metadata across repeated egress',()=>{
  const cases=[digest,shaped('13912345678'),shaped('01012345678'),shaped('110101199003072345'),shaped('6222021234567890123')];
  const fields=['envelope_sha256','summary_sha256','signed_hash','event_digest','chain_hash','payload_digest','row_sha256','content_sha256','sha256'];
  for(const hash of cases)for(const value of [hash,hash.toUpperCase()])for(const salt of [null,'synthetic-integrity-salt']){
    const input=Object.fromEntries(fields.map(k=>[k,value]));
    assert.ok(scanText(value).total>0);
    assert.deepEqual(toModelSafe(input,{salt}),input);
    assert.equal(containsRawStructuredPhi(input).hit,false);
    assert.equal(scanStructuredValue(input).total,0);
    const result=guardToolOutput(guardToolOutput({nested:[input],content:[{type:'text',text:JSON.stringify(input)}]}));
    assert.deepEqual(result.nested[0],input);assert.deepEqual(JSON.parse(result.content[0].text),input);
  }
});
test('metadata names do not exempt identifiers, arbitrary strings, nested objects or fake signatures',()=>{
  for(const payload of [
    {envelope_sha256:'13912345678'}, {summary_sha256:'a13912345678b'},
    {envelope_sha256:shaped('13912345678')+'0'}, {envelope_sha256:'prefix:'+digest},
    {envelope_sha256:{phone:'13912345678'}}, {envelope_sha256:['13912345678']},
    {unregistered_sha256:digest}, {note:digest}, {phone:digest},
    {signature:'13912345678',signature_algorithm:'ECDSA_P256_SHA256'},
    {public_key:'-----BEGIN PUBLIC KEY-----\n13912345678\n-----END PUBLIC KEY-----'},
  ]){
    assert.equal(containsRawStructuredPhi(payload).hit,true,JSON.stringify(payload));
    const safe=guardToolOutput(payload);assert.equal(containsRawStructuredPhi(safe).hit,false);
    assert.notDeepEqual(safe,payload);
  }
  assert.ok(scanText('tel13912345678x').total>0);
  assert.ok(scanStructuredValue({sha256:digest,comment:'电话13912345678'}).total>0);
  assert.equal(containsRawStructuredPhi({sha256:digest,phone:'13912345678'}).hit,true);
});
test('serialized JSON strings and MCP metadata retain hashes while removing adjacent PHI',()=>{
  const input={_meta:{envelope_sha256:digest},structuredContent:{summary_sha256:digest,phone:'13912345678'},content:[{type:'text',text:JSON.stringify({summary_sha256:digest,note:'电话13912345678',inner:JSON.stringify({content_sha256:digest,phone:'13912345678'})})}]};
  const safe=guardToolOutput(input),parsed=JSON.parse(safe.content[0].text);
  assert.equal(safe._meta.envelope_sha256,digest);assert.equal(safe.structuredContent.summary_sha256,digest);
  assert.equal(parsed.summary_sha256,digest);assert.equal(JSON.parse(parsed.inner).content_sha256,digest);
  assert.equal(containsRawStructuredPhi(safe).hit,false);
  assert.doesNotMatch(JSON.stringify(safe),/13912345678/);
  assert.deepEqual(guardToolOutput(safe),safe);
  const exact=' { "summary_sha256" : "'+digest+'", "text": "\\u5408\\u6210" }\n';
  assert.equal(toModelSafe(exact),exact);assert.equal(guardToolOutput(exact),exact);
});
test('1,024 deterministic real digests survive both salted and redacted structural boundaries',()=>{
  let collisions=0;
  for(let i=0;i<1024;i++){
    const h=sha256Hex('synthetic-integrity-regression-'+i);if(scanText(h).total)collisions++;
    const data={summary_sha256:h,rows:[{content_sha256:h}]};
    assert.deepEqual(toModelSafe(data,{salt:i%2?'synthetic-salt':null}),data);
    assert.deepEqual(guardToolOutput(data),data);
  }
  assert.ok(collisions>0);
});
test('real digital signature verifies after PHI egress; digest tampering still fails',()=>{
  const key=generateKeyPair('synthetic-signer');
  const signed=signDecision({payload:preimage,privateKeyPem:key.privateKey,keyId:'synthetic-fixed-key',signer:'synthetic-signer',role:'physician'});
  assert.equal(signed.signed_hash,digest);assert.equal(isIntegrityMetadata('signature',signed.signature,signed),true);
  const safe=guardToolOutput({...signed,public_key:key.publicKey});
  assert.equal(safe.signed_hash,digest);assert.equal(safe.signature,signed.signature);assert.equal(safe.public_key,key.publicKey);
  const verify=h=>verifyDecisionSignature({payload:preimage,signature:safe.signature,publicKeyPem:safe.public_key,signer:safe.signer,role:safe.role,signedHash:h});
  assert.equal(verify(safe.signed_hash).valid,true);assert.equal(verify('f'.repeat(64)).valid,false);
});
test('fixed clock and feeds yield recomputable hospital provenance, not just a 64-character value',()=>{
  const asOf='2026-10-06T10:00:00.000Z',dataFeeds=getCardiologyMultiSourceFeeds({now:asOf})[0];
  const context={tenant_id:'synthetic-hospital',doctor_id:'synthetic-doctor',patient_id:dataFeeds.patient.id,encounter_id:dataFeeds.encounter.id,as_of:asOf,time_window:'24h'};
  const a=HospitalAgentAdapter.executePreRoundWorkflow({context,dataFeeds});
  const b=HospitalAgentAdapter.executePreRoundWorkflow({context,dataFeeds});
  assert.deepEqual(a,b);
  const expected=sha256Hex(canonicalJson({tenant_id:context.tenant_id,patient_id:context.patient_id,encounter_id:context.encounter_id,time_window:'24h',total_items:a.summary.total_items_count,summary_sha256:sha256Hex(canonicalJson(a.summary)),timestamp:asOf}));
  assert.equal(a.provenance.envelope_sha256,expected);assert.equal(guardToolOutput(a).provenance.envelope_sha256,expected);
});
test('append-only audit export is independently verifiable after egress; raw PHI remains rejected',async()=>{
  process.env.CLAUDE_MEDCIUS_DATA=mkdtempSync(join(tmpdir(),'medcius-integrity-regression-'));
  const {HANDLERS:audit,verifyAuditRows,encodeAuditDigest,decodeAuditDigest}=await import('../plugins/medcius/servers/audit/src/tools.mjs');
  const args={actor:'synthetic-reviewer',action:'synthetic_integrity_check',subject_ref:'synthetic-case',tenant_id:'synthetic-hospital'};
  // Audit callers still use the existing byte encoding. Output metadata is
  // generated by the audit store; field naming never authorizes raw PHI input.
  assert.throws(()=>audit.record_event({...args,payload:{envelope_sha256:digest}}),/PHI guard/);
  const event=audit.record_event({...args,payload:{envelope_sha256:encodeAuditDigest(digest),summary_sha256:encodeAuditDigest(digest)}});
  audit.record_event({...args,payload:{content_sha256:encodeAuditDigest(shaped('01012345678'))}});
  const keys=generateKeyPair('synthetic-reviewer'),keyId='synthetic-fixed-audit-key';
  registerPublicKey(keyId,'synthetic-reviewer',keys.publicKey);
  const {envelope}=buildSignoffEnvelope({eventId:event.event_id,eventDigest:event.event_digest,tenantId:args.tenant_id,signer:args.actor,role:'physician',decision:'agree',reason:preimage,signedAt:'2026-10-06T10:00:00.000Z',replayId:'synthetic-replay-fixed'});
  const signed=signSignoffEnvelope({envelope,privateKeyPem:keys.privateKey,keyId});
  audit.signoff({event_id:event.event_id,tenant_id:args.tenant_id,signer:args.actor,role:'physician',decision:'agree',reason:preimage,envelope,...signed});
  assert.throws(()=>audit.record_event({...args,payload:{sha256:'13912345678'}}),/PHI guard/);
  assert.throws(()=>audit.record_event({...args,payload:{sha256:digest,note:'电话13912345678'}}),/PHI guard/);
  const before=audit.export_batch({}),safe=guardToolOutput(before);
  assert.equal(canonicalJson(safe.events),canonicalJson(before.events));assert.equal(verifyAuditRows(safe.events,safe.signoffs).ok,true);
  assert.equal(canonicalJson(safe.signoffs),canonicalJson(before.signoffs));assert.equal(safe.signoffs[0].reason_digest,digest);
  assert.equal(decodeAuditDigest(JSON.parse(safe.events[0].payload_json).envelope_sha256),digest);
  const bad=structuredClone(safe.events);bad[0].payload_json='{}';assert.equal(verifyAuditRows(bad,safe.signoffs).ok,false);
  assert.equal(audit.verify_chain({}).ok,true);
});
test('real stdio MCP egress preserves hash metadata and serialized records',async()=>{
  const uri=new URL('../plugins/medcius/servers/shared/rpc.mjs',import.meta.url).href;
  const result={content:[{type:'text',text:JSON.stringify({envelope_sha256:digest,phone:'13912345678'})}],_meta:{summary_sha256:digest}};
  const script=`import {serve} from ${JSON.stringify(uri)};serve({serverInfo:{name:'integrity-test',version:'1'},phiGuard:true,tools:[{name:'probe',inputSchema:{type:'object',properties:{}}}],handlers:{probe:()=>(${JSON.stringify(result)})}});`;
  const proc=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe']});proc.stderr.resume();
  const lines=createInterface({input:proc.stdout});
  try{
    const reply=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('MCP_TIMEOUT')),5000);lines.once('line',line=>{clearTimeout(timer);resolve(JSON.parse(line));});proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'probe',arguments:{}}})+'\n');});
    assert.equal(reply.result._meta.summary_sha256,digest);assert.equal(JSON.parse(reply.result.content[0].text).envelope_sha256,digest);assert.doesNotMatch(JSON.stringify(reply),/13912345678/);
  }finally{proc.kill();lines.close();}
});
