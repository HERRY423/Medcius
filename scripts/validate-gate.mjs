#!/usr/bin/env node
// 验证 P0-2 硬门闩：official=0 时默认阻断，--allow-sample 才放行
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function run(args) {
  return spawnSync("node", args, { encoding: "utf8" });
}

const tests = [
  { name: "doctor 默认可查", args: ["plugins/medcius/scripts/doctor.mjs"], expectExit: 0, expectContains: '"ready": false' },
  { name: "doctor --require-production 阻断", args: ["plugins/medcius/scripts/doctor.mjs", "--require-production"], expectExit: 2, expectContains: "official" },
  { name: "settlement 无 allow-sample 阻断", args: ["plugins/medcius/scripts/settlement-from-note.mjs", "plugins/medcius/skills/clinical-note-extract/assets/sample-note.md"], expectExit: 2, expectContains: "HALT" },
  { name: "settlement 有 allow-sample 放行", args: ["plugins/medcius/scripts/settlement-from-note.mjs", "plugins/medcius/skills/clinical-note-extract/assets/sample-note.md", "--allow-sample"], expectExit: 0, expectContains: "production_ready" },
  { name: "intake --code 无 allow-sample 阻断", args: ["plugins/medcius/scripts/intake-discharge.mjs", "plugins/medcius/skills/clinical-note-extract/assets/sample-note.md", "--code"], expectExit: 2, expectContains: "HALT" },
  { name: "intake --code 有 allow-sample 放行", args: ["plugins/medcius/scripts/intake-discharge.mjs", "plugins/medcius/skills/clinical-note-extract/assets/sample-note.md", "--code", "--allow-sample", "--out", "out/gate-test"], expectExit: 0, expectContains: "intake-report" },
];

let fails = 0;
for (const t of tests) {
  const r = run(t.args);
  const out = (r.stdout || "") + (r.stderr || "");
  const exitOk = r.status === t.expectExit;
  const containsOk = t.expectContains ? out.includes(t.expectContains) : true;
  const ok = exitOk && containsOk;
  console.log(`${ok ? "PASS" : "FAIL"} ${t.name} (exit ${r.status} expect ${t.expectExit}, contains '${t.expectContains}': ${containsOk})`);
  if (!ok) {
    console.log(`  stdout: ${r.stdout?.slice(0, 300)}`);
    console.log(`  stderr: ${r.stderr?.slice(0, 300)}`);
    fails++;
  }
}
console.log(fails === 0 ? "\nGATE VALIDATION PASSED — H01 已堵住" : `\nGATE VALIDATION FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
