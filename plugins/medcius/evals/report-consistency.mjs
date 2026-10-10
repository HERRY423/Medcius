// A report must not state a verdict that its own evidence table contradicts.
//
// Two failure modes this guards against, both observed in shipped reports:
//   1. An endpoint that decides the overall verdict is absent from the evidence
//      table, so the reader sees "all rows met" above a "not met" headline and
//      cannot tell why.
//   2. The verdict is computed from one set of endpoints while the table renders
//      a different (hand-picked) set, so the two drift apart silently.
//
// Mechanical consistency only: this does not establish clinical correctness.

const fail = (code, detail) => {
  throw new Error(`REPORT_CONSISTENCY_FAILED: ${code}: ${detail}`);
};

/**
 * Assert that a report's overall verdict is derivable from the evidence table
 * it prints alongside that verdict.
 *
 * @param {object} input
 * @param {string} input.context - Report identity, for the error message.
 * @param {boolean} input.allPrimaryMet - The verdict the report states.
 * @param {string[]} input.primaryEndpointIds - Every endpoint that feeds the verdict.
 * @param {Array<{id: string, met: boolean}>} input.evidenceRows - Rows the report actually prints.
 */
export function assertEndpointVerdictConsistent({ context, allPrimaryMet, primaryEndpointIds, evidenceRows }) {
  if (!Array.isArray(primaryEndpointIds) || primaryEndpointIds.length === 0) {
    fail("NO_PRIMARY_ENDPOINT_IDS", `${context}: the verdict must declare the endpoints that decide it`);
  }
  if (!Array.isArray(evidenceRows)) fail("NO_EVIDENCE_ROWS", `${context}: missing evidence rows`);
  if (typeof allPrimaryMet !== "boolean") fail("VERDICT_NOT_BOOLEAN", `${context}: verdict must be an explicit boolean`);

  const unknown = evidenceRows.filter((row) => typeof row.id !== "string" || !row.id.trim());
  if (unknown.length > 0) fail("EVIDENCE_ROW_WITHOUT_ID", `${context}: ${unknown.length} evidence row(s) carry no endpoint id`);

  const rendered = new Set(evidenceRows.map((row) => row.id));
  const invisible = primaryEndpointIds.filter((id) => !rendered.has(id));
  if (invisible.length > 0) {
    fail("DECIDING_ENDPOINT_NOT_RENDERED", `${context}: endpoints decide the verdict but are absent from the evidence table: ${invisible.join(", ")}`);
  }

  const failedRows = evidenceRows.filter((row) => primaryEndpointIds.includes(row.id) && row.met !== true).map((row) => row.id);
  if (!allPrimaryMet && failedRows.length === 0) {
    fail("VERDICT_WITHOUT_EVIDENCE", `${context}: verdict is "not met" but every rendered primary endpoint row reports success`);
  }
  if (allPrimaryMet && failedRows.length > 0) {
    fail("VERDICT_ABOVE_FAILING_EVIDENCE", `${context}: verdict is "met" but rendered primary endpoints report failure: ${failedRows.join(", ")}`);
  }

  return { checked: true, primary_count: primaryEndpointIds.length, failed: failedRows };
}

/**
 * Render the failed-endpoint list a reader needs in order to understand a
 * "not met" verdict. Returns null when nothing failed.
 */
export function describeFailedEndpoints(labelsById, primaryEndpointIds, evidenceRows) {
  const failed = evidenceRows.filter((row) => primaryEndpointIds.includes(row.id) && row.met !== true);
  if (failed.length === 0) return null;
  return failed.map((row) => `${labelsById[row.id] ?? row.id} (${row.id})`).join("、");
}
