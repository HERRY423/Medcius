#!/usr/bin/env node
// China-skills eval harness.
// - Static mode (default): validate case files well-formed, count trap coverage, optionally probe local drug-labels corpus.
// - With --with-corpus: also ingest --sample and run corpus_status + check_interactions probes (offline, no model).
// - If results/*.json exist (agent self-scores), aggregate them.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(__dirname, "cases");
const RESULTS_DIR = join(__dirname, "results");
const withCorpus = process.argv.includes("--with-corpus");
const withGrade = process.argv.includes("--grade");

function loadCases() {
  const files = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort();
  let all = [];
  for (const f of files) {
    const raw = readFileSync(join(CASES_DIR, f), "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error(`${f}: top-level must be an array`);
    for (const c of arr) c._file = f;
    all.push(...arr);
  }
  return { files, all };
}

function validate(cases) {
  const errors = [];
  const ids = new Set();
  for (const c of cases) {
    const where = `${c._file}:${c.id ?? "?"}`;
    if (!c.id || typeof c.id !== "string") errors.push(`${where}: missing id`);
    else if (ids.has(c.id)) errors.push(`${where}: duplicate id ${c.id}`);
    else ids.add(c.id);
    if (!c.skill || typeof c.skill !== "string") errors.push(`${where}: missing skill`);
    if (!c.trap || typeof c.trap !== "string") errors.push(`${where}: missing trap`);
    if (!c.title || typeof c.title !== "string") errors.push(`${where}: missing title`);
    if (!c.input || typeof c.input !== "object" || Array.isArray(c.input)) errors.push(`${where}: missing input object`);
    if (!Array.isArray(c.must) || c.must.length === 0) errors.push(`${where}: must must be a non-empty array`);
    if (!Array.isArray(c.must_not)) errors.push(`${where}: must_not must be an array`);
    if (c.must && !c.must.every((s) => typeof s === "string" && s.length > 0)) errors.push(`${where}: must entries must be non-empty strings`);
  }
  return { errors, ids };
}

async function probeCorpus() {
  try {
    const { HANDLERS } = await import("../../servers/drug-labels/src/tools.mjs");
    const { HANDLERS: CH } = await import("../../servers/china-codes/src/tools.mjs");
    const st = HANDLERS.corpus_status({});
    const chSt = CH.corpus_status({});
    const probes = {};
    try { const r1 = HANDLERS.check_interactions({ drugs: ["合成他汀片", "合成克拉霉素片"], include_samples: true }); probes.mention_found = r1.pairs[0]?.status ?? "error"; } catch (e) { probes.mention_found = `error: ${e.message}`; }
    try { const r2 = HANDLERS.check_interactions({ drugs: ["合成他汀片", "合成阿莫西林胶囊"], include_samples: true }); probes.no_mention = r2.pairs[0]?.status ?? "error"; } catch (e) { probes.no_mention = `error: ${e.message}`; }
    try { const r3 = HANDLERS.check_interactions({ drugs: ["合成他汀片", "不存在的药X"] , include_samples: true}); probes.insufficient = r3.pairs[0]?.status ?? "error"; } catch (e) { probes.insufficient = `error: ${e.message}`; }
    try { const r4 = HANDLERS.check_allergy({ allergies:["青霉素"], drugs:["合成阿莫西林胶囊"], include_samples:true }); probes.allergy_hit = r4.per_drug[0]?.status ?? "error"; } catch (e) { probes.allergy_hit = `error: ${e.message}`; }
    try { const r5 = HANDLERS.check_contraindication({ conditions:["肝病"], drugs:["合成他汀片"], include_samples:true }); probes.contra_hit = r5.per_drug[0]?.status ?? "error"; } catch (e) { probes.contra_hit = `error: ${e.message}`; }
    try { const r6 = HANDLERS.calc_renal({ age:68, weightKg:70, scrUmolL:88, sex:"male", calc:"both" }); probes.calc_umol = (r6.crcl && r6.egfr && r6.crcl.crcl > 10) ? "ok" : "error"; } catch (e) { probes.calc_umol = `error: ${e.message}`; }
    try { HANDLERS.calc_renal({ age:68, weightKg:70, scrMgDl:88, sex:"male", calc:"crcl" }); probes.calc_reject_88mg = "error: accepted 88 mg/dL"; } catch (e) { probes.calc_reject_88mg = e.name === "CreatinineUnitError" || /μmol|umol|scrMgDl/i.test(e.message) ? "ok" : `error: ${e.message}`; }
    try { const r7 = HANDLERS.check_interactions({ drugs: ["合成辛伐他汀片", "合成克拉霉素片"], include_samples: true }); probes.class_signal = r7.pairs[0]?.status ?? "error"; } catch (e) { probes.class_signal = `error: ${e.message}`; }
    try { probes.approval_fmt = HANDLERS.validate_approval_format({ approval_number: "国药准字H2000000" }).ok === false ? "ok" : "error"; } catch (e) { probes.approval_fmt = `error: ${e.message}`; }
    try { probes.codes_bare = CH.validate_code({code:"J45"}).validation_status ?? "error"; } catch (e) { probes.codes_bare = `error: ${e.message}`; }
    try { probes.codes_valid = CH.validate_code({code:"J45.900"}).validation_status ?? "error"; } catch (e) { probes.codes_valid = `error: ${e.message}`; }
    try {
      const { HANDLERS: TH } = await import("../../servers/china-trials/src/tools.mjs");
      probes.trials_fmt = TH.validate_ctr_format({ ctr: "CTR2025" }).ok === false ? "ok" : "error";
      probes.trials_get_missing = TH.get_trial({ ctr: "CTR20251234" }).error === "not_in_corpus" || TH.get_trial({ ctr: "CTR20251234" }).error ? "ok" : "error";
    } catch (e) { probes.trials = `error: ${e.message}`; }
    // --- P0 compliance probes: phiguard (stateless) + audit (isolated data dir) ---
    try {
      const PG = await import("../../servers/phiguard/src/lib.mjs");
      let id = "11010119900307001"; // synthetic; compute valid check digit at runtime
      const W=[7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2], M=["1","0","X","9","8","7","6","5","4","3","2"];
      let s=0; for (let i=0;i<17;i++) s+=Number(id[i])*W[i];
      id += M[s%11];
      const t = `患者：张三，身份证 ${id}，手机 13800138000`;
      const sc = PG.scanText(t);
      const red = PG.redactText(t, { mode: "mask" });
      const ps = PG.pseudonymizeText(t, { salt: "eval-probe-salt-0001" });
      probes.phi_scan = sc.findings.some(f=>f.type==="id_card"&&f.checksum_valid) && sc.findings.some(f=>f.type==="phone_cn_mobile") && sc.findings.some(f=>f.type==="name_label") ? "ok" : "incomplete";
      probes.phi_redact = !/13800138000/.test(red.text) && red.text.includes("*") ? "ok" : "leaked";
      probes.phi_pseudo = !/\d{17}[\dXx]/.test(ps.text) && (ps.text.match(/\[PSN:/g)||[]).length >= 2 ? "ok" : "leaked";
    } catch (e) { probes.phi_scan = `error: ${e.message}`; }
    try {
      const os = await import("node:os");
      const fsx = await import("node:fs");
      const prevData = process.env.CLAUDE_MEDCIUS_DATA;
      const tmp = join(os.tmpdir(), `medcius-audit-probe-${Date.now()}`);
      process.env.CLAUDE_MEDCIUS_DATA = tmp; // audit db.mjs reads this at import time
      const { HANDLERS: A } = await import("../../servers/audit/src/tools.mjs");
      try {
        A.record_event({ actor: "eval", action: "rx_review_verdict", subject_ref: "MRN-PSN-EVAL", payload: { verdict: "FLAG" } });
        let guardRejected = false;
        try { A.record_event({ actor: "eval", action: "x", subject_ref: "身份证 110101199003077758", payload: {} }); } catch { guardRejected = true; }
        A.record_event({ actor: "eval", action: "rx_review_verdict", subject_ref: "MRN-PSN-EVAL-2", payload: { verdict: "PASS" } });
        A.signoff({ event_id: 1, signer: "pharmacist-eval", role: "pharmacist", decision: "agree", reason: "probe" });
        const v = A.verify_chain({});
        probes.audit_chain = v.ok && guardRejected ? "ok" : `verify=${v.ok} guard=${guardRejected}`;
        probes.audit_signoff = A.get_event({ event_id: 1 }).signoffs?.length === 1 ? "ok" : "missing";
      } finally {
        if (prevData === undefined) delete process.env.CLAUDE_MEDCIUS_DATA;
        else process.env.CLAUDE_MEDCIUS_DATA = prevData; // child graders must NOT inherit the temp dir
        try { fsx.rmSync(tmp, { recursive: true, force: true }); } catch {} // Windows may hold WAL lock briefly
      }
    } catch (e) { probes.audit_chain = `error: ${e.message}`; }
    return { corpus_status: st, china_codes: chSt, probes };
  } catch (e) {
    return { error: String(e.message ?? e) };
  }
}

function aggregateResults() {
  if (!existsSync(RESULTS_DIR)) return null;
  const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json"));
  if (!files.length) return null;
  let pass = 0, fail = 0, skip = 0, items = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf8"));
      const verdict = j.verdict ?? j.status ?? "unknown";
      items.push({ file: f, id: j.id ?? f, verdict });
      if (verdict === "pass") pass++;
      else if (verdict === "skip") skip++;
      else fail++;
    } catch {
      items.push({ file: f, verdict: "unreadable" });
      fail++;
    }
  }
  return { pass, fail, skip, total: pass + fail + skip, items };
}

// ---- main ----
const { files, all } = loadCases();
const { errors } = validate(all);

const bySkill = {};
for (const c of all) (bySkill[c.skill] ??= []).push(c);
const byFile = {};
for (const c of all) (byFile[c._file] ??= []).push(c);

console.log("=== China-skills eval harness ===");
console.log(`cases: ${all.length} across ${files.length} files (${files.join(", ")})`);
for (const [skill, arr] of Object.entries(bySkill).sort()) console.log(`  ${skill}: ${arr.length}`);
for (const [file, arr] of Object.entries(byFile).sort()) console.log(`  ${file}: ${arr.length}`);

if (errors.length) {
  console.log("\nVALIDATION FAILED:");
  for (const e of errors) console.log(`  - ${e}`);
} else {
  console.log("\nvalidation: OK (all cases well-formed, ids unique, must/must_not present)");
}

let corpusInfo = null;
if (withCorpus) {
  console.log("\n-- --with-corpus: probing local corpora --");
  const ingestMap = [
    ["../../servers/drug-labels/src/db.mjs", "drug-labels", "drug_labels", "../../servers/drug-labels/scripts/ingest.mjs"],
    ["../../servers/china-codes/src/db.mjs", "china-codes", "nhsa_codes", "../../servers/china-codes/scripts/ingest.mjs"],
    ["../../servers/china-trials/src/db.mjs", "china-trials", "clinical_trials", "../../servers/china-trials/scripts/ingest.mjs"],
  ];
  for (const [rel, label, table, script] of ingestMap) {
    try {
      const { db } = await import(rel);
      const n = db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
      if (n === 0) {
        console.log(`  ${label} empty — ingesting sample...`);
        const { spawnSync } = await import("node:child_process");
        const r = spawnSync("node", [join(__dirname, script), "--sample"], { encoding: "utf8" });
        if (r.status !== 0) console.log(`  ${label} ingest failed: ${r.stderr?.slice(0,400)}`); else console.log(`  ${label} ingest: ok`);
      }
    } catch {}
  }
  corpusInfo = await probeCorpus();
  if (corpusInfo.error) {
    console.log(`  corpus probe error: ${corpusInfo.error}`);
    errors.push(`corpus probe error: ${corpusInfo.error}`);
  } else {
    console.log(`  drug-labels: total=${corpusInfo.corpus_status.counts.total} official=${corpusInfo.corpus_status.counts.official} sample=${corpusInfo.corpus_status.counts.sample} mentions=${corpusInfo.corpus_status.interaction_mentions}`);
    console.log(`  china-codes: codes=${corpusInfo.china_codes.counts.codes.total} catalog=${corpusInfo.china_codes.counts.catalog.total}`);
    console.log(`  probes:`);
    const expect = [
      ["mention_found","mention_found"],
      ["no_mention","no_mention_in_corpus"],
      ["class_signal","class_signal_found"],
      ["insufficient","insufficient_data"],
      ["allergy_hit","hit"],
      ["contra_hit","hit"],
      ["calc_umol","ok"],
      ["calc_reject_88mg","ok"],
      ["approval_fmt","ok"],
      ["codes_bare","pending"],
      ["codes_valid","valid"],
      ["trials_fmt","ok"],
      ["phi_scan","ok"],
      ["phi_redact","ok"],
      ["phi_pseudo","ok"],
      ["audit_chain","ok"],
      ["audit_signoff","ok"],
    ];
    for (const [k,exp] of expect) {
      const got = corpusInfo.probes[k]; const ok = got===exp ? "✓" : "✗";
      console.log(`    ${ok} ${k}: got ${got} (expect ${exp})`);
    }
    const probesOk = expect.every(([k, exp]) => corpusInfo.probes[k] === exp);
    console.log(`  probe verdict: ${probesOk ? "OK" : "UNEXPECTED"}`);
    if (!probesOk) {
      errors.push("Corpus probe tests failed (unexpected probe results)");
    }
  }
}

if (withGrade) {
  console.log("\n-- --grade: deterministic grader --");
  const { spawnSync } = await import("node:child_process");
  const g = spawnSync("node", [join(__dirname, "grade.mjs")], { encoding: "utf8" });
  if (g.stdout) process.stdout.write(g.stdout);
  if (g.stderr) process.stderr.write(g.stderr);
  if (g.status !== 0 && g.status != null) {
    console.log("grader reported failures");
    errors.push(`Deterministic grader exited with status ${g.status}`);
  }
}

const agg = aggregateResults();
let engineeringPass = false;
let syntheticValidationPass = false;
const clinicalEvidencePass = false; // Never true for offline evals

if (agg) {
  console.log(`\nresults/: ${agg.pass} pass / ${agg.fail} fail / ${agg.skip} skip / ${agg.total} total`);
  for (const it of agg.items) {
    const sym = it.verdict === "pass" ? "✓" : (it.verdict === "skip" ? "○" : "✗");
    console.log(`  ${sym} ${it.id} (${it.file}): ${it.verdict}`);
  }
  if (agg.fail > 0) {
    errors.push(`Evaluation results contain ${agg.fail} failures.`);
  }
  if (agg.pass < 27) {
    errors.push(`Required deterministic pass count not reached: ${agg.pass}/27`);
  }
  if (agg.skip > 26) {
    errors.push(`Too many skipped cases: ${agg.skip} > 26 allowed`);
  }
  engineeringPass = agg.fail === 0 && agg.pass >= 27 && errors.length === 0;
  syntheticValidationPass = agg.fail === 0 && errors.length === 0;
} else {
  console.log("\nresults/: (no scores — run with --grade)");
}

console.log("\n================================================================================");
console.log(" Evaluation Pass Classification (Three-Tier Integrity Audit)");
console.log("================================================================================");
console.log(`- 1. engineering_pass:          ${engineeringPass ? "🟢 PASS (Deterministic tools & parsers verified)" : "🔴 FAIL"}`);
console.log(`- 2. synthetic_validation_pass:  ${syntheticValidationPass ? "🟢 PASS (Synthetic trap benchmark verified)" : "🔴 FAIL"}`);
console.log(`- 3. clinical_evidence_pass:    🔒 BLOCKED (Requires live multi-center shadow study with independent blind labeling)`);
console.log("================================================================================");

const ok = errors.length === 0 && engineeringPass;
console.log(ok ? "\nALL EVALUATION CHECKS PASSED" : "\nEVALUATION CHECKS FAILED");
if (!ok) {
  for (const err of errors) console.error(`  - ${err}`);
}
process.exit(ok ? 0 : 1);
