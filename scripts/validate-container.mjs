// Actual local Docker acceptance, synthetic only. Build the image first.
// Requires MEDCIUS_CONTAINER_IMAGE, MEDCIUS_CN_NER_MODEL_DIR,
// MEDCIUS_CONTAINER_TEST_TLS (synthetic.key/.crt with loopback SAN), and an out dir.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const image=process.env.MEDCIUS_CONTAINER_IMAGE;
const model=process.env.MEDCIUS_CN_NER_MODEL_DIR;
const tls=process.env.MEDCIUS_CONTAINER_TEST_TLS;
assert.ok(image && model && tls,'container image, local model and synthetic TLS fixtures are required');
const out=resolve(process.argv[2]||'out/container-validation-'+randomUUID());mkdirSync(out,{recursive:true});
const empty=join(out,'empty-runtime'),corrupt=join(out,'corrupt-model');
mkdirSync(empty,{recursive:true});mkdirSync(corrupt,{recursive:true});writeFileSync(join(corrupt,'config.json'),'{}');
const unavailableWorker=join(out,'unavailable-worker.mjs');writeFileSync(unavailableWorker,'// Synthetic worker bootstrap failure: no ready handshake.\n');
const receipt={run_id:randomUUID(),started_at:new Date().toISOString(),image,scope:'local synthetic Linux container engineering',steps:[]};
function run(label,args,expected=0,pattern,timeout=120000){
  const start=Date.now();
  const r=spawnSync('docker',args,{encoding:'utf8',timeout,maxBuffer:16*1024*1024});
  const text=(r.stdout||'')+'\n'+(r.stderr||'');
  const log=join(out,`${receipt.steps.length+1}-${label}.log`);writeFileSync(log,text);
  const ok=r.status===expected && !r.error && (!pattern||pattern.test(text));
  receipt.steps.push({label,args,status:r.status,error:r.error?.code||null,expected_exit:expected,
    duration_ms:Date.now()-start,ok,log,sha256:createHash('sha256').update(text).digest('hex')});
  assert.ok(ok,`${label} failed; see ${log}`);return r.stdout.trim();
}
const mount=(source,target)=>['--mount',`type=bind,source=${resolve(source)},target=${target},readonly`];
const base=['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
  '--tmpfs','/tmp:rw,noexec,nosuid,size=512m','--tmpfs','/opt/medcius/data:rw,noexec,nosuid,mode=1777,size=256m',
  '-e','MEDCIUS_DATA=/opt/medcius/data'];
const modelMount=mount(model,'/opt/medcius/models/bert-base-chinese-ner-int8');
const tlsMount=[...mount(tls,'/opt/medcius/test-tls'),'-e','MEDCIUS_TLS_KEY=/opt/medcius/test-tls/synthetic.key',
  '-e','MEDCIUS_TLS_CERT=/opt/medcius/test-tls/synthetic.crt','-e','NODE_EXTRA_CA_CERTS=/opt/medcius/test-tls/synthetic.crt'];
const name='medcius-synthetic-'+receipt.run_id;
let started=false;
try {
  receipt.engine=JSON.parse(run('engine',['version','--format','{{json .Server}}']));
  receipt.image_id=run('image-id',['image','inspect',image,'--format','{{.Id}}']);
  run('nonroot', [...base,image,'node','-e',"if(process.getuid()===0)process.exit(1);console.log('NONROOT_CPU_CONTAINER')"],0,/NONROOT_CPU_CONTAINER/);
  run('native-cpu',[...base,...modelMount,image,'node','scripts/verify-runtime.mjs'],0,/RUNTIME_READY/);
  run('missing-model',[...base,image,'node','scripts/verify-runtime.mjs'],1,/RUNTIME_NOT_READY/);
  run('corrupt-model',[...base,...mount(corrupt,'/opt/medcius/models/bert-base-chinese-ner-int8'),image,'node','scripts/verify-runtime.mjs'],1,/RUNTIME_NOT_READY/);
  run('missing-dependency',[...base,...modelMount,...mount(empty,'/opt/medcius/app/plugins/medcius/runtimes/cn-phi-ner/node_modules'),image,'node','scripts/verify-runtime.mjs'],1,/RUNTIME_NOT_READY/);
  run('missing-graph-parser',[...base,...modelMount,...mount(empty,'/opt/medcius/app/plugins/medcius/runtimes/cn-phi-ner/node_modules/onnx-proto'),image,'node','scripts/verify-runtime.mjs'],1,/RUNTIME_NOT_READY/);
  run('worker-bootstrap-failure',[...base,...modelMount,...mount(unavailableWorker,'/opt/medcius/app/plugins/medcius/runtimes/cn-phi-ner/batch-worker.mjs'),image,'node','scripts/verify-runtime.mjs'],1,/RUNTIME_NOT_READY/);
  run('missing-tls',[...base,...modelMount,image],1,/TLS is mandatory/);
  run('server-missing-model',[...base,...tlsMount,image],1,/PHI_LOCAL_NER_LOAD_FAILED/);
  run('production-start',[...base,'--detach','--name',name,'--health-interval','1s','--health-start-period','2s',...modelMount,...tlsMount,image]);started=true;
  let healthy=false;
  for(let attempt=0;attempt<40;attempt++){
    const r=spawnSync('docker',['inspect',name,'--format','{{.State.Health.Status}}'],{encoding:'utf8',timeout:5000});
    if(r.status===0 && r.stdout.trim()==='healthy'){healthy=true;break;}
    await new Promise(r=>setTimeout(r,500));
  }
  run('server-log',['logs',name],0,/Server listening on https/);
  run('health-state',['inspect',name,'--format','{{.State.Health.Status}}'],0,/^healthy\s*$/);
  assert.ok(healthy,'actual declared Docker healthcheck must become healthy');
  run('trusted-tls',['exec',name,'node','scripts/healthcheck.mjs']);
  run('untrusted-tls',['exec','-e','NODE_EXTRA_CA_CERTS=',name,'node','scripts/healthcheck.mjs'],1,/HEALTHCHECK_FAILED/);
  run('phi-regression',[...base,...modelMount,...mount('tests','/opt/medcius/app/tests'),image,'node','--test','--test-concurrency=1',
    'tests/test-phi-inference-scope.mjs','tests/test-production-dual-phi.mjs','tests/test-production-mcp-phi.mjs',
    'tests/test-ner-concurrency.mjs','tests/test-cn-phi-onnx.mjs','tests/test-ner-batch-equivalence.mjs'],0,/# tests 31[\s\S]*# fail 0[\s\S]*# skipped 0/,240000);
  receipt.container_engineering_pass=true;
} catch(error){receipt.container_engineering_pass=false;receipt.error=error.message;process.exitCode=1;}
finally {
  if(started)try {run('cleanup',['stop','--time','10',name]);}
  catch(error){receipt.container_engineering_pass=false;receipt.cleanup_error=error.message;process.exitCode=1;}
  receipt.completed_at=new Date().toISOString();receipt.clinical_evidence_pass='NOT_ESTABLISHED';
  writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify({container_engineering_pass:receipt.container_engineering_pass,steps:receipt.steps.length,receipt:join(out,'receipt.json')}));
}
