#!/usr/bin/env node
/**
 * Official Corpus Fetcher (官方语料拉取器 · 缺口四知识供应链).
 *
 * Registry-driven fetch/stage/verify pipeline for the source manifest in
 * packs/official-sources.json. Hard rule (H01 / ARCH-01): this tool NEVER
 * ingests — it fetches to a staging directory with a provenance sidecar, and
 * ingestion stays an explicit human action via import-official.mjs.
 *
 * Modes:
 *   --list                 validate the registry (CI-safe, no network) and print it
 *   --fetch <id>           fetch source -> staging/<id>-<sha8>.(csv|json) + .provenance.json
 *                          (transport injectable via --fixture <file> for offline replay/tests)
 *   --verify <sidecar.json>  re-verify checksum + file shape against the registry
 *
 * Exit codes: 0 ok; 2 registry/validation/verify failure.
 * Provenance discipline (ARCH-03): a staged pack without source_version +
 * effective_date context cannot pass import-official.mjs — fetching never
 * manufactures provenance.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, "..", "plugins", "medcius", "packs", "official-sources.json");

// ---------- pure registry validation (exported for tests) ----------
const REQUIRED_FIELDS = ["id", "name", "authority", "basis", "channel", "channel_url", "update_cycle_days", "format", "import_command", "target", "notes"];
const URL_RE = /^https:\/\/[^\s]+$/;
const ID_RE = /^[a-z0-9_]+$/;

export function validateRegistry(registry) {
  const errors = [];
  const ids = new Set();
  const sources = Array.isArray(registry?.sources) ? registry.sources : null;
  if (!sources || sources.length === 0) {
    return { errors: ["sources array missing/empty"], sources: [] };
  }
  if (typeof registry._discipline !== "string" || !registry._discipline.includes("永不自动 ingest")) {
    errors.push("_discipline must state the never-auto-ingest rule (H01)");
  }
  for (const source of sources) {
    const where = source?.id ?? "untitled";
    if (!ID_RE.test(String(source?.id ?? ""))) errors.push(`${where}: id must match ${ID_RE}`);
    if (ids.has(source.id)) errors.push(`${where}: duplicate id`);
    ids.add(source.id);
    for (const field of REQUIRED_FIELDS) {
      // external-only sources legitimately defer import plumbing until a table exists
      if (source.format === "external-only" && (field === "import_command" || field === "columns_template")) continue;
      if (source[field] === undefined || source[field] === null || source[field] === "") {
        errors.push(`${where}: missing required field '${field}'`);
      }
    }
    if (source.channel_url && !URL_RE.test(source.channel_url)) errors.push(`${where}: channel_url must be https`);
    const cycle = Number(source?.update_cycle_days);
    if (!Number.isInteger(cycle) || cycle < 30) errors.push(`${where}: update_cycle_days must be an integer >= 30`);
    if (source.import_command && !/import-official\.mjs|packs\/README\.md/.test(String(source.import_command))) {
      errors.push(`${where}: import_command must go through import-official.mjs or a documented manual path (never auto-ingest)`);
    }
    if (source.format === "external-only" && (source.import_command || source.columns_template)) {
      errors.push(`${where}: external-only sources must not declare import commands yet`);
    }
  }
  return { errors, sources };
}

export function loadRegistry(path = REGISTRY_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---------- staged pack + provenance sidecar (exported for tests) ----------
export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Build a staged pack artifact set for one source.
 * Pure: returns {filename, sidecarFilename, body, sidecar} — the CLI writes them.
 */
export function buildStagedPack({ source, body, fetchedAt, transportNote = null }) {
  if (!source?.id) throw new Error("FETCH_SOURCE_REQUIRED");
  if (typeof body !== "string" || !body.trim()) throw new Error("FETCH_BODY_EMPTY");
  const digest = sha256Text(body);
  const short = digest.slice(0, 8);
  const ext = source.format.startsWith("json") ? "json" : "csv";
  return {
    filename: `${source.id}-${short}.${ext}`,
    sidecarFilename: `${source.id}-${short}.provenance.json`,
    body,
    sidecar: {
      source_id: source.id,
      source_name: source.name,
      authority: source.authority,
      channel_url: source.channel_url,
      basis: source.basis,
      fetched_at: fetchedAt,
      sha256: digest,
      bytes: Buffer.byteLength(body, "utf8"),
      format: source.format,
      transport: transportNote ?? "https-fetch",
      // Provenance discipline: fetching does NOT invent source_version /
      // effective_date — the human importer supplies them at import time.
      provenance_status: "raw_staged_unverified",
      next_step: source.import_command ?? "(登记为 external-only：暂无导入路径)",
      disclaimer: "暂存件未经真实性核验；导入前由数据专员核对渠道版本与生效日期（ARCH-03）。",
    },
  };
}

/** Verify a staged sidecar against the on-disk body (checksum + non-empty). */
export function verifyStagedPack(sidecar, bodyText) {
  if (!sidecar || sidecar.provenance_status !== "raw_staged_unverified") {
    return { ok: false, reason: "SIDECAR_INVALID" };
  }
  if (typeof bodyText !== "string" || !bodyText.trim()) return { ok: false, reason: "BODY_EMPTY" };
  const digest = sha256Text(bodyText);
  if (digest !== sidecar.sha256) return { ok: false, reason: `CHECKSUM_MISMATCH expected=${sidecar.sha256.slice(0, 12)} got=${digest.slice(0, 12)}` };
  return { ok: true, sha256: digest };
}

// ---------- CLI (only when run directly; corpus-freshness imports the pure fns) ----------
const __is_main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (__is_main) {
  await cliMain();
}

async function cliMain() {
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

if (args.includes("--help") || args.length === 0) {
  process.stdout.write(`usage: node fetch-official-corpus.mjs --list\n       node fetch-official-corpus.mjs --fetch <source_id> --out <dir> [--fixture <file>]\n       node fetch-official-corpus.mjs --verify <staged.provenance.json>\n拉取→暂存→校验；永不自动导入（H01）。导入始终显式走 import-official.mjs。\n`);
  process.exit(args.length === 0 ? 2 : 0);
}

const registry = loadRegistry();
const { errors, sources } = validateRegistry(registry);
if (errors.length) {
  process.stderr.write(`REGISTRY_INVALID:\n${errors.map((e) => `  - ${e}`).join("\n")}\n`);
  process.exit(2);
}

if (args.includes("--list")) {
  process.stdout.write(`official sources registry: ${sources.length} entries, all checks passed\n`);
  for (const source of sources) {
    process.stdout.write(`  ${source.id.padEnd(34)} cycle=${String(source.update_cycle_days).padStart(3)}d  target=${source.target}\n`);
  }
  process.exit(0);
}

if (args.includes("--fetch")) {
  const id = flag("fetch");
  const source = sources.find((s) => s.id === id);
  if (!source) {
    process.stderr.write(`SOURCE_NOT_FOUND: ${id}\n`);
    process.exit(2);
  }
  if (source.format === "external-only") {
    process.stderr.write(`FETCH_NOT_AVAILABLE: ${id} is external-only（暂无导入路径，仅登记来源周期）\n`);
    process.exit(2);
  }
  const outDir = flag("out") ? resolve(flag("out")) : join(__dirname, "..", "staging");
  const fixturePath = flag("fixture");
  let body;
  if (fixturePath) {
    body = readFileSync(isAbsolute(fixturePath) ? fixturePath : join(process.cwd(), fixturePath), "utf8");
  } else {
    const res = await fetch(source.channel_url, { headers: { "user-agent": "medcius-corpus-fetcher/0.6 (hospital data officer use)" } });
    if (!res.ok) {
      process.stderr.write(`FETCH_HTTP_ERROR: ${res.status} ${source.channel_url}\n`);
      process.exit(2);
    }
    body = await res.text();
  }
  const staged = buildStagedPack({ source, body, fetchedAt: new Date().toISOString(), transportNote: fixturePath ? `fixture:${fixturePath}` : null });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, staged.filename), staged.body, "utf8");
  writeFileSync(join(outDir, staged.sidecarFilename), JSON.stringify(staged.sidecar, null, 2), "utf8");
  process.stdout.write(`staged: ${join(outDir, staged.filename)}\nsidecar: ${join(outDir, staged.sidecarFilename)}\nsha256: ${staged.sidecar.sha256}\n下一步（显式人工导入）: ${staged.sidecar.next_step}\n`);
  process.exit(0);
}

if (args.includes("--verify")) {
  const sidecarPath = resolve(flag("verify"));
  if (!existsSync(sidecarPath)) {
    process.stderr.write(`SIDECAR_NOT_FOUND: ${sidecarPath}\n`);
    process.exit(2);
  }
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  const bodyExt = String(sidecar.format ?? "").startsWith("json") ? "json" : "csv";
  const bodyPath = sidecarPath.replace(/\.provenance\.json$/, `.${bodyExt}`);
  if (!existsSync(bodyPath)) {
    process.stderr.write(`BODY_NOT_FOUND: ${bodyPath}
`);
    process.exit(2);
  }
  const body = readFileSync(bodyPath, "utf8");
  const result = verifyStagedPack(sidecar, body);
  if (!result.ok) {
    process.stderr.write(`VERIFY_FAILED: ${result.reason}\n`);
    process.exit(2);
  }
  process.stdout.write(`VERIFY_OK: ${sidecar.source_id} sha256=${result.sha256.slice(0, 16)}…（仍未核验渠道真实性；导入须由数据专员补 source_version/effective-date）\n`);
  process.exit(0);
}

process.stderr.write("UNKNOWN_MODE\n");
process.exit(2);
}
