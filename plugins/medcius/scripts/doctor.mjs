#!/usr/bin/env node
/**
 * Production readiness: official corpus counts. Sample-only is not production.
 * exit 0 always unless --require-production (then exit 2 when not ready).
 */
const requireProd = process.argv.includes("--require-production");

async function safeStatus(importer, fn) {
  try {
    const mod = await import(importer);
    return fn(mod);
  } catch (e) {
    return { error: String(e.message ?? e) };
  }
}

const codes = await safeStatus("../servers/china-codes/src/tools.mjs", (m) => m.HANDLERS.corpus_status());
const labels = await safeStatus("../servers/drug-labels/src/tools.mjs", (m) => m.HANDLERS.corpus_status());
const trials = await safeStatus("../servers/china-trials/src/tools.mjs", (m) => m.HANDLERS.corpus_status());

const codeOff = codes?.counts?.codes?.official ?? 0;
const catOff = codes?.counts?.catalog?.official ?? 0;
const labOff = labels?.counts?.official ?? 0;
const trialOff = trials?.counts?.official ?? 0;

const report = {
  production: {
    coding: codeOff > 0,
    catalog: catOff > 0,
    review: labOff > 0,
    trials: trialOff > 0,
    ready: codeOff > 0 && labOff > 0,
  },
  official_counts: {
    nhsa_codes: codeOff,
    nhsa_catalog: catOff,
    drug_labels: labOff,
    clinical_trials: trialOff,
  },
  sample_counts: {
    nhsa_codes: codes?.counts?.codes?.sample ?? null,
    drug_labels: labels?.counts?.sample ?? null,
    clinical_trials: trials?.counts?.sample ?? null,
  },
  halt:
    codeOff === 0 || labOff === 0
      ? "官方语料不足。真实编码/审方必须停止。导入见 plugins/medcius/packs/README.md"
      : null,
  errors: [codes.error, labels.error, trials.error].filter(Boolean),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (requireProd && !report.production.ready) process.exit(2);
