import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('pinned upstream validator accepts the plugin and rejects an invalid manifest',()=>{
  const run = target => spawnSync(process.execPath,['scripts/validate-plugin.mjs',target],{encoding:'utf8'});
  const real=run('plugins/medcius');
  assert.equal(real.status,0,real.stdout+real.stderr);
  assert.match(real.stdout,/Plugin validation passed:/);
  const fixture=mkdtempSync(join(tmpdir(),'medcius-validator-negative-'));
  try {
    mkdirSync(join(fixture,'.codex-plugin'));
    writeFileSync(join(fixture,'.codex-plugin/plugin.json'),JSON.stringify({name:'INVALID NAME',version:'0.1.0'}));
    const invalid=run(fixture);
    assert.notEqual(invalid.status,0);
    assert.match(invalid.stdout+invalid.stderr,/name|validation/i);
  } finally {rmSync(fixture,{recursive:true,force:true});}
});
