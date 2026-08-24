#!/usr/bin/env node
/**
 * Import hospital-owned official packs (CSV or JSON) into local SQLite.
 * Does not download NMPA/NHSA corpora. Missing version/date → refuse official rows.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, pick } from "../lib/csv.mjs";

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : "";
}
const kind = flag("kind");
const file = flag("file");
const sourceName = flag("source") || "hospital-import";
const sourceUrl = flag("url") || "";
const version = flag("version") || "";
const effective = flag("effective-date") || flag("effective_date") || "";

if (!kind || !file || ["-h", "--help"].includes(args[0])) {
  process.stderr.write(
    "usage: node import-official.mjs --kind codes|catalog|labels|trials --file <csv|json> --source NAME --version V --effective-date YYYY-MM-DD\n",
  );
  process.exit(args[0] ? 0 : 2);
}

const path = /^[A-Za-z]:[\\/]/.test(file) || file.startsWith("/") ? file : join(process.cwd(), file);
const raw = readFileSync(path, "utf8");
const ext = extname(path).toLowerCase();

function requireProv(rowLabel) {
  if (!version || !effective) {
    throw new Error(`official ${kind} 导入必须提供 --version 与 --effective-date（缺于 ${rowLabel}）`);
  }
}

/** @type {unknown} */
let payload;
if (ext === ".json") {
  payload = JSON.parse(raw);
  if (kind === "labels" && payload.records) {
    for (const r of payload.records) {
      if ((r.data_class ?? "official") !== "sample") {
        r.source_version = r.source_version || version;
        r.effective_date = r.effective_date || effective;
        r.data_class = "official";
      }
    }
  }
} else {
  const rows = parseCsv(raw);
  if (kind === "codes") {
    requireProv("codes.csv");
    payload = {
      source: { name: sourceName, url: sourceUrl, note: "official import" },
      codes: rows.map((r) => {
        const code = pick(r, ["code", "诊断编码", "手术编码", "编码", "代码"]);
        const name = pick(r, ["name", "诊断名称", "手术名称", "名称"]);
        const ctype = /procedure|手术/.test(pick(r, ["code_type", "类型"])) ? "procedure" : "diagnosis";
        const sys =
          pick(r, ["code_system", "编码体系"]) ||
          (ctype === "procedure" ? "医保版手术操作分类" : "医保版ICD-10");
        const fl = pick(r, ["full_length"]) === "0" ? 0 : 1;
        return {
          code,
          name,
          code_type: ctype,
          code_system: sys,
          full_length: fl,
          is_main_diag_allowed: pick(r, ["is_main_diag_allowed"]) === "0" ? 0 : 1,
          category: pick(r, ["category", "分类"]) || null,
          code_version: pick(r, ["code_version", "版本"]) || version,
          effective_date: pick(r, ["effective_date", "生效日期"]) || effective,
          data_class: "official",
        };
      }).filter((r) => r.code && r.name),
    };
  } else if (kind === "catalog") {
    requireProv("catalog.csv");
    payload = {
      source: { name: sourceName, url: sourceUrl, note: "official import" },
      catalog: rows.map((r) => ({
        generic_name: pick(r, ["generic_name", "通用名", "药品名称"]),
        category: pick(r, ["category", "甲乙类", "类别"]) || "未知",
        payment_restriction: pick(r, ["payment_restriction", "限定支付范围"]) || null,
        spec: pick(r, ["spec", "规格"]) || null,
        dosage_form: pick(r, ["dosage_form", "剂型"]) || null,
        source_version: pick(r, ["source_version", "版本"]) || version,
        effective_date: pick(r, ["effective_date", "生效日期"]) || effective,
        data_class: "official",
      })).filter((r) => r.generic_name),
    };
  } else if (kind === "labels") {
    requireProv("labels.csv");
    payload = {
      source: { name: sourceName, url: sourceUrl, note: "official import" },
      records: rows.map((r) => {
        const sections = {};
        for (const k of ["适应症", "用法用量", "禁忌", "药物相互作用", "注意事项", "成分", "特殊人群用药"]) {
          if (r[k]) sections[k] = r[k];
        }
        return {
          generic_name: pick(r, ["generic_name", "通用名"]),
          approval_number: pick(r, ["approval_number", "批准文号"]),
          brand_name: pick(r, ["brand_name", "商品名"]) || null,
          classification: pick(r, ["classification"]) || "unknown",
          pharm_class: pick(r, ["pharm_class"]) || null,
          sections,
          source_version: pick(r, ["source_version", "版本"]) || version,
          effective_date: pick(r, ["effective_date", "生效日期"]) || effective,
          data_class: "official",
        };
      }).filter((r) => r.generic_name && r.approval_number),
    };
  } else if (kind === "trials") {
    requireProv("trials.csv");
    payload = {
      source: { name: sourceName, url: sourceUrl, note: "official import" },
      records: rows.map((r) => ({
        ctr: pick(r, ["ctr", "登记号"]),
        title: pick(r, ["title", "试验名称"]),
        drug_generic: pick(r, ["drug_generic", "药品"]),
        indication: pick(r, ["indication", "适应症"]),
        phase: pick(r, ["phase", "分期"]),
        status: pick(r, ["status", "状态"]),
        sponsor: pick(r, ["sponsor", "申办者"]),
        source_version: pick(r, ["source_version"]) || version,
        effective_date: pick(r, ["effective_date"]) || effective,
        data_class: "official",
      })).filter((r) => r.ctr && r.title),
    };
  } else {
    process.stderr.write(`unknown --kind ${kind}\n`);
    process.exit(2);
  }
}

const ingest = {
  codes: join(PLUGIN, "servers/china-codes/scripts/ingest.mjs"),
  catalog: join(PLUGIN, "servers/china-codes/scripts/ingest.mjs"),
  labels: join(PLUGIN, "servers/drug-labels/scripts/ingest.mjs"),
  trials: join(PLUGIN, "servers/china-trials/scripts/ingest.mjs"),
}[kind];
if (!ingest) {
  process.stderr.write(`unknown --kind ${kind}\n`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "medcius-import-"));
const tmpJson = join(dir, `${kind}.json`);
writeFileSync(tmpJson, JSON.stringify(payload, null, 2), "utf8");
const r = spawnSync("node", [ingest, tmpJson], { encoding: "utf8" });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
