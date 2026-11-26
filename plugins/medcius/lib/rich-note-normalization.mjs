// Bounded, non-rendering rich-text normalization. This module never executes
// markup, loads URLs, guesses a source encoding, or logs the supplied text.
// Source offsets are UTF-16 offsets into the exact input string, not bytes/DOM.
import { sha256Hex } from '../servers/shared/crypto.mjs';

const MAX_INPUT = 500000, MAX_DEPTH = 128, MAX_SEGMENTS = 100000;
const HTML_TAGS = new Set('html body div p span b strong i em u s br table tbody thead tfoot tr td th ul ol li font section article h1 h2 h3 h4 h5 h6'.split(' '));
const HTML_BLOCKS = new Set('div p section article h1 h2 h3 h4 h5 h6 li'.split(' '));
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const RTF_IGNORE_DEST = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'generator']);
const RTF_FORMAT = new Set(('rtf ansi deff deflang viewkind viewscale paperw paperh margl margr margt margb '
  + 'pard plain b i ul ulnone strike f fs cf highlight lang langfe ql qr qc qj li ri fi sa sb sl slmult '
  + 'keep keepn widctlpar nowidctlpar intbl cellx trleft trrh trgaph clvertalt clvertalc clvertalb '
  + 'ltrpar rtlpar ltrch rtlch sectd sect pagebb v v0').split(' '));
const rejected = (format, reason) => ({ schema_version: 'medcius.rich-text.v1', status: 'quarantined', format,
  reason, text: null, source_sha256: null, normalized_sha256: null, offset_unit: 'utf16', offset_map: [], tables: [] });

function writer(raw, format) {
  let text = '', map = [], tables = [], activeTable = null, activeRow = null, cellStart = null, cellInfo = null;
  const add = (value, start, end, kind = 'literal') => {
    if (!value) return;
    const cleanStart = text.length; text += value;
    if (map.length >= MAX_SEGMENTS) throw new Error('RICH_MAPPING_LIMIT');
    const prev = map.at(-1);
    if (kind === 'literal' && value.length === end - start && prev?.kind === 'literal'
      && prev.clean_end === cleanStart && prev.source_end === start) {
      prev.clean_end = text.length; prev.source_end = end;
    } else map.push({ clean_start: cleanStart, clean_end: text.length,
      source_start: start, source_end: end, kind });
  };
  const sep = (value, at) => {
    // Structural separators have no source character and are not raw anchors.
    if (value === '\n' && (!text || text.endsWith('\n'))) return;
    add(value, at, at, 'inserted_separator');
  };
  const openTable = () => { if (activeTable) throw new Error('RICH_NESTED_TABLE_UNSUPPORTED'); activeTable = { rows: [] }; };
  const openRow = () => { if (!activeTable || activeRow) throw new Error('RICH_TABLE_STRUCTURE_INVALID'); activeRow = { cells: [] }; };
  const openCell = (info = {}) => { if (!activeRow || cellStart != null) throw new Error('RICH_TABLE_STRUCTURE_INVALID'); cellStart = text.length; cellInfo = info; };
  const closeCell = at => {
    if (!activeRow || cellStart == null) throw new Error('RICH_TABLE_STRUCTURE_INVALID');
    activeRow.cells.push({ start: cellStart, end: text.length, ...cellInfo }); cellStart = null; cellInfo = null;
    sep('\t', at);
  };
  const closeRow = at => {
    if (!activeRow || cellStart != null || !activeRow.cells.length) throw new Error('RICH_TABLE_STRUCTURE_INVALID');
    activeTable.rows.push(activeRow); activeRow = null; sep('\n', at);
  };
  const discardEmptyCell = () => {
    if (!activeRow || cellStart == null || cellStart !== text.length) throw new Error('RICH_TABLE_STRUCTURE_INVALID');
    cellStart = null; cellInfo = null;
  };
  const closeTable = () => { if (!activeTable || activeRow || cellStart != null) throw new Error('RICH_TABLE_STRUCTURE_INVALID'); tables.push(activeTable); activeTable = null; };
  const done = () => {
    if (activeTable || activeRow || cellStart != null || !text.isWellFormed() || text.includes('\ufffd')) throw new Error('RICH_CONTENT_INVALID');
    // A second layer of markup/encoded entities may hide PHI from a detector.
    // It is quarantined instead of recursively guessing its intended decoding.
    if (/<\s*\/?[A-Za-z][A-Za-z0-9:-]*(?:\s|\/?\s*>)/.test(text)
      || /&(?:#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]*);/i.test(text)) throw new Error('RICH_NESTED_ENCODING_UNSUPPORTED');
    return { schema_version: 'medcius.rich-text.v1', status: 'normalized', format, reason: null, text,
      source_sha256: sha256Hex(raw), normalized_sha256: sha256Hex(text), offset_unit: 'utf16', offset_map: map, tables };
  };
  return { add, sep, openTable, openRow, openCell, closeCell, discardEmptyCell, closeRow, closeTable, done, get length() { return text.length; } };
}

function decodeEntity(raw, i) {
  const match = /^&(#(?:x[0-9a-fA-F]+|[0-9]+)|[A-Za-z][A-Za-z0-9]*);/.exec(raw.slice(i, i + 35));
  if (!match) {
    if (/^&(?:#|[A-Za-z][A-Za-z0-9]*;)/.test(raw.slice(i, i + 35))) throw new Error('HTML_ENTITY_INVALID');
    return { value: '&', length: 1, kind: 'literal' };
  }
  const name = match[1]; let value;
  if (name[0] === '#') {
    const hex = name[1]?.toLowerCase() === 'x', n = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new Error('HTML_ENTITY_INVALID');
    value = String.fromCodePoint(n);
  } else {
    value = HTML_ENTITIES[name];
    if (value == null) throw new Error('HTML_ENTITY_UNSUPPORTED');
  }
  return { value, length: match[0].length, kind: 'entity' };
}

function normalizeHtml(raw) {
  const w = writer(raw, 'html'), stack = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '<') {
      if (raw.startsWith('<!--', i) || raw.startsWith('<!', i) || raw.startsWith('<?', i)) throw new Error('HTML_DECLARATION_UNSUPPORTED');
      let end = i + 1, quote = null;
      for (; end < raw.length; end++) {
        const c = raw[end];
        if (quote) { if (c === quote) quote = null; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (end >= raw.length || quote) throw new Error('HTML_TAG_UNTERMINATED');
      const token = raw.slice(i + 1, end), m = /^\s*(\/?)\s*([A-Za-z][A-Za-z0-9]*)([\s\S]*)$/.exec(token);
      if (!m) throw new Error('HTML_TAG_INVALID');
      const closing = Boolean(m[1]), tag = m[2].toLowerCase(), tail = m[3];
      if (!HTML_TAGS.has(tag)) throw new Error('HTML_TAG_UNSUPPORTED');
      if (/\bhidden\b|\baria-hidden\s*=\s*['"]?true|display\s*:\s*none|visibility\s*:\s*hidden/i.test(tail)) throw new Error('HTML_HIDDEN_CONTENT_UNSUPPORTED');
      if (/\bclass\s*=|\bon[a-z]+\s*=/i.test(tail)) throw new Error('HTML_VISIBILITY_OR_ACTIVE_CONTENT_UNSUPPORTED');
      if (/\bstyle\s*=/i.test(tail)) {
        const match = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tail);
        if (!match || /[&\\]|\/\*/.test(match[1] ?? match[2])) throw new Error('HTML_STYLE_UNSUPPORTED');
        for (const declaration of (match[1] ?? match[2]).split(';').map(s => s.trim()).filter(Boolean)) {
          const pair = /^([a-z-]+)\s*:\s*([^:]+)$/i.exec(declaration);
          if (!pair) throw new Error('HTML_STYLE_UNSUPPORTED');
          const property = pair[1].toLowerCase(), val = pair[2].trim();
          const okay = property === 'font-weight' ? /^(?:normal|bold|[1-9]00)$/i.test(val)
            : property === 'font-style' ? /^(?:normal|italic|oblique)$/i.test(val)
              : property === 'text-align' ? /^(?:left|right|center|justify|start|end)$/i.test(val)
                : property === 'vertical-align' ? /^(?:top|middle|bottom|baseline)$/i.test(val)
                  : property === 'font-size' ? /^(?:[1-9]\d?(?:\.\d+)?)(?:px|pt|em|%)$/i.test(val) : false;
          if (!okay) throw new Error('HTML_STYLE_UNSUPPORTED');
        }
      }
      const selfClose = tag === 'br' || /\/\s*$/.test(tail);
      if (closing && (tail.trim() || tag === 'br')) throw new Error('HTML_TAG_INVALID');
      if (closing) {
        if (stack.pop() !== tag) throw new Error('HTML_NESTING_INVALID');
        if (tag === 'td' || tag === 'th') w.closeCell(i);
        else if (tag === 'tr') w.closeRow(i);
        else if (tag === 'table') w.closeTable();
        else if (HTML_BLOCKS.has(tag)) w.sep('\n', i);
      } else {
        if (tag === 'table') w.openTable();
        else if (tag === 'tr') w.openRow();
        else if (tag === 'td' || tag === 'th') {
          const attr = name => {
            const v = new RegExp(`\\b${name}\\s*=\\s*(?:"(\\d+)"|'(\\d+)'|(\\d+))`, 'i').exec(tail);
            const occurrences = [...tail.matchAll(new RegExp(`\\b${name}\\b`, 'ig'))].length;
            if (occurrences > 1 || (occurrences === 1 && !v)) throw new Error('HTML_TABLE_SPAN_INVALID');
            return v ? Number(v[1] ?? v[2] ?? v[3]) : 1;
          };
          const colspan = attr('colspan'), rowspan = attr('rowspan');
          if (![colspan, rowspan].every(n => Number.isInteger(n) && n >= 1 && n <= 100)) throw new Error('HTML_TABLE_SPAN_INVALID');
          w.openCell({ colspan, rowspan, header: tag === 'th' });
        } else if (tag === 'br') w.sep('\n', i);
        if (!selfClose) { stack.push(tag); if (stack.length > MAX_DEPTH) throw new Error('RICH_DEPTH_LIMIT'); }
        else if (tag !== 'br') throw new Error('HTML_SELFCLOSE_UNSUPPORTED');
      }
      i = end + 1; continue;
    }
    if (raw[i] === '&') {
      const entity = decodeEntity(raw, i); w.add(entity.value, i, i + entity.length, entity.kind); i += entity.length; continue;
    }
    w.add(raw[i], i, i + 1); i++;
  }
  if (stack.length) throw new Error('HTML_NESTING_INVALID');
  return w.done();
}

function normalizeRtf(raw) {
  const w = writer(raw, 'rtf'), stack = [];
  let state = { skip: false, uc: 1, codepage: null, optional: false }, i = 0, fallback = 0, tableOpen = false, rowOpen = false, rootClosed = false;
  if (!/^\s*\{\\rtf\d/.test(raw)) throw new Error('RTF_HEADER_REQUIRED');
  const emit = (value, start, end, kind = 'literal') => { if (!state.skip && !fallback) w.add(value, start, end, kind); else if (!state.skip && fallback) fallback--; };
  while (i < raw.length) {
    const c = raw[i];
    if (c === '{') { if (!stack.length && rootClosed) throw new Error('RTF_GROUP_INVALID');
      stack.push({ ...state }); if (stack.length > MAX_DEPTH) throw new Error('RICH_DEPTH_LIMIT'); i++; continue; }
    if (c === '}') { if (!stack.length || fallback) throw new Error('RTF_GROUP_INVALID');
      if (stack.length === 1 && tableOpen && !rowOpen) { w.closeTable(); tableOpen = false; }
      if (stack.length === 1) rootClosed = true;
      state = stack.pop(); i++; continue; }
    if (!stack.length) { if (/\s/.test(c)) { i++; continue; } throw new Error('RTF_OUTSIDE_GROUP'); }
    if (c !== '\\') { if (!rowOpen && tableOpen && !/\s/.test(c)) { w.closeTable(); tableOpen = false; }
      if (c !== '\r' && c !== '\n') emit(c, i, i + 1); i++; continue; }
    const start = i++;
    if (i >= raw.length) throw new Error('RTF_ESCAPE_INVALID');
    if (['\\', '{', '}'].includes(raw[i])) { emit(raw[i], start, i + 1, 'rtf_escape'); i++; continue; }
    if (raw[i] === "'") {
      if (!/^[0-9a-fA-F]{2}$/.test(raw.slice(i + 1, i + 3))) throw new Error('RTF_HEX_INVALID');
      const tokens = [];
      while (raw[i] === "'" && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 1, i + 3))) {
        tokens.push({ byte: Number.parseInt(raw.slice(i + 1, i + 3), 16), start: i - 1, end: i + 3 }); i += 3;
        if (raw[i] === '\\' && raw[i + 1] === "'") i++; else break;
      }
      if (state.skip) continue;
      if (fallback) { const consumed = Math.min(fallback, tokens.length); fallback -= consumed; tokens.splice(0, consumed); }
      if (!tokens.length) continue;
      if (!state.codepage && tokens.some(t => t.byte >= 128)) throw new Error('RTF_CODEPAGE_REQUIRED');
      const encoding = ({ 1252: 'windows-1252', 936: 'gb18030', 65001: 'utf-8' })[state.codepage] ?? 'utf-8';
      const decoder = new TextDecoder(encoding, { fatal: true }); let runStart = tokens[0].start;
      try {
        for (const token of tokens) {
          const out = decoder.decode(Uint8Array.of(token.byte), { stream: true });
          if (out) { w.add(out, runStart, token.end, 'rtf_hex'); runStart = token.end; }
        }
        if (decoder.decode()) throw new Error('RTF_HEX_INCOMPLETE');
      } catch { throw new Error('RTF_HEX_INVALID'); }
      continue;
    }
    if (raw[i] === '*') { state.optional = true; i++; continue; }
    if (raw[i] === '~' || raw[i] === '-' || raw[i] === '_') {
      const values = { '~': '\u00a0', '-': '\u00ad', '_': '\u2011' }; emit(values[raw[i]], start, i + 1, 'rtf_escape'); i++; continue;
    }
    const m = /^([A-Za-z]+)(-?\d+)? ?/.exec(raw.slice(i));
    if (!m) throw new Error('RTF_CONTROL_INVALID');
    const word = m[1].toLowerCase(), value = m[2] == null ? null : Number(m[2]); i += m[0].length;
    if (RTF_IGNORE_DEST.has(word)) { state.skip = true; state.optional = false; continue; }
    if (state.skip) continue;
    if (state.optional) throw new Error('RTF_DESTINATION_UNSUPPORTED');
    if (word === 'bin' || word === 'object' || word === 'pict' || word === 'field' || word === 'htmltag' || word === 'fromhtml') throw new Error('RTF_DESTINATION_UNSUPPORTED');
    if (word === 'ansicpg') { if (![1252, 936, 65001].includes(value)) throw new Error('RTF_CODEPAGE_UNSUPPORTED'); state.codepage = value; continue; }
    if (word === 'uc') { if (!Number.isInteger(value) || value < 0 || value > 8) throw new Error('RTF_UC_INVALID'); state.uc = value; continue; }
    if (word === 'u') {
      if (!Number.isInteger(value) || value < -32768 || value > 32767 || fallback) throw new Error('RTF_UNICODE_INVALID');
      w.add(String.fromCharCode(value < 0 ? value + 65536 : value), start, i, 'rtf_unicode'); fallback = state.uc; continue;
    }
    if (fallback) throw new Error('RTF_FALLBACK_INVALID');
    if (word === 'par' || word === 'line') { if (!rowOpen && tableOpen) { w.closeTable(); tableOpen = false; } w.sep('\n', start); continue; }
    if (word === 'tab') { w.sep('\t', start); continue; }
    if (word === 'trowd') { if (rowOpen) throw new Error('RICH_TABLE_STRUCTURE_INVALID'); if (!tableOpen) { w.openTable(); tableOpen = true; } w.openRow(); w.openCell(); rowOpen = true; continue; }
    if (word === 'cell') { if (!rowOpen) throw new Error('RICH_TABLE_STRUCTURE_INVALID'); w.closeCell(start); w.openCell(); continue; }
    if (word === 'row') {
      if (!rowOpen) throw new Error('RICH_TABLE_STRUCTURE_INVALID');
      // A row must end with an explicit cell delimiter; never invent a cell.
      w.discardEmptyCell(); w.closeRow(start); rowOpen = false; continue;
    }
    if (word === 'v' && value !== 0) throw new Error('RTF_HIDDEN_CONTENT_UNSUPPORTED');
    if (!RTF_FORMAT.has(word)) throw new Error('RTF_CONTROL_UNSUPPORTED');
  }
  if (stack.length || fallback || rowOpen || tableOpen) throw new Error('RTF_GROUP_INVALID');
  return w.done();
}

export function detectRichFormat(value, contentType = '') {
  if (typeof value !== 'string') return null;
  const type = String(contentType ?? '').toLowerCase().split(';')[0].trim();
  if (/^\s*\{\\rtf\d/i.test(value) || ['application/rtf', 'text/rtf'].includes(type)) return 'rtf';
  if (/<\s*\/?(?:html|body|div|p|span|table|tr|td|th|br|script|style|iframe|object)\b/i.test(value)
    || /<\s*\/?[A-Za-z][A-Za-z0-9:-]*(?:\s|\/?\s*>)/.test(value)
    || /&(?:#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]*);/i.test(value)
    || ['text/html', 'application/xhtml+xml'].includes(type)) return 'html';
  return null;
}

export function normalizeRichText(raw, format = detectRichFormat(raw)) {
  if (!['html', 'rtf'].includes(format)) return rejected(format ?? 'unknown', 'RICH_FORMAT_UNKNOWN');
  if (typeof raw !== 'string' || raw.length > MAX_INPUT || raw.includes('\ufffd') || !raw.isWellFormed()) return rejected(format, 'RICH_INPUT_INVALID');
  try { return format === 'html' ? normalizeHtml(raw) : normalizeRtf(raw); }
  catch (error) {
    const reason = /^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'RICH_PARSE_FAILED';
    return rejected(format, reason);
  }
}

// Normalize only known payload fields; raw HTML/RTF is replaced in memory
// before PHI scanning. Unsupported content is quarantined, never partially used.
export function prepareRichTextTree(value, depth = 0) {
  if (depth > 64) throw new Error('PHI_SOURCE_DEPTH');
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const format = typeof value[i] === 'string' ? detectRichFormat(value[i]) : null;
      if (format) value[i] = normalizeRichText(value[i], format).text ?? '';
      else if (ArrayBuffer.isView(value[i]) || value[i] instanceof ArrayBuffer) value[i] = null;
      else prepareRichTextTree(value[i], depth + 1);
    }
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  for (const key of ['text', 'content', 'clob', 'html', 'rtf', 'div']) {
    if (ArrayBuffer.isView(value[key]) || value[key] instanceof ArrayBuffer) {
      const { text, ...metadata } = rejected('unknown', 'RICH_BINARY_ENCODING_UNCONFIRMED');
      value[key] = ''; if (key === 'text' || value.text == null) { value.text = ''; value.rich_text_normalization = metadata; }
      continue;
    }
    if (typeof value[key] !== 'string') continue;
    const format = detectRichFormat(value[key], value.content_type ?? value.mime_type);
    if (!format) continue;
    const result = normalizeRichText(value[key], format), { text, ...metadata } = result;
    value[key] = text ?? '';
    if (key === 'text' || (value.text == null && ['content', 'clob', 'html', 'rtf'].includes(key))) {
      value.text = text ?? ''; value.rich_text_normalization = metadata;
    }
    value.content_type = 'text/plain';
  }
  // Other fields may carry duplicate encoded payloads. Do not allow a raw
  // markup copy to bypass PHI scanning via a different property name.
  for (const [key, child] of Object.entries(value)) {
    if (ArrayBuffer.isView(child) || child instanceof ArrayBuffer) { value[key] = null; continue; }
    if (['text', 'content', 'clob', 'html', 'rtf', 'div'].includes(key) || typeof child !== 'string') continue;
    const format = detectRichFormat(child);
    if (format) value[key] = normalizeRichText(child, format).text ?? '';
  }
  for (const [key, child] of Object.entries(value)) if (key !== 'rich_text_normalization') prepareRichTextTree(child, depth + 1);
  return value;
}

// A PHI redaction changes offsets; never pretend a pre-redaction source map
// still applies. Structure and mapping are removed rather than shifted.
export function finalizeRichTextTree(before, after, depth = 0) {
  if (depth > 64 || !before || !after || typeof before !== 'object' || typeof after !== 'object') return after;
  let result = after;
  if (before.rich_text_normalization && after.rich_text_normalization && before.text !== after.text) {
    result = { ...after, rich_text_normalization: { ...after.rich_text_normalization, status: 'normalized_mapping_unavailable',
      reason: 'PHI_GUARD_CHANGED_TEXT', normalized_sha256: sha256Hex(after.text ?? ''), offset_map: [], tables: [] } };
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < before.length; i++) {
      const child = finalizeRichTextTree(before[i], after[i], depth + 1);
      if (child !== after[i]) { if (result === after) result = after.slice(); result[i] = child; }
    }
    return result;
  }
  for (const key of Object.keys(before)) if (key !== 'rich_text_normalization' && Object.hasOwn(after, key)) {
    const child = finalizeRichTextTree(before[key], after[key], depth + 1);
    if (child !== after[key]) { if (result === after) result = { ...after }; result[key] = child; }
  }
  return result;
}

// Reparse and hash-check the exact source every time. Returned intervals are
// source-string UTF-16 offsets; inserted separators and partial escape tokens
// cannot be projected and therefore never receive fabricated highlights.
export function projectRichTextSpan(record, raw, { start, end } = {}) {
  const meta = record?.rich_text_normalization;
  const no = reason => ({ status: 'unavailable', reason, source_spans: [] });
  if (!meta || meta.status !== 'normalized' || typeof raw !== 'string') return no('NORMALIZED_SOURCE_REQUIRED');
  const parsed = normalizeRichText(raw, meta.format);
  if (parsed.status !== 'normalized' || parsed.source_sha256 !== meta.source_sha256
    || parsed.normalized_sha256 !== meta.normalized_sha256 || parsed.text !== record.text) return no('SOURCE_OR_GUARDED_TEXT_CHANGED');
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > parsed.text.length
    || !parsed.text.slice(start, end).isWellFormed()) return no('SPAN_INVALID');
  const spans = [];
  for (const run of parsed.offset_map) {
    const a = Math.max(start, run.clean_start), b = Math.min(end, run.clean_end);
    if (a >= b) continue;
    if (run.kind === 'inserted_separator') return no('INSERTED_SEPARATOR_NOT_PROJECTABLE');
    if (run.kind !== 'literal' && (a !== run.clean_start || b !== run.clean_end)) return no('PARTIAL_ESCAPE_NOT_PROJECTABLE');
    const s = run.kind === 'literal' ? run.source_start + (a - run.clean_start) : run.source_start;
    const e = run.kind === 'literal' ? run.source_start + (b - run.clean_start) : run.source_end;
    const last = spans.at(-1);
    if (last && last.end === s) last.end = e; else spans.push({ start: s, end: e });
  }
  return spans.length ? { status: 'verified_for_exact_source', reason: null, source_spans: spans,
    source_sha256: parsed.source_sha256, offset_unit: 'utf16', end_exclusive: true } : no('SPAN_UNMAPPED');
}
