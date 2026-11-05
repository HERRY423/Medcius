// Bounded XML 1.0 subset for local CDA ingestion. No DTD, external entities,
// processing instructions, schema fetching, XInclude or execution of markup.
// This is structural parsing, NOT XML Schema/Schematron conformance validation.
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;
function fail(code) { throw new Error(`CONNECTOR_XML_${code}`); }
function validCodePoint(n) { return n === 9 || n === 10 || n === 13 || n >= 32 && n <= 0xd7ff || n >= 0xe000 && n <= 0xfffd || n >= 0x10000 && n <= 0x10ffff; }
function decode(text) {
  return text.replace(/&([^;\s]*);|&/g, (all, entity) => {
    const predefined = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, entity)) return predefined[entity];
    if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity ?? '')) fail('ENTITY_REJECTED');
    const n = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!validCodePoint(n)) fail('CHARACTER_INVALID');
    return String.fromCodePoint(n);
  });
}
function tagEnd(xml, start) {
  let quote = null;
  for (let i = start; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
    else if (ch === '<') fail('TAG_INVALID');
  }
  fail('UNCLOSED_TAG');
}
function namespace(qname, ns, attribute = false) {
  const parts = qname.split(':');
  if (parts.length === 1) return attribute ? '' : ns[''] ?? '';
  if (!Object.hasOwn(ns, parts[0]) || !ns[parts[0]]) fail('NAMESPACE_UNBOUND');
  return ns[parts[0]];
}

export function parseBoundedXml(xml, { maxBytes = 2 * 1024 * 1024, maxNodes = 20000, maxDepth = 64 } = {}) {
  if (typeof xml !== 'string' || !xml.trim() || !xml.isWellFormed()) fail('INPUT_INVALID');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024
    || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 100000 || !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 128) fail('LIMIT_INVALID');
  if (Buffer.byteLength(xml, 'utf8') > maxBytes) fail('SIZE_LIMIT');
  for (const ch of xml) if (!validCodePoint(ch.codePointAt(0))) fail('CHARACTER_INVALID');
  const stack = []; let root = null, count = 0, i = xml[0] === '\ufeff' ? 1 : 0;
  while (i < xml.length) {
    if (xml[i] !== '<') {
      const end = xml.indexOf('<', i), stop = end < 0 ? xml.length : end;
      const raw = xml.slice(i, stop);
      if (raw.includes(']]>')) fail('TEXT_INVALID');
      if (stack.length) stack.at(-1).content.push({ text: decode(raw), start: i, end: stop });
      else if (raw.trim()) fail('TEXT_OUTSIDE_ROOT');
      i = stop; continue;
    }
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      if (end < 0 || xml.slice(i + 4, end).includes('--') || xml.slice(i + 4, end).endsWith('-')) fail('COMMENT_INVALID');
      i = end + 3; continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9);
      if (!stack.length || end < 0) fail('CDATA_INVALID');
      stack.at(-1).content.push({ text: xml.slice(i + 9, end), start: i, end: end + 3 });
      i = end + 3; continue;
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2), body = xml.slice(i, end + 2);
      if (root || xml.slice(0, i).replace(/^\ufeff/, '').trim() || end < 0
        || !/^<\?xml\s+version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])(?:UTF-8|utf-8)\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>$/.test(body)) fail('PROCESSING_INSTRUCTION_REJECTED');
      i = end + 2; continue;
    }
    if (xml.startsWith('<!', i)) fail('DECLARATION_REJECTED');
    const end = tagEnd(xml, i + 1), body = xml.slice(i + 1, end);
    if (body.startsWith('/')) {
      const name = body.slice(1).trimEnd();
      if (!NAME.test(name) || stack.at(-1)?.qname !== name) fail('NESTING_INVALID');
      stack.pop().end = end + 1; i = end + 1; continue;
    }
    const selfClosing = /\/$/.test(body), source = selfClosing ? body.slice(0, -1) : body;
    const matched = /^([^\s]+)([\s\S]*)$/.exec(source);
    if (!matched || !NAME.test(matched[1])) fail('NAME_INVALID');
    const attrs = Object.create(null); let rest = matched[2];
    while (rest.length) {
      if (!rest.trim()) break;
      const m = /^\s+([^\s=]+)\s*=\s*(['"])([\s\S]*?)\2/.exec(rest);
      if (!m || !NAME.test(m[1]) || m[3].includes('<') || Object.hasOwn(attrs, m[1])) fail('ATTRIBUTE_INVALID');
      attrs[m[1]] = decode(m[3]); rest = rest.slice(m[0].length);
    }
    const ns = Object.assign(Object.create(null), stack.at(-1)?.namespaces ?? { xml: 'http://www.w3.org/XML/1998/namespace' });
    for (const [key, value] of Object.entries(attrs)) {
      if ((key === 'xmlns' || key.startsWith('xmlns:')) && (value === 'http://www.w3.org/2000/xmlns/'
        || value === 'http://www.w3.org/XML/1998/namespace' && key !== 'xmlns:xml')) fail('NAMESPACE_INVALID');
      if (key === 'xmlns') ns[''] = value;
      else if (key.startsWith('xmlns:')) {
        const prefix = key.slice(6);
        if (!value || prefix === 'xmlns' || prefix === 'xml' && value !== 'http://www.w3.org/XML/1998/namespace') fail('NAMESPACE_INVALID');
        ns[prefix] = value;
      }
    }
    const expanded = new Set();
    for (const key of Object.keys(attrs).filter(k => k !== 'xmlns' && !k.startsWith('xmlns:'))) {
      const expandedName = `${namespace(key, ns, true)}|${key.split(':').at(-1)}`;
      if (expanded.has(expandedName)) fail('ATTRIBUTE_DUPLICATE');
      expanded.add(expandedName);
    }
    const node = { qname: matched[1], name: matched[1].split(':').at(-1), ns: namespace(matched[1], ns), attrs,
      namespaces: ns, children: [], content: [], start: i, end: selfClosing ? end + 1 : null };
    if (++count > maxNodes || stack.length + 1 > maxDepth) fail('COMPLEXITY_LIMIT');
    if (node.ns === 'http://www.w3.org/2001/XInclude') fail('XINCLUDE_REJECTED');
    if (stack.length) { stack.at(-1).children.push(node); stack.at(-1).content.push(node); }
    else { if (root) fail('MULTIPLE_ROOTS'); root = node; }
    if (!selfClosing) stack.push(node);
    i = end + 1;
  }
  if (stack.length || !root) fail('NESTING_INVALID');
  return root;
}

export const CDA_NS = 'urn:hl7-org:v3';
export function children(node, name) { return node?.children.filter(n => n.ns === CDA_NS && n.name === name) ?? []; }
export function one(node, name) {
  const found = children(node, name);
  if (found.length > 1) fail('CARDINALITY_INVALID');
  return found[0] ?? null;
}
export function path(node, ...names) { return names.reduce((n, name) => one(n, name), node); }
export function narrativeText(node) {
  if (!node) return '';
  const blocks = new Set(['paragraph', 'list', 'item', 'table', 'tr', 'br', 'caption']);
  function walk(n) {
    if (Object.hasOwn(n, 'text')) return n.text;
    if (!['', CDA_NS].includes(n.ns) || ['script', 'style', 'iframe', 'object', 'reference', 'linkHtml'].includes(n.name)) {
      if (['reference', 'linkHtml'].includes(n.name)) return n.content.map(walk).join('');
      fail('NARRATIVE_MARKUP_REJECTED');
    }
    const value = n.content.map(walk).join('');
    return blocks.has(n.name) ? `\n${value}\n` : ['td', 'th'].includes(n.name) ? `${value}\t` : value;
  }
  return walk(node).replace(/\r\n?/g, '\n').split('\n').map(x => x.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}
