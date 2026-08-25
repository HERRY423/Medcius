#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db, tx, DATA, DB_PATH } from "../src/db.mjs";
import { validateCtrFormat } from "../src/tools.mjs";

const arg = process.argv[2];
let payload;
if (!arg || arg === "--sample") {
  payload = JSON.parse(readFileSync(new URL("../assets/sample-trials.json", import.meta.url), "utf8"));
} else if (arg === "-h" || arg === "--help") {
  console.error("usage: node scripts/ingest.mjs <trials.json> | --sample");
  process.exit(0);
} else payload = JSON.parse(readFileSync(resolve(arg), "utf8"));

const source = payload.source ?? { name: "unknown" };
const records = payload.records ?? payload.trials ?? [];
const r = tx(() => {
  const sid = Number(db.prepare("INSERT INTO sources (name,url,note) VALUES (?,?,?)").run(source.name, source.url ?? null, source.note ?? null).lastInsertRowid);
  let inserted = 0, updated = 0;
  for (const t of records) {
    const fmt = validateCtrFormat(t.ctr);
    if (!fmt.ok) throw new Error(`invalid CTR ${t.ctr}: ${fmt.reason}`);
    const dclass = t.data_class === "sample" ? "sample" : "official";
    if (dclass === "official" && (!t.source_version || !t.effective_date))
      throw new Error(`${fmt.ctr}: official 须有 source_version 与 effective_date`);
    const sites = JSON.stringify(t.sites ?? []);
    const ex = db.prepare("SELECT id FROM clinical_trials WHERE ctr=?").get(fmt.ctr);
    const vals = [t.title, t.drug_generic ?? null, t.indication ?? null, t.phase ?? null, t.status ?? null, t.sponsor ?? null, t.pi ?? null, sites, t.design ?? null, t.sample_size ?? null, t.primary_endpoint ?? null, dclass, sid, t.source_version ?? null, t.effective_date ?? null, t.disclaimer ?? null];
    if (!ex) {
      db.prepare("INSERT INTO clinical_trials (ctr,title,drug_generic,indication,phase,status,sponsor,pi,sites_json,design,sample_size,primary_endpoint,data_class,source_id,source_version,effective_date,disclaimer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(fmt.ctr, ...vals);
      inserted++;
    } else {
      db.prepare("UPDATE clinical_trials SET title=?,drug_generic=?,indication=?,phase=?,status=?,sponsor=?,pi=?,sites_json=?,design=?,sample_size=?,primary_endpoint=?,data_class=?,source_id=?,source_version=?,effective_date=?,disclaimer=? WHERE id=?")
        .run(...vals, ex.id);
      updated++;
    }
  }
  return { inserted, updated };
});
const official = db.prepare("SELECT count(*) n FROM clinical_trials WHERE data_class='official'").get().n;
const sample = db.prepare("SELECT count(*) n FROM clinical_trials WHERE data_class='sample'").get().n;
process.stdout.write(`${JSON.stringify({ ...r, corpus: { official, sample }, db_path: DB_PATH, data_dir: DATA }, null, 2)}\n`);
