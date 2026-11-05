// Fabricated names, addresses and narratives only; no patient-derived material.
export function syntheticNerTexts() {
  const names=['王建国','林志明','欧阳明远','司马文宁','陈志清','张云海','李桂芬','赵星竹'];
  const starts=['今晨','合成病程记录：','患者','昨日查房，','𠮷😀','Ｒ／Ｏ ','Zhang Synthetic '];
  const tails=['无发热、咳嗽、胸闷，偶有咳痰。','术后恢复可。','居住于和平路28号3栋602室。',
    '由其女儿林志明陪同，药物过敏史不详。','血钾3.9mmol/L，尿量1000mL。','主治医师王建国查房后记录。','急诊拟收住院，建议复查血常规。'];
  return [...Array.from({length:256},(_,i)=>starts[i%starts.length]+(i<224?'':'合成病程，无头痛。'.repeat(18+i%18))
    +names[i%8]+tails[Math.floor(i/8)%tails.length]+(i%3===0?'家属赵星竹来院。':'')),
    '', '，。；！？', '[REDACTED:LOCAL_ENTITY]', '𠮷野明，Ａｌｉｃｅ，和平路２８号', '李桂芬'.repeat(87)];
}
