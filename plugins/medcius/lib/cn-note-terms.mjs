// Bounded lexical aliases, not codes or inferred diagnoses. Surface text is
// always preserved. Ambiguous abbreviations never receive a default expansion.
export const CN_TERM_VERSION = 'cn-note-terms-1';
const TERMS = [
  ['慢性阻塞性肺疾病急性加重', /\bAECOPD\b|COPD急性加重|慢性阻塞性肺疾病急性加重/gi],
  ['慢性阻塞性肺疾病', /\bCOPD\b|慢性阻塞性肺疾病/gi],
  ['心房颤动', /心房颤动|房颤/g],
  ['心肌梗死', /心肌梗死|心梗/g], // "心梗" alone does not establish acuity.
  ['急性阑尾炎', /急性阑尾炎|急阑尾炎/g],
  ['腹腔镜胆囊切除术', /腹腔镜胆囊切除术|(?<![A-Za-z])LC术(?![A-Za-z])/gi],
  ['发热', /发热|发烧/g],
];
export function extractCnTerms(input) {
  const text=String(input??''), out=[];
  for(const [canonical,pattern] of TERMS) for(const m of text.matchAll(pattern)) {
    if(out.some(x=>m.index>=x.start && m.index+m[0].length<=x.end)) continue;
    out.push({span:m[0],start:m.index,end:m.index+m[0].length,offset_unit:'utf16',canonical,
      status:'lexical_alias_only',lexicon_version:CN_TERM_VERSION});
  }
  for(const m of text.matchAll(/(?<![A-Za-z])(?:PE|RA|MS)(?![A-Za-z])/g)) {
    out.push({span:m[0],start:m.index,end:m.index+m[0].length,offset_unit:'utf16',canonical:null,
      status:'ambiguous_abbreviation',lexicon_version:CN_TERM_VERSION});
  }
  return out.sort((a,b)=>a.start-b.start);
}
