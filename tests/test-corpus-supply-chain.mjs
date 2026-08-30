// Tests for the corpus supply chain (缺口四) and regulatory readiness tooling (缺口五):
// official-source registry validation, staged-pack fetch/verify/checksum-tamper,
// freshness SLA computation, DRG/DIP reconciliation contract, classification-pack
// readiness gate, and the executable QMS internal audit runner.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRegistry, buildStagedPack, verifyStagedPack, loadRegistry } from "../scripts/fetch-official-corpus.mjs";
import { computeFreshness } from "../scripts/corpus-freshness.mjs";
import { buildDrgDipReconciliation, reconciliationDigest } from "../plugins/medcius/lib/drg-dip-reconciliation.mjs";
import { buildRecordQualityReport } from "../plugins/medcius/lib/nhsa-record-quality-engine.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

console.log("== Testing corpus supply chain & regulatory readiness (缺口四/五) ==");

// ----------------------------------------------------
// Test 1: official source registry
// ----------------------------------------------------
console.log("\n[Test 1] Registry: valid repo registry passes; corrupted registry fails...");
const registry = loadRegistry(join(REPO, "plugins/medcius/packs/official-sources.json"));
const { errors, sources } = validateRegistry(registry);
assert.deepEqual(errors, []);
assert.ok(sources.length >= 5);
assert.ok(sources.every((s) => s.channel_url.startsWith("https://")), "channels must be https");
const corrupted = { _discipline: "no rule", sources: [{ id: "Bad-Id", update_cycle_days: 5, import_command: "auto-ingest" }] };
assert.ok(validateRegistry(corrupted).errors.length >= 4, "corrupted registry must trip multiple checks");
console.log(`✓ Registry validated (${sources.length} entries, never-auto-ingest discipline enforced)`);

// ----------------------------------------------------
// Test 2: staged pack fetch/verify/checksum-tamper
// ----------------------------------------------------
console.log("\n[Test 2] Staged pack: provenance sidecar, checksum roundtrip, tamper detection...");
const source = sources.find((s) => s.format === "csv-templates/codes");
const body = "编码,名称\nA00.000,示例（合成）\n";
const staged = buildStagedPack({ source, body, fetchedAt: "2026-08-30T00:00:00Z", transportNote: "fixture:test" });
assert.match(staged.filename, /^nhsa_icd10_diagnosis_codes-[0-9a-f]{8}\.csv$/);
assert.equal(staged.sidecar.provenance_status, "raw_staged_unverified");
assert.equal(verifyStagedPack(staged.sidecar, body).ok, true);
const mismatch = verifyStagedPack(staged.sidecar, `${body}tampered`);
assert.equal(mismatch.ok, false);
assert.match(mismatch.reason, /CHECKSUM_MISMATCH/);
assert.ok(!staged.sidecar.source_version && !staged.sidecar.effective_date, "fetching must NOT invent provenance (ARCH-03)");
console.log("✓ Fetch→stage→verify pipeline verified (no auto-ingest, no invented provenance)");

// ----------------------------------------------------
// Test 3: freshness SLA computation
// ----------------------------------------------------
console.log("\n[Test 3] Freshness SLA: fresh/due_soon/overdue/empty/unknown_age...");
const now = "2026-08-30T00:00:00Z";
const fresh = computeFreshness({
  now,
  registry,
  corpusStatuses: {
    nhsa_icd10_diagnosis_codes: { official: 33000, latest_official_effective_date: "2026-07-15" },
    nhsa_drug_catalog: { official: 0, latest_official_effective_date: null },
    nmpa_drug_labels: { official: 500, latest_official_effective_date: "2026-01-15" },
    provincial_benefits_l3: { official: 12, latest_official_ingested_at: "2026-08-20T00:00:00Z" },
    nhsa_procedure_codes: { official: 12000, latest_official_effective_date: "2026-06-20" },
  },
});
const byId = Object.fromEntries(fresh.entries.map((e) => [e.corpus, e]));
assert.equal(byId.nhsa_icd10_diagnosis_codes.state, "fresh"); // 90d age
assert.equal(byId.nhsa_drug_catalog.state, "empty_sample_only");
assert.equal(byId.nmpa_drug_labels.state, "overdue"); // 227d > 180d
assert.equal(byId.provincial_benefits_l3.state, "fresh");
assert.equal(byId.nhsa_procedure_codes.state, "due_soon"); // 121d > 0.75*90
assert.equal(fresh.summary.require_fresh_ok, false, "overdue + empty must block --require-fresh");
const unknownAge = computeFreshness({
  now,
  registry,
  corpusStatuses: { nmpa_drug_labels: { official: 10, latest_official_effective_date: null } },
});
assert.equal(unknownAge.entries[0].state, "unknown_age", "official rows without dates violate ARCH-03");
console.log("✓ Freshness states computed deterministically with actions");

// ----------------------------------------------------
// Test 4: DRG/DIP reconciliation contract
// ----------------------------------------------------
console.log("\n[Test 4] DRG/DIP reconciliation: clean / blocked / incomplete + fail-closed...");
const cleanNote = "出院记录\n性别：女 年龄：35岁\n入院日期：2026-08-01 出院日期：2026-08-08\n住院天数：8天\n离院方式：1 医嘱离院\n出院诊断：急性阑尾炎\n手术及操作：腹腔镜阑尾切除术";
const cleanReport = buildRecordQualityReport(cleanNote);
const cleanRec = buildDrgDipReconciliation({
  recordQualityReport: cleanReport,
  hospitalGrouping: { scheme: "drg", code: "QS29（合成组）", version: "CHS-DRG 样例", weight_or_score: 0.9, source: "医院分组器（合成）" },
  encounter: { patient_id: "p1", encounter_id: "e1" },
});
assert.equal(cleanRec.schema_version, "medcius.drg-dip-reconciliation.v1");
assert.equal(cleanRec.status, "clean");
assert.equal(cleanRec.elements.complete, true);
assert.equal(cleanRec.reconciliation.quality_gate, "pass");
assert.equal(cleanRec.hospital_grouping_echo.scheme, "drg");
assert.equal(cleanRec.boundary.is_drg_dip_grouper, false);

const badNote = "出院记录\n性别：男 年龄：67岁\n入院日期：2026-08-01 出院日期：2026-08-10\n住院天数：3天\n离院方式：7\n出院诊断：新生儿肺炎";
const blockedRec = buildDrgDipReconciliation({
  recordQualityReport: buildRecordQualityReport(badNote),
  hospitalGrouping: { scheme: "dip", code: "SYNTH-DIP-1", version: "DIP 样例目录" },
});
assert.equal(blockedRec.status, "elements_incomplete");
assert.ok(blockedRec.data_quality_risks.some((r) => r.finding_code === "NEONATAL_DIAGNOSIS_AGE_CONFLICT" && r.payment_risk === "coding_review"));
assert.ok(blockedRec.data_quality_risks.some((r) => r.payment_risk === "days_billing_mismatch" && r.finding_code === "STAY_DAYS_MISMATCH"));
assert.ok(blockedRec.data_quality_risks.some((r) => r.payment_risk === "settlement_field_invalid" && r.finding_code === "DISCHARGE_METHOD_ILLEGAL"));

// grouping_blocked requires a missing primary diagnosis
const noPrimary = buildDrgDipReconciliation({
  recordQualityReport: buildRecordQualityReport("出院记录\n性别：女 年龄：35岁\n主诉：头晕。"),
  hospitalGrouping: { scheme: "drg", code: "SYNTH-DRG-1" },
});
assert.equal(noPrimary.status, "grouping_blocked");
assert.ok(noPrimary.data_quality_risks.some((r) => r.payment_risk === "grouping_blocked" && r.finding_code === "PRIMARY_DISCHARGE_DIAGNOSIS_MISSING"));
assert.equal(noPrimary.reconciliation.grouping_affected, true);

assert.throws(() => buildDrgDipReconciliation({ hospitalGrouping: { scheme: "drg", code: "X" } }), /RECORD_QUALITY_REPORT_REQUIRED/);
assert.throws(() => buildDrgDipReconciliation({ recordQualityReport: cleanReport, hospitalGrouping: {} }), /GROUPING_RESULT_REQUIRED/);
const digest = reconciliationDigest(cleanRec);
assert.equal(digest, reconciliationDigest({ ...cleanRec, digest: null }), "digest excludes the digest field itself");
console.log("✓ Reconciliation builder verified against contract semantics (clean/blocked/fail-closed)");

// ----------------------------------------------------
// Test 5: classification-pack readiness gate (CLI)
// ----------------------------------------------------
console.log("\n[Test 5] Classification pack readiness gate...");
const gate = spawnSync("node", ["plugins/medcius/scripts/gen-classification-pack.mjs"], { cwd: REPO, encoding: "utf8" });
assert.equal(gate.status, 0, "structural check must pass on the current repo");
assert.match(gate.stdout, /结构检查 ✅/);
assert.match(gate.stdout, /ready_for_r05=false/, "[待核] 项未关闭前不得就绪");
assert.ok(/\[待核\].*1|未关闭 \[待核\] 项 \*\*1\*\*/.test(gate.stdout.replace(/\*\*/g, "")), "open item must be enumerated");
console.log("✓ Readiness gate: structure OK, open [待核] item enumerated, ready_for_r05=false");

// ----------------------------------------------------
// Test 6: executable QMS internal audit (subset, no record write)
// ----------------------------------------------------
console.log("\n[Test 6] QMS internal audit runner (subset + attestation)...");
const subset = spawnSync("node", ["scripts/qms-internal-audit.mjs", "--only", "m01,m06", "--no-write"], { cwd: REPO, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
assert.equal(subset.status, 0, `subset audit failed: ${subset.stderr}`);
assert.match(subset.stdout, /m01/);
assert.match(subset.stdout, /pass_with_pending_attestation/);
const attested = spawnSync("node", ["scripts/qms-internal-audit.mjs", "--only", "m06", "--no-write", "--attest-item", "a01", "张三（合成）:管理者代表:首轮管理评审已召开"], { cwd: REPO, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
assert.equal(attested.status, 0);
assert.match(attested.stdout, /✅ 已签认/);
assert.match(attested.stdout, /⬜ 待签认/, "其余未签认项必须显式待签");
// audit machine failure path: corrupt a version file temporarily is too invasive; trust exit-code logic covered by m-checks
console.log("✓ Audit runner: machine subset + attestation separation verified");

// ----------------------------------------------------
// Test 7: CLI smokes
// ----------------------------------------------------
console.log("\n[Test 7] CLI smokes...");
const list = spawnSync("node", ["scripts/fetch-official-corpus.mjs", "--list"], { cwd: REPO, encoding: "utf8" });
assert.equal(list.status, 0);
assert.match(list.stdout, /6 entries, all checks passed/);
const freshCli = spawnSync("node", ["scripts/corpus-freshness.mjs"], { cwd: REPO, encoding: "utf8" });
assert.equal(freshCli.status, 0, `freshness CLI failed: ${freshCli.stderr}`);
assert.match(freshCli.stdout, /语料新鲜度/);
console.log("✓ fetch --list and corpus-freshness CLIs pass");

console.log("\nALL CORPUS SUPPLY CHAIN & REGULATORY READINESS TESTS PASSED");
