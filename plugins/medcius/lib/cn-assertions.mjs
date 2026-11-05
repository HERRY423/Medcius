// Verbatim UTF-16 offsets; slash abbreviations remain atomic. Existing clause
// callers retain their shape, with mention-level cue and coordination links.
import { CN_ASSERTION_RULES as R, CN_ASSERTION_RULE_VERSION } from './cn-assertion-rules.mjs';
const LABELS = { positive: '【阳性/现症】', negative: '【阴性/否定】', uncertain: '【疑似/待查】', not_evaluated: '【未评估】', not_mentioned: '【未提及】' };

function classify(text, defaults = {}) {
  let presence = !text ? 'not_mentioned' : 'positive';
  // Keep string length so cue anchors still index the original input.
  const withoutPseudo = text.replace(R.pseudo_negation, m => ' '.repeat(m.length));
  const rule = ['uncertain', 'not_evaluated', 'negative'].find(k => R[k].test(withoutPseudo));
  if (rule) presence = rule;
  const cue = rule ? R[rule].exec(withoutPseudo) : null;
  let temporality = defaults.temporality ?? 'current';
  if (R.current.test(text)) temporality = 'current';
  if (R.historical.test(text)) temporality = 'historical';
  if (R.hypothetical.test(text)) temporality = 'hypothetical';
  let experiencer = defaults.experiencer ?? 'patient';
  if (R.family.test(text)) experiencer = 'family_member';
  else if (/同室|其他患者/.test(text)) experiencer = 'other';
  else if (/^(?:患者|本人)/.test(text)) experiencer = 'patient';
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
  for (const m of text.matchAll(R.predicate_boundary)) {
    if (!m.index) continue;
    const left = text.slice(0, m.index);
    // "未出现", "无明显诱因出现" and "不能排除" are indivisible.
    if (/未$|不$|若$|如$|一旦$|并未$/.test(left) || /无明显诱因$/.test(left)
      || /^(?:但是|然而|不过|但|而)$/.test(text.slice(cuts.at(-1), m.index))) continue;
    if (/^(?:但是|然而|不过|但|而)$/.test(m[0]) || R.negative.test(left) || R.uncertain.test(left)
      || R.historical.test(left) || R.family.test(left)) cuts.push(m.index);
  }
  cuts.push(text.length);
  return cuts.slice(0, -1).map((start, i) => ({ text: text.slice(start, cuts[i+1]), start }));
}

export function extractConTextAssertions(input = '', defaults = {}) {
  const text = String(input ?? '');
  const clauses = [];
  let previous = null;
  let lastEnd = 0;
  for (const match of text.matchAll(/[^，,。；;\r\n]+/g)) {
    // Contrast conjunctions end the preceding cue's scope even without a comma.
    for (const piece of pieces(match[0])) {
      const raw = piece.text;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const start = match.index + piece.start + raw.indexOf(trimmed);
      const end = start + trimmed.length;
      const boundary = text.slice(lastEnd, start);
      const hardReset = /[。；;\r\n]/.test(boundary) || /^(?:但是|然而|不过|但|而|患者|本人)/.test(trimmed);
      const inherited = !hardReset && previous ? { ...defaults, temporality: previous.temporality, experiencer: previous.experiencer } : defaults;
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
        if (!a.cue && prev && (mentions.length || R.bare_finding.test(value))
          && !/^(?:偶有|伴|出现|现有|现无|目前|现在|今日|患者|本人|但|而)/.test(value)
          && prev.cue?.direction !== 'backward' && ['negative', 'uncertain', 'not_evaluated'].includes(prev.presence)) {
          a.presence = prev.presence; a.presence_label = LABELS[a.presence]; a.cue = prev.cue;
          dependency = mentions.length ? 'coordinated_complement' : 'comma_bare_finding';
        }
        mentions.push({ text: value, span: value, start: memberStart, end: memberStart + value.length,
          offset_unit: 'utf16', ...a, dependency });
      }
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
