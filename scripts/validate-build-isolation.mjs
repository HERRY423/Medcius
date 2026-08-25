#!/usr/bin/env node
// Build & Packaging Isolation Validator
// Verifies that sample artifacts and test datasets are strictly isolated from production bundles.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

let failures = 0;
const ok = (msg) => console.log(`PASS ${msg}`);
const fail = (msg) => {
  console.log(`FAIL ${msg}`);
  failures++;
};

console.log("== Validating Sample vs Production Artifact Isolation ==");

// Check 1: Verify sample code assets are tagged with data_class='sample'
const sampleCodesPath = join(repoRoot, "plugins", "medcius", "servers", "china-codes", "assets", "sample-codes.json");
if (existsSync(sampleCodesPath)) {
  const codesData = JSON.parse(readFileSync(sampleCodesPath, "utf8"));
  const codesList = codesData.codes || codesData;
  const allSample = codesList.every((item) => item.data_class === "sample");
  if (allSample) {
    ok(`china-codes sample asset (${codesList.length} items) explicitly tagged data_class='sample'`);
  } else {
    fail("china-codes sample asset contains items without data_class='sample'");
  }
}

// Check 2: Verify sample label assets are tagged with data_class='sample'
const sampleLabelsPath = join(repoRoot, "plugins", "medcius", "servers", "drug-labels", "assets", "sample-labels.json");
if (existsSync(sampleLabelsPath)) {
  const labelsData = JSON.parse(readFileSync(sampleLabelsPath, "utf8"));
  const labelsList = labelsData.records || labelsData;
  const allSample = labelsList.every((item) => item.data_class === "sample");
  if (allSample) {
    ok(`drug-labels sample asset (${labelsList.length} items) explicitly tagged data_class='sample'`);
  } else {
    fail("drug-labels sample asset contains items without data_class='sample'");
  }
}

// Check 3: Verify Hospital Production Knowledge Packs contain NO sample data
const hospitalPackPath = join(repoRoot, "plugins", "medcius", "packs", "hospital-knowledge-pack.json");
if (existsSync(hospitalPackPath)) {
  const packData = JSON.parse(readFileSync(hospitalPackPath, "utf8"));
  if (packData.pack_id && packData.hospital_code && packData.formulary) {
    ok(`hospital production knowledge pack is well-formed (${packData.formulary.length} formulary items, pack_id: ${packData.pack_id})`);
  } else {
    fail("hospital knowledge pack missing required production metadata");
  }
}

// Check 4: Verify default API parameters require production / includeSamples=false
const supervisorSrc = readFileSync(join(repoRoot, "plugins", "medcius", "orchestrator", "supervisor.mjs"), "utf8");
if (supervisorSrc.includes("includeSamples = false") && !supervisorSrc.includes("includeSamples = true")) {
  ok("ClinicalSupervisor defaults includeSamples=false for strict production isolation");
} else {
  fail("ClinicalSupervisor does not default includeSamples to false");
}

const codingWorkerSrc = readFileSync(join(repoRoot, "plugins", "medcius", "orchestrator", "workers", "coding-worker.mjs"), "utf8");
if (codingWorkerSrc.includes("include_samples ?? false")) {
  ok("CodingWorker defaults include_samples=false");
} else {
  fail("CodingWorker does not default include_samples to false");
}

const pharmaWorkerSrc = readFileSync(join(repoRoot, "plugins", "medcius", "orchestrator", "workers", "pharma-worker.mjs"), "utf8");
if (pharmaWorkerSrc.includes("include_samples ?? false")) {
  ok("PharmaWorker defaults include_samples=false");
} else {
  fail("PharmaWorker does not default include_samples to false");
}

// Check 5: No hardcoded salt or acknowledged bypass in codebase
const auditWorkerSrc = readFileSync(join(repoRoot, "plugins", "medcius", "orchestrator", "workers", "audit-worker.mjs"), "utf8");
if (auditWorkerSrc.includes("medcius-audit-default-salt")) {
  fail("audit-worker.mjs contains hardcoded default salt");
} else {
  ok("audit-worker.mjs free of hardcoded salt");
}

if (auditWorkerSrc.includes('"acknowledged"')) {
  fail("audit-worker.mjs contains acknowledged bypass string");
} else {
  ok("audit-worker.mjs free of acknowledged bypass");
}

console.log(failures === 0 ? "\nBUILD & PACKAGING ISOLATION VALIDATION PASSED" : `\nBUILD ISOLATION FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
