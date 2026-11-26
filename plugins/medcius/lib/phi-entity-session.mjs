// Patient-scoped, memory-only deterministic entities. Never serialize names,
// their phonetic forms, or a reusable unsalted dictionary digest into receipts.
import { COMPOUND_SURNAMES } from './cn-surnames.mjs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { toModelSafe, assertExplicitFeedOwnership, mayContainStructuredJson } from './clinical-boundary.mjs';
import { isIntegrityMetadata } from '../servers/shared/integrity-metadata.mjs';

const require = createRequire(import.meta.url);
let pronunciations;
function phoneticTable() {
  if (!pronunciations) {
    try { pronunciations = require('../data/phi/cn-pronunciations.v1.json'); }
    catch { throw new Error('PHI_PHONETIC_TABLE_UNAVAILABLE'); }
  }
  return pronunciations;
}
const sessions = new WeakSet();
const TOKEN = /\[(?:ID:[A-Za-z0-9_-]+:(?:[a-f0-9]{32}|REDACTED)|PSN:[a-f0-9]{8,64}|REDACTED:[A-Za-z0-9_]+)\]/g;
const keyOf = key => key.replace(/[_\s-]/g, '').toLowerCase();
const NAME_KEYS = new Set(['name', 'patientname', 'fullname', 'doctorname', 'authorname', 'attendingname',
  'attendingdoctor', 'supervisingdoctor', 'consultingdoctor', 'physicianname', 'emergencycontactname',
  'contactname', '姓名', '患者姓名', '联系人姓名', '紧急联系人姓名', '主管医师', '经管医师', '上级医师', '会诊医师']);
const ALIAS_KEYS = new Set(['alias', 'aliases', 'namealiases', 'homophones', 'namevariants', 'homophonevariants', '曾用名', '别名', '同音字变体']);
const PERSON_CONTAINERS = new Set(['contact', 'contacts', 'emergencycontact', 'emergencycontacts', 'practitioner',
  'practitioners', 'attending', 'supervising', 'consulting', 'careteam', 'participant', 'participants',
  'individual', 'member', 'generalpractitioner', 'performer', 'author', '紧急联系人']);
const ADDRESS_KEYS = new Set(['address', 'currentaddress', 'homeaddress', 'street', '现住址', '住址', '家庭地址']);
const CLINICIAN_CONTAINERS = new Set(['practitioner','practitioners','attending','supervising','consulting','careteam',
  'participant','participants','individual','member','generalpractitioner','performer','author']);
const ORGANIZATION_KEYS = new Set(['organization','organizations','hospital','hospitalname','referringhospital',
  'serviceprovider','managingorganization','机构','医院','转出医院']);
const LOCATION_KEYS = new Set(['location','locations','wardname','院区','病区名称']);

const CLINICIAN_TITLES = ['主任','医生','医师','大夫','护士','护士长','老师','教授'];

export function phiNoteEntityMetadata(note) {
  if(!note||typeof note!=='object'||Array.isArray(note)) throw new Error('PHI_SESSION_ENTITIES_INVALID');
  return Object.fromEntries(Object.entries(note).filter(([key])=>{
    const k=keyOf(key);
    return ['tenantid','patientid','encounterid'].includes(k) || (k!=='name' && (NAME_KEYS.has(k)||ALIAS_KEYS.has(k)
      ||PERSON_CONTAINERS.has(k)||ADDRESS_KEYS.has(k)||ORGANIZATION_KEYS.has(k)||LOCATION_KEYS.has(k)));
  }));
}

function assertEntityOwnership(context, values, depth=0) {
  if(depth>16) throw new Error('PHI_SESSION_ENTITY_DEPTH');
  for(const value of values) {
    if(!value || typeof value!=='object') continue;
    try {assertExplicitFeedOwnership(context,[value],'phi_entities');}
    catch {throw new Error('PHI_SESSION_SOURCE_MISMATCH');}
    assertEntityOwnership(context,Object.values(value),depth+1);
  }
}

function names(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(names);
  if (!value || typeof value !== 'object') return [];
  const family = typeof value.family === 'string' ? value.family : '';
  const given = Array.isArray(value.given) ? value.given.join('') : (value.given ?? '');
  return [value.text, value.display, family + given].filter(x => typeof x === 'string' && x.trim());
}

function projected(text) {
  const chars = [], starts = [], ends = [];
  let at = 0;
  for (const cp of text) {
    for (const c of cp.normalize('NFKC').toLowerCase()) {
      if (/\s|\p{Cf}/u.test(c)) continue;
      chars.push(c); starts.push(at); ends.push(at + cp.length);
    }
    at += cp.length;
  }
  return { chars, starts, ends, text: chars.join('') };
}

export function createPhiEntitySession({ context, patient = {}, encounter = {}, practitioners = [], careTeam = [], notes = [], organizations = [], locations = [],
  homophones = true, cacheScans = true } = {}) {
  const keys = ['tenant_id', 'patient_id', 'encounter_id'];
  if (!context || keys.some(k => typeof context[k] !== 'string' || !context[k].trim())) throw new Error('PHI_SESSION_CONTEXT_REQUIRED');
  if (patient.id !== context.patient_id || encounter.id !== context.encounter_id) throw new Error('PHI_SESSION_CONTEXT_MISMATCH');
  if (![practitioners, careTeam, notes, organizations, locations].every(Array.isArray)) throw new Error('PHI_SESSION_ENTITIES_INVALID');
  assertEntityOwnership(context,[patient,encounter,practitioners,careTeam,notes,organizations,locations]);
  return makeSession({ context, patient, encounter, practitioners, careTeam, notes, organizations, locations, homophones, cacheScans,
    binding: Object.fromEntries([...keys, 'phi_session_id', 'ward_id'].map(k => [k, context[k] ?? null])) });
}

// MCP/document/audit requests need a deterministic dictionary even without a
// clinical encounter. This scope asserts NO patient ownership or authorization.
// It is never accepted in place of a patient-bound snapshot session.
export function createPhiRequestSession(values = []) {
  const context = Object.freeze({ phi_request_id: randomUUID() });
  const session = makeSession({ context, values, binding: context });
  return { context, session };
}

function makeSession({ context, patient = {}, encounter = {}, practitioners = [], careTeam = [], notes = [], organizations = [], locations = [],
  values = [], binding, homophones = true, cacheScans = true }) {
  const entities = new Map();
  let disposed = false;
  const add = (raw, label) => {
    if (typeof raw !== 'string' || raw.includes('[ID:') || raw.includes('[PSN:') || raw.includes('[REDACTED:')) return;
    const normalized = projected(raw.trim()).text;
    if (normalized.length < 2 || normalized.length > 256) return;
    if (entities.size >= 2048 && !entities.has(normalized)) throw new Error('PHI_SESSION_ENTITY_LIMIT');
    entities.set(normalized, label);
  };
  const personName = (value, clinician=false) => {
    for(const raw of names(value)) {
      add(raw,'PERSON');
      const name=projected(raw.trim()).text;
      // Derived aliases require a supplied clinician name; never promote an
      // arbitrary surname or a clinical term to a global blacklist.
      if(clinician && /^[\p{Script=Han}]{2,6}$/u.test(name)) {
        const surname=COMPOUND_SURNAMES.exec(name)?.[0] ?? Array.from(name)[0];
        for(const title of CLINICIAN_TITLES) add(surname+title,'PERSON');
      }
    }
  };
  const address = value => {
    if (Array.isArray(value)) { value.forEach(address); return; }
    if (value && typeof value === 'object') {
      for(const key of ['text','line','street','city','district','state']) address(value[key]); return;
    }
    if (typeof value !== 'string') return;
    add(value, 'ADDRESS');
    const tail = value.split(/省|自治区|市|区|县|旗|街道/).at(-1);
    const street = /^[^\d，,。；;]{2,30}?(?:大道|大街|路|街|巷|弄)/.exec(tail)?.[0];
    if (street) add(street, 'ADDRESS');
  };
  const institution = (value, label, depth=0) => {
    if(depth>12) throw new Error('PHI_SESSION_ENTITY_DEPTH');
    if(Array.isArray(value)) {for(const item of value) institution(item,label,depth+1);return;}
    if(typeof value==='string') {add(value,label);return;}
    if(!value || typeof value!=='object') return;
    for(const [key,item] of Object.entries(value)) {
      if(['name','text','display','alias','aliases','shortname','简称'].includes(keyOf(key))) institution(item,label,depth+1);
      else if(ADDRESS_KEYS.has(keyOf(key))) address(item);
      else if(ORGANIZATION_KEYS.has(keyOf(key))) institution(item,'ORGANIZATION',depth+1);
      else if(LOCATION_KEYS.has(keyOf(key))) institution(item,'ADDRESS',depth+1);
    }
  };
  const collect = (value, depth = 0, person = false, clinician = false) => {
    if (depth > 12) throw new Error('PHI_SESSION_ENTITY_DEPTH');
    if (Array.isArray(value)) { value.forEach(x => collect(x, depth + 1, person, clinician)); return; }
    if (!value || typeof value !== 'object') { if (person) personName(value,clinician); return; }
    if (person) personName(value,clinician);
    for (const [key, item] of Object.entries(value)) {
      const k = keyOf(key);
      if (NAME_KEYS.has(k) || ALIAS_KEYS.has(k)) personName(item,!ALIAS_KEYS.has(k) &&
        (clinician || /doctor|physician|attending|supervising|consulting|医师|authorname/.test(k)));
      else if (ADDRESS_KEYS.has(k)) address(item);
      else if (ORGANIZATION_KEYS.has(k)) institution(item,'ORGANIZATION');
      else if (LOCATION_KEYS.has(k)) institution(item,'ADDRESS');
      else if (PERSON_CONTAINERS.has(k)) collect(item, depth + 1, true,CLINICIAN_CONTAINERS.has(k));
    }
  };
  collect(patient); collect(encounter); collect(context); collect(practitioners, 0, true, true); collect(careTeam, 0, true, true);
  institution(organizations,'ORGANIZATION'); institution(locations,'ADDRESS');
  for (const { name: _title, ...metadata } of notes) collect(metadata);
  const collectRequest = (value, depth = 0) => {
    if (depth > 64) throw new Error('PHI_SESSION_ENTITY_DEPTH');
    if (typeof value === 'string' && mayContainStructuredJson(value)) {
      let parsed; try { parsed = JSON.parse(value); } catch { return; }
      collectRequest(parsed, depth + 1); return;
    }
    if (!value || typeof value !== 'object') return;
    collect(value);
    for (const item of Object.values(value)) collectRequest(item, depth + 1);
  };
  for (const value of values) collectRequest(value);
  const phoneticIndex = new Map();
  const scanCache=new Map();let scanBytes=0;
  let table = {};
  const rebuildPhonetics = () => {
    scanCache.clear();scanBytes=0;
    phoneticIndex.clear();
    table = homophones && [...entities].some(([s, label]) => label === 'PERSON' && /^[\p{Script=Han}]{2,6}$/u.test(s)) ? phoneticTable() : {};
    for (const [entity, label] of entities) {
      if (!homophones || label !== 'PERSON' || !/^[\p{Script=Han}]{2,6}$/u.test(entity)) continue;
      const syllables = Array.from(entity, c => table[c] ?? []);
      if (syllables.some(x => !x.length)) continue;
      for (const first of syllables[0]) {
        if (!phoneticIndex.has(first)) phoneticIndex.set(first, []);
        phoneticIndex.get(first).push(syllables);
      }
    }
  };
  rebuildPhonetics();
  const assertContext = current => {
    if (disposed) throw new Error('PHI_SESSION_DISPOSED');
    if (!current || Object.keys(binding).some(k => (current[k] ?? null) !== binding[k])) throw new Error('PHI_SESSION_CONTEXT_MISMATCH');
  };
  const session = Object.freeze({
    assertContext,
    inject(source) {
      if (binding.phi_request_id) throw new Error('PHI_SESSION_CONTEXT_MISMATCH');
      assertContext(source?.context);
      if (source.patient?.id !== binding.patient_id || source.encounter?.id !== binding.encounter_id) throw new Error('PHI_SESSION_CONTEXT_MISMATCH');
      const lists = [source.practitioners ?? [], source.careTeam ?? [], source.notes ?? [], source.organizations ?? [], source.locations ?? []];
      if (!lists.every(Array.isArray)) throw new Error('PHI_SESSION_ENTITIES_INVALID');
      assertEntityOwnership(source.context,[source.patient,source.encounter,...lists]);
      try {
        collect(source.patient); collect(source.encounter); collect(source.context);
        collect(lists[0], 0, true, true); collect(lists[1], 0, true, true);
        for (const { name: _title, ...metadata } of lists[2]) collect(metadata);
        institution(lists[3],'ORGANIZATION'); institution(lists[4],'ADDRESS');
        rebuildPhonetics();
      } catch { entities.clear(); phoneticIndex.clear();scanCache.clear();scanBytes=0; disposed = true; throw new Error('PHI_SESSION_INJECTION_FAILED'); }
    },
    scan(text, current) {
      assertContext(current);
      if (typeof text !== 'string' || !text.isWellFormed() || text.length > 100000) throw new Error('PHI_SESSION_TEXT_INVALID');
      // An empty dictionary has no matching rule. NER is a separate mandatory
      // track; this fast path does not certify or suppress neural inference.
      if(!entities.size) return [];
      if(scanCache.has(text)) return scanCache.get(text).map(s=>({...s}));
      const p = projected(text), spans = [], protectedSpans = [...text.matchAll(TOKEN)].map(m => [m.index, m.index + m[0].length]);
      const push = (start, end, label, method) => {
        if (protectedSpans.some(([a,b]) => start < b && end > a)) return;
        if (label === 'ADDRESS') end += /^(?:\s*[0-9０-９一二三四五六七八九十百甲乙丙-]+(?:号|弄|栋|幢|单元|楼|层|室))+/u.exec(text.slice(end))?.[0].length ?? 0;
        spans.push({ start, end, label, method });
      };
      // Exact index uses UTF-16; map back via code-point projection for astral text.
      const units = []; p.chars.forEach((c,i) => { for (let n=0;n<c.length;n++) units.push(i); });
      for (const [entity, label] of entities) {
        let at = p.text.indexOf(entity);
        while (at !== -1) { push(p.starts[units[at]], p.ends[units[at + entity.length - 1]], label, 'session_exact'); at = p.text.indexOf(entity, at + 1); }
      }
      for (let i=0; i<p.chars.length; i++) {
        for (const first of table[p.chars[i]] ?? []) {
          for (const candidate of phoneticIndex.get(first) ?? []) {
            if (candidate.every((sounds,j) => (table[p.chars[i+j]] ?? []).some(s => sounds.includes(s)))) {
              push(p.starts[i], p.ends[i+candidate.length-1], 'PERSON', 'session_homophone');
            }
          }
        }
      }
      if(cacheScans && scanCache.size<512 && scanBytes+text.length*2<=2_000_000) {
        scanCache.set(text,spans.map(s=>({...s})));scanBytes+=text.length*2;
      }
      return spans;
    },
    dispose() { entities.clear(); phoneticIndex.clear(); scanCache.clear();scanBytes=0; disposed = true; },
    toJSON() { return { kind: 'opaque_phi_session', disposed }; },
  });
  sessions.add(session);
  return session;
}

export function assertPhiEntitySession(session, context) {
  if (!sessions.has(session)) throw new Error('PHI_ENTITY_SESSION_REQUIRED');
  session.assertContext(context);
}

export function mergePhiSpans(spans) {
  const merged = [];
  for (const span of spans.toSorted((a,b) => a.start - b.start || b.end - a.end)) {
    const last = merged.at(-1);
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

export function redactSessionEntities(text, { session, context } = {}) {
  assertPhiEntitySession(session, context);
  let result = text;
  for (const s of mergePhiSpans(session.scan(text, context)).reverse()) result = result.slice(0,s.start) + '[REDACTED:SESSION_ENTITY]' + result.slice(s.end);
  return result;
}

export function guardSessionValue(value, { session, context } = {}) {
  assertPhiEntitySession(session, context);
  const guard = (v, depth = 0) => {
    if (depth > 64) throw new Error('PHI_SESSION_VALUE_DEPTH');
    if (typeof v === 'string') return redactSessionEntities(v, { session, context });
    if (Array.isArray(v)) return v.map(x => guard(x, depth + 1));
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k,item] of Object.entries(v)) {
      const safeKey = redactSessionEntities(k, { session, context });
      if (Object.hasOwn(out, safeKey)) throw new Error('PHI_SESSION_KEY_COLLISION');
      Object.defineProperty(out, safeKey, { enumerable: true, configurable: true, writable: true,
        value: isIntegrityMetadata(k, item, v) ? item : guard(item, depth + 1) });
    }
    return out;
  };
  return guard(toModelSafe(value));
}
