// Subprocess document extraction: text out of untrusted bytes, entirely local.
// The server never touches the network; extraction is one subprocess per
// document, CPU-bound, and OCR on a scanned page costs seconds — so extraction
// is async and callers run it in parallel.
//
// Extractor selection: liteparse's `lit` binary if it can be found, otherwise
// pdftotext -layout for PDFs. `lit` is probed at runtime (--version) rather
// than assumed, so a broken install degrades to pdftotext instead of failing.
import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const pexec = promisify(execFile);

const MAX_BUFFER = 256 * 1024 * 1024;

const pageMarker = (page, text) => `\n\n=== [page ${page}] ===\n\n${text}`;

// Child env is an allowlist, not a spread of process.env: the extractors parse
// untrusted document bytes and `lit` is a third-party binary — neither needs
// the API keys or tokens the server was launched with. What they do need:
// binary resolution, tesseract's model cache, temp space, and proxy vars for
// OCR's one-time traineddata download.
const CHILD_ENV = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "COMSPEC",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "TESSDATA_PREFIX",
    "LITEPARSE_PATH",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]
    .filter((k) => process.env[k] !== undefined)
    .map((k) => [k, process.env[k]]),
);
// The Rust/OpenMP runtimes `lit` links against thread internally; bound their
// pools so parallel extraction lanes can't starve the machine.
CHILD_ENV.RAYON_NUM_THREADS = "2";
CHILD_ENV.OMP_THREAD_LIMIT = "2";
CHILD_ENV.TOKIO_WORKER_THREADS = "2";

// Extraction runs behind interactive work: whole-child low priority via nice on
// POSIX. On Windows children just run unniced.
let niceMissing = false;
const run = async (cmd, args, opts = {}) => {
  const o = { ...opts, env: CHILD_ENV };
  if (process.platform === "win32" || niceMissing) return pexec(cmd, args, o);
  try {
    return await pexec("nice", ["-n", "10", cmd, ...args], o);
  } catch (e) {
    // ENOENT here means `nice` itself is missing — a missing cmd under nice
    // exits 127 instead. A missing nicety must not read as N parse failures.
    if (e?.code !== "ENOENT") throw e;
    niceMissing = true;
    process.stderr.write("extract: `nice` not found — running extraction at normal priority\n");
    return pexec(cmd, args, o);
  }
};

// Where `lit` can be, in priority order. $LITEPARSE_PATH is an explicit
// operator choice. The server's own node_modules is the DECLARED dependency
// and outranks PATH (a bare `lit` on PATH is a name-collision risk — the
// LitElement package ships a bin that would pass a --version probe). PATH is
// the last resort.
const litCandidates = () => [
  process.env.LITEPARSE_PATH,
  fileURLToPath(new URL("../node_modules/.bin/lit", import.meta.url)),
  "lit",
];

export function resolveLit() {
  return litCandidates()
    .filter((p) => !!p)
    .find((p) => spawnSync(p, ["--version"], { stdio: "ignore" }).status === 0);
}

async function extractWithLiteparse(lit, src) {
  // OCR on by default; retry --no-ocr so a text-layer extraction still lands if
  // the OCR path fails. --format json, not text: liteparse 2.x emits no page
  // boundaries in text/markdown output, so page anchors are rebuilt from the
  // JSON pages array.
  for (const extra of [[], ["--no-ocr"]]) {
    let stdout;
    try {
      ({ stdout } = await run(lit, ["parse", src, "--format", "json", "--max-pages", "2000", ...extra], {
        maxBuffer: MAX_BUFFER,
      }));
    } catch (e) {
      if (/maxBuffer/i.test(String(e?.message)))
        process.stderr.write(`extract: ${src} output exceeded the ${MAX_BUFFER}-byte cap\n`);
      continue; // non-zero exit — try the next variant, then the pdftotext fallback
    }
    if (!stdout.trim()) continue;
    try {
      const pages = JSON.parse(stdout).pages ?? [];
      const text = pages.map((p) => pageMarker(p.page, p.text)).join("");
      if (text.trim()) return { text, method: "liteparse" };
    } catch {
      // unparseable stdout — try the next variant, then the pdftotext fallback
    }
  }
  return null;
}

async function extractWithPdftotext(src) {
  let stdout;
  try {
    ({ stdout } = await run("pdftotext", ["-layout", src, "-"], { maxBuffer: MAX_BUFFER }));
  } catch (e) {
    if (/maxBuffer/i.test(String(e?.message)))
      process.stderr.write(`extract: ${src} output exceeded the ${MAX_BUFFER}-byte cap\n`);
    return null;
  }
  // pdftotext separates pages with a form-feed; anchor each with its number.
  const text = stdout
    .split("\f")
    .map((page, i) => pageMarker(i + 1, page))
    .join("");
  return { text, method: "pdftotext" };
}

export async function extractWithMethod(lit, src, isPdf = /\.pdf$/i.test(src)) {
  if (lit) {
    const extracted = await extractWithLiteparse(lit, src);
    if (extracted) return extracted;
  }
  // Only PDFs have a no-liteparse fallback.
  return isPdf ? await extractWithPdftotext(src) : null;
}

export async function extract(lit, src) {
  return (await extractWithMethod(lit, src))?.text ?? null;
}
