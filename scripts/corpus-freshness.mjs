#!/usr/bin/env node
/**
 * Corpus Freshness SLA Monitor (语料新鲜度 SLA 监控 · 缺口四知识供应链).
 *
 * Compares the latest official corpus effective_date / ingest time against the
 * update cycles declared in packs/official-sources.json, and reports
 * fresh / due_soon / overdue / empty_sample_only per corpus.
 *
 *   node corpus-freshness.mjs                 # informational report (CI: exit 0)
 *   node corpus-freshness.mjs --require-fresh # production gate: exit 2 on overdue/empty
 *
 * Interpretation discipline: freshness is a KNOWLEDGE-SUPPLY-CHAIN health
 * metric, not clinical evidence. Overdue corpora must block the workflows that
 * consume them only via the existing production gate (doctor.mjs / H01);
 * --require-fresh lets hospital deployments tighten the policy locally.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateRegistry, loadRegistry } from "./fetch-official-corpus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Pure freshness computation (exported for tests). */
export function computeFreshness({ now, corpusStatuses, registry }) {
  const { errors, sources } = validateRegistry(registry);
  if (errors.length) throw new Error(`REGISTRY_INVALID: ${errors.join("; ")}`);
  const byId = new Map(sources.map((s) => [s.id, s]));

  const entries = [];
  for (const [corpusId, status] of Object.entries(corpusStatuses)) {
    const source = byId.get(corpusId);
    if (!source) continue; // corpora without a registry entry are skipped
    const official = status?.official ?? 0;
    const effectiveDate = status?.latest_official_effective_date ?? null;
    const ingestedAt = status?.latest_official_ingested_at ?? null;
    const referenceDate = effectiveDate ?? (ingestedAt ? String(ingestedAt).slice(0, 10) : null);
    let state;
    let ageDays = null;
    if (!official || !referenceDate) {
      state = official > 0 ? "unknown_age" : "empty_sample_only";
    } else {
      ageDays = Math.floor((new Date(now) - new Date(referenceDate)) / 86400000);
      state = ageDays > source.update_cycle_days ? "overdue" : ageDays > source.update_cycle_days * 0.75 ? "due_soon" : "fresh";
    }
    entries.push({
      corpus: corpusId,
      official_rows: official,
      latest_effective_date: effectiveDate,
      latest_ingested_at: ingestedAt,
      update_cycle_days: source.update_cycle_days,
      age_days: ageDays,
      state,
      action: {
        empty_sample_only: "样例库不满足生产（H01）；按 official-sources.json 完成首次官方导入",
        unknown_age: "官方行缺少 effective_date/ingested_at —— 违反 ARCH-03，须修复导入来源",
        fresh: "正常",
        due_soon: `距超过更新周期（${source.update_cycle_days} 天）不足 25%，安排数据专员复拉`,
        overdue: `已超过登记更新周期（${source.update_cycle_days} 天），数据专员必须复拉并重新导入`,
      }[state],
    });
  }

  const blocking = entries.filter((e) => ["overdue", "empty_sample_only", "unknown_age"].includes(e.state));
  return {
    checked_at: new Date(now).toISOString(),
    entries,
    summary: {
      fresh: entries.filter((e) => e.state === "fresh").length,
      due_soon: entries.filter((e) => e.state === "due_soon").length,
      overdue: entries.filter((e) => e.state === "overdue").length,
      empty_sample_only: entries.filter((e) => e.state === "empty_sample_only").length,
      unknown_age: entries.filter((e) => e.state === "unknown_age").length,
      require_fresh_ok: blocking.length === 0,
    },
    disclaimer: "新鲜度是知识供应链健康指标，不是临床证据；生产阻断以 doctor.mjs/H01 为准。",
  };
}

/** Pull official-row freshness facts from the local corpora DBs. */
async function collectCorpusStatuses() {
  const statuses = {};
  const chinaCodes = await import("../plugins/medcius/servers/china-codes/src/db.mjs").catch(() => null);
  const drugLabels = await import("../plugins/medcius/servers/drug-labels/src/db.mjs").catch(() => null);
  if (chinaCodes?.db) {
    const q = (table, dateCol) => {
      try {
        const row = chinaCodes.db.prepare(`SELECT count(*) n, max(${dateCol}) d FROM ${table} WHERE data_class='official'`).get();
        return { official: row.n, latest: row.d };
      } catch {
        return { official: 0, latest: null };
      }
    };
    const codes = q("nhsa_codes", "effective_date");
    const catalog = q("nhsa_drug_catalog", "effective_date");
    const benefits = q("provincial_benefits", "effective_date");
    statuses.nhsa_icd10_diagnosis_codes = { official: codes.official, latest_official_effective_date: codes.latest };
    statuses.nhsa_procedure_codes = { official: codes.official, latest_official_effective_date: codes.latest };
    statuses.nhsa_drug_catalog = { official: catalog.official, latest_official_effective_date: catalog.latest };
    statuses.provincial_benefits_l3 = { official: benefits.official, latest_official_effective_date: benefits.latest };
  }
  if (drugLabels?.db) {
    try {
      const row = drugLabels.db.prepare("SELECT count(*) n, max(effective_date) d FROM drug_labels WHERE data_class='official'").get();
      statuses.nmpa_drug_labels = { official: row.n, latest_official_effective_date: row.d };
    } catch {
      statuses.nmpa_drug_labels = { official: 0, latest_official_effective_date: null };
    }
  }
  return statuses;
}

// ---- main (only when run directly; tests import computeFreshness) ----
const __is_main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!__is_main) {
  // Imported as a module: expose computeFreshness only, never run the CLI.
} else {
  await cliMain();
}

async function cliMain() {
const requireFresh = process.argv.includes("--require-fresh");
let statuses;
let registry;
try {
  statuses = await collectCorpusStatuses();
  registry = loadRegistry(join(__dirname, "..", "plugins", "medcius", "packs", "official-sources.json"));
} catch (e) {
  process.stderr.write(`FRESHNESS_COLLECT_ERROR: ${e.message}\n`);
  process.exit(2);
}
const report = computeFreshness({ now: new Date(), corpusStatuses: statuses, registry });
const line = (e) => `  [${e.state}] ${e.corpus}: official=${e.official_rows} latest=${e.latest_effective_date ?? "—"} age=${e.age_days ?? "—"}d → ${e.action}`;
process.stdout.write(`语料新鲜度（SLA 对齐 packs/official-sources.json）:\n${report.entries.map(line).join("\n")}\nsummary: ${JSON.stringify(report.summary)}\n${report.disclaimer}\n`);
if (requireFresh && !report.summary.require_fresh_ok) {
  process.stderr.write(`FRESHNESS_GATE_FAILED: overdue/empty 语料阻断部署（--require-fresh）。\n`);
  process.exit(2);
}
process.exit(0);
}
