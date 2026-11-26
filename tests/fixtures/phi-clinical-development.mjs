// Authored synthetic development cases, not independent clinical validation.
// Expected entity spans and retained clinical text are fixed before the repair.
const row = (id, category, text, phi = [], keep = [], metadata = {}) => ({ id, category, text,
  phi: phi.map(value => { const start=text.indexOf(value); if(start<0) throw new Error('fixture'); return {start,end:start+value.length}; }),
  keep, metadata });
export const phiClinicalDevelopment = [
  row('rare-known','known_name','郄芃诉胸闷。',['郄芃'],['胸闷'],{patient:{name:'郄芃'}}),
  row('astral-known','known_name','😀𠮷玥无发热。',['𠮷玥'],['无发热'],{patient:{name:'𠮷玥'}}),
  row('separated-known','known_name','郄\u200b 芃诉胸痛。',['郄\u200b 芃'],['胸痛'],{patient:{name:'郄芃'}}),
  row('rare-unseeded','unseeded_name','郄芃诉胸闷。',['郄芃'],['胸闷']),
  row('astral-unseeded','unseeded_name','𠮷玥无发热。',['𠮷玥'],['无发热']),
  row('ordinary-unseeded','unseeded_name','王建国因胸痛入院。',['王建国'],['胸痛']),
  row('staff-title','clinician_alias','郄主任查房，无发热。',['郄主任'],['无发热'],{practitioners:[{name:'郄芃'}]}),
  row('staff-compound','clinician_alias','欧阳大夫会诊，考虑肺炎。',['欧阳大夫'],['考虑肺炎'],{practitioners:[{name:'欧阳星澜'}]}),
  row('staff-nurse','clinician_alias','𠮷护士交班，尿量正常。',['𠮷护士'],['尿量正常'],{practitioners:[{name:'𠮷玥'}]}),
  row('staff-familiar','clinician_alias','老郄查房后记录胸痛缓解。',['老郄'],['胸痛缓解'],{practitioners:[{name:'郄芃',aliases:['老郄']}]}),
  row('staff-note-author','clinician_alias','郄老师已阅，血钾正常。',['郄老师'],['血钾正常'],{notes:[{author:{display:'郄芃'}}]}),
  row('hospital-alias','institution','转自芃院，诊断肺炎。',['芃院'],['诊断肺炎'],{organizations:[{name:'合成芃禾医院',aliases:['芃院']}]}),
  row('hospital-name','institution','合成芃禾医院复查血常规。',['合成芃禾医院'],['复查血常规'],{organizations:[{name:'合成芃禾医院'}]}),
  row('ward-alias','institution','芃院心内二区查房，胸痛缓解。',['芃院心内二区'],['胸痛缓解'],{locations:[{name:'合成芃禾医院心内科第二病区',aliases:['芃院心内二区']}]}),
  row('encounter-org','institution','芃禾分院转入，血压正常。',['芃禾分院'],['血压正常'],{encounter:{serviceProvider:{display:'芃禾分院'}}}),
  row('unusual-address','address','住在𠮷垚村，现无胸闷。',['𠮷垚村'],['现无胸闷'],{patient:{address:{text:'𠮷垚村'}}}),
  row('address-city','address','芃禾镇居住，现无胸闷。',['芃禾镇'],['现无胸闷'],{patient:{address:{city:'芃禾镇'}}}),
  row('address-number','address','住青禾路31号2栋101室。',['青禾路31号2栋101室'],[],{patient:{address:{line:['合成市合成区青禾路28号']}}}),
  row('medicine-aspirin','clinical_preservation','继续阿司匹林肠溶片。',[],['阿司匹林肠溶片']),
  row('medicine-loop','clinical_preservation','继续呋塞米片及螺内酯片。',[],['呋塞米片','螺内酯片']),
  row('clinical-terms','clinical_preservation','主治医师查房，高血压、白血病、黄疸待查。',[],['主治医师','高血压','白血病','黄疸']),
  row('clinical-specialty','clinical_preservation','心内科会诊，胸痛缓解。',[],['心内科','胸痛缓解']),
  row('clinical-ambiguous-alias','clinical_preservation','高血压患者胸闷。',[],['高血压','胸闷'],{practitioners:[{name:'高明'}]}),
  row('dictionary-overrides-drug','clinical_name_collision','呋塞米片来访。',['呋塞米片'],[],{patient:{name:'呋塞米片'}}),
];

export function phiFixtureSource(fixture, index=0) {
  const context={tenant_id:'synthetic-site',ward_id:'synthetic-ward',patient_id:`synthetic-p-${index}`,
    encounter_id:`synthetic-e-${index}`,phi_session_id:`synthetic-s-${index}`};
  return {...structuredClone(fixture.metadata), context,
    patient:{id:context.patient_id,...fixture.metadata.patient},encounter:{id:context.encounter_id,...fixture.metadata.encounter}};
}
