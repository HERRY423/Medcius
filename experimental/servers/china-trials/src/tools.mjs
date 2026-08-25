import { db, DATA } from "./db.mjs";

export const CTR_RE = /^CTR20\d{2}\d{4,}$/;

export function validateCtrFormat(raw) {
  const s = String(raw ?? "").replace(/\s+/g, "").toUpperCase();
  if (!s) return { ok: false, reason: "空登记号", exists: false };
  if (CTR_RE.test(s)) return { ok: true, ctr: s, reason: "CTR+4位年+序号", exists: false, note: "仅格式，不证明平台在册" };
  return { ok: false, ctr: s, reason: "格式应为 CTR + 年份 + 至少4位序号，如 CTR20251234", exists: false };
}

function toHit(row) {
  let sites = [];
  try { sites = JSON.parse(row.sites_json || "[]"); } catch { sites = []; }
  return {
    ctr: row.ctr,
    title: row.title,
    drug_generic: row.drug_generic,
    indication: row.indication,
    phase: row.phase,
    status: row.status,
    sponsor: row.sponsor,
    pi: row.pi,
    sites,
    design: row.design,
    sample_size: row.sample_size,
    primary_endpoint: row.primary_endpoint,
    data_class: row.data_class,
    source_version: row.source_version,
    effective_date: row.effective_date,
    disclaimer: row.disclaimer,
  };
}

export const HANDLERS = {
  search_trials({ query, include_samples, limit }) {
    const lim = Math.max(1, Math.min(50, Number(limit ?? 10)));
    const allow = Boolean(include_samples);
    const like = `%${query}%`;
    const sc = allow ? "" : "AND data_class!='sample'";
    const rows = db
      .prepare(
        `SELECT * FROM clinical_trials
         WHERE (ctr LIKE ? OR title LIKE ? OR drug_generic LIKE ? OR indication LIKE ? OR sponsor LIKE ?)
           ${sc}
         ORDER BY id ASC LIMIT ?`,
      )
      .all(like, like, like, like, like, lim);
    const official = db.prepare("SELECT count(*) n FROM clinical_trials WHERE data_class='official'").get().n;
    const sample = db.prepare("SELECT count(*) n FROM clinical_trials WHERE data_class='sample'").get().n;
    return {
      query: String(query),
      hits: rows.map(toHit),
      hit_count: rows.length,
      corpus: { official, sample, include_samples: allow },
      coverage_note: "本地登记库覆盖有限；未命中不代表全国无此试验。样例禁止用于正式查询结论。",
    };
  },
  get_trial({ ctr }) {
    const fmt = validateCtrFormat(ctr);
    if (!fmt.ok) return { error: "invalid_ctr_format", ...fmt };
    const row = db.prepare("SELECT * FROM clinical_trials WHERE ctr=?").get(fmt.ctr);
    if (!row) {
      return {
        error: "not_in_corpus",
        ctr: fmt.ctr,
        hint: "本地未收录。打开 chinadrugtrials.org.cn 检索；无法打开则停止，不得编造方案/终点/中心。",
      };
    }
    return toHit(row);
  },
  validate_ctr_format({ ctr }) {
    return validateCtrFormat(ctr);
  },
  corpus_status() {
    const official = db.prepare("SELECT count(*) n FROM clinical_trials WHERE data_class='official'").get().n;
    const sample = db.prepare("SELECT count(*) n FROM clinical_trials WHERE data_class='sample'").get().n;
    const sources = db.prepare("SELECT id,name,url,note,ingested_at FROM sources ORDER BY id").all();
    return {
      counts: { official, sample, total: official + sample },
      production_ready: official > 0,
      sources,
      db_path: `${DATA}/data.sqlite`,
      note: official + sample === 0 ? "空库。ingest --sample 或导入登记摘录。" : sample > 0 && official === 0 ? "仅样例，禁止当作平台全库" : "就绪",
    };
  },
};
