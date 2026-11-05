const required = [
  ['plugin-validate.yml', 'push'],
  ['secret-scan.yml', 'push'],
  ['performance-reference.yml', 'workflow_dispatch'],
];

// A missing, skipped, stale or failed performance run never authorizes release.
async function requireReleaseCi(github, repo, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('RELEASE_COMMIT_INVALID');
  const accepted = [];
  for (const [workflow_id, event] of required) {
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
