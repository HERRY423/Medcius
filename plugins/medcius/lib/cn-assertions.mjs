// Verbatim UTF-16 offsets; slash abbreviations remain atomic. Existing clause
// callers retain their shape, with mention-level cue and coordination links.
import { CN_ASSERTION_RULES as R, CN_ASSERTION_RULE_VERSION } from './cn-assertion-rules.mjs';
const LABELS = { positive: '【阳性/现症】', negative: '【阴性/否定】', uncertain: '【疑似/待查】', not_evaluated: '【未评估】', not_mentioned: '【未提及】' };

function classify(text, defaults = {}) {
  let presence = !text ? 'not_mentioned' : 'positive';
  // Keep string length so cue anchors still index the original input.
  const withoutPseudo = text.replace(R.pseudo_negation, m => ' '.repeat(m.length));
  const rule = ['not_mentioned', 'not_evaluated', 'uncertain', 'negative'].find(k => R[k].test(withoutPseudo));
  if (rule) presence = rule;
  const cue = rule ? R[rule].exec(withoutPseudo) : null;
  const report = R.patient_report.exec(text);
  let temporality = defaults.temporality ?? 'current';
  if (R.historical.test(text)) temporality = 'historical';
  if (R.current.test(report ? text.slice(report[0].length) : text)) temporality = 'current';
  if (R.hypothetical.test(text)) temporality = 'hypothetical';
  let experiencer = defaults.experiencer ?? 'patient';
  if (report && !R.family.test(text.slice(report[0].length))) experiencer = 'patient';
  else if (R.family.test(text)) experiencer = 'family_member';
  else if (/同室|其他患者/.test(text)) experiencer = 'other';
  else if (R.patient_start.test(text)) experiencer = 'patient';
  // A remote procedure remains an observed event, never a negated procedure.
  // "恢复可" is postoperative recovery, not proof all prior disease resolved.
  const clinical_status = presence !== 'positive' ? 'unknown' : R.resolved.test(text) && !/未.{0,4}(?:治愈|痊愈|恢复正常|消失|消退)/.test(text) ? 'resolved'
    : R.recovered.test(text) ? 'recovered' : 'unknown';
  if (clinical_status === 'resolved') temporality = 'historical';
  return { presence, temporality, experiencer, clinical_status, presence_label: LABELS[presence],
    cue: cue ? { text: cue[0], start: cue.index, end: cue.index + cue[0].length,
      direction: cue.index > 0 && cue.index + cue[0].length === text.length ? 'backward' : 'forward' } : null };
}

function summarize(mentions) {
  const axis = k => new Set(mentions.map(c => c[k]));
  const mixed = ['presence', 'temporality', 'experiencer'].some(k => axis(k).size > 1);
  const presence = mixed ? 'uncertain' : mentions[0].presence;
  return { presence, temporality: axis('temporality').size === 1 ? mentions[0].temporality : 'unknown',
    experiencer: axis('experiencer').size === 1 ? mentions[0].experiencer : 'unknown',
    clinical_status: axis('clinical_status').size === 1 ? mentions[0].clinical_status : 'unknown',
    presence_label: LABELS[presence], scope_status: mixed ? 'mixed_clauses' : 'uniform' };
}

function pieces(text) {
  const cuts = [0];
  const reportEnd = R.patient_report.exec(text)?.[0].length ?? 0;
  for (const m of text.matchAll(R.predicate_boundary)) {
    if (!m.index || m.index < reportEnd) continue;
    const left = text.slice(cuts.at(-1), m.index);
    const contrast = R.contrast_start.test(m[0]);
    if (/^(?:但是|然而|不[过過]|但|而)$/.test(left) || (m[0] === '而' && /从$|因$|进$/.test(left))) continue;
    // Keep a reporting or negation prefix attached to its following predicate.
    if (!contrast && /(?:未(?:再|曾|能)?|不|若|如|一旦|否[认認](?:再)?|[无無]明[显顯][诱誘]因|其他)$/.test(left)) continue;
    const scopedLeft = left.replace(R.pseudo_negation, '');
    const newSubject = R.patient_start.test(m[0]);
    if (contrast || R.negative.test(scopedLeft) || R.uncertain.test(scopedLeft)
      || R.not_evaluated.test(scopedLeft) || R.not_mentioned.test(scopedLeft)
      || ((newSubject || R.current.test(m[0])) && R.historical.test(left))
      || (newSubject && R.family.test(left) && !R.patient_report.test(left))) cuts.push(m.index);
  }
  cuts.push(text.length);
  return cuts.slice(0, -1).map((start, i) => ({ text: text.slice(start, cuts[i+1]), start }));
}

// Sentence punctuation ends cue scope; decimal points and slash abbreviations
// remain intact. Keep question marks attached to the finding they qualify.
function clauseSpans(text) {
  const result = [];
  let start = 0;
  for (let i=0;i<text.length;i++) {
    const ch=text[i];
    const question=/[?？]/.test(ch);
    const dot=ch==='.' && !( /\d/.test(text[i-1]??'') && /\d/.test(text[i+1]??'') );
    if (!question && !dot && !/[，,。；;\r\n！!]/.test(ch)) continue;
    // A leading question mark is a forward cue, not an empty sentence.
    if(question && !text.slice(start,i).trim()) continue;
    const end=question ? i+1 : i;
    if(end>start) result.push({index:start,text:text.slice(start,end)});
    start=i+1;
  }
  if(start<text.length) result.push({index:start,text:text.slice(start)});
  return result;
}

export function extractConTextAssertions(input = '', defaults = {}) {
  const text = String(input ?? '');
  const clauses = [];
  let previous = null;
  let lastEnd = 0;
  for (const match of clauseSpans(text)) {
    // Contrast conjunctions end the preceding cue's scope even without a comma.
    for (const piece of pieces(match.text)) {
      const raw = piece.text;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const start = match.index + piece.start + raw.indexOf(trimmed);
      const end = start + trimmed.length;
      const boundary = text.slice(lastEnd, start);
      const subjectReset = /[。；;.！!\r\n]/.test(boundary) || /[?？]$/.test(previous?.text??'')
        || R.patient_start.test(trimmed) || R.patient_report.test(trimmed);
      const hardReset = subjectReset || R.contrast_start.test(trimmed);
      // Contrast and a change of time end a polarity cue, not necessarily the
      // subject. "母亲胸痛，但目前无气促" must not become patient evidence.
      const inherited = !subjectReset && previous ? { ...defaults, temporality: previous.temporality, experiencer: previous.experiencer } : defaults;
      const mentions = [];
      for (const member of trimmed.matchAll(/[^、]+/g)) {
        const value = member[0].trim();
        if (!value) continue;
        const memberStart = start + member.index + member[0].indexOf(value);
        const prev = mentions.at(-1) ?? (!hardReset ? previous?.mentions?.at(-1) : null);
        const a = classify(value, mentions.length ? mentions.at(-1) : inherited);
        if (a.cue) a.cue = { ...a.cue, start: memberStart + a.cue.start, end: memberStart + a.cue.end, offset_unit: 'utf16' };
        let dependency = a.cue ? 'explicit_cue' : 'none';
        // 顿号 binds coordinated complements over arbitrary distance, not a
        // fixed character window. A new predicate/subject stops inheritance.
        const listComplement = mentions.length && ['negative', 'uncertain', 'not_evaluated', 'not_mentioned'].includes(prev?.presence);
        const commaComplement = ['negative', 'uncertain'].includes(prev?.presence) && R.bare_finding.test(value);
        if (!a.cue && (listComplement || commaComplement) && a.experiencer === prev.experiencer
          && !R.new_predicate.test(value) && !R.current.test(value) && !R.patient_start.test(value)
          && !R.contrast_start.test(value) && !R.hypothetical.test(value) && prev.cue?.direction !== 'backward') {
          a.presence = prev.presence; a.presence_label = LABELS[a.presence]; a.cue = prev.cue;
          dependency = mentions.length ? 'coordinated_complement' : 'comma_bare_finding';
        }
        mentions.push({ text: value, span: value, start: memberStart, end: memberStart + value.length,
          offset_unit: 'utf16', ...a, dependency });
      }
      // Explicit "均" binds a postposed negative to the whole enumeration.
      // Do not generalize this to "肺炎待排、糖尿病" or other ambiguous lists.
      const last=mentions.at(-1);
      if (last?.presence==='negative' && /均(?:[无無]|[阴陰]性)$/.test(last.text)) {
        for(const m of mentions.slice(0,-1)) if(!m.cue && m.experiencer === last.experiencer && m.temporality === last.temporality) {
          m.presence='negative';m.presence_label=LABELS.negative;m.cue=last.cue;m.dependency='postposed_coordination';
        }
      }
      if (!mentions.length) continue;
      const clause = { text: trimmed, span: trimmed, start, end, offset_unit: 'utf16', ...summarize(mentions),
        rule_version: CN_ASSERTION_RULE_VERSION, mentions };
      clauses.push(clause); previous = clause; lastEnd = end;
    }
  }
  return clauses;
}

export function extractConTextAssertion(sentence = '') {
  const clauses = extractConTextAssertions(sentence);
  if (!clauses.length) return { ...classify(''), scope_status: 'empty' };
  return { ...summarize(clauses), rule_version: CN_ASSERTION_RULE_VERSION, clauses };
}
