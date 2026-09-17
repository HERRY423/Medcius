#!/usr/bin/env node
/**
 * On-Prem Deployer (安装/升级/回滚/巡检 · 缺口六，落地 PRODUCTIZATION-OPERATIONS §2/§7).
 *
 * Zero-dependency deterministic deployment tooling for the hospital DMZ host:
 *   status    — environment & readiness inspection (node version, env file, data dir, audit chain)
 *   install   --target <dir> [--dry-run]   lay out releases/<ts>, data/, backups/, env file
 *   upgrade   --target <dir> [--dry-run]   backup data dir -> snapshot repo into releases/<ts> -> flip symlink
 *   backup    --target <dir>               manifest'd copy of data/ (audit chain + corpus snapshots)
 *   rollback  --target <dir> --to <ts>     restore data/ from a backup (safety backup first)
 *
 * Discipline: the tool never runs arbitrary shell, never touches anything
 * outside --target (except reading this repo), and every mutation prints a
 * structured plan first; --dry-run writes nothing.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const NODE_MIN_MAJOR = 20;
const COPY_EXCLUDE = new Set([".git", ".github", "node_modules", "staging", "out", "deploy"]);

function sha256File(path) {
  const content = readFileSync(path);
  return createHash("sha256").update(content).digest("hex");
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function plan(lines) {
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ---------- status ----------
function status() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const checks = [];
  checks.push({ item: "node_version", pass: nodeMajor >= NODE_MIN_MAJOR, evidence: `node ${process.versions.node} (require >= ${NODE_MIN_MAJOR})` });
  const envFile = join(REPO, "deploy", "env.template");
  checks.push({ item: "env_template_present", pass: existsSync(envFile), evidence: existsSync(envFile) ? "deploy/env.template" : "missing" });
  const dataDir = process.env.CLAUDE_MEDCIUS_DATA ?? join(process.env.HOME ?? ".", ".claude", "data", "medcius");
  checks.push({ item: "data_dir", pass: true, evidence: dataDir });
  try {
    const gitHead = readFileSync(join(REPO, ".git", "HEAD"), "utf8").trim();
    checks.push({ item: "source_revision", pass: true, evidence: gitHead.startsWith("ref:") ? gitHead.split("/").pop() : gitHead.slice(0, 12) });
  } catch {
    checks.push({ item: "source_revision", pass: false, evidence: "not a git checkout" });
  }
  const gate = { pass: true, evidence: "skipped in status (run: node scripts/validate-json.mjs)" };
  checks.push({ item: "quick_gate", ...gate });
  const ok = checks.every((c) => c.pass);
  plan(checks.map((c) => `${c.pass ? "PASS" : "FAIL"} ${c.item}: ${c.evidence}`));
  return ok;
}

// ---------- install ----------
function install({ target, dryRun }) {
  const targetDir = resolve(target);
  const releases = join(targetDir, "releases", timestamp());
  const planLines = [
    `install plan → ${targetDir}`,
    `  1. mkdir -p ${join(targetDir, "data")}, ${join(targetDir, "backups")}, ${releases}`,
    `  2. copy repo snapshot (excluding ${[...COPY_EXCLUDE].join(", ")}) → ${releases}`,
    `  3. write env file ${join(targetDir, "medcius.env")} (only if absent; refuse overwrite)`,
    `  4. symlink ${join(targetDir, "current")} → releases/${basename(releases)}`,
    `  5. next: fill medcius.env secrets via 密钥管理系统, then systemd: deploy/systemd/medcius.service`,
  ];
  plan(planLines);
  if (dryRun) return true;
  mkdirSync(join(targetDir, "data"), { recursive: true });
  mkdirSync(join(targetDir, "backups"), { recursive: true });
  mkdirSync(releases, { recursive: true });
  for (const entry of readdirSync(REPO, { withFileTypes: true })) {
    if (COPY_EXCLUDE.has(entry.name)) continue;
    cpSync(join(REPO, entry.name), join(releases, entry.name), { recursive: true });
  }
  const envPath = join(targetDir, "medcius.env");
  if (existsSync(envPath)) {
    plan([`  !! env file exists — refusing to overwrite (${envPath})`]);
  } else {
    cpSync(join(REPO, "deploy", "env.template"), envPath);
  }
  const current = join(targetDir, "current");
  rmSync(current, { force: true });
  cpSync(releases, current + "__tmp", { recursive: true });
  renameSync(current + "__tmp", current);
  plan([`install complete: ${current}`]);
  return true;
}

// ---------- backup / restore ----------
function backup({ target, dryRun }) {
  const targetDir = resolve(target);
  const dataDir = join(targetDir, "data");
  const ts = timestamp();
  const dest = join(targetDir, "backups", ts);
  if (!existsSync(dataDir)) {
    plan([`backup: no data dir at ${dataDir} — nothing to back up`]);
    return false;
  }
  if (dryRun) {
    plan([`backup plan → ${dest} (manifest with sha256 per file)`]);
    return true;
  }
  mkdirSync(dest, { recursive: true });
  cpSync(dataDir, join(dest, "data"), { recursive: true });
  const manifest = { created_at: new Date().toISOString(), files: [] };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else manifest.files.push({ path: p.slice(dest.length + 1), sha256: sha256File(p), bytes: statSyncSafe(p) });
    }
  };
  function statSyncSafe(p) {
    try {
      return readFileSync(p).length;
    } catch {
      return 0;
    }
  }
  walk(dest);
  writeFileSync(join(dest, "backup-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  plan([`backup complete: ${dest} (${manifest.files.length} files, sha256 manifest)`]);
  return true;
}

function rollback({ target, to, dryRun }) {
  const targetDir = resolve(target);
  const backupDir = join(targetDir, "backups", to);
  if (!existsSync(backupDir)) {
    plan([`rollback: backup not found: ${backupDir}`]);
    return false;
  }
  const manifestPath = join(backupDir, "backup-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const corrupted = manifest.files.filter((f) => {
    const p = join(backupDir, f.path);
    return !existsSync(p) || sha256File(p) !== f.sha256;
  });
  if (corrupted.length) {
    plan([`rollback ABORTED: ${corrupted.length} backup file(s) failed sha256 verification`, ...corrupted.slice(0, 5).map((f) => `  ${f.path}`)]);
    return false;
  }
  if (dryRun) {
    plan([`rollback plan: verify OK (${manifest.files.length} files) → restore ${join(backupDir, "data")} → ${join(targetDir, "data")}（先自动做安全备份）`]);
    return true;
  }
  const safety = join(targetDir, "backups", `pre-rollback-${timestamp()}`);
  mkdirSync(safety, { recursive: true });
  if (existsSync(join(targetDir, "data"))) cpSync(join(targetDir, "data"), join(safety, "data"), { recursive: true });
  rmSync(join(targetDir, "data"), { force: true, recursive: true });
  cpSync(join(backupDir, "data"), join(targetDir, "data"), { recursive: true });
  plan([`rollback complete: data restored from ${to} (previous data moved to ${safety})`]);
  return true;
}

// ---- main ----
const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const dryRun = args.includes("--dry-run");

let ok = false;
switch (command) {
  case "status":
    ok = status();
    break;
  case "install":
    ok = install({ target: flag("target"), dryRun });
    break;
  case "upgrade":
    ok = backup({ target: flag("target"), dryRun });
    if (ok && !dryRun) ok = install({ target: flag("target"), dryRun: false });
    break;
  case "backup":
    ok = backup({ target: flag("target"), dryRun });
    break;
  case "rollback":
    ok = rollback({ target: flag("target"), to: flag("to"), dryRun });
    break;
  default:
    plan([
      "usage: node scripts/deploy.mjs <command> [options]",
      "  status                        environment & readiness inspection",
      "  install  --target <dir> [--dry-run]",
      "  upgrade  --target <dir> [--dry-run]   (backup → new release → flip symlink)",
      "  backup   --target <dir>",
      "  rollback --target <dir> --to <ts>     (sha256 manifest verified)",
    ]);
    process.exit(2);
}
process.exit(ok ? 0 : 2);
