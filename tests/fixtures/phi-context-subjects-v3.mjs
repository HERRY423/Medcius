// Authored synthetic development cases, fixed before the v3 implementation.
// Original v1/v2 cohorts remain unchanged. These are not independent patients.
const make=(id,category,text,phi=[],keep=[])=>({id,category,text,phi:phi.map(value=>{
  const start=text.indexOf(value);if(start<0) throw new Error('FIXTURE_SPAN');
  return {start,end:start+value.length};
}),keep});
const names=['郤珺','邰珺','隗瑾','郜珺','邢珺','屠瑾','令狐珺','欧阳瑾','王珺','司徒珺'];
const positives=names.flatMap((name,i)=>[
  make(`context-${i}-report`,'context_name',`${name}诉胸闷。`,[name],['诉胸闷。']),
  make(`context-${i}-negative`,'context_name',`${name}无发热。`,[name],['无发热。']),
  make(`context-${i}-patient`,'context_name',`患者${name}自述胸痛，血钾正常。`,[name],['患者','自述胸痛，血钾正常。']),
]);
const subjects=['房颤','房扑','黄疸','贫血','低钠','低钾','低血糖','白细胞','白蛋白','巨细胞','脂肪肝','脑梗','眩晕','失眠','便秘','失语','消瘦','黑便',
  '小便','大便','吞咽','进食','活动','平卧','夜间','今晨','昨日','近期','偶尔','明显','反复','家属','患者','主管护士','主治医师',
  '瘰疬','瘰癧','癥瘕','痃癖','痿躄','腘窝','囟门','胼胝','颞颌关节'];
const clinical=subjects.map((word,i)=>make(`clinical-subject-${i}`,'clinical_subject',`${word}无发热。`,[],[`${word}无发热。`]));
const herbs=['杜仲','苏木','陈皮','白术','白芍','何首乌','刘寄奴','徐长卿','王不留行','夏枯草','黄芪','黄连','麦冬','秦艽','郁金','茯苓','半夏','当归','甘草','朱砂','常山','海金沙'];
const medications=herbs.flatMap((word,i)=>[
  make(`herb-${i}-dose`,'medication_context',`中药处方：${word}10g，每日一剂。`,[],[`中药处方：${word}10g，每日一剂。`]),
  make(`herb-${i}-effect`,'medication_context',`服用${word}后无发热。`,[],[`服用${word}后无发热。`]),
]);
const boundaries=[
  make('context-unicode','context_name','😀郤\u200b 珺诉胸闷。',['郤\u200b 珺'],['诉胸闷。']),
  make('context-repeated-literal','mixed','郤珺诉胸闷。房颤无胸闷，黄疸无发热。',['郤珺'],['诉胸闷。','房颤无胸闷，黄疸无发热。']),
  make('context-crlf','context_name','病程记录：\r\n郤珺无发热。',['郤珺'],['病程记录：\r\n','无发热。']),
  make('drug-and-person','mixed','中药处方：杜仲10g。患者杜仲无发热。',['患者杜仲'.slice(2)],['中药处方：','10g。','患者','无发热。']),
  make('drug-list','medication_context','中药处方：杜仲10g、徐长卿6g、刘寄奴9g。',[],['中药处方：杜仲10g、徐长卿6g、刘寄奴9g。']),
  make('drug-prescription-newline','medication_context','中药处方：\r\n杜仲10g\r\n徐长卿6g，每日一剂。',[],['中药处方：\r\n杜仲10g\r\n徐长卿6g，每日一剂。']),
  make('existing-drugs','medication_context','阿司匹林肠溶片、呋塞米片，无发热。',[],['阿司匹林肠溶片、呋塞米片，无发热。']),
];
// In this mixed case the second occurrence is the person; preserve the first
// clinical occurrence. Position scoring must not count an intact duplicate as
// evidence that a different occurrence was preserved.
const mixed=boundaries.find(f=>f.id==='drug-and-person');
mixed.phi=[{start:mixed.text.lastIndexOf('杜仲'),end:mixed.text.lastIndexOf('杜仲')+2}];
mixed.keep=['中药处方：杜仲10g。','患者','无发热。'];
export const phiContextSubjectsV3=Object.freeze([...positives,...clinical,...medications,...boundaries]);
