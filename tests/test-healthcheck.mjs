import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';

test('container health probe enforces production TLS and rejects unavailable service',async()=>{
  let status=200, requests=0;
  const server=createServer((req,res)=>{requests++;res.writeHead(status);res.end('{}');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const run=extra=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['scripts/healthcheck.mjs'],{env:{...process.env,
      NODE_ENV:'test',MEDCIUS_PROFILE:'demo',MEDCIUS_TLS_KEY:'',MEDCIUS_TLS_CERT:'',
      PORT:String(server.address().port),...extra},stdio:'ignore'});
    child.on('error',reject);child.on('close',resolve);
  });
  try {
    assert.equal(await run({}),0);
    const before=requests;
    assert.equal(await run({NODE_ENV:'production'}),1);
    assert.equal(await run({MEDCIUS_TLS_CERT:'/missing-cert'}),1);
    assert.equal(requests,before,'production or partial TLS must not downgrade to HTTP');
    status=503;assert.equal(await run({}),1);
  } finally {await new Promise(r=>server.close(r));}
});
