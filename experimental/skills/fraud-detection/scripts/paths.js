// Single source of truth for filesystem paths. Per the medcius plugin convention, skill-local
// data lives at ~/.claude/data/medcius/<skill-name>/ (override the parent with
// $CLAUDE_MEDCIUS_DATA) — NEVER under the plugin install path, which is a versioned cache
// wiped on upgrade.
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SKILL_ROOT = path.resolve(import.meta.dirname, "..");
const MEDCIUS_DATA =
  process.env.CLAUDE_MEDCIUS_DATA || path.join(os.homedir(), ".claude", "data", "medcius");
export const DATA_ROOT = path.join(MEDCIUS_DATA, "fraud-detection");
export const dataCache = (...p) => path.join(DATA_ROOT, "data-cache", ...p);
export const refDir = (q) => dataCache("reference", q);
export const refDb = (q) => path.join(refDir(q), "reference.duckdb");
export const refMeta = (q) => path.join(refDir(q), "reference.meta.json");
export const corpusDb = () => dataCache("corpus.duckdb");
export const outDir = () =>
  process.env.FRAUD_OUT_DIR ||
  path.join(DATA_ROOT, "out", `run-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 15)}`);

mkdirSync(DATA_ROOT, { recursive: true });
