#!/usr/bin/env node
// Top-level shim: delegates to the china-skills harness.
// Keeps `node scripts/run-evals.mjs` working from repo root.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const harness = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "medcius", "evals", "china-skills", "run.mjs");
const extra = process.argv.slice(2);
if (!extra.includes("--grade")) extra.push("--grade");
const r = spawnSync("node", [harness, ...extra], { stdio: "inherit" });
process.exit(r.status ?? 1);
