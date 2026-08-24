#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db, tx, DATA, DB_PATH, snapshotHash } from "../src/db.mjs";
const arg = process.argv[2];
let payload;
if (!arg || arg === "--sample" || arg === "--allow-sample") {
  payload = JSON.parse(readFileSync(new URL("../assets/sample-codes.json", import.meta.url), "utf8"));
} else if (arg === "--help" || arg === "-h") { console.error("usage: node scripts/ingest.mjs <json> | --sample"); process.exit(0); }
else { payload = JSON.parse(readFileSync(resolve(arg), "utf8")); }
const source = payload.source ?? { name: arg ? `import:${arg}` : "unknown" };
const codes = payload.codes ?? payload.nhsa_codes ?? [];
const catalog = payload.catalog ?? payload.drug_catalog ?? [];
const benefits = payload.benefits ?? payload.provincial_benefits ?? [];
const genderRules = payload.gender_rules ?? [];
const procHints = payload.procedure_dx_hints ?? payload.proc_dx ?? [];
const r = tx(() => {
  const s = db.prepare("INSERT INTO sources (name,url,note) VALUES (?,?,?)").run(source.name ?? "unknown", source.url ?? null, source.note ?? null);
  const sid = Number(s.lastInsertRowid);
  let ci=0, cu=0, cs=0, di=0, du=0;
  for (const c of codes) {
    const code = String(c.code ?? "").trim(); if (!code) continue;
    const csys = String(c.code_system ?? "").trim() || "医保版ICD-10";
    const name = String(c.name ?? "").trim() || code;
    const ctype = c.code_type === "procedure" ? "procedure" : "diagnosis";
    const full = c.full_length ? 1 : 0; const mainOk = c.is_main_diag_allowed === 0 ? 0 : 1;
    const dclass = c.data_class === "sample" ? "sample" : "official";
    const ver = c.code_version != null ? String(c.code_version) : null;
    const eff = c.effective_date != null ? String(c.effective_date) : null;
    const cat = c.category != null ? String(c.category) : null;
    const dis = c.disclaimer != null ? String(c.disclaimer) : null;
    const ex = db.prepare("SELECT id, code_version, effective_date FROM nhsa_codes WHERE code=? AND code_system=?").get(code, csys);
    const hash = snapshotHash({ code, csys, name, ver, eff, ctype });
    if (!ex) {
      const ins = db.prepare("INSERT INTO nhsa_codes (code,code_system,name,category,code_type,full_length,is_main_diag_allowed,data_class,source_id,code_version,effective_date,disclaimer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(code, csys, name, cat, ctype, full, mainOk, dclass, sid, ver, eff, dis);
      db.prepare("INSERT INTO code_snapshots (code_id,snapshot_hash,code_version) VALUES (?,?,?)").run(Number(ins.lastInsertRowid), hash, ver); ci++; cs++;
    } else {
      const prev = db.prepare("SELECT snapshot_hash FROM code_snapshots WHERE code_id=? ORDER BY captured_at DESC, id DESC LIMIT 1").get(ex.id);
      if (prev?.snapshot_hash !== hash) {
        db.prepare("UPDATE nhsa_codes SET name=?,category=?,code_type=?,full_length=?,is_main_diag_allowed=?,data_class=?,source_id=?,code_version=?,effective_date=?,disclaimer=? WHERE id=?")
          .run(name, cat, ctype, full, mainOk, dclass, sid, ver, eff, dis, ex.id);
        db.prepare("INSERT INTO code_snapshots (code_id,snapshot_hash,code_version) VALUES (?,?,?)").run(ex.id, hash, ver); cu++; cs++;
      }
    }
  }
  for (const d of catalog) {
    const g = String(d.generic_name ?? "").trim(); if (!g) continue;
    const cat = ["甲类","乙类","谈判"].includes(d.category) ? d.category : "未知";
    const pr = d.payment_restriction != null ? String(d.payment_restriction) : null;
    const spec = d.spec != null ? String(d.spec) : null;
    const form = d.dosage_form != null ? String(d.dosage_form) : null;
    const dclass = d.data_class === "sample" ? "sample" : "official";
    const ver = d.source_version != null ? String(d.source_version) : null;
    const eff = d.effective_date != null ? String(d.effective_date) : null;
    const dis = d.disclaimer != null ? String(d.disclaimer) : null;
    const ex = db.prepare("SELECT id FROM nhsa_drug_catalog WHERE generic_name=?").get(g);
    if (!ex) { db.prepare("INSERT INTO nhsa_drug_catalog (generic_name,category,payment_restriction,spec,dosage_form,data_class,source_id,source_version,effective_date,disclaimer) VALUES (?,?,?,?,?,?,?,?,?,?)").run(g,cat,pr,spec,form,dclass,sid,ver,eff,dis); di++; }
    else { db.prepare("UPDATE nhsa_drug_catalog SET category=?,payment_restriction=?,spec=?,dosage_form=?,data_class=?,source_id=?,source_version=?,effective_date=?,disclaimer=? WHERE id=?").run(cat,pr,spec,form,dclass,sid,ver,eff,dis,ex.id); du++; }
  }
  let bi = 0;
  for (const b of benefits) {
    const prov = String(b.province ?? "").trim(); if (!prov) continue;
    db.prepare("INSERT INTO provincial_benefits (province,insurance_type,encounter,deductible,reimburse_pct,chronic_outpatient,data_class,source_id,source_version,effective_date,disclaimer) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(prov, b.insurance_type ?? "职工", b.encounter ?? "住院", b.deductible ?? null, b.reimburse_pct ?? null, b.chronic_outpatient ?? null, b.data_class === "official" ? "official" : "sample", sid, b.source_version ?? null, b.effective_date ?? null, b.disclaimer ?? "省级待遇摘录");
    bi++;
  }
  for (const g of genderRules) {
    const code = String(g.code ?? "").trim(); if (!code) continue;
    db.prepare("INSERT OR REPLACE INTO gender_code_rules (code,sex_required,note) VALUES (?,?,?)").run(code, g.sex_required, g.note ?? null);
  }
  for (const h of procHints) {
    if (!h.procedure_substr || !h.dx_substr) continue;
    db.prepare("INSERT INTO procedure_dx_hints (procedure_substr,dx_substr) VALUES (?,?)").run(h.procedure_substr, h.dx_substr);
  }
  return { codes_inserted: ci, codes_updated: cu, snapshots: cs, catalog_inserted: di, catalog_updated: du, benefits_inserted: bi };
});
const offC = db.prepare("SELECT count(*) n FROM nhsa_codes WHERE data_class='official'").get().n;
const smpC = db.prepare("SELECT count(*) n FROM nhsa_codes WHERE data_class='sample'").get().n;
const offD = db.prepare("SELECT count(*) n FROM nhsa_drug_catalog WHERE data_class='official'").get().n;
const smpD = db.prepare("SELECT count(*) n FROM nhsa_drug_catalog WHERE data_class='sample'").get().n;
console.log(JSON.stringify({ source: source.name, ...r, corpus: { codes: { official: offC, sample: smpC, total: offC+smpC }, catalog: { official: offD, sample: smpD, total: offD+smpD } }, db_path: DB_PATH, data_dir: DATA }, null, 2));
