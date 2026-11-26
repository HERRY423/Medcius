// Supplemental privacy candidates, NOT neural PERSON predictions or confirmed
// patient identities. Requires an OOV Han character in the pinned tokenizer,
// a clause-initial short subject and an explicit clinical predicate. Never seed
// the patient dictionary from these guesses or propagate them to another note.
import {sha256Hex} from '../servers/shared/crypto.mjs';
import {CLINICAL_HERBS} from './phi-clinical-literals.mjs';
import {COMPOUND_SURNAMES} from './cn-surnames.mjs';
export const OOV_SUBJECT_POLICY='cn-oov-clinical-subject-v1';
export const CONTEXT_SUBJECT_POLICY='cn-source-subject-probe-v3';
export const MAX_CONTEXT_SUBJECTS=64;
export const MAX_CONTEXT_OCCURRENCES=512;
const SEP='[ \\t\\p{Cf}]*';
const SUBJECT_PREFIX='(?:^|[。；;，,！？!?\\r\\n：:])(?:[ \\t\\p{Cf}]|\\p{Extended_Pictographic})*'
  +'(?:(?:今日|今晨|昨日|昨晚|目前|现在|入院时)'+SEP+')?'
  +'(?:(?<person>患者|病人|患儿)'+SEP+')?'
  +'(?<name>\\p{Script=Han}(?:'+SEP+'\\p{Script=Han}){1,3}?)'+SEP
  +'(?:(?:今日|今晨|目前|现在|现|仍)'+SEP+')?';
const SYMPTOM_PREDICATE='(?<cue>自述|自诉|主诉|未诉|否认|诉|无|有|出现)(?=(?:明显|反复|持续|偶有|突发)?(?:胸闷|胸痛|发热|咳嗽|咳痰|气促|头痛|头晕|恶心|呕吐|腹痛|腹泻|水肿|皮疹|心悸|压痛|寒战|乏力|气短|尿血|出血))';
// First-person reports can introduce complaints outside the symptom vocabulary.
// In this wider frame only a surname-shaped subject can trigger the crop.
const REPORT_PREDICATE='(?:自述|自诉|主诉|诉称|诉说|反映|表示|自觉|自感|提到|回忆|称自己)(?=[\\p{Script=Han}“「])';
const CONTEXT=new RegExp(SUBJECT_PREFIX+'(?:'+SYMPTOM_PREDICATE+'|'+REPORT_PREDICATE+')','dgu');
// Only veto this supplemental heuristic. Neural spans and supplied identities
// remain authoritative for redaction even when they overlap a clinical word.
const NON_NAME=/(?:患者|病人|患儿|本人|家属|医师|医生|护士|主任|主治|术后|术前|反复|持续|主动|药|骨|关节|静脉|动脉|神经|淋巴|胸|腹|肺|肝|肾|脾|胃|肠|膀胱|腘|囟|痈|疽|疬|癧|癥|瘕|痃|癖|痿|躄|喑|哑|瘰|胼|胝|瘢|疮|癣|疹|瘤|症|炎|病|征|痛|痒)/u;
const HERBS=new Set(CLINICAL_HERBS);
const CLINICAL_SUBJECT=/^(?:房颤|房扑|黄疸|贫血|低钠|低钾|低血糖|血糖|白细胞|白蛋白|眩晕|失眠|便秘|失语|消瘦|黑便|小便|大便|吞咽|进食|活动|平卧|夜间|今晨|昨日|近期|偶尔|明显|长期|早期|近日|目前|今日)$/u;
const excluded=name=>NON_NAME.test(name)||HERBS.has(name)||CLINICAL_SUBJECT.test(name);

// Compound surnames supply more evidence than a single surname character.
// Exclude place, clinical, role and grammatical suffixes. Common ambiguous
// compounds and single surnames additionally require given-name characters.
const SINGLE_SURNAME=/^[查郤郄郗郜仉覃解单邰缪隗逯翟邢薄芮蔺晏郦谌宓阚虞晁闵卞宦瞿佘嵇鄢郏郇訾庾龚袁贺韩许冯曹彭何蒋谢郑朱胡梁宋唐邓沈顾程姚傅汪潘范苏田白陆罗林王李张陈刘黄赵周吴孙徐马]/u;
// For these distinctive surnames an unlisted given character is permissible.
const DISTINCTIVE_SINGLE=/^[郤郄郗郜仉邰缪隗逯翟邢蔺郦谌阚晁卞瞿佘嵇鄢郏郇訾庾龚邹郝耿]/u;
const GIVEN_NAME=/^[祎泠珺瑾玥瑜璟珩琛玮昕栩祉祺祯祐祈祚祥晗晞晟昱昀旻暄皓琬瑶琦瑄琳瑛璇琰涵沅澄洵泓沐清沁湛苒芷菡荻芊绫绮婉宁妍蓁桐槿楠榆柏梓睿熙翎翊宸]{1,2}$/u;
const AMBIGUOUS_COMPOUND=/^(?:东方|公羊|长孙|太史|濮阳)$/u;
const NON_PERSON_END=/(?:市|县|区|镇|乡|村|街|路|院|科|组|室|口|侧|部|段|处|站|床|者|人|氏|家|方|穴|体|血|属|诉|伴|可|拟|后|前|来|时|间|中|长|仍|又|再|仅|已|也|才|均|较|稍|偶|常|今|昨|晨|晚|曾|称|述|说|片|膜|层|剂|液|丸|散|膏)$/u;

export function hasSurnameGivenNameShape(crop) {
  const name=crop.replace(/[ \t\p{Cf}]/gu,'');
  if(excluded(name)||NON_PERSON_END.test(name)) return false;
  const compound=COMPOUND_SURNAMES.exec(name)?.[0];
  if(compound) {
    const given=name.slice(compound.length);
    return AMBIGUOUS_COMPOUND.test(compound)?GIVEN_NAME.test(given):/^\p{Script=Han}{1,2}$/u.test(given);
  }
  if(DISTINCTIVE_SINGLE.test(name)) return /^\p{Script=Han}{1,2}$/u.test(name.slice(1));
  return SINGLE_SURNAME.test(name)&&GIVEN_NAME.test(name.slice(1));
}

function eligibleContext(match,name) {
  return !NON_NAME.test(name)&&!CLINICAL_SUBJECT.test(name)&&(!HERBS.has(name)||!!match.groups.person)
    &&(!!match.groups.cue||hasSurnameGivenNameShape(name));
}

export function findOovSubjectSpans(text,isUnknownHan) {
  if(typeof text!=='string'||!text.isWellFormed()||typeof isUnknownHan!=='function') throw new Error('LOCAL_NER_SUBJECT_INPUT_INVALID');
  const spans=[];
  for(const m of text.matchAll(CONTEXT)) {
    const name=m.groups.name.replace(/[\s\p{Cf}]/gu,'');
    if(excluded(name)||(!m.groups.cue&&!hasSurnameGivenNameShape(name))||!Array.from(name).some(isUnknownHan)) continue;
    const [start,end]=m.indices.groups.name;
    spans.push({start,end,label:'PERSON',method:'oov_han_clinical_subject'});
  }
  return spans;
}

// These are bounded candidates, not redaction decisions. No inserted prompt,
// fabricated patient context or global name dictionary. The detector must run
// the same pinned model on the exact source crop before applying either method.
export function findContextSubjectCandidates(text,isUnknownHan,covered=[]) {
  const candidates=[];
  for(const m of text.matchAll(CONTEXT)) {
    const name=m.groups.name.replace(/[\s\p{Cf}]/gu,'');
    const [start,end]=m.indices.groups.name;
    // A herb may be a person's actual name. A direct human subject cue can
    // request neural review, but it does not override anatomical/role vetoes
    // or itself authorize masking. Medication contexts still remain separate.
    if(!eligibleContext(m,name)
      ||Array.from(name).some(isUnknownHan)||covered.some(s=>s.start<=start&&s.end>=end)) continue;
    candidates.push({start,end});
    if(candidates.length>MAX_CONTEXT_OCCURRENCES) throw new Error('LOCAL_NER_SUBJECT_LIMIT');
  }
  return candidates;
}

export function validateContextSubjectSpans(text,screening) {
  if(screening===undefined) return [];
  if(screening?.policy!==CONTEXT_SUBJECT_POLICY||screening.complete!==true||!Number.isInteger(screening.probe_count)
    ||screening.probe_count<0||screening.probe_count>MAX_CONTEXT_SUBJECTS||!Number.isInteger(screening.candidate_count)
    ||!Number.isInteger(screening.reused_input_count??0)||(screening.reused_input_count??0)<0||(screening.reused_input_count??0)>screening.probe_count
    ||screening.candidate_count<screening.probe_count||screening.candidate_count>MAX_CONTEXT_OCCURRENCES
    ||(screening.candidate_count>0&&screening.probe_count===0)||!Array.isArray(screening.spans)
    ||screening.spans.length>screening.candidate_count) throw new Error('LOCAL_PHI_CONTEXT_RESULT_INVALID');
  const seen=new Set();
  let positions;
  return screening.spans.map(s=>{
    const rule=s?.method==='surname_subject_rule';
    if(s?.label!=='PERSON'||(!rule&&s.method!=='source_crop_ner')||!Number.isInteger(s.start)||!Number.isInteger(s.end)
      ||s.start<0||s.end<=s.start||s.end>text.length||!text.slice(s.start,s.end).isWellFormed()
      ||!/^(?:\p{Script=Han}[ \t\p{Cf}]*){2,4}$/u.test(text.slice(s.start,s.end))
      ||s.probe_text_sha256!==sha256Hex(text.slice(s.start,s.end))||seen.has(`${s.start}:${s.end}`)) throw new Error('LOCAL_PHI_CONTEXT_RESULT_INVALID');
    if(!positions) {
      positions=new Map();
      for(const match of text.matchAll(CONTEXT)) {
        const name=match.groups.name.replace(/[ \t\p{Cf}]/gu,'');
        if(eligibleContext(match,name)) positions.set(match.indices.groups.name.join(':'),hasSurnameGivenNameShape(name));
      }
    }
    const key=s.start+':'+s.end;
    if(!positions.has(key)||(rule&&!positions.get(key))) throw new Error('LOCAL_PHI_CONTEXT_RESULT_INVALID');
    seen.add(`${s.start}:${s.end}`);return {start:s.start,end:s.end,label:s.label};
  });
}

export function validateOovSubjectSpans(text,screening) {
  if(screening===undefined) return [];
  if(screening?.policy!==OOV_SUBJECT_POLICY||!Array.isArray(screening.spans)) throw new Error('LOCAL_PHI_SUBJECT_RESULT_INVALID');
  return screening.spans.map(s=>{
    if(!s||s.label!=='PERSON'||s.method!=='oov_han_clinical_subject'||!Number.isInteger(s.start)||!Number.isInteger(s.end)
      ||s.start<0||s.end<=s.start||s.end>text.length||!text.slice(s.start,s.end).isWellFormed()
      ||!/^(?:\p{Script=Han}[ \t\p{Cf}]*){2,4}$/u.test(text.slice(s.start,s.end))) throw new Error('LOCAL_PHI_SUBJECT_RESULT_INVALID');
    return {start:s.start,end:s.end,label:s.label};
  });
}
