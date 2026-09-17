// Tests for the Real-World Noise Robustness Benchmark & Desensitized Real-Data
// Ingest Channel (缺口二量具). Validates: noise-model determinism, parser
// hardening wins (heading variants recoverable), grader semantics, the CI
// benchmark gate, and the fail-closed desensitization gates of the real-data
// ingest channel.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRng, applyNoise, NOISE_MODELS } from "../plugins/medcius/evals/real-world-noise/noise-models.mjs";
import { gradeNoteText, gradeFieldSpec } from "../plugins/medcius/evals/real-world-noise/grader.mjs";
import { wilsonScore } from "../plugins/medcius/evals/clinical-validation/run.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = join(__dirname, "..", "plugins/medcius/skills/clinical-note-extract/assets/china-notes");
const BENCH = join(__dirname, "..", "plugins/medcius/evals/real-world-noise/run-noise-benchmark.mjs");
const INGEST = join(__dirname, "..", "plugins/medcius/evals/real-world-noise/ingest-real-data.mjs");
const GOLD = JSON.parse(readFileSync(join(NOTES_DIR, "expected.json"), "utf8"));

console.log("== Testing noise robustness benchmark & real-data ingest channel ==");

// ----------------------------------------------------
// Test 1: noise determinism
// ----------------------------------------------------
console.log("\n[Test 1] Same seed -> byte-identical noise; different seed -> different text...");
const note = readFileSync(join(NOTES_DIR, "01-allergy-negation.md"), "utf8");
const a1 = applyNoise(note, "combined", 1);
const a2 = applyNoise(note, "combined", 1);
const a3 = applyNoise(note, "combined", 2);
assert.equal(a1, a2, "same seed must reproduce byte-identical output");
assert.notEqual(a1, a3, "different seed must differ");
const seq = (seed) => {
  const r = createRng(seed);
  return [r(), r(), r()];
};
assert.deepEqual(seq("seed-x"), seq("seed-x"), "same seed must reproduce the identical sequence");
assert.notDeepEqual(seq("seed-x"), seq("seed-y"), "different seeds must diverge");
console.log("✓ Deterministic transforms verified");

// ----------------------------------------------------
// Test 2: every model actually perturbs at least one note
// ----------------------------------------------------
console.log("\n[Test 2] Every noise model perturbs the corpus...");
const notes = ["01-allergy-negation", "04-admission-vs-discharge", "05-prior-vs-current-procedure", "10-rule-out-mi"]
  .map((key) => readFileSync(join(NOTES_DIR, `${key}.md`), "utf8"));
for (const model of Object.keys(NOISE_MODELS)) {
  const perturbs = notes.some((sample, index) => applyNoise(sample, model, 7 + index) !== sample);
  assert.ok(perturbs, `model ${model} must change at least one note`);
}
console.log(`✓ ${Object.keys(NOISE_MODELS).length} models all perturb`);

// ----------------------------------------------------
// Test 3: grader semantics
// ----------------------------------------------------
console.log("\n[Test 3] Field-spec grader mirrors china-skills gold semantics...");
assert.deepEqual(gradeFieldSpec("f", { value_contains: ["胆囊"] }, { value: "急性胆囊炎" }), []);
assert.ok(gradeFieldSpec("f", { value_contains: ["胆囊"] }, { value: "急性阑尾炎" }).length > 0);
assert.ok(gradeFieldSpec("f", { null_or_none: true }, { value: "无" }).length === 0);
assert.ok(gradeFieldSpec("f", { null_or_none: true }, { value: "已行手术" }).length > 0);
const clean01 = gradeNoteText(note, GOLD["01-allergy-negation"]);
assert.equal(clean01.exact, true, "clean note 01 must grade exact");
console.log("✓ Grader semantics verified");

// ----------------------------------------------------
// Test 4: parser hardening wins (noise benchmark found & fixed real gaps)
// ----------------------------------------------------
console.log("\n[Test 4] Parser survives structurally realistic dialects...");
const headingNoise = applyNoise(note, "heading_variants", 3);
const graded = gradeNoteText(headingNoise, GOLD["01-allergy-negation"]);
assert.equal(graded.exact, true, "non-standard headings must be normalized (was 7% before hardening)");
const bracket = "出院记录\n【出院诊断】\n1. 急性胆囊炎\n离院方式：1\n";
assert.ok(gradeNoteText(bracket, { discharge_diagnosis_primary: { value_contains: ["急性胆囊炎"] } }).exact);
const inline = "出院记录\n主诉：腹痛。现病史：加重 1 天。\n出院诊断：急性胆囊炎\n";
assert.ok(gradeNoteText(inline, { discharge_diagnosis_primary: { value_contains: ["急性胆囊炎"] } }).exact);
const scanJunk = "出院记录\n出院诊断：急性胆囊炎\n手术及操作：无。 第3页 ─────\n";
assert.ok(gradeNoteText(scanJunk, { procedures: { null_or_none: true } }).exact, "scan artifacts after 无 must not fake a procedure");
console.log("✓ Bracket/alias/midline/scan-junk hardening verified");

// ----------------------------------------------------
// Test 5: benchmark CLI gate passes and is deterministic
// ----------------------------------------------------
console.log("\n[Test 5] Benchmark CLI gate + determinism...");
const run1 = execFileSync("node", [BENCH, "--out"], { encoding: "utf8" });
const run2 = execFileSync("node", [BENCH], { encoding: "utf8" });
const digest1 = /digest: ([0-9a-f]+)/.exec(run1)[1];
const digest2 = /digest: ([0-9a-f]+)/.exec(run2)[1];
assert.equal(digest1, digest2, "benchmark must be byte-deterministic across runs");
assert.ok(/NOISE BENCHMARK PASSED/.test(run1));
assert.ok(/clean=100%/.test(run1), "clean baseline must be perfect");
console.log(`✓ Benchmark passed deterministically (digest ${digest1.slice(0, 8)}…)`);

// ----------------------------------------------------
// Test 6: ingest channel fail-closed gates
// ----------------------------------------------------
console.log("\n[Test 6] Ingest refuses undeclared or non-desensitized data...");
const tmp = mkdtempSync(join(tmpdir(), "medcius-ingest-"));
const goodLine = {
  note_id: "real-001",
  note_text: "出院记录\n性别：女 年龄：45岁\n出院诊断：急性阑尾炎\n手术及操作：腹腔镜阑尾切除术\n离院方式：1",
  gold: { discharge_diagnosis_primary: { value_contains: ["急性阑尾炎"] }, procedures: { value_contains: ["阑尾切除"] } },
  source_meta: { desensitized: true, note_type: "discharge", dialect: "synthetic-probe" },
};
const goodPath = join(tmp, "good.jsonl");
writeFileSync(goodPath, JSON.stringify(goodLine) + "\n", "utf8");
const goodRun = execFileSync("node", [INGEST, goodPath], { encoding: "utf8" });
assert.ok(/REAL-DATA INGEST OK: 1\/1/.test(goodRun), "desensitized synthetic probe must ingest");

const runIngest = (obj) => {
  const p = join(tmp, "case.jsonl");
  writeFileSync(p, JSON.stringify(obj) + "\n", "utf8");
  try {
    execFileSync("node", [INGEST, p], { encoding: "utf8" });
    return null;
  } catch (error) {
    return String(error.stderr || error.message);
  }
};
const noFlag = runIngest({ ...goodLine, source_meta: { desensitized: false } });
assert.ok(/HALT .*desensitized !== true/.test(noFlag), "must halt on missing desensitized declaration");
assert.ok(!/急性阑尾炎/.test(noFlag) || !/PHI/.test(noFlag), "halt messages must not echo note content on the desensitization gate");

// checksum-valid synthetic ID card (same construction as the eval probes)
let id = "11010119900307001";
const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const M = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
let s = 0;
for (let i = 0; i < 17; i++) s += Number(id[i]) * W[i];
id += M[s % 11];
const withId = runIngest({
  ...goodLine,
  note_text: `出院记录\n身份证 ${id}\n出院诊断：急性阑尾炎\n`,
});
assert.ok(/HALT .*RAW_PHI_DETECTED types=\[id_card\]/.test(withId), `must halt on raw ID card, got: ${withId}`);
assert.ok(!withId.includes(id), "halt message must never echo the PHI value itself");

const noGold = runIngest({ note_id: "x", note_text: "出院诊断：阑尾炎", source_meta: { desensitized: true } });
assert.ok(/HALT .*gold missing/.test(noGold), "must halt when gold annotation missing");
rmSync(tmp, { recursive: true, force: true });
console.log("✓ Desensitization + gold-annotation gates fail closed without content echo");

// ----------------------------------------------------
// Test 7: Wilson CI sanity
// ----------------------------------------------------
console.log("\n[Test 7] Wilson CI sanity...");
const ci = wilsonScore(7, 10);
assert.ok(ci.point === 0.7 && ci.low < 0.7 && ci.high > 0.7);
console.log("✓ wilsonScore(7,10) ->", ci.str);

console.log("\nALL NOISE-BENCHMARK & INGEST-CHANNEL TESTS PASSED");
