#!/usr/bin/env node
// Offline import only. Never fetches a label, patient record, or confidential price.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { prepareChinaPharmacyCatalog } from "../plugins/medcius/lib/china-pharmacy-catalog.mjs";
import { requiresProductionPhi } from "../plugins/medcius/lib/production-phi-policy.mjs";

const args = process.argv.slice(2);
const arg = key => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
try {
  if (!arg("--input") || !arg("--output") || !arg("--source-dir")) throw new Error("USAGE: --input catalog.json --output new-version.json --source-dir reviewed-documents [--synthetic]");
  const production = requiresProductionPhi() || !args.includes("--synthetic");
  const bundle = prepareChinaPharmacyCatalog(JSON.parse(readFileSync(resolve(arg("--input")), "utf8")), { production });
  const sourceDir = resolve(arg("--source-dir"));
  const hashes = new Set(readdirSync(sourceDir, { withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => createHash("sha256").update(readFileSync(join(sourceDir, entry.name))).digest("hex")));
  if (bundle.records.some(row => !hashes.has(row.source.document_sha256))) throw new Error("CN_PHARMACY_SOURCE_BYTES_MISSING_OR_DIGEST_MISMATCH");
  const output = resolve(arg("--output"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(bundle, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: "IMPORTED", version: bundle.version, records: bundle.records.length, sha256: bundle.sha256,
    source_bytes_checked: true, authority: "review_metadata_supplied_by_importer_not_independent_clinical_approval" }));
} catch (error) {
  // Avoid leaking file paths or record contents in external logs.
  console.error(/^(?:CN_PHARMACY_|USAGE:)/.test(error.message) ? error.message : "CN_PHARMACY_IMPORT_FAILED");
  process.exitCode = 1;
}
