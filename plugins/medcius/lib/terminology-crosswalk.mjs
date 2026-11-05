// Data-only, release-pinned crosswalks. A relation is not permission to code.
import { canonicalJson, sha256Hex } from '../servers/shared/crypto.mjs';

export const CROSSWALK_SCHEMA = 'medcius.terminology-crosswalk.v1';
export const terminologyDigest = value => sha256Hex(canonicalJson(value));
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 512;
export const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const fail = () => { throw new Error('CROSSWALK_INVALID_PACK'); };
const tuple = n => canonicalJson([n.system, n.version, n.code]);
const validRegion = r => typeof r === 'string' && /^CN(?:-\d{2}(?:\d{2})?)?$/.test(r);
const containsRegion = (parent, child) => validRegion(child) && (parent === 'CN' || parent === child || parent.length === 5 && child.startsWith(parent));

export function validateCrosswalk(pack) {
  if (pack?.schema_version !== CROSSWALK_SCHEMA || !text(pack.pack_id)
      || !['sample', 'official'].includes(pack.data_class) || !/^CN(?:-\d{2}(?:\d{2})?)?$/.test(pack.region)
      || !validDate(pack.effective_from) || !validDate(pack.effective_until) || pack.effective_from > pack.effective_until
      || !text(pack.source?.name) || !text(pack.source?.version) || !text(pack.source?.url)
      || !/^[a-f0-9]{64}$/.test(pack.source?.sha256) || !validDate(pack.source?.retrieved_on)
      || !Array.isArray(pack.nodes) || !pack.nodes.length || pack.nodes.length > 100000
      || !Array.isArray(pack.edges) || pack.edges.length > 200000) fail();
  const ids = new Map(), tuples = new Set(), edges = new Set(), parent = new Map();
  const root = id => {
    let top = id; while (parent.get(top) !== top) top = parent.get(top);
    while (id !== top) { const next = parent.get(id); parent.set(id, top); id = next; }
    return top;
  };
  for (const n of pack.nodes) {
    if (![n.id, n.system, n.version, n.code, n.name].every(text)
        || !['diagnosis', 'procedure', 'clinical_term'].includes(n.kind)
        || ids.has(n.id) || tuples.has(tuple(n))) fail();
    if (pack.data_class === 'official' && /^(unknown|unconfigured|unverifiable)$/i.test(n.version)) fail();
    ids.set(n.id, n); tuples.add(tuple(n)); parent.set(n.id, n.id);
  }
  for (const e of pack.edges) {
    if (!text(e.id) || edges.has(e.id) || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to
        || !['equivalent', 'broader', 'narrower', 'related'].includes(e.relation)
        || typeof e.bidirectional !== 'boolean' || !text(e.source_locator)
        || !Array.isArray(e.qualifiers) || !e.qualifiers.every(text)) fail();
    const a = ids.get(e.from), b = ids.get(e.to);
    if (a.kind !== 'clinical_term' && b.kind !== 'clinical_term' && a.kind !== b.kind) fail();
    parent.set(root(e.from), root(e.to));
    edges.add(e.id);
  }
  const componentKinds = new Map();
  for (const n of pack.nodes.filter(n => n.kind !== 'clinical_term')) {
    const key = root(n.id), prior = componentKinds.get(key);
    if (prior && prior !== n.kind) fail(); // a free-text term cannot bridge diagnoses to procedures
    componentKinds.set(key, n.kind);
  }
  // Approval binds the exact payload; it is a local attestation, not source authentication.
  return pack;
}

export function queryCodeMappings(pack, { from, target, region, as_of } = {}) {
  validateCrosswalk(pack);
  const base = { pack_id: pack.pack_id, pack_digest: terminologyDigest(pack), data_class: pack.data_class,
    source: pack.source, region: region ?? null, as_of: as_of ?? null, candidates: [],
    production_ready: false, automatic_code_selection: false };
  const unknown = reason => ({ ...base, status: 'unverifiable', reason });
  if (!text(from?.system) || !text(from?.version) || !text(from?.code ?? from?.term)
      || !text(target?.system) || !text(target?.version) || !validDate(as_of) || !text(region)) return unknown('EXPLICIT_RELEASE_REGION_DATE_REQUIRED');
  if (!containsRegion(pack.region, region)
      || as_of < pack.effective_from || as_of > pack.effective_until) return unknown('OUTSIDE_PACK_SCOPE');
  const starts = pack.nodes.filter(n => n.system === from.system && n.version === from.version
    && (from.code != null ? n.code === from.code && (from.term == null || n.name === from.term) : n.name === from.term));
  if (starts.length !== 1) return unknown(starts.length ? 'AMBIGUOUS_SOURCE_TERM' : 'SOURCE_NOT_IN_PACK');
  const byId = new Map(pack.nodes.map(n => [n.id, n]));
  const adjacent = new Map(pack.nodes.map(n => [n.id, []]));
  for (const edge of pack.edges) {
    adjacent.get(edge.from).push({ edge, to: edge.to, direction: 'forward', relation: edge.relation });
    if (edge.bidirectional) adjacent.get(edge.to).push({ edge, to: edge.from, direction: 'reverse',
      relation: ({ broader: 'narrower', narrower: 'broader' })[edge.relation] ?? edge.relation });
  }
  const candidates = [], queue = [{ id: starts[0].id, path: [], seen: new Set([starts[0].id]) }];
  // Bound expansion: fail closed instead of returning a misleading truncated singleton.
  let steps = 0;
  while (queue.length) {
    if (++steps > 10000) return unknown('CROSSWALK_EXPANSION_LIMIT');
    const item = queue.shift(), n = byId.get(item.id);
    if (item.path.length && n.system === target.system && n.version === target.version) {
      candidates.push({ node: n, path: item.path }); continue;
    }
    if (item.path.length >= 3) continue;
    for (const link of adjacent.get(item.id)) {
      if (item.seen.has(link.to)) continue;
      // Non-equivalence is visible for a direct pair but cannot propagate through a chain.
      if (item.path.some(e => e.relation !== 'equivalent' || e.qualifiers.length)) continue;
      const next = byId.get(link.to);
      if (item.path.length && (link.relation !== 'equivalent' || link.edge.qualifiers.length)
          && !(next.system === target.system && next.version === target.version)) continue;
      queue.push({ id: link.to, seen: new Set([...item.seen, link.to]), path: [...item.path,
        { edge_id: link.edge.id, from: item.id, to: link.to, direction: link.direction,
          relation: link.relation, qualifiers: link.edge.qualifiers, source_locator: link.edge.source_locator }] });
    }
  }
  const uniqueTargets = new Set(candidates.map(c => c.node.id));
  const equivalent = candidates.length > 0 && candidates.every(c => c.path.every(e => e.relation === 'equivalent' && !e.qualifiers.length));
  const status = uniqueTargets.size > 1 ? 'ambiguous' : uniqueTargets.size === 0 ? 'not_mapped' : equivalent ? 'equivalent_mapping' : 'review_required';
  return { ...base, status, candidates, candidate_count: uniqueTargets.size,
    validation_status: pack.data_class === 'sample' ? 'unverifiable' : 'mapping_recorded',
    note: '映射关系不等于可结算编码；样例、条件、非等价关系及一对多关系均不得自动选码。' };
}

export function checkCodePair(pack, { left, right, region, as_of } = {}) {
  const forward = queryCodeMappings(pack, { from: left, target: right, region, as_of });
  const reverse = queryCodeMappings(pack, { from: right, target: left, region, as_of });
  const has = (result, code) => result.candidates.some(c => c.node.code === code);
  const mutual = forward.status === 'equivalent_mapping' && reverse.status === 'equivalent_mapping'
    && has(forward, right?.code) && has(reverse, left?.code);
  return { status: mutual ? 'bidirectional_equivalent_mapping' : 'review_required', forward, reverse,
    valid_for_settlement: null, automatic_code_selection: false };
}

export function searchVersionedCodes(pack, { query, code, code_system, code_version, code_type, region, as_of, include_samples = false, limit = 10 } = {}) {
  validateCrosswalk(pack);
  const unknown = reason => ({ hits: [], total_matches: 0, status: 'unverifiable', reason });
  if (![code_system, code_version, region].every(text) || !validDate(as_of) || !text(code ?? query)) return unknown('EXPLICIT_RELEASE_REGION_DATE_REQUIRED');
  if (!containsRegion(pack.region, region)
      || as_of < pack.effective_from || as_of > pack.effective_until) return unknown('OUTSIDE_PACK_SCOPE');
  if (pack.data_class === 'sample' && !include_samples) return unknown('SAMPLE_EXCLUDED');
  const rows = pack.nodes.filter(n => n.kind !== 'clinical_term' && n.system === code_system && n.version === code_version
    && (!code_type || n.kind === code_type) && (code != null ? n.code === code : n.name === query));
  const lim = Number.isInteger(limit) ? Math.min(50, Math.max(1, limit)) : 10;
  return { status: 'release_scoped', pack_id: pack.pack_id, pack_digest: terminologyDigest(pack), total_matches: rows.length,
    hits: rows.slice(0, lim).map(n => ({ code: n.code, code_system: n.system, code_version: n.version, name: n.name,
      code_type: n.kind, full_length: n.full_length ?? null, is_main_diag_allowed: n.is_main_diag_allowed ?? null,
      validation_status: pack.data_class !== 'official' || typeof n.full_length !== 'boolean' ? 'unverifiable' : n.full_length ? 'valid' : 'pending',
      data_class: pack.data_class, source: pack.source.name, source_url: pack.source.url, snapshot_hash: pack.source.sha256,
      effective_date: pack.effective_from, effective_until: pack.effective_until, retrieved_at: pack.source.retrieved_on })),
    truncated: rows.length > lim, coverage_note: '只核对所选包、版本、地域与日期；未命中不表示不存在。' };
}
