#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createPatientSourceSnapshotAsync, getPatientSnapshotPhiSession } from "../plugins/medcius/lib/patient-source-snapshot.mjs";
import { backtestRecordQuality } from "../plugins/medcius/lib/record-quality-backtest.mjs";
import { guardPhiValue } from "../plugins/medcius/lib/phi-value-guard.mjs";
import { assertSyncPhiAllowed } from "../plugins/medcius/lib/production-phi-policy.mjs";

try {
  if (process.argv.length !== 3) throw new Error("BACKTEST_INPUT_FILE_REQUIRED");
  assertSyncPhiAllowed();
  const { tenant_id: tenantId, policy, cases: sources } = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (typeof tenantId !== "string" || !tenantId.trim() || tenantId === "default" || !Array.isArray(sources) || !sources.length) {
    throw new Error("BACKTEST_COHORT_REQUIRED");
  }
  const cases = [];
  for (const { source, reference } of sources) {
    if (source?.context?.tenant_id !== tenantId) throw new Error("BACKTEST_COHORT_SCOPE_MISMATCH");
    assertSyncPhiAllowed(source.context);
    const snapshot = await createPatientSourceSnapshotAsync(source);
    getPatientSnapshotPhiSession(snapshot, snapshot.context).dispose();
    cases.push({ snapshot, reference });
  }
  const report = backtestRecordQuality({ tenantId, policy, cases });
  await guardPhiValue(report, { reject: true });
  console.log(JSON.stringify(report, null, 2));
  if (report.counts.not_evaluated || report.counts.partially_reviewed) process.exitCode = 1;
} catch (error) {
  const code = /^(?:BACKTEST_[A-Z_]+|PHI_[A-Z_]+|RECORD_REVIEW_POLICY_INVALID)$/.test(error?.message) ? error.message : "BACKTEST_FAILED";
  console.error(code);
  process.exitCode = 1;
}
