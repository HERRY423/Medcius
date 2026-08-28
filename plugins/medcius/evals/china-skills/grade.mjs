#!/usr/bin/env node
/**
 * Deterministic grader: local tools + 出院记录解析器。写出 results/<id>.json。
 * 不调用托管模型。无法用工具判定的陷阱标 skip（needs_agent）。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCnNote } from "../../lib/parse-cn-note.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(__dirname, "../..");
const CASES = join(__dirname, "cases");
const RESULTS = join(__dirname, "results");
const NOTES = join(PLUGIN, "skills/clinical-note-extract/assets/china-notes");
const GOLD = JSON.parse(readFileSync(join(NOTES, "expected.json"), "utf8"));

function has(s, n) {
  return String(s ?? "").includes(n);
}

function gradeGold(id, rec) {
  const map = {
    "cne-01-allergy-negation": "01-allergy-negation",
    "cne-02-family-history": "02-family-history",
    "cne-03-uncertain-admission": "03-uncertain-admission",
    "cne-04-admission-vs-discharge": "04-admission-vs-discharge",
    "cne-05-prior-vs-current-procedure": "05-prior-vs-current-procedure",
    "cne-06-planned-procedure": "06-planned-procedure",
    "cne-07-negative-physical-exam": "07-negative-physical-exam",
    "cne-08-prophylaxis-not-diagnosis": "08-prophylaxis-not-diagnosis",
    "cne-09-lab-not-complication": "09-lab-not-complication",
    "cne-10-rule-out-mi": "10-rule-out-mi",
  };
  const g = GOLD[map[id]];
  if (!g) return { pass: false, fails: ["no gold"] };
  const fails = [];
  const checkField = (name, spec) => {
    if (!spec) return;
    const f = rec[name] ?? {};
    const val = f.value;
    if (spec.value_contains) {
      for (const n of spec.value_contains) if (!has(val, n)) fails.push(`${name} missing ${n}`);
    }
    if (spec.must_not_contain) {
      for (const n of spec.must_not_contain) if (has(val, n)) fails.push(`${name} must not contain ${n}`);
    }
    if (spec.presence && f.presence !== spec.presence) fails.push(`${name}.presence=${f.presence} want ${spec.presence}`);
    if (spec.temporality && f.temporality !== spec.temporality) fails.push(`${name}.temporality=${f.temporality}`);
    if (spec.span_contains) {
      for (const n of spec.span_contains) if (!has(f.span, n) && !has(val, n)) fails.push(`${name} span missing ${n}`);
    }
    if (spec.null_or_none) {
      const empty = val == null || val === "" || val === "无" || val === "无手术";
      if (!empty) fails.push(`${name} should be empty, got ${val}`);
    }
    if (spec.null_or_not_diabetes) {
      if (has(val, "糖尿病")) fails.push(`${name} should not be diabetes`);
    }
    if (spec.must_not_be_confirmed_pe) {
      if (f.presence === "present" && has(val, "肺栓塞") && !has(val, "疑似")) fails.push("admission confirmed PE");
    }
    if (spec.allowed_contains && val) {
      const ok = spec.allowed_contains.some((n) => has(val, n));
      if (!ok && val) fails.push(`${name} unexpected ${val}`);
    }
  };
  checkField("admission_diagnosis", g.admission_diagnosis);
  checkField("discharge_diagnosis_primary", g.discharge_diagnosis_primary);
  checkField("discharge_diagnosis_other", g.discharge_diagnosis_other);
  checkField("procedures", g.procedures);
  checkField("allergy_history", g.allergy_history);
  checkField("physical_exam", g.physical_exam);
  for (const ban of g.must_not ?? []) {
    if (ban.includes("青霉素过敏") && rec.allergy_history?.presence === "present" && has(rec.allergy_history.value, "青霉素"))
      fails.push(ban);
    if (ban.includes("出院诊断含糖尿病") && (has(rec.discharge_diagnosis_primary?.value, "糖尿病") || has(rec.discharge_diagnosis_other?.value, "糖尿病")))
      fails.push(ban);
    if (ban.includes("入院诊断确定为肺栓塞") && rec.admission_diagnosis?.presence === "present" && has(rec.admission_diagnosis.value, "肺栓塞"))
      fails.push(ban);
    if (ban.includes("阑尾切除且") && has(rec.procedures?.value, "阑尾") && rec.procedures?.temporality === "current")
      fails.push(ban);
    if (ban.includes("全髋关节置换") && has(rec.procedures?.value, "置换")) fails.push(ban);
    if (ban.includes("深静脉血栓") && has(rec.discharge_diagnosis_primary?.value, "血栓")) fails.push(ban);
    if (ban.includes("急性心肌梗死") && has(rec.discharge_diagnosis_primary?.value, "心肌梗死")) fails.push(ban);
    if (ban.includes("可闻及") && has(rec.physical_exam?.value, "可闻及干湿")) fails.push(ban);
  }
  return { pass: fails.length === 0, fails, record: rec };
}

async function gradeOne(c, tools) {
  const { DL, CC, TR } = tools;
  try {
    if (c.skill === "clinical-note-extract") {
      const rel = c.input?.note;
      if (!rel) return skip(c, "no note");
      const rec = parseCnNote(readFileSync(join(NOTES, rel.split("/").pop()), "utf8"));
      // cne-11/cne-16 have no expected.json gold entry — dedicated checks (the
      // blocks further down were unreachable because gradeGold lacks their ids)
      if (c.id === "cne-11-outpatient") {
        const ok =
          rec.note_type === "outpatient" &&
          has(rec.discharge_diagnosis_primary?.value, "胃炎") &&
          !has(rec.procedures?.value, "胃镜检查");
        return done(c, ok, { note_type: rec.note_type, primary: rec.discharge_diagnosis_primary?.value, procedures: rec.procedures?.value ?? null });
      }
      if (c.id === "cne-16-labs-umol") {
        const scr = (rec.labs ?? []).find((l) => l.name === "肌酐");
        return done(c, scr?.value === 188 && scr.unit === "umol_L", rec.labs);
      }
      const g = gradeGold(c.id, rec);
      return done(c, g.pass, g);
    }
    if (c.id === "nhsa-coding-01-bare-category") {
      const v = CC.validate_code({ code: "J45" });
      return done(c, v.validation_status !== "valid", { validation_status: v.validation_status, reasons: v.reasons });
    }
    if (c.id === "nhsa-coding-04-version-unknown") {
      const v = CC.validate_code({ code: "99.2500x001" });
      return done(c, v.validation_status !== "valid", v);
    }
    if (c.id === "nhsa-coding-05-no-connector") {
      const st = CC.corpus_status();
      if ((st.counts?.codes?.official ?? 0) > 0) return skip(c, "official corpus present; halt trap N/A");
      return done(c, true, { official: 0, note: st.note });
    }
    if (c.id === "nmpa-01-approval-format") {
      const v = DL.validate_approval_format({ approval_number: "国药准字H2000000" });
      return done(c, v.ok === false, v);
    }
    if (c.id === "nmpa-03-import-approval") {
      const j = DL.validate_approval_format({ approval_number: "国药准字J20150001" });
      const h = DL.validate_approval_format({ approval_number: "国药准字H20150001" });
      return done(c, j.ok && j.kind === "import_repack" && h.kind === "domestic", { j, h });
    }
    if (c.id === "nmpa-05-no-invent-approval") {
      const miss = DL.search_labels({ query: "不存在的药XYZ", include_samples: false });
      return done(c, miss.hit_count === 0, { hit_count: miss.hit_count });
    }
    if (c.id === "trials-01-ctr-format") {
      const v = TR.validate_ctr_format({ ctr: "CTR2025" });
      return done(c, v.ok === false, v);
    }
    if (c.id === "trials-03-not-in-corpus") {
      const v = TR.get_trial({ ctr: "CTR20251234" });
      return done(c, v.error === "not_in_corpus" || v.error === "invalid_ctr_format", v);
    }
    if (c.id === "trials-04-local-search-hit") {
      const v = TR.search_trials({ query: "高胆固醇血症", include_samples: true });
      const sample = (v.hits ?? []).some((h) => h.data_class === "sample");
      return done(c, v.hit_count > 0 && sample, { hit_count: v.hit_count, sample });
    }
    if (c.id === "prescription-15-scr-umol") {
      const ok = DL.calc_renal({ age: 68, weightKg: 70, scrUmolL: 88, sex: "male", calc: "crcl" });
      let rejected = false;
      try {
        DL.calc_renal({ age: 68, weightKg: 70, scrMgDl: 88, sex: "male", calc: "crcl" });
      } catch {
        rejected = true;
      }
      return done(c, ok.crcl?.crcl > 10 && rejected, { crcl: ok.crcl?.crcl, rejected });
    }
    if (c.id === "prescription-16-cyp-class-signal") {
      const v = DL.check_interactions({ drugs: ["合成辛伐他汀片", "合成克拉霉素片"], include_samples: true });
      const st = v.pairs?.[0]?.status;
      return done(c, st === "class_signal_found" || st === "mention_found", { status: st });
    }
    if (c.id === "prescription-17-cross-allergy") {
      const v = DL.safety_screen({ drugs: ["合成头孢呋辛钠"], allergies: ["青霉素"] });
      return done(c, (v.cross_allergy ?? []).length > 0, v);
    }
    if (c.id === "prescription-18-tcm-fan") {
      const v = DL.safety_screen({ drugs: ["合成甘草片", "海藻"] });
      return done(c, (v.tcm_incompatibility ?? []).length > 0, v);
    }
    if (c.id === "prescription-19-morphine-limit") {
      const v = DL.safety_screen({ drugs: ["合成吗啡片"], encounter: "outpatient", days_supply: 14 });
      return done(c, (v.controlled ?? []).some((x) => x.over_limit), v);
    }
    if (c.id === "cne-11-outpatient") {
      const rec = parseCnNote(readFileSync(join(NOTES, "11-outpatient.md"), "utf8"));
      const ok = rec.note_type === "outpatient" && has(rec.discharge_diagnosis_primary?.value, "胃炎") && !has(rec.procedures?.value, "奥美拉唑");
      return done(c, ok, rec);
    }
    if (c.id === "cne-16-labs-umol") {
      const rec = parseCnNote(readFileSync(join(NOTES, "16-labs-renal.md"), "utf8"));
      const scr = (rec.labs ?? []).find((l) => l.name === "肌酐");
      return done(c, scr?.value === 188 && scr.unit === "umol_L", rec.labs);
    }
    if (c.id === "prescription-07-no-mention-not-no-interaction") {
      const v = DL.check_interactions({ drugs: ["合成他汀片", "合成阿莫西林胶囊"], include_samples: true });
      return done(c, v.pairs?.[0]?.status === "no_mention_in_corpus", v.pairs?.[0]);
    }
    if (c.id === "prescription-02-g3-no-query") {
      return skip(c, "needs_agent: protocol gate, no tool call when query_done=false");
    }
    return skip(c, "needs_agent");
  } catch (e) {
    return done(c, false, { error: String(e.message ?? e) });
  }
}

function done(c, pass, evidence) {
  return { id: c.id, skill: c.skill, trap: c.trap, verdict: pass ? "pass" : "fail", mode: "deterministic", evidence };
}
function skip(c, reason) {
  return { id: c.id, skill: c.skill, trap: c.trap, verdict: "skip", mode: "needs_agent", evidence: { reason } };
}

const { readdirSync } = await import("node:fs");
const cases = readdirSync(CASES)
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => JSON.parse(readFileSync(join(CASES, f), "utf8")).map((c) => ({ ...c, _file: f })));

// Ensure sample test fixtures are seeded for deterministic grading
const trDbPath = existsSync(join(__dirname, "../../../../experimental/servers/china-trials/src/db.mjs"))
  ? "../../../../experimental/servers/china-trials/src/db.mjs"
  : "../../servers/china-trials/src/db.mjs";
const trIngestScript = existsSync(join(__dirname, "../../../../experimental/servers/china-trials/scripts/ingest.mjs"))
  ? "../../../../experimental/servers/china-trials/scripts/ingest.mjs"
  : "../../servers/china-trials/scripts/ingest.mjs";

const ingestMap = [
  ["../../servers/drug-labels/src/db.mjs", "drug-labels", "drug_labels", "../../servers/drug-labels/scripts/ingest.mjs"],
  ["../../servers/china-codes/src/db.mjs", "china-codes", "nhsa_codes", "../../servers/china-codes/scripts/ingest.mjs"],
  [trDbPath, "china-trials", "clinical_trials", trIngestScript],
];
for (const [rel, label, table, script] of ingestMap) {
  try {
    const { db } = await import(rel);
    const n = db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
    if (n === 0) {
      const { spawnSync } = await import("node:child_process");
      spawnSync("node", [join(__dirname, script), "--sample"], { encoding: "utf8" });
    }
  } catch {}
}

const { HANDLERS: DL } = await import("../../servers/drug-labels/src/tools.mjs");
const { HANDLERS: CC } = await import("../../servers/china-codes/src/tools.mjs");
const trPath = existsSync(join(__dirname, "../../../../experimental/servers/china-trials/src/tools.mjs"))
  ? "../../../../experimental/servers/china-trials/src/tools.mjs"
  : "../../servers/china-trials/src/tools.mjs";
const { HANDLERS: TR } = await import(trPath);

mkdirSync(RESULTS, { recursive: true });
const scored = [];
for (const c of cases) {
  const r = await gradeOne(c, { DL, CC, TR });
  scored.push(r);
  writeFileSync(join(RESULTS, `${c.id}.json`), JSON.stringify(r, null, 2), "utf8");
}

const pass = scored.filter((s) => s.verdict === "pass").length;
const fail = scored.filter((s) => s.verdict === "fail").length;
const skipN = scored.filter((s) => s.verdict === "skip").length;
const graded = pass + fail;
const summary = {
  pass,
  fail,
  skip: skipN,
  graded,
  total: scored.length,
  pass_rate_graded: graded ? pass / graded : 0,
  pass_rate_all: scored.length ? pass / scored.length : 0,
  engineering_pass: fail === 0 && pass === 27,
  synthetic_validation_pass: fail === 0,
  clinical_evidence_pass: false, // Deterministic grader is synthetic test, NEVER clinical evidence
};
process.stdout.write(`${JSON.stringify({ summary, items: scored.map((s) => ({ id: s.id, verdict: s.verdict })) }, null, 2)}\n`);
if (fail > 0 || pass < 27) {
  console.error(`\n[CRITICAL] Grader failed: ${fail} failures, only ${pass}/27 required deterministic cases passed.`);
  process.exit(1);
}
