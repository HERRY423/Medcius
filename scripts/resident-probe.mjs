#!/usr/bin/env node
/**
 * Resident Probe (院内常驻探针 · 缺口六，落地 PRODUCTIZATION-OPERATIONS §6).
 *
 * Periodically evaluates deployment health from the inside and publishes
 * Prometheus text exposition + an alert-state file for the hospital
 * monitoring platform. Alert rules are the deterministic subset of the ops
 * manual §6.2:
 *   - audit_chain_broken        P1  (any single failure freezes writes)
 *   - health_endpoint_down      P2 after N consecutive failures (P1 > 30 min)
 *   - production_corpus_missing P2  (official=0 — H01 would halt real workflows)
 *   - probe_latency_breach      P3  (health latency above budget)
 *
 * Modes:
 *   --once                     single cycle (CI/tests), exit 2 if any P1/P2 active
 *   --interval <sec>           daemon loop (default 60)
 *   --target <url>             health endpoint (default http://127.0.0.1:8080/health)
 *   --metrics-out <file>       write Prometheus exposition each cycle
 *   --state-file <file>        persist consecutive-failure counters
 * Deterministic rule engine exported as evaluateProbeRules() for tests.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

/**
 * Pure alert-rule engine (exported for tests).
 * @param {{health_ok: boolean, health_latency_ms: number, health_consecutive_failures: number,
 *          audit_chain_ok: boolean, official_codes: number, official_labels: number,
 *          latency_budget_ms: number, downtime_p1_after_ms: number}} input
 */
export function evaluateProbeRules(input) {
  const alerts = [];
  if (!input.audit_chain_ok) {
    alerts.push({ rule: "audit_chain_broken", severity: "P1", message: "审计链 verify 失败：防篡改承诺失效，冻结写操作并按运维手册 §8.2 处置" });
  }
  const downMs = input.health_consecutive_failures * (input.interval_ms ?? 60000);
  if (!input.health_ok) {
    alerts.push({
      rule: "health_endpoint_down",
      severity: downMs >= input.downtime_p1_after_ms ? "P1" : input.health_consecutive_failures >= 3 ? "P2" : "P3",
      message: `/health 连续 ${input.health_consecutive_failures} 个周期不可达（累计 ~${Math.round(downMs / 1000)}s）`,
    });
  }
  if (input.official_codes === 0 || input.official_labels === 0) {
    alerts.push({ rule: "production_corpus_missing", severity: "P2", message: "official 语料为 0：H01 将阻断真实工作流（样例库不是生产）" });
  }
  if (input.health_ok && input.health_latency_ms > input.latency_budget_ms) {
    alerts.push({ rule: "probe_latency_breach", severity: "P3", message: `/health 延迟 ${input.health_latency_ms}ms 超预算 ${input.latency_budget_ms}ms` });
  }
  return alerts;
}

/** Prometheus text exposition (exported for tests). */
export function renderMetrics({ health_ok, health_latency_ms, audit_chain_ok, official_codes, official_labels, alerts, inflight_llm = 0, llm_topology = "unset" }) {
  const lines = [];
  const p1 = alerts.filter((a) => a.severity === "P1").length;
  const p2 = alerts.filter((a) => a.severity === "P2").length;
  const p3 = alerts.filter((a) => a.severity === "P3").length;
  lines.push("# HELP medcius_probe_health_ok Last-cycle /health reachability (1 ok, 0 down)");
  lines.push("# TYPE medcius_probe_health_ok gauge");
  lines.push(`medcius_probe_health_ok ${health_ok ? 1 : 0}`);
  lines.push("# HELP medcius_probe_health_latency_ms Last /health latency in milliseconds");
  lines.push("# TYPE medcius_probe_health_latency_ms gauge");
  lines.push(`medcius_probe_health_latency_ms ${health_latency_ms}`);
  lines.push("# HELP medcius_probe_audit_chain_ok Audit hash-chain verify result (1 ok)");
  lines.push("# TYPE medcius_probe_audit_chain_ok gauge");
  lines.push(`medcius_probe_audit_chain_ok ${audit_chain_ok ? 1 : 0}`);
  lines.push("# HELP medcius_probe_official_corpus Official corpus rows (codes/labels)");
  lines.push("# TYPE medcius_probe_official_corpus gauge");
  lines.push(`medcius_probe_official_codes ${official_codes}`);
  lines.push(`medcius_probe_official_labels ${official_labels}`);
  lines.push("# HELP medcius_probe_alerts Active alerts by severity");
  lines.push("# TYPE medcius_probe_alerts gauge");
  lines.push(`medcius_probe_alerts{severity="P1"} ${p1}`);
  lines.push(`medcius_probe_alerts{severity="P2"} ${p2}`);
  lines.push(`medcius_probe_alerts{severity="P3"} ${p3}`);
  lines.push("# HELP medcius_probe_llm_inflight Current LLM extraction concurrency");
  lines.push("# TYPE medcius_probe_llm_inflight gauge");
  lines.push(`medcius_probe_llm_inflight{topology="${llm_topology}"} ${inflight_llm}`);
  return `${lines.join("\n")}\n`;
}

async function checkHealth(target, budgetMs) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(budgetMs * 2, 5000));
    const res = await fetch(target, { signal: controller.signal });
    clearTimeout(timer);
    return { ok: res.ok, latency_ms: Date.now() - started, payload: res.ok ? await res.json().catch(() => ({})) : {} };
  } catch {
    return { ok: false, latency_ms: Date.now() - started, payload: {} };
  }
}

async function localChecks() {
  let auditChainOk = false;
  let officialCodes = 0;
  let officialLabels = 0;
  // Dynamic imports must never crash the probe loop — any failure degrades to
  // the fail-closed defaults (chain broken / corpus missing) and surfaces as an alert.
  try {
    const { HANDLERS } = await import(pathToFileURL(join(REPO, "plugins/medcius/servers/audit/src/tools.mjs")).href);
    auditChainOk = HANDLERS.verify_chain({}).ok === true;
  } catch { auditChainOk = false; }
  try {
    const { HANDLERS } = await import(pathToFileURL(join(REPO, "plugins/medcius/servers/china-codes/src/tools.mjs")).href);
    officialCodes = HANDLERS.corpus_status().counts?.codes?.official ?? 0;
  } catch { officialCodes = 0; }
  try {
    const { HANDLERS } = await import(pathToFileURL(join(REPO, "plugins/medcius/servers/drug-labels/src/tools.mjs")).href);
    officialLabels = HANDLERS.corpus_status().official ?? 0;
  } catch { officialLabels = 0; }
  return { auditChainOk, officialCodes, officialLabels };
}

async function runCycle({ target, latencyBudgetMs, stateFile, metricsOut }) {
  const health = await checkHealth(target, latencyBudgetMs);
  const local = await localChecks();
  const state = existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : { health_consecutive_failures: 0, cycles: 0 };
  state.cycles += 1;
  state.health_consecutive_failures = health.ok ? 0 : (state.health_consecutive_failures ?? 0) + 1;

  const alerts = evaluateProbeRules({
    health_ok: health.ok,
    health_latency_ms: health.latency_ms,
    health_consecutive_failures: state.health_consecutive_failures,
    audit_chain_ok: local.auditChainOk,
    official_codes: local.officialCodes,
    official_labels: local.officialLabels,
    latency_budget_ms: latencyBudgetMs,
    interval_ms: 60000,
    downtime_p1_after_ms: 30 * 60000,
  });

  const metrics = renderMetrics({
    health_ok: health.ok,
    health_latency_ms: health.latency_ms,
    audit_chain_ok: local.auditChainOk,
    official_codes: local.officialCodes,
    official_labels: local.officialLabels,
    alerts,
  });
  if (metricsOut) {
    mkdirSync(dirname(metricsOut), { recursive: true });
    writeFileSync(metricsOut, metrics, "utf8");
  }
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");

  const activeP12 = alerts.filter((a) => ["P1", "P2"].includes(a.severity));
  process.stdout.write(`probe cycle #${state.cycles}: health=${health.ok} latency=${health.latency_ms}ms audit_chain=${local.auditChainOk} official(codes/labels)=${local.officialCodes}/${local.officialLabels} alerts=${alerts.length}${alerts.length ? `\n  ${alerts.map((a) => `[${a.severity}] ${a.rule}: ${a.message}`).join("\n  ")}` : ""}\n`);
  return { ok: activeP12.length === 0, alerts, metrics, state };
}

// ---- main (only when run directly; tests import evaluateProbeRules/renderMetrics) ----
const __is_main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!__is_main) {
  // Imported as a module: expose pure functions only, never start the daemon loop.
} else {
  await cliMain();
}

async function cliMain() {
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const once = args.includes("--once");
const daemon = args.includes("--daemon");
if (!once && !daemon) {
  process.stdout.write("usage: node resident-probe.mjs --once | --daemon [--interval <sec>] [--target <url>] [--metrics-out <file>] [--state-file <file>] [--latency-budget-ms <ms>]\n");
  process.exit(2);
}
const intervalMs = Number(flag("interval", "60")) * 1000;
const target = flag("target", `http://127.0.0.1:${process.env.PORT ?? 8080}/health`);
const latencyBudgetMs = Number(flag("latency-budget-ms", "2000"));
const stateFile = flag("state-file", join(process.env.CLAUDE_MEDCIUS_DATA ?? join(process.env.HOME ?? ".", ".medcius"), "probe-state.json"));
const metricsOut = flag("metrics-out");

const cycle = await runCycle({ target, latencyBudgetMs, stateFile, metricsOut });
if (once) {
  process.exit(cycle.ok ? 0 : 2);
}
// daemon loop
for (;;) {
  await new Promise((r) => setTimeout(r, intervalMs));
  try {
    await runCycle({ target, latencyBudgetMs, stateFile, metricsOut });
  } catch (e) {
    process.stderr.write(`PROBE_CYCLE_ERROR: ${e.message}\n`);
  }
}

}
