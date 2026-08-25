import assert from "node:assert/strict";
import { qcMonitor } from "../plugins/medcius/servers/api/src/qc-monitor.mjs";

console.log("== Testing Proactive QC Monitor ==");

// Test 1: Scan for anomalies
console.log("\n[Test 1] Scanning for anomalies across audit streams...");
const report = await qcMonitor.scanForAnomalies({ timeWindowHours: 48 });
assert.ok(report.scanned_at);
assert.ok(Array.isArray(report.anomalies));
console.log("✓ Anomaly report generated. Anomalies found:", report.anomalies_count);
console.log("  First item:", report.anomalies[0].title);

// Test 2: Check doctor quality drift alert
console.log("\n[Test 2] Querying doctor drift alert for DOC-882...");
const drift = await qcMonitor.doctorDriftAlert("DOC-882");
assert.equal(drift.doctor_id, "DOC-882");
assert.ok(drift.quality_status);
assert.ok(drift.risk_dimensions.length >= 2);
console.log("✓ Doctor drift assessed:", drift.quality_status, "Score:", drift.current_score);

// Test 3: Generate proactive recommendations
console.log("\n[Test 3] Generating proactive quality recommendations...");
const recs = await qcMonitor.generateProactiveRecommendations();
assert.ok(recs.recommendations.length >= 2);
console.log("✓ Proactive recommendations count:", recs.recommendations.length);
console.log("  Top recommendation:", recs.recommendations[0].topic);

console.log("\nALL PROACTIVE QC MONITOR TESTS PASSED!");
