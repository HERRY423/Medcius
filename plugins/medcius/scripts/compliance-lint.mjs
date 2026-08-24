// Compliance lint: machine-checks the regulatory boundary (SAMD-PATHWAY §3.3 D1–D3)
// and DHF document consistency. Exits non-zero on any violation.
//
//   node plugins/medcius/scripts/compliance-lint.mjs
//
// Checks:
//   1  Boundary wording — product-facing docs must not self-describe as 审方系统/审方软件 etc.
//      Lines carrying the ban itself (不得/禁止/红线) are exempt; docs/compliance/** is out of scope.
//   2  Structural anchors — prescription-review SKILL.md must keep its regulatory-positioning
//      section, four-outcome vocabulary, signoff closure, and the LLM-no-verdict statement.
//   3  Traceability sync — dhf/TRACEABILITY.md must equal regenerated matrix output.
//   4  Cross-refs — every ARCH-nn cited in dhf/RISK-MANAGEMENT.md exists in dhf/SRS-CN-SKILLS.md;
//      every REQ-* id cited anywhere under dhf/ exists in TRACEABILITY.md.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginScripts = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(pluginScripts, "..", "..", "..");
const dhfDir = join(repoRoot, "docs", "compliance", "dhf");

let failures = 0;
const ok = (msg) => console.log(`OK   ${msg}`);
const bad = (msg) => {
  console.log(`FAIL ${msg}`);
  failures += 1;
};

function walkMd(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walkMd(p, acc);
    else if (e.endsWith(".md")) acc.push(p);
  }
  return acc;
}

// ---- Check 1: boundary wording ------------------------------------------
const FORBIDDEN = [/审方系统/g, /审方软件/g, /智能审方/g, /自动审方/g, /AI审方/g];
const NORMATIVE_LINE = /(不得|禁止|红线)/;
const scopedFiles = [
  join(repoRoot, "README.md"),
  join(pluginScripts, "..", "README.md"),
  join(pluginScripts, "..", "CLAUDE.md"),
  ...walkMd(join(pluginScripts, "..", "skills")),
];

let hits = [];
for (const f of scopedFiles) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (NORMATIVE_LINE.test(line)) return;
    for (const re of FORBIDDEN) {
      re.lastIndex = 0;
      if (re.test(line)) hits.push(`${f}:${i + 1} → ${line.trim().slice(0, 80)}`);
    }
  });
}
if (hits.length === 0) ok("boundary wording clean across product-facing docs");
else hits.forEach((h) => bad(`boundary phrase: ${h}`));

// ---- Check 2: structural anchors ----------------------------------------
const rxSkill = readFileSync(
  join(pluginScripts, "..", "skills", "prescription-review", "SKILL.md"),
  "utf8",
);
const anchors = [
  ["监管定位 section", "## 监管定位"],
  ["LLM-no-verdict statement", "LLM 无判定权"],
  ["four-outcome vocab: PASS", "**PASS**"],
  ["four-outcome vocab: FLAG", "**FLAG**"],
  ["four-outcome vocab: INSUFFICIENT_DATA", "**INSUFFICIENT_DATA**"],
  ["four-outcome vocab: REQUIRES_PHARMACIST_REVIEW", "**REQUIRES_PHARMACIST_REVIEW**"],
  ["signoff closure", "signoff"],
  ["expected-use wording", "不出具用药建议"],
];
for (const [name, needle] of anchors) {
  if (rxSkill.includes(needle)) ok(`prescription-review anchor: ${name}`);
  else bad(`prescription-review missing anchor: ${name} (${needle})`);
}

// ---- Check 3: traceability sync -----------------------------------------
const tracePath = join(dhfDir, "TRACEABILITY.md");
const gen = spawnSync(process.execPath, [join(pluginScripts, "gen-dhf-trace.mjs")], {
  encoding: "utf8",
});
if (gen.status !== 0) bad(`traceability generator exited ${gen.status}: ${gen.stderr}`);
else {
  const onDisk = readFileSync(tracePath, "utf8");
  if (onDisk === gen.stdout) ok("TRACEABILITY.md in sync with eval cases");
  else {
    bad("TRACEABILITY.md out of sync — rerun: node plugins/medcius/scripts/gen-dhf-trace.mjs --out docs/compliance/dhf/TRACEABILITY.md");
    const diskRows = (onDisk.match(/^\| REQ-/gm) ?? []).length;
    const genRows = (gen.stdout.match(/^\| REQ-/gm) ?? []).length;
    bad(`  rows on disk=${diskRows}, regenerated=${genRows}`);
  }
}

// ---- Check 4: cross-references -------------------------------------------
const srs = readFileSync(join(dhfDir, "SRS-CN-SKILLS.md"), "utf8");
const risk = readFileSync(join(dhfDir, "RISK-MANAGEMENT.md"), "utf8");
const archIds = new Set([...srs.matchAll(/^\|\s*(ARCH-\d{2})\s*\|/gm)].map((m) => m[1]));
const citedArch = new Set(risk.match(/ARCH-\d{2}/g) ?? []);
for (const id of citedArch) {
  if (archIds.has(id)) ok(`risk doc ref ${id} exists in SRS`);
  else bad(`risk doc cites ${id} but SRS has none`);
}

const knownReq = new Set(
  [...readFileSync(tracePath, "utf8").matchAll(/^\| (REQ-[^\s|]+)\s*\|/gm)].map((m) => m[1]),
);
for (const f of walkMd(dhfDir)) {
  if (f.endsWith("TRACEABILITY.md")) continue;
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/REQ-[a-z0-9\-]+/g)) {
    if (!knownReq.has(m[0])) bad(`${f} cites unknown requirement ${m[0]}`);
  }
}
ok("dhf cross-reference scan done");

// ---- Summary ---------------------------------------------------------------
console.log(failures === 0 ? "\nCOMPLIANCE LINT PASSED" : `\nCOMPLIANCE LINT FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
