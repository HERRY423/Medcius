import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('performance gate refuses budget-factor overrides before running benchmarks',()=>{
  const data=mkdtempSync(join(tmpdir(),'medcius-budget-negative-'));
  for(const factor of ['2','100','0','NaN']){
    const r=spawnSync(process.execPath,['plugins/medcius/evals/performance-baseline/bench.mjs'],
      {encoding:'utf8',env:{...process.env,CLAUDE_MEDCIUS_DATA:data,MEDCIUS_DATA:data,MEDCIUS_PERF_BUDGET_FACTOR:factor},timeout:5000});
    assert.equal(r.status,1);
    assert.match(r.stderr,/must be exactly 1/);
  }
});
