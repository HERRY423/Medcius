import test from 'node:test';
import assert from 'node:assert/strict';
import {requireReleaseCi} from '../scripts/lib/release-ci.cjs';
const sha='a'.repeat(40), repo={owner:'synthetic',repo:'synthetic'};
const fake = (alter, expectedSha = sha) => ({rest:{actions:{async listWorkflowRuns(query) {
  assert.equal(query.head_sha,expectedSha);
  const run={head_sha:expectedSha,head_branch:'main',event:query.event,status:'completed',conclusion:'success',run_number:2,run_attempt:1,html_url:query.workflow_id};
  return {data:{workflow_runs:alter(query.workflow_id,run)}};
}}}});
test('release requires all three successful workflows for the same main commit',async()=>{
  const result=await requireReleaseCi(fake((id,run)=>[run]),repo,sha);
  assert.equal(result.length,3);assert.equal(result[2].workflow,'performance-reference.yml');
});
test('missing reference performance blocks release',async()=>{
  await assert.rejects(requireReleaseCi(fake((id,run)=>id==='performance-reference.yml'?[]:[run]),repo,sha),/RELEASE_CI_NOT_PASSED/);
});
test('failed, skipped and unfinished checks block release',async()=>{
  for(const state of [{conclusion:'failure'},{conclusion:'skipped'},{status:'in_progress',conclusion:null}]) {
    await assert.rejects(requireReleaseCi(fake((id,run)=>[{...run,...state}]),repo,sha),{
      code:state.status==='in_progress'?'RELEASE_CI_PENDING':'RELEASE_CI_FAILED',
      message:/RELEASE_CI_NOT_PASSED/
    });
  }
});
test('different commit, branch or event cannot authorize release',async()=>{
  for(const state of [{head_sha:'b'.repeat(40)},{head_branch:'unreviewed'},{event:'pull_request'}]) {
    await assert.rejects(requireReleaseCi(fake((id,run)=>[{...run,...state}]),repo,sha),/RELEASE_CI_NOT_PASSED/);
  }
});
test('a newer failure supersedes an older success',async()=>{
  await assert.rejects(requireReleaseCi(fake((id,run)=>[run,{...run,run_number:3,conclusion:'failure'}]),repo,sha),/RELEASE_CI_NOT_PASSED/);
});
test('invalid commit is rejected before API access',async()=>{
  await assert.rejects(requireReleaseCi({},repo,'main'),/RELEASE_COMMIT_INVALID/);
});

const medcius = {owner:'HERRY423',repo:'Medcius'};
const releaseCommit = 'c'.repeat(40);
const waiver = {referenceWaiverTag:'V1.1.0',referenceWaiverPluginTree:'47190c31d29d106cb60d42da1ffcefbfb16f330b'};

test('V1.1.0 waiver verifies both hosted checks for the exact release commit',async()=>{
  const result=await requireReleaseCi(fake((id,run)=>{
    assert.notEqual(id,'performance-reference.yml');
    return [run];
  },releaseCommit),medcius,releaseCommit,waiver);
  assert.deepEqual(result.map(x=>x.workflow),['plugin-validate.yml','secret-scan.yml']);
  for (const check of ['plugin-validate.yml','secret-scan.yml']) {
    await assert.rejects(requireReleaseCi(
      fake((id,run)=>id===check?[]:[run],releaseCommit),medcius,releaseCommit,waiver
    ),/RELEASE_CI_NOT_PASSED/);
  }
});

test('default, another repository, tag or plugin tree cannot reuse the waiver',async()=>{
  await assert.rejects(requireReleaseCi(
    fake((id,run)=>id==='performance-reference.yml'?[]:[run],releaseCommit),medcius,releaseCommit
  ),/RELEASE_CI_NOT_PASSED/);
  await assert.rejects(requireReleaseCi({},repo,releaseCommit,waiver),/RELEASE_REFERENCE_WAIVER_INVALID/);
  await assert.rejects(requireReleaseCi({},medcius,releaseCommit,{...waiver,referenceWaiverPluginTree:sha}),/RELEASE_REFERENCE_WAIVER_INVALID/);
  await assert.rejects(requireReleaseCi({},medcius,releaseCommit,{...waiver,referenceWaiverTag:'V1.2.0'}),/RELEASE_REFERENCE_WAIVER_INVALID/);
});
