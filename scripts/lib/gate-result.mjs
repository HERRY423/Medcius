// Process completion is not a clinical endpoint or a regulatory approval.
export function assessGateResult(step, result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const execution = result.status === 0 && !result.error && !result.signal;
  const evidence = step.kind === "report" || (step.successPattern instanceof RegExp && step.successPattern.test(output));
  const ok = execution && evidence;
  return { ok, execution_status: execution ? "COMPLETED" : "FAILED",
    assertion_status: !ok ? "FAILED" : step.kind === "report" ? "NOT_ASSERTED" : "PASSED",
    evidence_status: !evidence ? "EXPECTED_EVIDENCE_MISSING" : step.kind === "report" ? "REPORT_EXECUTED_ONLY" : "ENGINEERING_CHECK",
    exit_code: result.status, error: result.error?.code ?? null };
}
