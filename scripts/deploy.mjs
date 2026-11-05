#!/usr/bin/env node
/**
 * On-Prem Deployer (安装/升级/回滚/巡检 · 缺口六，落地 PRODUCTIZATION-OPERATIONS §2/§7).
 *
 * Offline, lockfile-bound deployment tooling for the hospital DMZ host:
 *   status    — environment & readiness inspection (node version, env file, data dir, audit chain)
 *   install   --target <dir> [--dry-run]   lay out releases/<ts>, data/, backups/, env file
 *   upgrade   --target <dir> [--dry-run]   backup -> staged runtime probe -> atomic active-release.json
 *   backup    --target <dir>               manifest'd copy of data/ (audit chain + corpus snapshots)
 *   rollback  --target <dir> --to <ts>     restore data/ from a backup (safety backup first)
 *
 * Discipline: the tool never runs arbitrary shell, never touches anything
 * outside --target (except reading this repo), and every mutation prints a
 * structured plan first; --dry-run writes nothing.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, lstatSync, openSync, closeSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve, relative, isAbsolute, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const NODE_MIN_MAJOR = 22;
const COPY_EXCLUDE = new Set([".git", ".github", "node_modules", "staging", "out", "output", ".agentmuxer"]);

function sha256File(path) {
  const content = readFileSync(path);
  return createHash("sha256").update(content).digest("hex");
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID();
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
  const result = spawnSync(process.execPath, [join(REPO, "scripts/validate-json.mjs")], { cwd: REPO, encoding: "utf8", timeout: 15000 });
  const gate = { pass: result.status === 0 && /ALL JSON CONTRACTS VALID/.test(result.stdout || ""), evidence: `validate-json exit=${result.status}; ${result.error ? "execution failed" : "syntax and declared contracts checked"}` };
  checks.push({ item: "quick_gate", ...gate });
  const ok = checks.every((c) => c.pass);
  plan(checks.map((c) => `${c.pass ? "PASS" : "FAIL"} ${c.item}: ${c.evidence}`));
  return ok;
}

// Validate every path before copying/moving, including existing ancestors. No
// symlink/junction traversal, root target, source/target overlap, or shell commands.
function checkedTarget(target) {
  if (typeof target !== 'string' || !target.trim()) throw new Error('DEPLOY_TARGET_REQUIRED');
  const dir = resolve(target);
  const sourceRelative = relative(dir, REPO);
  if (dir === parse(dir).root || dir === REPO || (!sourceRelative.startsWith('..') && !isAbsolute(sourceRelative))) throw new Error('DEPLOY_TARGET_UNSAFE');
  const rel = relative(REPO, dir);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !/^output[\\/]/.test(rel))) throw new Error('DEPLOY_TARGET_OVERLAPS_SOURCE');
  for (let p = dir; p !== dirname(p); p = dirname(p))
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('DEPLOY_REPARSE_PATH_REJECTED');
  return dir;
}
function inside(root, ...parts) {
  const p = resolve(root, ...parts), rel = relative(root, p);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('DEPLOY_PATH_ESCAPE');
  for (let at = p; at !== root; at = dirname(at))
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw new Error('DEPLOY_REPARSE_PATH_REJECTED');
  return p;
}
function rejectLinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('DEPLOY_REPARSE_PATH_REJECTED');
    if (entry.isDirectory()) rejectLinks(join(dir, entry.name));
  }
}
function atomicJson(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}
function install({ target, dryRun, serviceStopped = false }) {
  const targetDir = checkedTarget(target);
  const current = inside(targetDir, 'current');
  const shim = "import '../../launch.mjs';\n";
  const legacy = existsSync(current) && (!existsSync(join(current,'scripts/serve.mjs')) || readFileSync(join(current,'scripts/serve.mjs'),'utf8') !== shim);
  if (legacy && !serviceStopped && !dryRun) throw new Error('DEPLOY_LEGACY_SERVICE_STOP_REQUIRED');
  const releaseId = timestamp();
  const releases = inside(targetDir, 'releases', releaseId);
  plan([`install plan → ${targetDir}`, '  stage immutable source and locked offline dependencies',
    '  verify actual CPU inference before atomically updating active-release.json',
    '  preserve data, previous releases and existing medcius.env']);
  if (dryRun) return true;
  for (const dir of ['data','backups','releases']) mkdirSync(inside(targetDir, dir), { recursive: true });
  mkdirSync(releases);
  for (const entry of readdirSync(REPO, { withFileTypes: true })) {
    if (COPY_EXCLUDE.has(entry.name)) continue;
    cpSync(join(REPO, entry.name), join(releases, entry.name), { recursive: true,
      filter: src => {
        if (lstatSync(src).isSymbolicLink()) throw new Error('DEPLOY_SOURCE_REPARSE_REJECTED');
        return !relative(REPO, src).split(/[\\/]/).some(p => COPY_EXCLUDE.has(p));
      } });
  }
  const runtime = join(releases, 'plugins/medcius/runtimes/cn-phi-ner');
  const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('DEPLOY_NPM_RUNTIME_REQUIRED');
  const deps = spawnSync(process.execPath, [npmCli, 'ci', '--prefix', runtime, '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'],
    { encoding: 'utf8', timeout: 120000 });
  if (deps.status !== 0) throw new Error('DEPLOY_OFFLINE_DEPENDENCIES_UNAVAILABLE');
  const probe = spawnSync(process.execPath, [join(releases, 'scripts/verify-runtime.mjs')],
    { cwd: releases, encoding: 'utf8', timeout: 60000 });
  if (probe.status !== 0 || !probe.stdout.includes('RUNTIME_READY:')) throw new Error('DEPLOY_RUNTIME_NOT_READY');
  const envPath = inside(targetDir, 'medcius.env');
  if (existsSync(envPath)) plan([`  !! env file exists — refusing to overwrite (${envPath})`]);
  else cpSync(join(REPO, 'deploy/env.template'), envPath);
  const launcher = inside(targetDir, 'launch.mjs');
  const sourceLauncher = join(REPO, 'deploy/launch.mjs');
  if (existsSync(launcher) && sha256File(launcher) !== sha256File(sourceLauncher)) throw new Error('DEPLOY_LAUNCHER_UPDATE_REQUIRED');
  if (!existsSync(launcher)) cpSync(sourceLauncher, launcher);
  // Legacy full-directory installs migrate only in an explicit stopped-service
  // window. Keep every byte of their current/ tree, with compensating restore.
  let preservedCurrent;
  if (legacy) {
    rejectLinks(current);
    preservedCurrent = inside(targetDir,'releases','legacy-current-' + releaseId);
    renameSync(current,preservedCurrent);
  }
  try {
  if (!existsSync(current)) {
    mkdirSync(join(current, 'scripts'), { recursive: true });
    writeFileSync(join(current, 'scripts/serve.mjs'), shim, { flag: 'wx' });
  }
  const activePath = inside(targetDir, 'active-release.json');
  const previous = existsSync(activePath) ? JSON.parse(readFileSync(activePath, 'utf8')) : null;
  const activation = { release: releaseId, previous_release: previous?.release ?? null, verified_at: new Date().toISOString(),
    runtime_probe: 'CPU_NER_EXECUTED', dependency_lock_sha256: sha256File(join(runtime, 'package-lock.json')) };
  writeFileSync(join(releases, 'activation.json'), JSON.stringify(activation, null, 2), { flag: 'wx' });
  atomicJson(activePath, activation);
  } catch (error) {
    if (preservedCurrent) {
      if (existsSync(current)) renameSync(current, inside(targetDir,'releases','failed-bootstrap-' + releaseId));
      renameSync(preservedCurrent,current);
    }
    throw error;
  }
  plan([`install complete: ${releaseId}; start ${launcher}`]);
  return true;
}

// ---------- backup / restore ----------
function backup({ target, dryRun }) {
  const targetDir = checkedTarget(target);
  const dataDir = inside(targetDir, "data");
  const ts = timestamp();
  const dest = inside(targetDir, "backups", ts);
  if (!existsSync(dataDir)) {
    plan([`backup: no data dir at ${dataDir} — nothing to back up`]);
    return false;
  }
  if (dryRun) {
    plan([`backup plan → ${dest} (manifest with sha256 per file)`]);
    return true;
  }
  rejectLinks(dataDir);
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
  const targetDir = checkedTarget(target);
  if (typeof to !== "string" || !/^[a-zA-Z0-9-]+$/.test(to)) throw new Error("DEPLOY_BACKUP_ID_INVALID");
  const backupDir = inside(targetDir, "backups", to);
  if (!existsSync(backupDir)) {
    plan([`rollback: backup not found: ${backupDir}`]);
    return false;
  }
  rejectLinks(backupDir);
  const manifestPath = join(backupDir, "backup-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expected = new Set(manifest.files.map(f => inside(backupDir, f.path)));
  const actual = [];
  const inventory = dir => { for (const item of readdirSync(dir, { withFileTypes:true })) {
    const file = join(dir,item.name); if (item.isDirectory()) inventory(file); else actual.push(file);
  } };
  inventory(inside(backupDir,'data'));
  if (expected.size !== manifest.files.length || expected.size !== actual.length || actual.some(p => !expected.has(p))) {
    plan(['rollback ABORTED: backup file inventory differs from manifest']); return false;
  }
  const corrupted = manifest.files.filter((f) => {
    const p = inside(backupDir, f.path);
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
  const data = inside(targetDir, 'data'), staged = inside(targetDir, 'restore-' + timestamp());
  if (existsSync(data)) rejectLinks(data);
  const safety = inside(targetDir, "backups", `pre-rollback-${timestamp()}`);
  mkdirSync(safety, { recursive: true });
  if (existsSync(join(targetDir, "data"))) cpSync(join(targetDir, "data"), join(safety, "data"), { recursive: true });
  cpSync(inside(backupDir, 'data'), staged, { recursive: true });
  const preserved = inside(targetDir, 'backups', 'preserved-' + timestamp());
  const hadData = existsSync(data);
  if (hadData) renameSync(data, preserved);
  try { renameSync(staged, data); } catch (error) { if (hadData) renameSync(preserved, data); throw error; }
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
let lock;
try {
if (['install','upgrade','backup','rollback'].includes(command) && !dryRun) {
  const root = checkedTarget(flag('target'));
  mkdirSync(root, { recursive: true });
  const lockPath = inside(root, '.deploy-lock');
  const fd = openSync(lockPath, 'wx', 0o600); closeSync(fd); lock = lockPath;
}
switch (command) {
  case "status":
    ok = status();
    break;
  case "install":
    ok = install({ target: flag("target"), dryRun, serviceStopped: args.includes('--service-stopped') });
    break;
  case "upgrade":
    ok = backup({ target: flag("target"), dryRun });
    if (ok && !dryRun) ok = install({ target: flag("target"), dryRun: false, serviceStopped: args.includes('--service-stopped') });
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
      "  upgrade  --target <dir> [--dry-run]   (backup → verified release → atomic activation)",
      "  backup   --target <dir>",
      "  rollback --target <dir> --to <ts>     (sha256 manifest verified)",
    ]);
    process.exit(2);
}
} catch (error) {
  plan([`DEPLOY_FAILED: ${/^(?:DEPLOY_[A-Z_]+|EEXIST)$/.test(error.message) ? error.message : error.code === 'EEXIST' ? 'DEPLOY_LOCKED' : 'DEPLOY_OPERATION_FAILED'}`]);
  ok = false;
} finally { if (lock && existsSync(lock)) unlinkSync(lock); }
process.exit(ok ? 0 : 2);
