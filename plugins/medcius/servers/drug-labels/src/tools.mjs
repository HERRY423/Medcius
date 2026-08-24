// Handlers for mcp-server-drug-labels.
// Every handler is honest about coverage limits; no "no interaction" is ever asserted.

import { db, tx, snapshotHash, interactionSection, normName, DATA } from "./db.mjs";
import { cockcroftGault, ckdEpi2021, bmi, bsaMosteller, doseByWeight, doseByBsa, renalBucket } from "./calculators.mjs";
import { complementaryHits, validateApprovalFormat } from "./mechanisms.mjs";
import { SAFETY_HANDLERS } from "./safety-handlers.mjs";
import { SIGNAL_SEVERITY } from "./safety-tables.mjs";

// ---------------------------------------------------------------------------
// Small helpers — pure, testable
// ---------------------------------------------------------------------------

function parseSections(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Resolve a drug query to a single label row (or null).
 * Resolution order: exact approval_number -> LIKE generic -> LIKE brand.
 * Sample exclusion respects allowSample.
 * @param {string} q
 * @param {boolean} allowSample
 * @returns {Record<string, unknown> | null}
 */
function resolveOne(q, allowSample) {
  const like = `%${q}%`;
  const sampleClause = allowSample ? "" : "AND data_class != 'sample'";
  // exact approval match first
  let row = db
    .prepare(
      `SELECT * FROM drug_labels WHERE approval_number = ? ${sampleClause} LIMIT 1`,
    )
    .get(q);
  if (row) return row;
  row = db
    .prepare(
      `SELECT * FROM drug_labels WHERE generic_name LIKE ? ${sampleClause} ORDER BY length(generic_name) ASC LIMIT 1`,
    )
    .get(like);
  if (row) return row;
  row = db
    .prepare(
      `SELECT * FROM drug_labels WHERE brand_name LIKE ? ${sampleClause} LIMIT 1`,
    )
    .get(like);
  return row ?? null;
}

function sourceLine(row) {
  if (!row) return null;
  const s = db.prepare("SELECT name, url FROM sources WHERE id = ?").get(row.source_id);
  return { source_name: s?.name ?? null, source_url: s?.url ?? null };
}

function latestSnapshotHash(labelId) {
  const r = db
    .prepare("SELECT snapshot_hash FROM label_snapshots WHERE label_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1")
    .get(labelId);
  return r?.snapshot_hash ?? null;
}

function labelToHit(row) {
  const sections = parseSections(row.sections_json);
  const keys = Object.keys(sections);
  const src = sourceLine(row);
  return {
    label_id: row.id,
    generic_name: row.generic_name,
    brand_name: row.brand_name ?? null,
    approval_number: row.approval_number,
    manufacturer: row.manufacturer ?? null,
    dosage_form: row.dosage_form ?? null,
    spec: row.spec ?? null,
    classification: row.classification,
    data_class: row.data_class,
    section_keys: keys,
    source_name: src?.source_name ?? null,
    source_version: row.source_version ?? null,
    effective_date: row.effective_date ?? null,
    ingested_at: row.ingested_at,
    snapshot_hash: latestSnapshotHash(row.id),
    disclaimer: row.disclaimer ?? null,
  };
}

function labelToFull(row, sectionFilter) {
  const sections = parseSections(row.sections_json);
  const src = sourceLine(row);
  const picked =
    sectionFilter != null
      ? { [sectionFilter]: sections[sectionFilter] ?? null }
      : sections;
  return {
    label_id: row.id,
    generic_name: row.generic_name,
    brand_name: row.brand_name ?? null,
    approval_number: row.approval_number,
    manufacturer: row.manufacturer ?? null,
    dosage_form: row.dosage_form ?? null,
    spec: row.spec ?? null,
    classification: row.classification,
    data_class: row.data_class,
    sections: picked,
    source_name: src?.source_name ?? null,
    source_url: src?.source_url ?? null,
    source_version: row.source_version ?? null,
    effective_date: row.effective_date ?? null,
    ingested_at: row.ingested_at,
    retrieved_at: row.ingested_at, // alias for nhsa-coding-style provenance
    source: src?.source_name ?? "local drug-labels corpus",
    snapshot_hash: latestSnapshotHash(row.id),
    disclaimer: row.disclaimer ?? null,
  };
}

function excerptAround(text, needle, radius = 60) {
  const idx = text.indexOf(needle);
  if (idx < 0) return null;
  const lo = Math.max(0, idx - radius), hi = Math.min(text.length, idx + needle.length + radius);
  return text.slice(lo, hi).replace(/\s+/g, " ").trim();
}
function sectionsText(sections, keys) {
  // Collect concatenated text for matching; keys containing any of the keywords
  const out = [];
  for (const [k, v] of Object.entries(sections)) {
    if (typeof v !== "string" || !v.trim()) continue;
    if (keys.some((kw) => k.includes(kw))) out.push({ key: k, text: v });
  }
  return out;
}
function allergyHitForDrug(row, allergyTerms) {
  const sections = parseSections(row.sections_json);
  const pools = sectionsText(sections, ["禁忌", "过敏", "成分", "注意事项"]);
  const hits = [];
  for (const term of allergyTerms) {
    const q = String(term).trim(); if (!q) continue;
    for (const { key, text } of pools) {
      if (text.includes(q)) {
        const ex = excerptAround(text, q);
        if (ex) hits.push({ term: q, section: key, excerpt: ex });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** @type {Record<string, (a: Record<string, unknown>) => unknown>} */
export const HANDLERS = {
  search_labels({ query, include_samples, limit }) {
    const lim = Math.max(1, Math.min(50, Number(limit ?? 10)));
    const allowSample = Boolean(include_samples);
    const like = `%${query}%`;
    const sampleClause = allowSample ? "" : "AND data_class != 'sample'";
    const rows = db
      .prepare(
        `SELECT * FROM drug_labels
         WHERE (generic_name LIKE ? OR brand_name LIKE ? OR approval_number LIKE ?)
           ${sampleClause}
         ORDER BY
           CASE WHEN approval_number = ? THEN 0 ELSE 1 END,
           length(generic_name) ASC, id ASC
         LIMIT ?`,
      )
      .all(like, like, like, String(query), lim);
    const hits = rows.map(labelToHit);
    const totalOfficial = db.prepare("SELECT count(*) AS n FROM drug_labels WHERE data_class='official'").get().n;
    const totalSample = db.prepare("SELECT count(*) AS n FROM drug_labels WHERE data_class='sample'").get().n;
    return {
      query: String(query),
      hits,
      hit_count: hits.length,
      corpus: { official: totalOfficial, sample: totalSample, include_samples: allowSample },
      coverage_note:
        "本地语料库覆盖有限；命中数与未命中均不代表全国目录状态，最终以官方来源为准。样例数据（data_class=sample）仅用于管线验证。",
    };
  },

  get_label({ label_id, approval_number, section }) {
    let row = null;
    if (Number.isInteger(label_id) && label_id >= 1) {
      row = db.prepare("SELECT * FROM drug_labels WHERE id = ?").get(label_id) ?? null;
    }
    if (!row && typeof approval_number === "string" && approval_number.trim()) {
      row = db.prepare("SELECT * FROM drug_labels WHERE approval_number = ?").get(approval_number) ?? null;
    }
    if (!row) {
      return {
        error: "label not found",
        hint: "Use search_labels to discover available approval_number values, or ingest the label first.",
      };
    }
    return labelToFull(row, section ? String(section) : null);
  },

  check_interactions({ drugs, include_samples }) {
    const allowSample = Boolean(include_samples);
    const names = drugs.map((s) => String(s).trim()).filter(Boolean);
    const resolved = names.map((q) => ({ query: q, row: resolveOne(q, allowSample) }));
    const unresolved = resolved.filter((r) => !r.row).map((r) => r.query);

    const totalOfficial = db.prepare("SELECT count(*) AS n FROM drug_labels WHERE data_class='official'").get().n;
    const totalSample = db.prepare("SELECT count(*) AS n FROM drug_labels WHERE data_class='sample'").get().n;

    // Build unordered pairs of resolved rows
    const pairs = [];
    for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        const a = resolved[i];
        const b = resolved[j];
        if (!a.row || !b.row) {
          pairs.push({
            drug_a: a.query,
            drug_b: b.query,
            status: "insufficient_data",
            explanation:
              "至少一方在本地语料库中无对应标签，无法判定相互作用。本维度应标 REQUIRES_PHARMACIST_REVIEW 或 INSUFFICIENT_DATA，不得输出“未发现相互作用”。",
            a_label: a.row ? { label_id: a.row.id, approval_number: a.row.approval_number, generic_name: a.row.generic_name, data_class: a.row.data_class } : null,
            b_label: b.row ? { label_id: b.row.id, approval_number: b.row.approval_number, generic_name: b.row.generic_name, data_class: b.row.data_class } : null,
          });
          continue;
        }
        // Look up interaction_mentions in both directions
        const hitsAB = db
          .prepare(
            "SELECT excerpt, section_name FROM interaction_mentions WHERE label_id = ? AND other_label_id = ?",
          )
          .all(a.row.id, b.row.id);
        const hitsBA = db
          .prepare(
            "SELECT excerpt, section_name FROM interaction_mentions WHERE label_id = ? AND other_label_id = ?",
          )
          .all(b.row.id, a.row.id);
        const allHits = [
          ...hitsAB.map((h) => ({ direction: `${a.row.generic_name}->${b.row.generic_name}`, ...h })),
          ...hitsBA.map((h) => ({ direction: `${b.row.generic_name}->${a.row.generic_name}`, ...h })),
        ];
        const aSections = parseSections(a.row.sections_json);
        const bSections = parseSections(b.row.sections_json);
        const sigA = db.prepare("SELECT signal, excerpt FROM label_signals WHERE label_id = ?").all(a.row.id);
        const sigB = db.prepare("SELECT signal, excerpt FROM label_signals WHERE label_id = ?").all(b.row.id);
        const classHits = complementaryHits(sigA, sigB);
        const aLabel = { label_id: a.row.id, approval_number: a.row.approval_number, generic_name: a.row.generic_name, data_class: a.row.data_class };
        const bLabel = { label_id: b.row.id, approval_number: b.row.approval_number, generic_name: b.row.generic_name, data_class: b.row.data_class };
        if (allHits.length) {
          pairs.push({
            drug_a: a.query,
            drug_b: b.query,
            status: "mention_found",
            a_label: aLabel,
            b_label: bLabel,
            mentions: allHits,
            excerpts: allHits.map((h) => h.excerpt),
            class_signals: classHits,
            raw_a_interaction_section: interactionSection(aSections) || null,
            raw_b_interaction_section: interactionSection(bSections) || null,
            severity: SIGNAL_SEVERITY.mention_found,
            note: "本地命中仅说明“在各自说明书相互作用章节中出现了对方药名”；严重程度与处置需以说明书原文为准，并由药师判定。",
          });
        } else if (classHits.length) {
          pairs.push({
            drug_a: a.query,
            drug_b: b.query,
            status: "class_signal_found",
            a_label: aLabel,
            b_label: bLabel,
            class_signals: classHits,
            a_signals: sigA,
            b_signals: sigB,
            raw_a_interaction_section: interactionSection(aSections) || null,
            raw_b_interaction_section: interactionSection(bSections) || null,
            severity: classHits.some((h) => h.kind === "cyp_complement") ? SIGNAL_SEVERITY.cyp_complement : SIGNAL_SEVERITY.class_token,
            explanation:
              "双方药名未互相出现，但检出 CYP 底物/抑制剂互补或药理分类标记（如 CYP3A4 抑制剂 × 他汀底物）。这不是药名命中，也不能等同 PASS 级 DDI 库。应 FLAG 或 REQUIRES_PHARMACIST_REVIEW，不得写成无相互作用。",
          });
        } else {
          pairs.push({
            drug_a: a.query,
            drug_b: b.query,
            status: "no_mention_in_corpus",
            a_label: aLabel,
            b_label: bLabel,
            a_signals: sigA,
            b_signals: sigB,
            explanation:
              "双方标签均在库，药名未互现，亦无本地 CYP/分类互补信号。这是“语料库内未提及”，不是“无相互作用”。本维度不得输出“未发现相互作用”，应标 no_mention_in_corpus 并建议药师复核。",
            raw_a_interaction_section: interactionSection(aSections) || null,
            raw_b_interaction_section: interactionSection(bSections) || null,
          });
        }
      }
    }

    return {
      drugs_queried: names,
      resolved: resolved.map((r) =>
        r.row
          ? { query: r.query, label_id: r.row.id, approval_number: r.row.approval_number, generic_name: r.row.generic_name, data_class: r.row.data_class }
          : { query: r.query, label_id: null, status: "not_in_corpus" },
      ),
      unresolved_queries: unresolved,
      pairs,
      corpus: { official: totalOfficial, sample: totalSample, include_samples: allowSample },
      coverage_disclaimer:
        "本地语料库覆盖有限；no_mention_in_corpus ≠ 无相互作用；insufficient_data 时 G3 不得断言“无相互作用”，应转 REQUIRES_PHARMACIST_REVIEW/INSUFFICIENT_DATA。样例数据仅用于测试。",
    };
  },

  list_snapshots({ approval_number }) {
    const row = db.prepare("SELECT id FROM drug_labels WHERE approval_number = ?").get(approval_number);
    if (!row) return { error: "label not found", approval_number };
    const snaps = db
      .prepare(
        "SELECT id, snapshot_hash, source_version, captured_at FROM label_snapshots WHERE label_id = ? ORDER BY captured_at DESC, id DESC",
      )
      .all(row.id);
    const label = db.prepare("SELECT source_version, effective_date, ingested_at FROM drug_labels WHERE id = ?").get(row.id);
    return {
      approval_number,
      current: label,
      snapshots: snaps,
      snapshot_count: snaps.length,
    };
  },

  corpus_status() {
    const official = db.prepare("SELECT count(*) AS n FROM drug_labels WHERE data_class='official'").get().n;
    const sample = db.prepare("SELECT count(*) AS n FROM drug_labels WHERE data_class='sample'").get().n;
    const total = official + sample;
    const sources = db.prepare("SELECT id, name, url, note, ingested_at FROM sources ORDER BY id ASC").all();
    const byClass = db
      .prepare("SELECT data_class, count(*) AS n FROM drug_labels GROUP BY data_class")
      .all();
    const mentionCount = db.prepare("SELECT count(*) AS n FROM interaction_mentions").get().n;
    return {
      counts: { total, official, sample, by_class: byClass },
      production_ready: official > 0,
      interaction_mentions: mentionCount,
      sources,
      db_path: `${DATA}/data.sqlite`,
      note:
        total === 0
          ? "语料库为空。请先用 ingest 脚本导入标签（见 servers/drug-labels/README.md）。"
          : sample > 0 && official === 0
            ? "当前仅有样例数据（data_class=sample），禁止用于真实审核。导入官方数据后方可用于 G2/G3。"
            : "语料库就绪。核对相互作用时仍需遵守“未查不得断言无相互作用”的门控。",
    };
  },

  check_allergy({ allergies, drugs, include_samples }) {
    const allow = Boolean(include_samples);
    const allergyTerms = allergies.map((s) => String(s).trim()).filter(Boolean);
    const perDrug = [];
    let anyHit = false;
    for (const q of drugs.map((s) => String(s).trim()).filter(Boolean)) {
      const row = resolveOne(q, allow);
      if (!row) { perDrug.push({ query: q, status: "insufficient_data", reason: "not_in_corpus" }); continue; }
      const hits = allergyHitForDrug(row, allergyTerms);
      if (hits.length) { anyHit = true; perDrug.push({ query: q, status: "hit", label: { label_id: row.id, generic_name: row.generic_name, data_class: row.data_class }, hits }); }
      else {
        const sections = parseSections(row.sections_json);
        const pools = sectionsText(sections, ["禁忌", "过敏", "成分"]);
        const hasAllergySection = pools.length > 0;
        perDrug.push({ query: q, status: hasAllergySection ? "no_mention_in_corpus" : "no_allergy_section_in_label", label: { label_id: row.id, generic_name: row.generic_name, data_class: row.data_class }, note: hasAllergySection ? "禁忌/过敏章节未提及所给过敏原" : "标签无禁忌/过敏章节，无法排除" });
      }
    }
    const official = db.prepare("SELECT count(*) n FROM drug_labels WHERE data_class='official'").get().n;
    const sample = db.prepare("SELECT count(*) n FROM drug_labels WHERE data_class='sample'").get().n;
    return { allergies: allergyTerms, per_drug: perDrug, corpus: { official, sample, include_samples: allow }, coverage_disclaimer: "no_mention_in_corpus ≠ 无过敏风险；insufficient_data/no_allergy_section 均需药师复核。" + (anyHit ? " 命中项应判 FLAG 或 REQUIRES_PHARMACIST_REVIEW。" : "") };
  },

  check_contraindication({ conditions, drugs, include_samples }) {
    const allow = Boolean(include_samples);
    const conds = conditions.map((s) => String(s).trim()).filter(Boolean);
    const perDrug = [];
    for (const q of drugs.map((s) => String(s).trim()).filter(Boolean)) {
      const row = resolveOne(q, allow);
      if (!row) { perDrug.push({ query: q, status: "insufficient_data", reason: "not_in_corpus" }); continue; }
      const sections = parseSections(row.sections_json);
      const pools = sectionsText(sections, ["禁忌", "注意事项", "警告"]);
      const hits = [];
      for (const term of conds) {
        for (const { key, text } of pools) if (text.includes(term)) { const ex = excerptAround(text, term); if (ex) hits.push({ term, section: key, excerpt: ex }); }
      }
      perDrug.push(hits.length
        ? { query: q, status: "hit", label: { label_id: row.id, generic_name: row.generic_name, data_class: row.data_class }, hits }
        : { query: q, status: pools.length ? "no_mention_in_corpus" : "no_contra_section", label: { label_id: row.id, generic_name: row.generic_name, data_class: row.data_class } });
    }
    return { conditions: conds, per_drug: perDrug, coverage_disclaimer: "no_mention ≠ 无禁忌；需以标签原文为准，必要时药师复核。" };
  },

  check_renal_dosing({ drugs, crcl, egfr, include_samples }) {
    const allow = Boolean(include_samples);
    const hasCrCl = typeof crcl === "number" && isFinite(crcl);
    const hasEgfr = typeof egfr === "number" && isFinite(egfr);
    const val = hasCrCl ? crcl : (hasEgfr ? egfr : null);
    const bucket = val != null ? renalBucket(val) : null;
    const perDrug = [];
    for (const q of drugs.map((s) => String(s).trim()).filter(Boolean)) {
      const row = resolveOne(q, allow);
      if (!row) { perDrug.push({ query: q, status: "insufficient_data", reason: "not_in_corpus" }); continue; }
      const sections = parseSections(row.sections_json);
      const pools = sectionsText(sections, ["肾", "特殊人群", "老年", "用法用量"]);
      const renalSignals = ["肾功能", "肌酐", "透析", "肾损害", "肾衰", "CrCl", "eGFR"];
      const hits = [];
      for (const { key, text } of pools) {
        if (renalSignals.some((sig) => text.includes(sig))) {
          // capture first renal-related line
          const line = text.split(/[。；;]/).find((l) => renalSignals.some((s) => l.includes(s)));
          if (line) hits.push({ section: key, excerpt: line.trim().slice(0, 180) });
        }
      }
      perDrug.push({ query: q, status: hits.length ? "renal_mentioned" : (pools.length ? "no_mention_in_corpus" : "no_renal_section"), label: { label_id: row.id, generic_name: row.generic_name, data_class: row.data_class }, renal_excerpts: hits, crcl_bucket: bucket });
    }
    return { renal: hasCrCl ? { crcl, bucket } : (hasEgfr ? { egfr, bucket } : { bucket: null, note: "未提供 crcl/egfr，无法分桶；建议先 calc_renal" }), per_drug: perDrug, coverage_disclaimer: "是否需调整剂量以标签“肾功能不全/老年”章节原文为准；无提及≠无需调整。" };
  },

  check_special_population({ population, drugs, include_samples }) {
    const allow = Boolean(include_samples);
    const sigMap = {
      pregnancy: ["妊娠", "孕妇", "胎儿", "致畸", "妊娠期"],
      lactation: ["哺乳", "乳汁", "母乳"],
      children: ["儿童", "小儿", "婴幼儿", "未成年人"],
      elderly: ["老年", "老年人", "高龄"],
      hepatic: ["肝功能", "肝损害", "肝衰", "肝病", "转氨酶"],
    };
    const signals = sigMap[population] ?? [];
    const perDrug = [];
    for (const q of drugs.map((s) => String(s).trim()).filter(Boolean)) {
      const row = resolveOne(q, allow);
      if (!row) { perDrug.push({ query: q, status: "insufficient_data", reason: "not_in_corpus" }); continue; }
      const sections = parseSections(row.sections_json);
      const pools = sectionsText(sections, signals.length ? signals : ["特殊人群", "注意事项", "禁忌"]);
      const hits = [];
      for (const { key, text } of pools) {
        for (const sig of signals) if (text.includes(sig)) { const ex = excerptAround(text, sig); if (ex) hits.push({ signal: sig, section: key, excerpt: ex }); }
      }
      // also scan all sections as fallback
      if (!hits.length) {
        for (const [k, v] of Object.entries(sections)) if (typeof v === "string") for (const sig of signals) if (v.includes(sig)) { const ex = excerptAround(v, sig); if (ex) hits.push({ signal: sig, section: k, excerpt: ex }); }
      }
      perDrug.push(hits.length
        ? { query: q, status: "hit", label: { label_id: row.id, generic_name: row.generic_name, data_class: row.data_class }, population, signals: hits }
        : { query: q, status: "no_mention_in_corpus", label: { label_id: row.id, generic_name: row.generic_name, data_class: row.data_class }, population });
    }
    return { population, per_drug: perDrug, coverage_disclaimer: "未提及≠安全；特殊人群用药以标签原文及指南为准。" };
  },

  check_duplicate_therapy({ drugs, include_samples }) {
    const allow = Boolean(include_samples);
    const resolved = drugs.map((s) => String(s).trim()).filter(Boolean).map((q) => ({ query: q, row: resolveOne(q, allow) }));
    const pairs = [];
    const norm = (s) => String(s).replace(/\s+/g, "").toLowerCase();
    // generic exact duplicate + substring containment (same ingredient)
    for (let i = 0; i < resolved.length; i++) for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i], b = resolved[j];
      if (!a.row || !b.row) { pairs.push({ drug_a: a.query, drug_b: b.query, status: "insufficient_data", reason: "not_in_corpus" }); continue; }
      const ga = norm(a.row.generic_name), gb = norm(b.row.generic_name);
      if (ga === gb) pairs.push({ drug_a: a.query, drug_b: b.query, status: "duplicate_generic", generic: a.row.generic_name, note: "通用名完全相同，重复用药。" });
      else if (ga.includes(gb) || gb.includes(ga) || norm(a.row.brand_name ?? "").includes(gb) || norm(b.row.brand_name ?? "").includes(ga)) {
        pairs.push({ drug_a: a.query, drug_b: b.query, status: "possible_duplicate", reason: "名称包含关系，疑似同成分/同类，需核对成分表", a_generic: a.row.generic_name, b_generic: b.row.generic_name });
      } else {
        pairs.push({ drug_a: a.query, drug_b: b.query, status: "no_duplicate_detected", a_generic: a.row.generic_name, b_generic: b.row.generic_name, note: "仅基于通用名/商品名字面比对，未做成分表深度比对；同类作用需药师结合药理判断。" });
      }
    }
    return { drugs_queried: drugs, resolved: resolved.map((r) => r.row ? { query: r.query, generic_name: r.row.generic_name } : { query: r.query, status: "not_in_corpus" }), pairs, coverage_disclaimer: "no_duplicate_detected 仅为字面比对结果；同类作用（同靶点/同适应症）需药师综合判断。" };
  },

  calc_renal({ age, weightKg, heightCm, scrMgDl, scrUmolL, scr, scrUnit, sex, calc }) {
    const mode = calc ?? (typeof weightKg === "number" ? "both" : "egfr");
    const scrArgs = { scrUmolL, scrMgDl, scr, scrUnit };
    const out = {};
    if (mode === "crcl" || mode === "both") {
      if (typeof weightKg !== "number") throw new Error("calc_renal crcl/both 需要 weightKg");
      out.crcl = cockcroftGault({ age, weightKg, sex, ...scrArgs });
      out.renal_bucket = renalBucket(out.crcl.crcl);
    }
    if (mode === "egfr" || mode === "both") out.egfr = ckdEpi2021({ age, sex, ...scrArgs });
    if (mode === "both" && typeof heightCm === "number" && typeof weightKg === "number") { out.bmi = bmi({ weightKg, heightCm }); out.bsa = bsaMosteller({ weightKg, heightCm }); }
    out.unit_note = "中国检验单肌酐默认 μmol/L（scrUmolL）。禁止把 88 当作 88 mg/dL。";
    return out;
  },

  validate_approval_format({ approval_number }) {
    return validateApprovalFormat(approval_number);
  },

  calc_dose({ weightKg, heightCm, dosePerKg, dosePerM2, bsa, calc }) {
    switch (calc) {
      case "bmi": return bmi({ weightKg, heightCm });
      case "bsa": return bsaMosteller({ weightKg, heightCm });
      case "dose_weight": return doseByWeight({ weightKg, dosePerKg });
      case "dose_bsa": {
        const b = typeof bsa === "number" ? b : bsaMosteller({ weightKg, heightCm }).bsa;
        return doseByBsa({ bsa: b, dosePerM2 });
      }
      default: throw new Error("calc must be bmi|bsa|dose_weight|dose_bsa");
    }
  },
  ...SAFETY_HANDLERS,
};
