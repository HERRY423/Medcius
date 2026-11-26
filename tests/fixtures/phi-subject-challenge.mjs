// Authored synthetic development/negative controls. Not an independent clinical
// benchmark. Fixed before v2 implementation; never used to train the NER model.
const make=(id,category,text,entity,keep)=>({id,category,text,keep,phi:entity?[{start:text.indexOf(entity),end:text.indexOf(entity)+entity.length}]:[]});
const names=['郄芃','𠮷玥','仉澂','逯祎','郢珩','𡌶宁','郤珺','𠮷祺'];
const positive=names.flatMap((name,i)=>[
  make(`oov-${i}-report`,'oov_subject',`${name}诉胸闷。`,name,['诉胸闷']),
  make(`oov-${i}-negative`,'oov_subject',`${name}无发热。`,name,['无发热']),
  make(`oov-${i}-context`,'oov_subject',`今晨患者${name}自述胸痛，血钾正常。`,name,['今晨患者','自述胸痛','血钾正常']),
  make(`oov-${i}-time`,'oov_subject',`病程记录：${name}今日否认胸痛。`,name,['病程记录：','今日否认胸痛']),
]);
const subjects=['患者','患儿','本人','家属','主治医师','主管护士','高血压','白血病','黄疸','心悸','胸闷','胸痛','气促',
  '双肺','心脏','胸部','腹部','肝脏','肾脏','腘窝','囟门','胼胝','瘢痕','瘰疬','瘰癧','癥瘕','痃癖','痿躄','喑哑',
  '痈疽','痤疮','腓骨','肱骨','髌骨','股癣','斑疹','淋巴结','术后','高龄','脾脏','跖趾关节','颞颌关节'];
const negative=subjects.map((s,i)=>make(`medical-${i}`,'clinical_negative',`${s}无发热。`,null,[s,'无发热']));
const boundaries=[
  make('astral-prefix','unicode_subject','😀𠮷玥诉胸闷。','𠮷玥',['诉胸闷']),
  make('invisible-space','unicode_subject','郄\u200b 芃诉胸痛。','郄\u200b 芃',['诉胸痛']),
  make('crlf-subject','unicode_subject','病程记录：\r\n𠮷玥无发热。','𠮷玥',['无发热']),
  make('clinical-predicate','clinical_negative','反复诉胸痛。主动诉胸闷。持续诉头痛。',null,['反复诉胸痛','主动诉胸闷','持续诉头痛']),
  make('ordinary-drugs','clinical_negative','阿司匹林肠溶片、呋塞米片，未诉胸闷。',null,['阿司匹林肠溶片','呋塞米片','未诉胸闷']),
  make('oov-compound','oov_subject','欧阳澂玥诉胸痛。','欧阳澂玥',['诉胸痛']),
];
export const phiSubjectChallenge=Object.freeze([...positive,...negative,...boundaries]);
