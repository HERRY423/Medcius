// Versioned, bounded ConText-style rules. These are shallow cue/coordination
// dependencies, not a trained Chinese dependency parser or a diagnosis model.
export const CN_ASSERTION_RULE_VERSION = 'cn-context-2';
export const CN_ASSERTION_RULES = Object.freeze({
  uncertain: /疑似|待查|待排|可能|拟诊|不除外|不能排除|未排除|不排除|考虑|倾向|(?<![a-z])R\s*\/\s*O(?![a-z])|\brule\s+out\b|[?？]/i,
  not_evaluated: /未查|未行|未做|未予评估|未及|未测|未见检查|未评估/,
  pseudo_negation: /(?:无|未见|没有|未有|未诉)(?:明显)?(?:缓解|好转|下降|减轻|改善|消退|变化|诱因)|无创|无痛(?:胃镜|肠镜|检查)|无力/g,
  negative: /否认|未触及|未闻及|未诉|未出现|未发生|未有|不伴|阴性|未见|没有|无/,
  family: /母亲|父亲|父母|家族|兄弟|姐妹|哥哥|弟弟|姐姐|妹妹|爷爷|奶奶|外公|外婆|同胞/,
  historical: /既往|曾(?:于|行|患)|[0-9一二三四五六七八九十数]+\s*(?:年|月)前|病史/,
  current: /^(?:患者|本人)?(?:目前|现在|现有|现无|今日|今天)/,
  hypothetical: /若出现|如发生|必要时|如果|一旦|警惕/,
  resolved: /(?<!未)(?<!未曾)(?:已愈|治愈|已痊愈|已恢复正常|已消失|已消退)/,
  recovered: /术后恢复(?:可|良好|顺利)/,
  // A comma carries negation ONLY onto this closed list; a 顿号 is stronger
  // evidence of coordination, but explicit new predicates always stop scope.
  bare_finding: /^(?:(?:发热|胸闷|胸痛|咳嗽|咳痰|气促|呼吸困难|心悸|腹痛|腹泻|恶心|呕吐|水肿|干湿啰音|干啰音|湿啰音|压痛|反跳痛)(?:及|和|或)?)+$/,
  predicate_boundary: /但是|然而|不过|但|而|偶有|伴有|伴随|伴|出现|现有|现无|目前|现在|今日|患者|本人/g,
});
