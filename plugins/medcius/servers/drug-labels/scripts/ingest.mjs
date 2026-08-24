#!/usr/bin/env node
// Ingest drug-label JSON into the local corpus.
// Usage:
//   node scripts/ingest.mjs <labels.json>
//   node scripts/ingest.mjs --sample                 # load bundled synthetic sample
//   node scripts/ingest.mjs --sample --allow-sample  # alias; sample is always data_class=sample
//
// Input contract (<labels.json>):
//   { source: { name, url?, note? }, records: [ { generic_name, brand_name?, approval_number, manufacturer?, dosage_form?, spec?, classification: rx|otc|unknown, sections: { "适应症": "...", "药物相互作用": "..." }, source_version?, effective_date?, disclaimer?, data_class? }, ... ] }
// Or use the bundled assets/sample-labels.json shape directly.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { db, tx, DATA, DB_PATH, snapshotHash, interactionSection } from "../src/db.mjs";
import { extractSignals } from "../src/mechanisms.mjs";

function usage(msg) {
  if (msg) process.stderr.write(`${msg}\n`);
  process.stderr.write("usage: node scripts/ingest.mjs <labels.json> | --sample\n");
  process.exit(msg ? 2 : 0);
}

function normalizeRecord(r, idx) {
  if (!r || typeof r !== "object") throw new Error(`records[${idx}]: not an object`);
  const generic = String(r.generic_name ?? r.genericName ?? "").trim();
  const approval = String(r.approval_number ?? r.approvalNumber ?? "").trim();
  if (!generic) throw new Error(`records[${idx}]: missing generic_name`);
  if (!approval) throw new Error(`records[${idx}]: missing approval_number`);
  const sections = r.sections ?? r.sections_json ?? r.label_json;
  if (!sections || typeof sections !== "object" || Array.isArray(sections))
    throw new Error(`records[${idx}] (${approval}): sections must be an object`);
  const classification = ["rx", "otc", "unknown"].includes(r.classification) ? r.classification : "unknown";
  const dataClass = r.data_class === "sample" ? "sample" : "official";
  const sourceVersion = r.source_version != null ? String(r.source_version).trim() || null : null;
  const effectiveDate = r.effective_date != null ? String(r.effective_date).trim() || null : null;
  if (dataClass === "official" && (!sourceVersion || !effectiveDate)) {
    throw new Error(`records[${idx}] (${approval}): official 记录必须有 source_version 与 effective_date`);
  }
  let pharmClass = r.pharm_class ?? r.pharmClass ?? null;
  if (Array.isArray(pharmClass)) pharmClass = pharmClass.map(String);
  return {
    generic_name: generic,
    brand_name: r.brand_name != null ? String(r.brand_name).trim() || null : null,
    approval_number: approval,
    manufacturer: r.manufacturer != null ? String(r.manufacturer).trim() || null : null,
    dosage_form: r.dosage_form != null ? String(r.dosage_form).trim() || null : null,
    spec: r.spec != null ? String(r.spec).trim() || null : null,
    classification,
    sections,
    data_class: dataClass,
    source_version: sourceVersion,
    effective_date: effectiveDate,
    disclaimer: r.disclaimer != null ? String(r.disclaimer).trim() || null : null,
    pharm_class: pharmClass,
  };
}

function extractInteractionMentions(labelId, sections, allLabels) {
  const text = interactionSection(sections);
  if (!text) return [];
  const hits = [];
  for (const other of allLabels) {
    if (other.id === labelId) continue;
    const needles = [other.generic_name, other.brand_name].filter(Boolean);
    for (const needle of needles) {
      const q = needle.replace(/\s+/g, "").trim();
      if (q.length < 2) continue;
      if (text.includes(q) || text.includes(needle)) {
        // capture a 120-char window around the first hit
        const idx = text.includes(q) ? text.indexOf(q) : text.indexOf(needle);
        const lo = Math.max(0, idx - 60);
        const hi = Math.min(text.length, idx + needle.length + 60);
        const excerpt = text.slice(lo, hi).replace(/\s+/g, " ").trim();
        hits.push({ label_id: labelId, other_label_id: other.id, excerpt, needle });
        break; // one hit per other label is enough
      }
    }
  }
  return hits;
}

const arg = process.argv[2];
let inputPath = null;
let useSample = false;
if (!arg) usage("missing argument");
if (arg === "--sample" || arg === "--allow-sample") useSample = true;
else inputPath = resolve(arg);
if (arg === "--help" || arg === "-h") usage();

let payload;
if (useSample) {
  payload = JSON.parse(readFileSync(new URL("../assets/sample-labels.json", import.meta.url), "utf8"));
} else {
  payload = JSON.parse(readFileSync(inputPath, "utf8"));
}

// Support both { source, records } and legacy array form
let source = payload.source ?? null;
let records = payload.records ?? payload;
if (!Array.isArray(records)) {
  if (Array.isArray(payload)) records = payload;
  else usage("input JSON must have { source, records } or be an array of records");
}
if (!source) source = { name: inputPath ? `import:${inputPath}` : "unknown", url: null, note: null };

const normalized = records.map(normalizeRecord);

// Insert source row first
const { inserted, updated, snapshots, mentions, signals } = tx(() => {
  const srcRes = db
    .prepare("INSERT INTO sources (name, url, note) VALUES (?, ?, ?)")
    .run(source.name ?? "unknown", source.url ?? null, source.note ?? source.ingested_note ?? null);
  const sourceId = Number(srcRes.lastInsertRowid);

  let inserted = 0;
  let updated = 0;
  let snapshots = 0;

  for (const r of normalized) {
    const sectionsJson = JSON.stringify(r.sections);
    const hash = snapshotHash(r.sections, r.generic_name, r.approval_number, r.source_version, r.effective_date);
    const existing = db.prepare("SELECT id, sections_json, source_version, effective_date FROM drug_labels WHERE approval_number = ?").get(r.approval_number);
    if (!existing) {
      const res = db
        .prepare(
          `INSERT INTO drug_labels
             (generic_name, brand_name, approval_number, manufacturer, dosage_form, spec, classification, sections_json, data_class, source_id, source_version, effective_date, disclaimer)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.generic_name,
          r.brand_name,
          r.approval_number,
          r.manufacturer,
          r.dosage_form,
          r.spec,
          r.classification,
          sectionsJson,
          r.data_class,
          sourceId,
          r.source_version,
          r.effective_date,
          r.disclaimer,
        );
      const labelId = Number(res.lastInsertRowid);
      db.prepare("INSERT INTO label_snapshots (label_id, snapshot_hash, source_version) VALUES (?, ?, ?)").run(
        labelId,
        hash,
        r.source_version,
      );
      inserted++;
      snapshots++;
    } else {
      const prevHashRow = db
        .prepare("SELECT snapshot_hash FROM label_snapshots WHERE label_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1")
        .get(existing.id);
      const sameContent =
        existing.sections_json === sectionsJson &&
        (existing.source_version ?? null) === (r.source_version ?? null) &&
        (existing.effective_date ?? null) === (r.effective_date ?? null);
      if (!sameContent || prevHashRow?.snapshot_hash !== hash) {
        db.prepare(
          `UPDATE drug_labels SET generic_name=?, brand_name=?, manufacturer=?, dosage_form=?, spec=?, classification=?, sections_json=?, data_class=?, source_id=?, source_version=?, effective_date=?, disclaimer=? WHERE id=?`,
        ).run(
          r.generic_name,
          r.brand_name,
          r.manufacturer,
          r.dosage_form,
          r.spec,
          r.classification,
          sectionsJson,
          r.data_class,
          sourceId,
          r.source_version,
          r.effective_date,
          r.disclaimer,
          existing.id,
        );
        db.prepare("INSERT INTO label_snapshots (label_id, snapshot_hash, source_version) VALUES (?, ?, ?)").run(
          existing.id,
          hash,
          r.source_version,
        );
        updated++;
        snapshots++;
      } else {
        // touch source for provenance even if unchanged? Keep existing to avoid churn.
      }
    }
  }

  // Rebuild interaction_mentions for the whole corpus (corpus is small; O(n^2) scan is fine and keeps cross-label mentions consistent)
  const allLabels = db
    .prepare("SELECT id, generic_name, brand_name, sections_json FROM drug_labels")
    .all()
    .map((l) => ({ ...l, sections: JSON.parse(l.sections_json) }));
  db.prepare("DELETE FROM interaction_mentions").run();
  db.prepare("DELETE FROM label_signals").run();
  let mentions = 0;
  let signals = 0;
  const classById = new Map(normalized.map((r) => [r.approval_number, r.pharm_class]));
  for (const label of allLabels) {
    const hits = extractInteractionMentions(label.id, label.sections, allLabels);
    for (const h of hits) {
      db.prepare(
        "INSERT OR IGNORE INTO interaction_mentions (label_id, other_label_id, excerpt, section_name) VALUES (?, ?, ?, '药物相互作用')",
      ).run(h.label_id, h.other_label_id, h.excerpt);
      mentions++;
    }
    const appr = db.prepare("SELECT approval_number FROM drug_labels WHERE id=?").get(label.id)?.approval_number;
    const declared = classById.get(appr) ?? null;
    for (const s of extractSignals(label.sections, label.generic_name, declared)) {
      db.prepare("INSERT OR IGNORE INTO label_signals (label_id, signal, excerpt) VALUES (?, ?, ?)").run(
        label.id,
        s.signal,
        s.excerpt,
      );
      signals++;
    }
  }

  return { inserted, updated, snapshots, mentions, signals };
});

const totalOfficial = db.prepare("SELECT count(*) AS n FROM drug_labels WHERE data_class='official'").get().n;
const totalSample = db.prepare("SELECT count(*) AS n FROM drug_labels WHERE data_class='sample'").get().n;

process.stdout.write(
  JSON.stringify(
    {
      source: source.name,
      inserted,
      updated,
      snapshots,
      interaction_mentions: mentions,
      label_signals: signals,
      corpus: { official: totalOfficial, sample: totalSample, total: totalOfficial + totalSample },
      db_path: DB_PATH,
      data_dir: DATA,
      note:
        totalOfficial === 0 && totalSample > 0
          ? "仅有样例数据；禁止用于真实审核。导入官方数据后 data_class=official 才会用于 G2/G3。"
          : undefined,
    },
    null,
    2,
  ) + "\n",
);
