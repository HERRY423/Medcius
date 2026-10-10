import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {assessGateResult} from "../scripts/lib/gate-result.mjs";
import {validateContract} from "../scripts/lib/schema-contract.mjs";
import {validateControlledDocuments,ROOT} from "../scripts/validate-controlled-documents.mjs";
import {runAudit} from "../scripts/qms-internal-audit.mjs";
import {EnhancedPhiGuard} from "../plugins/medcius/lib/enhanced-phi-guard.mjs";
import {scanText,redactPhiText} from "../plugins/medcius/servers/phiguard/src/lib.mjs";
import {deepFreeze} from "../plugins/medcius/servers/shared/immutable.mjs";

assert.equal(assessGateResult({kind:"report"},{status:0}).assertion_status,"NOT_ASSERTED");
assert.equal(assessGateResult({kind:"check"},{status:0}).ok,false,"Exit zero without an evidence contract must fail");
assert.equal(assessGateResult({kind:"check",successPattern:/VERIFIED/},{status:0,stdout:"done"}).ok,false);
assert.equal(assessGateResult({kind:"check"},{status:0,error:{code:"ETIMEDOUT"}}).ok,false);
assert.equal(assessGateResult({kind:"check"},{status:null,signal:"SIGTERM"}).ok,false);
assert.equal(assessGateResult({kind:"check",successPattern:/VERIFIED/},{status:0,stdout:"VERIFIED"}).ok,true);
console.log("PASS completion, assertions, missing evidence, timeout and signal separation");

const schema={type:"object",required:["limit","date"],additionalProperties:false,properties:{limit:{type:"number",minimum:1},date:{type:"string",format:"date"}}};
assert.equal(validateContract(schema,{limit:1,date:"2026-10-06"}),true);
for(const invalid of [{limit:"1",date:"2026-10-06"},{limit:0,date:"2026-10-06"},{limit:1,date:"2026-02-30"},{limit:1},{limit:1,date:"2026-10-06",extra:true}]) assert.throws(()=>validateContract(schema,invalid));
assert.throws(()=>validateContract({type:"object",properties:{absent:{unsupported:true}}},{}),/unsupported/);
console.log("PASS valid JSON with wrong type, threshold, calendar date, missing/extra fields rejected");

const root=mkdtempSync(join(tmpdir(),"medcius-controlled-negative-"));
const registryPath="docs/compliance/qms/controlled-documents.json";
const registry=JSON.parse(readFileSync(join(ROOT,registryPath),"utf8"));
for(const path of [registryPath,...registry.manifests,...registry.documents.map(d=>d.path),...registry.components.map(c=>c.path)]) {
  mkdirSync(dirname(join(root,path)),{recursive:true});cpSync(join(ROOT,path),join(root,path));
}
assert.equal(validateControlledDocuments(root).ok,true);
const doc=registry.documents[0].path, original=readFileSync(join(root,doc),"utf8");
writeFileSync(join(root,doc),original+"\nUnreviewed change\n");
assert.ok(validateControlledDocuments(root).errors.some(e=>e.startsWith("DOCUMENT_CONTENT_CHANGED")));
writeFileSync(join(root,doc),original.replaceAll("0.8.0-pilot","0.2.0-pilot"));
assert.ok(validateControlledDocuments(root).errors.some(e=>e.startsWith("DOCUMENT_VERSION_DRIFT")));
writeFileSync(join(root,doc),original);
const component=registry.components[0].path, value=JSON.parse(readFileSync(join(root,component),"utf8"));
writeFileSync(join(root,component),JSON.stringify({...value,version:"99.0.0"}));
assert.ok(validateControlledDocuments(root).errors.some(e=>e.startsWith("COMPONENT_VERSION_DRIFT")));
console.log("PASS controlled document content/version drift and independent component drift rejected");

assert.throws(()=>runAudit({only:[]}),/INVALID_AUDIT_SELECTION/);
assert.throws(()=>runAudit({only:["unknown"]}),/INVALID_AUDIT_SELECTION/);
const audit=runAudit({only:["m06"],attestations:[{item:"a01",name:"Synthetic",role:"reviewer",note:"claim"}]});
assert.equal(audit.scope,"PARTIAL_MACHINE_CHECKS");
assert.equal(audit.attestations[0].status,"claimed_unverified");
assert.notEqual(audit.overall,"pass");
const strict=spawnSync(process.execPath,["scripts/qms-internal-audit.mjs","--only","m06","--no-write","--strict","--attest-item","a01","Synthetic:reviewer:claim"],{cwd:ROOT,encoding:"utf8"});
assert.equal(strict.status,2);
assert.notEqual(audit.audit_id,runAudit({only:["m06"]}).audit_id);
console.log("PASS invalid audit subsets, unsigned claims and unique audit identities");

for(const text of ["患者张三，联系电话 13800138000", "联系人：李四；邮箱 synthetic@example.com", "CHA2DS2-VASc 与 Cockcroft-Gault 仅为名称"]) {
  const actual=EnhancedPhiGuard.sanitize(text,{mode:"REDACT"});
  assert.equal(actual.sanitized,redactPhiText(text,{contextual:true}));
  assert.equal(actual.detected_count,scanText(text,{contextual:true}).total);
  assert.equal(scanText(actual.sanitized,{contextual:true}).total,0);
  assert.equal(EnhancedPhiGuard.sanitize(actual.sanitized,{mode:"REDACT"}).sanitized,actual.sanitized);
}
assert.throws(()=>EnhancedPhiGuard.generateToken("synthetic","name",""),/PHI_SALT_REQUIRED/);
const cyclic={nested:{value:1}};cyclic.self=cyclic;deepFreeze(cyclic);
assert.throws(()=>{cyclic.nested.value=2;},TypeError);
console.log("PASS canonical PHI facade parity, no fixed salt and deep immutability");

const probe=spawnSync(process.execPath,["--input-type=module","-e",`
import {createLlmInferenceClient} from './plugins/medcius/lib/llm-inference-config.mjs';
const client=createLlmInferenceClient({config:{topology:'A',model_id:'synthetic',model_version:'1',prompt_pack_version:'1',endpoint:'http://localhost/unused'},transport:async()=>({text:'synthetic'})});
await client.extract({text:'synthetic'});
if(client.capacity().inflight!==0) throw new Error('inflight leak');
console.log('TIMER_RELEASED');`],{cwd:ROOT,encoding:"utf8",timeout:5000});
assert.equal(probe.status,0,`Successful extraction must not keep its 30s timeout alive: ${probe.error?.code}`);
assert.match(probe.stdout,/TIMER_RELEASED/);

// A syntactically valid but structurally invalid manifest must fail the real deploy status.
const fake=mkdtempSync(join(tmpdir(),"medcius-deploy-gate-negative-"));
mkdirSync(join(fake,"scripts"),{recursive:true});
cpSync(join(ROOT,"scripts/deploy.mjs"),join(fake,"scripts/deploy.mjs"));
cpSync(join(ROOT,"scripts/validate-json.mjs"),join(fake,"scripts/validate-json.mjs"));
cpSync(join(ROOT,"scripts/lib"),join(fake,"scripts/lib"),{recursive:true});
cpSync(join(ROOT,"plugins/medcius/lib/specialty-rule-pack.mjs"),join(fake,"plugins/medcius/lib/specialty-rule-pack.mjs"),{recursive:true});
cpSync(join(ROOT,"plugins/medcius/servers/shared"),join(fake,"plugins/medcius/servers/shared"),{recursive:true});
writeFileSync(join(fake,"plugins/medcius/plugin.json"),JSON.stringify({name:"medcius",version:8}));
const deploy=spawnSync(process.execPath,[join(fake,"scripts/deploy.mjs"),"status"],{encoding:"utf8"});
assert.notEqual(deploy.status,0);assert.match(deploy.stdout,/FAIL quick_gate/);
console.log("ALL GOVERNANCE GATE NEGATIVE CONTROLS PASSED");
