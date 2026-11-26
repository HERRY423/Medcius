// Local descriptive comparison; counts are development fixtures, not patients.
import { ASSERTION_CASES } from '../tests/fixtures/cn-messy-notes.mjs';
import { extractConTextAssertions } from '../plugins/medcius/lib/cn-assertions.mjs';
import { createHash } from 'node:crypto';
const axes = m => [m.text,m.presence,m.temporality,m.experiencer];
let exact = 0, matched = 0, expectedCount = 0, predictedCount = 0;
const cases = ASSERTION_CASES.map(c => {
  const predictions = extractConTextAssertions(c.text).flatMap(x=>x.mentions);
  const remaining = c.expected.map(x=>JSON.stringify(x));
  let hits = 0;
  for (const p of predictions) {
    if(c.text.slice(p.start,p.end)!==p.text) throw new Error('FIXTURE_ANCHOR_INVALID');
    const i=remaining.indexOf(JSON.stringify(axes(p)));
    if(i>=0) { hits++;remaining.splice(i,1); }
  }
  const ok=hits===c.expected.length && predictions.length===c.expected.length;
  exact+=Number(ok);matched+=hits;expectedCount+=c.expected.length;predictedCount+=predictions.length;
  return {id:c.id,exact:ok,expected:c.expected,predicted:predictions.map(axes)};
});
console.log(JSON.stringify({identity:'cn-messy-development-v1',scope:'SYNTHETIC_DEVELOPMENT_ONLY',
  fixture_sha256:createHash('sha256').update(JSON.stringify(ASSERTION_CASES)).digest('hex'),
  case_count:cases.length,exact_cases:exact,matched_mentions:matched,expected_mentions:expectedCount,predicted_mentions:predictedCount,
  precision:matched/predictedCount,recall:matched/expectedCount,independence:'NOT_ESTABLISHED',clinical_evidence:'NOT_ESTABLISHED',cases},null,2));
