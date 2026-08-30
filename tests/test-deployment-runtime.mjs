// Tests for the runtime product form (缺口六): LLM inference config management
// (topology enforcement, D1 structural limit, budgets), resident probe rule
// engine + Prometheus exposition + live --once cycle, deterministic deployer
// (install/backup/rollback with sha256 manifests), and container delivery
// artifacts (Dockerfile / compose structural checks).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateLlmConfig, createLlmInferenceClient } from "../plugins/medcius/lib/llm-inference-config.mjs";
import { evaluateProbeRules, renderMetrics } from "../scripts/resident-probe.mjs";
import { startServer } from "../plugins/medcius/servers/api/src/server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

console.log("== Testing runtime product form (缺口六: container/deploy/probe/LLM config) ==");

// ----------------------------------------------------
// Test 1: LLM inference config — topology enforcement & fail-closed validation
// ----------------------------------------------------
console.log("\n[Test 1] LLM config: A valid, C rejected outright, B requires attestation...");
const baseA = {
  topology: "A",
  model_id: "qwen2.5-14b-instruct（合成）",
  model_version: "2026-08",
  prompt_pack_version: "medcius-extract-v3",
  endpoint: "http://127.0.0.1:11434/v1",
  capacity: { max_concurrency: 8, latency_budget_ms_p95: 8000 },
};
const vA = validateLlmConfig(baseA);
assert.equal(vA.ok, true, `A 档应通过: ${vA.errors.join(";")}`);
assert.ok(vA.config_digest);

const vC = validateLlmConfig({ ...baseA, topology: "C" });
assert.equal(vC.ok, false);
assert.ok(vC.errors.some((e) => e.includes("LLM_TOPOLOGY_C_REJECTED")), "C 档全托管必须在校验层直接拒绝（ARCH-02/D1）");

const vB = validateLlmConfig({ ...baseA, topology: "B", desensitization_attestation: false });
assert.equal(vB.ok, false);
assert.ok(vB.errors.some((e) => e.includes("LLM_B_ATTESTATION_REQUIRED")));
const vBOk = validateLlmConfig({
  ...baseA,
  topology: "B",
  desensitization_attestation: true,
  provider_registration_ref: "R20:服务商备案核验留档-001",
});
assert.equal(vBOk.ok, true);

const vBad = validateLlmConfig({ ...baseA, model_id: "", capacity: { max_concurrency: 9999 } });
assert.ok(vBad.errors.some((e) => e.includes("LLM_CONFIG_FIELD_REQUIRED")));
assert.ok(vBad.errors.some((e) => e.includes("LLM_CAPACITY_CONCURRENCY_INVALID")));
console.log("✓ Topology A/B/C enforcement + attestation + capacity budgets validated");

// ----------------------------------------------------
// Test 2: extraction-only client — D1 structural limit, provenance, budgets
// ----------------------------------------------------
console.log("\n[Test 2] LLM client: extract-only surface, provenance stamps, timeout/concurrency fail-closed...");
const client = createLlmInferenceClient({ config: baseA, transport: async () => ({ text: "抽取结果（合成）" }), timeoutMs: 5000 });
assert.equal(typeof client.extract, "function");
assert.equal(typeof client.decide, "undefined", "D1 结构性限制：client 上不得存在 decide()");
assert.equal(typeof client.adjudicate, "undefined", "client 上不得存在 adjudicate()");
const extraction = await client.extract({ text: "出院诊断：急性阑尾炎（合成文本）" });
assert.equal(extraction.text, "抽取结果（合成）");
assert.equal(extraction.model_id, baseA.model_id);
assert.ok(extraction.config_digest);
assert.equal(extraction.latency_budget_breached, false);

// latency budget breach surfaced, not fatal
const slowClient = createLlmInferenceClient({
  config: { ...baseA, capacity: { latency_budget_ms_p95: 50 } },
  transport: async () => {
    await new Promise((r) => setTimeout(r, 80));
    return { text: "slow" };
  },
});
const slow = await slowClient.extract({ text: "x" });
assert.equal(slow.latency_budget_breached, true);

// timeout fail-closed (no degraded output, no fabrication)
const hangClient = createLlmInferenceClient({
  config: baseA,
  transport: () => new Promise(() => {}),
  timeoutMs: 50,
});
await assert.rejects(() => hangClient.extract({ text: "x" }), /LLM_TIMEOUT/);

// concurrency budget fail-closed
const busyTransport = () => new Promise((r) => setTimeout(() => r({ text: "ok" }), 60));
const capped = createLlmInferenceClient({ config: { ...baseA, capacity: { max_concurrency: 1 } }, transport: busyTransport });
const first = capped.extract({ text: "a" });
await assert.rejects(() => capped.extract({ text: "b" }), /LLM_CONCURRENCY_BUDGET_EXCEEDED/);
await first;

// config invalid -> construction refused
assert.throws(() => createLlmInferenceClient({ config: { ...baseA, topology: "C" }, transport: async () => ({ text: "" }) }), /LLM_CONFIG_INVALID/);
console.log("✓ Extraction-only client verified (no judge surface, budgets fail-closed)");

// ----------------------------------------------------
// Test 3: probe rule engine (deterministic subset of ops §6.2)
// ----------------------------------------------------
console.log("\n[Test 3] Probe rules: P1 chain-break, escalation ladder, corpus gate, latency...");
const healthy = evaluateProbeRules({ health_ok: true, health_latency_ms: 30, health_consecutive_failures: 0, audit_chain_ok: true, official_codes: 100, official_labels: 50, latency_budget_ms: 2000, interval_ms: 60000, downtime_p1_after_ms: 1800000 });
assert.deepEqual(healthy.map((a) => a.rule), []);

const chainBroken = evaluateProbeRules({ health_ok: true, health_latency_ms: 30, health_consecutive_failures: 0, audit_chain_ok: false, official_codes: 100, official_labels: 50, latency_budget_ms: 2000, interval_ms: 60000, downtime_p1_after_ms: 1800000 });
assert.equal(chainBroken[0].severity, "P1");
assert.equal(chainBroken[0].rule, "audit_chain_broken");

const down1 = evaluateProbeRules({ health_ok: false, health_latency_ms: 0, health_consecutive_failures: 1, audit_chain_ok: true, official_codes: 100, official_labels: 50, latency_budget_ms: 2000, interval_ms: 60000, downtime_p1_after_ms: 1800000 });
assert.equal(down1[0].severity, "P3");
const down5 = evaluateProbeRules({ health_ok: false, health_latency_ms: 0, health_consecutive_failures: 5, audit_chain_ok: true, official_codes: 100, official_labels: 50, latency_budget_ms: 2000, interval_ms: 60000, downtime_p1_after_ms: 1800000 });
assert.equal(down5.find((a) => a.rule === "health_endpoint_down").severity, "P2");
const down45 = evaluateProbeRules({ health_ok: false, health_latency_ms: 0, health_consecutive_failures: 45, audit_chain_ok: true, official_codes: 100, official_labels: 50, latency_budget_ms: 2000, interval_ms: 60000, downtime_p1_after_ms: 1800000 });
assert.equal(down45.find((a) => a.rule === "health_endpoint_down").severity, "P1");

const corpusMissing = evaluateProbeRules({ health_ok: true, health_latency_ms: 30, health_consecutive_failures: 0, audit_chain_ok: true, official_codes: 0, official_labels: 0, latency_budget_ms: 2000, interval_ms: 60000, downtime_p1_after_ms: 1800000 });
assert.ok(corpusMissing.some((a) => a.rule === "production_corpus_missing" && a.severity === "P2"));

const slowHealth = evaluateProbeRules({ health_ok: true, health_latency_ms: 3000, health_consecutive_failures: 0, audit_chain_ok: true, official_codes: 100, official_labels: 50, latency_budget_ms: 2000, interval_ms: 60000, downtime_p1_after_ms: 1800000 });
assert.ok(slowHealth.some((a) => a.rule === "probe_latency_breach" && a.severity === "P3"));

const metrics = renderMetrics({ health_ok: true, health_latency_ms: 30, audit_chain_ok: false, official_codes: 100, official_labels: 50, alerts: chainBroken, llm_topology: "A" });
assert.match(metrics, /medcius_probe_health_ok 1/);
assert.match(metrics, /medcius_probe_audit_chain_ok 0/);
assert.match(metrics, /medcius_probe_alerts\{severity="P1"\} 1/);
console.log("✓ Rule engine + Prometheus exposition verified");

// ----------------------------------------------------
// Test 4: probe --once against a live ephemeral server
// ----------------------------------------------------
console.log("\n[Test 4] Probe --once live cycle (sample-only corpus is expected to raise P2)...");
const { server, port, host } = await startServer(0, "127.0.0.1");
const tmp = mkdtempSync(join(tmpdir(), "medcius-probe-"));
try {
  // NOTE: must use async spawn — spawnSync freezes the parent event loop while
  // the probe child fetches THIS parent's /health (self-deadlock → 5s abort).
  const { spawn } = await import("node:child_process");
  const run = await new Promise((resolveRun) => {
    const child = spawn("node", [
      "scripts/resident-probe.mjs", "--once",
      "--target", `http://${host}:${port}/health`,
      "--state-file", join(tmp, "state.json"),
      "--metrics-out", join(tmp, "probe.prom"),
    ], { cwd: REPO, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("close", (code) => resolveRun({ status: code, stdout }));
  });
  // sample-only corpus → production_corpus_missing (P2) active → exit 2 (honest)
  assert.equal(run.status, 2, `expected exit 2, got ${run.status}: ${run.stdout}`);
  assert.match(run.stdout, /production_corpus_missing/);
  assert.ok(existsSync(join(tmp, "probe.prom")));
  const prom = readFileSync(join(tmp, "probe.prom"), "utf8");
  assert.match(prom, /medcius_probe_health_ok 1/);
  assert.match(prom, /medcius_probe_official_codes 0/);
  assert.ok(existsSync(join(tmp, "state.json")));
} finally {
  rmSync(tmp, { recursive: true, force: true });
  server.close();
}
console.log("✓ Live probe cycle: honest P2 on sample-only corpus, metrics + state persisted");

// ----------------------------------------------------
// Test 5: deployer — status / install / backup / rollback
// ----------------------------------------------------
console.log("\n[Test 5] Deployer: deterministic install, refuse-overwrite, sha256 rollback...");
const statusRun = spawnSync("node", ["scripts/deploy.mjs", "status"], { cwd: REPO, encoding: "utf8" });
assert.equal(statusRun.status, 0);
assert.match(statusRun.stdout, /PASS node_version/);

const target = join(mkdtempSync(join(tmpdir(), "medcius-deploy-")), "opt");
const dryRun = spawnSync("node", ["scripts/deploy.mjs", "install", "--target", target, "--dry-run"], { cwd: REPO, encoding: "utf8" });
assert.equal(dryRun.status, 0);
assert.match(dryRun.stdout, /install plan/);
assert.equal(existsSync(target), false, "dry-run must write nothing");

const installRun = spawnSync("node", ["scripts/deploy.mjs", "install", "--target", target], { cwd: REPO, encoding: "utf8" });
assert.equal(installRun.status, 0);
assert.ok(existsSync(join(target, "current", "scripts", "serve.mjs")), "release snapshot must contain runtime entry");
assert.ok(existsSync(join(target, "medcius.env")), "env file must be created from template");
const reinstall = spawnSync("node", ["scripts/deploy.mjs", "install", "--target", target], { cwd: REPO, encoding: "utf8" });
assert.match(reinstall.stdout, /refusing to overwrite/, "env 文件存在时必须拒绝覆盖");

// data dir + backup + tamper + rollback
mkdirSync(join(target, "data"), { recursive: true });
writeFileSync(join(target, "data", "audit.sqlite"), "synthetic-audit-bytes-v1");
const backupRun = spawnSync("node", ["scripts/deploy.mjs", "backup", "--target", target], { cwd: REPO, encoding: "utf8" });
assert.equal(backupRun.status, 0);
const backups = readdirSync(join(target, "backups")).filter((name) => /^\d{4}-/.test(name));
const ts = backups[0];
assert.ok(ts, "backup timestamp dir expected");
// tamper with the backup → rollback must abort on sha256 mismatch
writeFileSync(join(target, "backups", ts, "data", "audit.sqlite"), "tampered");
const abort = spawnSync("node", ["scripts/deploy.mjs", "rollback", "--target", target, "--to", ts], { cwd: REPO, encoding: "utf8" });
assert.equal(abort.status, 2);
assert.match(abort.stdout, /ABORTED/);
// restore the backup file content and redo rollback → must succeed
writeFileSync(join(target, "backups", ts, "data", "audit.sqlite"), "synthetic-audit-bytes-v1");
const rolled = spawnSync("node", ["scripts/deploy.mjs", "rollback", "--target", target, "--to", ts], { cwd: REPO, encoding: "utf8" });
assert.equal(rolled.status, 0);
assert.match(rolled.stdout, /rollback complete/);
assert.equal(readFileSync(join(target, "data", "audit.sqlite"), "utf8"), "synthetic-audit-bytes-v1");
rmSync(target, { recursive: true, force: true });
console.log("✓ Deployer: dry-run purity, refuse-overwrite, sha256-verified rollback");

// ----------------------------------------------------
// Test 6: container delivery artifacts (structural checks)
// ----------------------------------------------------
console.log("\n[Test 6] Container artifacts: Dockerfile / compose structural discipline...");
const dockerfile = readFileSync(join(REPO, "Dockerfile"), "utf8");
assert.match(dockerfile, /FROM node:22\.\d+\.[\dx]-alpine/, "base image must be version-pinned alpine");
assert.ok(!/FROM .*latest/.test(dockerfile), "latest base tag forbidden");
assert.match(dockerfile, /USER medcius/, "must run as non-root");
assert.match(dockerfile, /HEALTHCHECK/, "must declare a healthcheck");
assert.match(dockerfile, /CMD \["node", "scripts\/serve\.mjs"\]/);
assert.ok(!/COPY tests/.test(dockerfile) && !/COPY docs/.test(dockerfile), "tests/compliance docs must not enter the runtime image");

const dockerignore = readFileSync(join(REPO, ".dockerignore"), "utf8");
assert.match(dockerignore, /\.git/);

const compose = readFileSync(join(REPO, "docker-compose.yml"), "utf8");
assert.match(compose, /medcius-sandbox/);
assert.match(compose, /profiles: \["hospital"\]/);
assert.match(compose, /env_file:/, "hospital profile must inject env via file");
assert.match(compose, /\/opt\/medcius\/data:/, "audit/data must be a mounted volume (院内留存)");
assert.ok(!/privileged:\s*true/.test(compose), "privileged containers forbidden");
const envTemplate = readFileSync(join(REPO, "deploy", "env.template"), "utf8");
assert.match(envTemplate, /MEDCIUS_LLM_TOPOLOGY=A/);
assert.match(envTemplate, /MEDCIUS_JWT_SECRET=/);
assert.match(envTemplate, /MEDCIUS_TLS_KEY=/);
console.log("✓ Dockerfile/compose/env structural discipline verified");

console.log("\nALL RUNTIME FORM (缺口六) TESTS PASSED");
