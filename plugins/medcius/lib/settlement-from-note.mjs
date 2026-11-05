/**
 * Weld extract → NHSA coding → 结算清单栏 + 六字段出处 + 清单机检 + 病案要素质量核对.
 * 【次级独立意图 (Secondary Intended Use)】本模块与查房前临床演变摘要隔离，属于医保结算清单核对试验管线。
 * Not a DRG/DIP grouper.
 */
import { parseCnNote, parseDemographics, parseLabs } from "./parse-cn-note.mjs";
import { buildRecordQualityReport } from "./nhsa-record-quality-engine.mjs";

function terms(f) {
  if (!f?.value) return [];
  return String(f.value).split(/[；;]/).map((s) => s.trim()).filter(Boolean);
}

function six(hit, fallbackStatus, official) {
  if (!hit) {
    return {
      code: null,
      code_system: "unknown",
      code_version: "unknown",
      effective_date: "unknown",
      retrieved_at: new Date().toISOString(),
      source: "local china-codes",
      validation_status: "unverifiable",
    };
  }
  const status = !official ? "unverifiable" : hit.validation_status;
  return {
    code: hit.code,
    code_system: hit.code_system,
    code_version: hit.code_version ?? "unknown",
    effective_date: hit.effective_date ?? "unknown",
    retrieved_at: hit.retrieved_at ?? new Date().toISOString(),
    source: hit.source ?? "local china-codes",
    validation_status: status,
    name: hit.name,
    data_class: hit.data_class,
    is_main_diag_allowed: hit.is_main_diag_allowed,
    full_length: hit.full_length,
  };
}

function resolveTerm(CC, term, kind, official, codeSystem, codeVersion, asOf, packId, region) {
  const found = CC.search_codes({
    query: term,
    code_type: kind,
    code_system: codeSystem,
    ...(packId ? { pack_id: packId, region } : {}),
    ...(codeVersion ? { code_version: codeVersion } : {}),
    ...(asOf ? { as_of: asOf } : {}),
    match_mode: "exact_name",
    include_samples: !official,
    limit: 5,
  });
  const candidates = (found.hits ?? []).filter(h => h.name === term && h.code_system === codeSystem && (!codeVersion || h.code_version === codeVersion));
  const hit = candidates.length === 1 && found.total_matches === 1 ? candidates[0] : null;
  const v = hit ? CC.validate_code({ code: hit.code, code_system: hit.code_system, ...(packId ? { pack_id: packId, region } : {}), ...(codeVersion ? { code_version: codeVersion } : {}), ...(asOf ? { as_of: asOf } : {}) }) : null;
  const merged = hit ? { ...hit, validation_status: v?.validation_status ?? hit.validation_status, reasons: v?.reasons } : null;
  return { term, kind, hit: merged, provenance: six(merged, "unverifiable", official), resolution_status: hit ? "exact_unique" : found.total_matches > 1 || candidates.length > 1 ? "ambiguous" : candidates.length ? "uniqueness_unverified" : "no_exact_match", candidate_count: found.total_matches ?? candidates.length, coverage_note: found.coverage_note };
}

/**
 * @param {string} text
 * @param {{ HANDLERS: Record<string, Function> }} CC
 */
export function settlementFromNote(text, CC, { diagnosisSystem = "医保版ICD-10", procedureSystem = "医保版手术操作分类",
  diagnosisVersion, procedureVersion, asOf, evidenceReview, crosswalk, codePackId, region } = {}) {
  const extracted = parseCnNote(text);
  const demo = parseDemographics(text);
  const labs = parseLabs(text);
  const st = CC.corpus_status();
  const official = codePackId ? CC.crosswalk_status?.().packs.some(p => p.pack_id === codePackId && p.data_class === 'official') === true : (st.counts?.codes?.official ?? 0) > 0;

  const jobs = [
    ...terms(extracted.discharge_diagnosis_primary).map((t) => ({ term: t, kind: "diagnosis", role: "discharge_primary" })),
    ...terms(extracted.discharge_diagnosis_other).map((t) => ({ term: t, kind: "diagnosis", role: "discharge_other" })),
    ...terms(extracted.admission_diagnosis).map((t) => ({ term: t, kind: "diagnosis", role: "admission" })),
    ...terms(extracted.procedures).map((t) => ({ term: t, kind: "procedure", role: "procedure" })),
  ];

  const items = jobs.map((j) => ({ ...j, ...resolveTerm(CC, j.term, j.kind, official, j.kind === "diagnosis" ? diagnosisSystem : procedureSystem,
    j.kind === 'diagnosis' ? diagnosisVersion : procedureVersion, asOf, codePackId, region) }));
  const mappings = crosswalk ? jobs.map(j => ({ term: j.term, role: j.role,
    review: typeof CC.query_code_mappings === 'function' ? CC.query_code_mappings({ ...crosswalk,
      from: { system: crosswalk.from?.system, version: crosswalk.from?.version, term: j.term }, as_of: asOf }) : { status: 'unverifiable', reason: 'CROSSWALK_TOOL_UNAVAILABLE' } })) : [];
  const listCheck = CC.check_settlement_list
    ? CC.check_settlement_list({
        sex: demo.sex,
        age: demo.age,
        items: items.map((i) => ({
          term: i.term,
          role: i.role,
          kind: i.kind,
          code: i.provenance.code,
          code_system: i.provenance.code_system,
          code_version: i.provenance.code_version,
          is_main_diag_allowed: i.hit?.is_main_diag_allowed,
        })),
      })
    : { checks: [], note: "check_settlement_list 不可用" };

  const list = {
    入院诊断: items.filter((i) => i.role === "admission"),
    出院主诊断: items.filter((i) => i.role === "discharge_primary"),
    出院其他诊断: items.filter((i) => i.role === "discharge_other"),
    手术及操作: items.filter((i) => i.role === "procedure"),
  };

  const record_quality = buildRecordQualityReport(text, {
    evidence_review: evidenceReview,
    diagnosis_codes: items
      .filter((i) => i.kind === "diagnosis" && i.provenance.code)
      .map((i) => ({ code: i.provenance.code, code_system: i.provenance.code_system, kind: "diagnosis" })),
  });

  return {
    note_type: extracted.note_type,
    demographics: demo,
    labs,
    extracted,
    production_ready: false,
    corpus_available: official,
    deployment_acceptance: "NOT_ESTABLISHED",
    halt: official ? null : "official 编码库为空：清单可出栏，validation_status 不得为 valid",
    settlement_list: list,
    list_check: listCheck,
    record_quality,
    mappings,
    grouping: {
      implemented: false,
      note: "本插件不做 DRG/DIP 分组器。分组以医院当期分组器与费率表为准。",
    },
    disclaimer: "抽取≠诊断；编码须人复核。合成权重不是结算依据。",
  };
}
