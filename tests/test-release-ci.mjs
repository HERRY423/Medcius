import test from 'node:test';
import assert from 'node:assert/strict';
import {requireReleaseCi} from '../scripts/lib/release-ci.cjs';
const sha='a'.repeat(40), repo={owner:'synthetic',repo:'synthetic'};
const fake = alter => ({rest:{actions:{async listWorkflowRuns(query) {
  assert.equal(query.head_sha,sha);
  const run={head_sha:sha,head_branch:'main',event:query.event,status:'completed',conclusion:'success',run_number:2,run_attempt:1,html_url:query.workflow_id};
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
    await assert.rejects(requireReleaseCi(fake((id,run)=>[{...run,...state}]),repo,sha),/RELEASE_CI_NOT_PASSED/);
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
