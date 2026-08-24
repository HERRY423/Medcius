/**
 * Production guard — 硬门闩唯一真相源。
 * 供 settlement/intake/review 等入口复用，杜绝 official=0 时静默降级为样例。
 * 对应 ARCH-01 / ARCH-09 / RISK H01
 */
export async function checkProduction({ requireCodes = true, requireLabels = false } = {}) {
  const codesMod = await import("../servers/china-codes/src/tools.mjs").catch(() => null);
  const labelsMod = await import("../servers/drug-labels/src/tools.mjs").catch(() => null);
  const codesSt = codesMod ? codesMod.HANDLERS.corpus_status() : { counts: { codes: { official: 0 }, catalog: { official: 0 } } };
  const labelsSt = labelsMod ? labelsMod.HANDLERS.corpus_status() : { counts: { official: 0 } };
  const codeOff = codesSt.counts?.codes?.official ?? 0;
  const catOff = codesSt.counts?.catalog?.official ?? 0;
  const labOff = labelsSt.counts?.official ?? 0;
  const codingReady = codeOff > 0;
  const reviewReady = labOff > 0;
  const ready = (!requireCodes || codingReady) && (!requireLabels || reviewReady);
  return {
    ready,
    codingReady,
    catalogReady: catOff > 0,
    reviewReady,
    official: { codes: codeOff, catalog: catOff, labels: labOff },
    sample: {
      codes: codesSt.counts?.codes?.sample ?? 0,
      labels: labelsSt.counts?.sample ?? 0,
    },
    halt: !ready
      ? `官方语料不足 — coding=${codeOff} labels=${labOff}。真实${requireCodes ? "编码" : ""}${requireCodes && requireLabels ? "/" : ""}${requireLabels ? "审方" : ""}必须停止；见 plugins/medcius/packs/README.md。加 --allow-sample 仅用于管线自检。`
      : null,
    raw: { codesSt, labelsSt },
  };
}

export async function assertProduction(opts, { allowSample = false } = {}) {
  const r = await checkProduction(opts);
  if (!r.ready && !allowSample) {
    const err = new Error(r.halt);
    err.code = "PRODUCTION_GATE_HALT";
    err.detail = r;
    throw err;
  }
  return r;
}
