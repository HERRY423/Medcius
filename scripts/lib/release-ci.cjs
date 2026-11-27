const required = [
  ['plugin-validate.yml', 'push'],
  ['secret-scan.yml', 'push'],
  ['performance-reference.yml', 'workflow_dispatch'],
];

// V1.1.0 uses the exact commit's local synthetic benchmark as the one-time
// performance evidence. The default release path still requires all three runs.
async function requireReleaseCi(github, repo, sha, {referenceWaiverTag} = {}) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('RELEASE_COMMIT_INVALID');
  if (referenceWaiverTag !== undefined &&
      (repo.owner !== 'HERRY423' || repo.repo !== 'Medcius' || referenceWaiverTag !== 'V1.1.0' ||
       sha !== 'fd31ec144967edf7b22d596b5af109a053938c68')) {
    throw new Error('RELEASE_REFERENCE_WAIVER_INVALID');
  }
  const accepted = [];
  for (const [workflow_id, event] of required) {
    if (referenceWaiverTag !== undefined && workflow_id === 'performance-reference.yml') continue;
    const {data} = await github.rest.actions.listWorkflowRuns({
      ...repo, workflow_id, head_sha:sha, event, per_page:100,
    });
    const latest = data.workflow_runs
      .filter(run => run.head_sha === sha && run.head_branch === 'main' && run.event === event)
      .sort((a,b) => b.run_number-a.run_number || b.run_attempt-a.run_attempt)[0];
    if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') {
      throw new Error(`RELEASE_CI_NOT_PASSED: ${workflow_id} at ${sha}`);
    }
    accepted.push({workflow:workflow_id,url:latest.html_url});
  }
  return accepted;
}
module.exports = {requireReleaseCi};
