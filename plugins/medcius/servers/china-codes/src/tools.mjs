import { db, DATA } from "./db.mjs";
import { checkSettlementList, searchProvincialBenefit, checkCatalogRestriction } from "./list-check.mjs";
import { buildRecordQualityReport } from "../../../lib/nhsa-record-quality-engine.mjs";
import { queryCodeMappings, checkCodePair, validDate, searchVersionedCodes } from '../../../lib/terminology-crosswalk.mjs';
import { loadCrosswalk, crosswalkInventory } from './crosswalk-store.mjs';

function latestHash(codeId) {
  const r = db.prepare("SELECT snapshot_hash FROM code_snapshots WHERE code_id=? ORDER BY captured_at DESC, id DESC LIMIT 1").get(codeId);
  return r?.snapshot_hash ?? null;
}
function srcLine(sourceId) {
  const s = db.prepare("SELECT name, url FROM sources WHERE id=?").get(sourceId);
  return { source_name: s?.name ?? null, source_url: s?.url ?? null };
}
function toHit(row) {
  const src = srcLine(row.source_id);
  return {
    code: row.code,
    code_system: row.code_system,
    code_version: row.code_version ?? "unknown",
    effective_date: row.effective_date ?? "unknown",
    retrieved_at: row.ingested_at,
    source: src.source_name ?? "local china-codes",
    source_url: src.source_url,
    validation_status: row.data_class !== "official" || !row.code_version || /^(unknown|sample)$/i.test(row.code_version) || !row.effective_date || !Number.isFinite(Date.parse(row.effective_date)) ? "unverifiable" : (row.full_length ? "valid" : "pending"),
    name: row.name,
    category: row.category,
    code_type: row.code_type,
    full_length: !!row.full_length,
    is_main_diag_allowed: !!row.is_main_diag_allowed,
    data_class: row.data_class,
    snapshot_hash: latestHash(row.id),
    disclaimer: row.disclaimer ?? null,
  };
}

function resolveCode(code, codeSystem, codeVersion, asOf) {
  if (asOf != null && !validDate(asOf)) return { row: null, reason: 'invalid_as_of' };
  const rows = (codeSystem
    ? db.prepare("SELECT * FROM nhsa_codes WHERE code=? AND code_system=?").all(code, codeSystem)
    : db.prepare("SELECT * FROM nhsa_codes WHERE code=?").all(code))
    .filter(r => (!codeVersion || r.code_version === codeVersion) && (!asOf || validDate(r.effective_date) && r.effective_date <= asOf));
  return { row: rows.length === 1 ? rows[0] : null, reason: rows.length > 1 ? "ambiguous_code_system" : "not_in_requested_corpus" };
}

/** @type {Record<string, (a: Record<string, unknown>) => unknown>} */
export const HANDLERS = {
  crosswalk_status() { return { packs: crosswalkInventory(), production_ready: false }; },
  query_code_mappings(a) {
    const pack = loadCrosswalk(a.pack_id);
    return pack ? queryCodeMappings(pack, a) : { status: 'unverifiable', reason: 'PACK_NOT_INSTALLED', candidates: [] };
  },
  check_code_pair(a) {
    const pack = loadCrosswalk(a.pack_id);
    return pack ? checkCodePair(pack, a) : { status: 'unverifiable', reason: 'PACK_NOT_INSTALLED', valid_for_settlement: null };
  },
  search_codes({ query, code_type, code_system, code_version, as_of, region, pack_id, match_mode = 'substring', include_samples, limit }) {
    if (pack_id) {
      const pack = loadCrosswalk(pack_id);
      return pack ? searchVersionedCodes(pack, { query, code_type, code_system, code_version, as_of, region, include_samples, limit })
        : { hits: [], total_matches: 0, status: 'unverifiable', reason: 'PACK_NOT_INSTALLED' };
    }
    if (!['substring', 'exact_name'].includes(match_mode)) throw new Error('CODE_MATCH_MODE_INVALID');
    if (as_of != null && !validDate(as_of)) throw new Error('CODE_DATE_INVALID');
    const lim = Math.max(1, Math.min(50, Number(limit ?? 10)));
    const allow = Boolean(include_samples);
    const like = `%${query}%`;
    const sc = allow ? "" : "AND data_class!='sample'";
    const typeClause = code_type ? "AND code_type=?" : "";
    const systemClause = code_system ? "AND code_system=?" : "";
    const where = `${match_mode === 'exact_name' ? 'name=?' : '(code LIKE ? OR name LIKE ? OR category LIKE ?)'} ${sc} ${typeClause} ${systemClause} ${code_version ? 'AND code_version=?' : ''} ${as_of ? 'AND effective_date<=? AND effective_date IS NOT NULL' : ''}`;
    const params = [...(match_mode === 'exact_name' ? [query] : [like, like, like]), ...(code_type ? [code_type] : []), ...(code_system ? [code_system] : []), ...(code_version ? [code_version] : []), ...(as_of ? [as_of] : [])];
    const totalMatches = db.prepare(`SELECT count(*) n FROM nhsa_codes WHERE ${where}`).get(...params).n;
    const rows = db.prepare(`SELECT * FROM nhsa_codes WHERE ${where} ORDER BY length(code) ASC, id ASC LIMIT ?`).all(...params, lim);
    const hits = rows.map(toHit);
    const official = db.prepare("SELECT count(*) n FROM nhsa_codes WHERE data_class='official'").get().n;
    const sample = db.prepare("SELECT count(*) n FROM nhsa_codes WHERE data_class='sample'").get().n;
    return { query: String(query), code_type: code_type ?? null, match_mode, hits, hit_count: hits.length, total_matches: totalMatches, truncated: totalMatches > hits.length, corpus: { official, sample, include_samples: allow }, coverage_note: "本地编码库覆盖有限；未命中不代表该编码不存在，以国家医保局发布为准。样例仅用于管线验证。" };
  },
  get_code({ code, code_system, code_version, as_of, pack_id, region }) {
    if (pack_id) {
      const pack = loadCrosswalk(pack_id);
      const result = pack && searchVersionedCodes(pack, { code, code_system, code_version, as_of, region, include_samples: true });
      return result?.total_matches === 1 ? result.hits[0] : { code, validation_status: 'unverifiable', reason: result?.reason ?? 'CODE_NOT_IN_PACK' };
    }
    const { row, reason } = resolveCode(code, code_system, code_version, as_of);
    if (!row) return { error: reason, code, code_system: code_system ?? "unknown", validation_status: "unverifiable" };
    return toHit(row);
  },
  validate_code({ code, code_system, code_version, as_of, pack_id, region }) {
    if (pack_id) return HANDLERS.get_code({ code, code_system, code_version, as_of, pack_id, region });
    const { row, reason } = resolveCode(code, code_system, code_version, as_of);
    if (!row) return { code, code_system: code_system ?? "unknown", validation_status: "unverifiable", reasons: [reason], coverage: "not_in_requested_corpus" };
    const hit = toHit(row);
    const reasons = [];
    if (row.data_class !== "official") reasons.push("sample_only: not official coding evidence");
    if (!row.code_version || !row.effective_date) reasons.push("code_version/effective_date 缺失 → validation_status 不得为 valid");
    if (!row.full_length) reasons.push("非完整可结算长度（裸类目）→ pending");
    if (!row.is_main_diag_allowed) reasons.push("不可作为主要诊断");
    return { code: hit.code, code_system: hit.code_system, code_version: hit.code_version, effective_date: hit.effective_date, retrieved_at: hit.retrieved_at, source: hit.source, validation_status: hit.validation_status, reasons, detail: hit };
  },
  search_drug_catalog({ query, include_samples, limit }) {
    const lim = Math.max(1, Math.min(50, Number(limit ?? 10)));
    const allow = Boolean(include_samples);
    const like = `%${query}%`;
    const sc = allow ? "" : "AND data_class!='sample'";
    const rows = db.prepare(`SELECT * FROM nhsa_drug_catalog WHERE generic_name LIKE ? ${sc} ORDER BY length(generic_name) ASC LIMIT ?`).all(like, lim);
    const hits = rows.map((r) => {
      const src = db.prepare("SELECT name, url FROM sources WHERE id=?").get(r.source_id);
      return { generic_name: r.generic_name, category: r.category, payment_restriction: r.payment_restriction ?? null, spec: r.spec ?? null, dosage_form: r.dosage_form ?? null, code_system: "医保药品目录", code_version: r.source_version ?? "unknown", effective_date: r.effective_date ?? "unknown", retrieved_at: r.ingested_at, source: src?.name ?? "local china-codes", data_class: r.data_class, disclaimer: r.disclaimer ?? null };
    });
    const official = db.prepare("SELECT count(*) n FROM nhsa_drug_catalog WHERE data_class='official'").get().n;
    const sample = db.prepare("SELECT count(*) n FROM nhsa_drug_catalog WHERE data_class='sample'").get().n;
    return { query: String(query), hits, hit_count: hits.length, corpus: { official, sample, include_samples: allow }, coverage_note: "本地目录库覆盖有限；未命中不代表不在国家目录，以国家医保局发布为准。" };
  },
  get_drug_catalog({ generic_name }) {
    const r = db.prepare("SELECT * FROM nhsa_drug_catalog WHERE generic_name=?").get(generic_name);
    if (!r) return { error: "not in catalog corpus", generic_name, hint: "Use search_drug_catalog or ingest catalog pack." };
    const src = db.prepare("SELECT name, url FROM sources WHERE id=?").get(r.source_id);
    return { generic_name: r.generic_name, category: r.category, payment_restriction: r.payment_restriction ?? null, spec: r.spec ?? null, dosage_form: r.dosage_form ?? null, code_system: "医保药品目录", code_version: r.source_version ?? "unknown", effective_date: r.effective_date ?? "unknown", retrieved_at: r.ingested_at, source: src?.name ?? "local china-codes", data_class: r.data_class, disclaimer: r.disclaimer ?? null };
  },
  corpus_status() {
    const codeOff = db.prepare("SELECT count(*) n FROM nhsa_codes WHERE data_class='official'").get().n;
    const codeSmp = db.prepare("SELECT count(*) n FROM nhsa_codes WHERE data_class='sample'").get().n;
    const catOff = db.prepare("SELECT count(*) n FROM nhsa_drug_catalog WHERE data_class='official'").get().n;
    const catSmp = db.prepare("SELECT count(*) n FROM nhsa_drug_catalog WHERE data_class='sample'").get().n;
    const sources = db.prepare("SELECT id, name, url, note, ingested_at FROM sources ORDER BY id ASC").all();
    const total = codeOff + codeSmp + catOff + catSmp;
    const benOff = (() => { try { return db.prepare("SELECT count(*) n FROM provincial_benefits WHERE data_class='official'").get().n; } catch { return 0; } })();
    return { counts: { codes: { official: codeOff, sample: codeSmp, total: codeOff + codeSmp }, catalog: { official: catOff, sample: catSmp, total: catOff + catSmp }, benefits: { official: benOff }, grand_total: total }, production_ready: false, corpus_available: codeOff > 0, deployment_acceptance: "NOT_ESTABLISHED", sources, db_path: `${DATA}/data.sqlite`, note: total === 0 ? "空库。请先 ingest --sample 或导入官方包。" : (codeOff === 0 ? "仅样例，禁止真实结算。见 packs/README.md" : "就绪") };
  },
  check_settlement_list(a) {
    return checkSettlementList(a);
  },
  search_provincial_benefit(a) {
    return searchProvincialBenefit(a);
  },
  check_record_quality(a) {
    if (typeof a?.note_text !== "string" || !a.note_text.trim()) {
      return { error: "note_text required (non-empty string)" };
    }
    return buildRecordQualityReport(a.note_text);
  },
  check_catalog_restriction(a) {
    return checkCatalogRestriction(a);
  },
};
