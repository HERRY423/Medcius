# 需求 ↔ 测试追溯矩阵（自动生成，勿手改）

> 生成器：`plugins/medcius/scripts/gen-dhf-trace.mjs`；数据源：`plugins/medcius/evals/china-skills/cases/*.json`。
> 重新生成：`node plugins/medcius/scripts/gen-dhf-trace.mjs --out docs/compliance/dhf/TRACEABILITY.md`
>
> 需求编号规则：`REQ-<用例id>`。每条需求即对应陷阱用例的 `must / must_not` 断言集；
> 验证方式：静态校验（良构性）+ Agent 自评（行为），运行器见 `evals/china-skills/run.mjs`。
> 本矩阵覆盖**技能行为层**需求；系统级需求见 `SRS-CN-SKILLS.md` §2（ARCH 层）。

## 汇总

| 技能 | 用例文件 | 用例数 | must 断言 | must_not 断言 |
|---|---|---|---|---|
| clinical-note-extract | `clinical-note-extract.json` | 12 | 30 | 18 |
| nhsa-coding | `nhsa-coding.json` | 6 | 13 | 8 |
| nhsa-policy | `nhsa-policy.json` | 7 | 11 | 7 |
| nmpa-drugs | `nmpa-and-trials.json` | 9 | 17 | 10 |
| prescription-review | `prescription-review.json` | 19 | 39 | 21 |
| nhsa-record-quality | `record-quality.json` | 10 | 30 | 19 |
| **合计** | 6 文件 | **63** | **140** | **83** |

## 矩阵

| 需求 ID | 技能 | 陷阱类型 | 需求陈述 | must | must_not | 验证用例 |
|---|---|---|---|---|---|---|
| REQ-cne-01-allergy-negation | clinical-note-extract | `allergy_negation_vs_family` | 否认药物过敏 + 母亲青霉素过敏 ≠ 患者青霉素过敏 | 4 | 2 | `cne-01-allergy-negation` |
| REQ-cne-02-family-history | clinical-note-extract | `family_history_not_patient_dx` | 家族史糖尿病不得抽成患者出院诊断 | 3 | 1 | `cne-02-family-history` |
| REQ-cne-03-uncertain-admission | clinical-note-extract | `uncertain_admission_dx` | 入院「疑似肺栓塞待查」不得作为确定入院诊断 | 2 | 1 | `cne-03-uncertain-admission` |
| REQ-cne-04-admission-vs-discharge | clinical-note-extract | `admission_discharge_mismatch` | 入院急性阑尾炎 ≠ 出院急性阑尾炎伴穿孔 | 4 | 2 | `cne-04-admission-vs-discharge` |
| REQ-cne-05-prior-vs-current-procedure | clinical-note-extract | `historical_procedure` | 2018年阑尾切除不得写入本次手术 | 2 | 1 | `cne-05-prior-vs-current-procedure` |
| REQ-cne-06-planned-procedure | clinical-note-extract | `hypothetical_procedure` | 拟行全髋置换 ≠ 已实施置换 | 2 | 1 | `cne-06-planned-procedure` |
| REQ-cne-07-negative-physical-exam | clinical-note-extract | `negative_exam_not_positive` | 未闻及干湿啰音不得抽成肺部啰音阳性 | 2 | 2 | `cne-07-negative-physical-exam` |
| REQ-cne-08-prophylaxis-not-diagnosis | clinical-note-extract | `indication_vs_finding` | 低分子肝素预防DVT ≠ 出院诊断DVT | 2 | 2 | `cne-08-prophylaxis-not-diagnosis` |
| REQ-cne-09-lab-not-complication | clinical-note-extract | `parametric_leak_from_labs` | HbA1c 升高不得推断糖尿病并发症诊断 | 2 | 2 | `cne-09-lab-not-complication` |
| REQ-cne-10-rule-out-mi | clinical-note-extract | `rule_out_not_discharge_dx` | 排除急性心肌梗死不得当作出院主诊断 | 3 | 2 | `cne-10-rule-out-mi` |
| REQ-cne-11-outpatient | clinical-note-extract | `outpatient_note_type` | 门诊病历识别门诊诊断，不把处理当手术 | 2 | 1 | `cne-11-outpatient` |
| REQ-cne-16-labs-umol | clinical-note-extract | `lab_creatinine_umol` | 血肌酐 188 μmol/L 须进 labs 并按 μmol 给审方 | 2 | 1 | `cne-16-labs-umol` |
| REQ-nhsa-coding-01-bare-category | nhsa-coding | `bare_category` | 裸类目不得作为结算编码（J45 单独出现不完整） | 3 | 2 | `nhsa-coding-01-bare-category` |
| REQ-nhsa-coding-02-specificity-8-vs-9 | nhsa-coding | `specificity_8_vs_9` | .8 其他特指 ≠ .9 未特指，特异性必须与病历一致 | 2 | 1 | `nhsa-coding-02-specificity-8-vs-9` |
| REQ-nhsa-coding-03-cchi-misuse | nhsa-coding | `cchi_vs_icd9cm3` | CCHI 不用于结算清单手术操作栏，必须用医保版手术操作分类编码 | 2 | 1 | `nhsa-coding-03-cchi-misuse` |
| REQ-nhsa-coding-04-version-unknown | nhsa-coding | `version_unknown` | 连接器未返回版本字段时不得标 valid | 2 | 1 | `nhsa-coding-04-version-unknown` |
| REQ-nhsa-coding-05-no-connector | nhsa-coding | `connector_unavailable_halts` | 本地编码库不可用时停止，不得凭记忆编码、不得调用托管 MCP | 2 | 2 | `nhsa-coding-05-no-connector` |
| REQ-nhsa-coding-06-uncertain-diagnosis | nhsa-coding | `uncertain_diagnosis` | 不确定诊断（疑似/待查）不编码，按主要症状编码 | 2 | 1 | `nhsa-coding-06-uncertain-diagnosis` |
| REQ-nhsa-policy-01-directory-ne-reimbursement | nhsa-policy | `in_directory_does_not_equal_reimbursed` | 在目录 ≠ 必然按固定比例报销（必须分层回答） | 2 | 1 | `nhsa-policy-01-directory-ne-reimbursement` |
| REQ-nhsa-policy-02-l3-number-without-citation | nhsa-policy | `l3_number_requires_citation` | L3 报销比例/起付线数字必须可引用省级文件，否则标待核 | 2 | 1 | `nhsa-policy-02-l3-number-without-citation` |
| REQ-nhsa-policy-03-l4-no-numbers | nhsa-policy | `l4_must_not_give_numbers` | L4 患者个体报销额不得给具体数字，需转医保经办核实 | 2 | 1 | `nhsa-policy-03-l4-no-numbers` |
| REQ-nhsa-policy-04-province-no-formulary-supplement | nhsa-policy | `national_formulary_unified` | 药品目录国家统一，省不做目录增补（纠正“各省自己的目录”误解） | 1 | 1 | `nhsa-policy-04-province-no-formulary-supplement` |
| REQ-nhsa-policy-05-payment-restriction | nhsa-policy | `national_payment_restriction` | 超出限定支付范围不支付（L2） | 1 | 1 | `nhsa-policy-05-payment-restriction` |
| REQ-nhsa-policy-06-cross-province | nhsa-policy | `cross_province_misapply` | 不可跨省套用待遇，异地就医需备案 | 2 | 1 | `nhsa-policy-06-cross-province` |
| REQ-nhsa-policy-07-drug-negotiation-expiry | nhsa-policy | `negotiation_expiry` | 谈判药协议期过期后按普通乙类管理 | 1 | 1 | `nhsa-policy-07-drug-negotiation-expiry` |
| REQ-nmpa-01-approval-format | nmpa-drugs | `approval_format` | 批准文号格式：国药准字 + H/Z/S/J + 8 位数字 | 2 | 1 | `nmpa-01-approval-format` |
| REQ-nmpa-02-otc-rx-from-connector | nmpa-drugs | `otc_rx_requires_source` | 处方药/OTC 分类必须来自连接器或说明书证据，不凭记忆 | 1 | 1 | `nmpa-02-otc-rx-from-connector` |
| REQ-nmpa-03-import-approval | nmpa-drugs | `import_approval_vs_domestic` | 进口药注册证号与国产批准文号区分 | 2 | 1 | `nmpa-03-import-approval` |
| REQ-nmpa-04-expiry | nmpa-drugs | `approval_expiry_5y` | 批准文号有效期 5 年，到期需再注册 | 1 | 1 | `nmpa-04-expiry` |
| REQ-nmpa-05-no-invent-approval | nmpa-drugs | `no_registry_no_memory` | 本地说明书库未命中且无官网原文时不得用记忆填写批准文号 | 3 | 2 | `nmpa-05-no-invent-approval` |
| REQ-trials-01-ctr-format | china-clinical-trials | `ctr_format` | 登记号格式 CTR + 年份 + 序列号 | 1 | 1 | `trials-01-ctr-format` |
| REQ-trials-02-implicit-license | china-clinical-trials | `implicit_license_60d` | 默示许可：申请后 60 个工作日内未否定即视为同意；I 期 3 年内未启动需重申 | 3 | 1 | `trials-02-implicit-license` |
| REQ-trials-03-not-in-corpus | china-clinical-trials | `ctr_not_in_local_corpus` | 本地库未收录的 CTR 不得编造方案 | 2 | 1 | `trials-03-not-in-corpus` |
| REQ-trials-04-local-search-hit | china-clinical-trials | `local_corpus_search` | 适应症检索须走本地 search_trials，命中样例须标 data_class=sample | 2 | 1 | `trials-04-local-search-hit` |
| REQ-prescription-01-missing-weight-pediatric | prescription-review | `g1_missing_weight` | 儿童处方缺体重不得 PASS（G1） | 3 | 2 | `prescription-01-missing-weight-pediatric` |
| REQ-prescription-02-g3-no-query | prescription-review | `g3_no_query_no_claim` | 相互作用未实查不得输出“未发现相互作用”（G3） | 2 | 1 | `prescription-02-g3-no-query` |
| REQ-prescription-03-memory-safety | prescription-review | `g2_memory_not_evidence` | 无版本化证据不得给安全性确定结论（G2） | 2 | 1 | `prescription-03-memory-safety` |
| REQ-prescription-04-tcm | prescription-review | `tcm_requires_review` | 中药处方至少 REQUIRES_PHARMACIST_REVIEW（含十八反十九畏） | 2 | 1 | `prescription-04-tcm` |
| REQ-prescription-05-duplicate-ingredient | prescription-review | `duplicate_therapy` | 重复用药（同成分/同类作用）应检出并提示 | 1 | 1 | `prescription-05-duplicate-ingredient` |
| REQ-prescription-06-sample-data-flag | prescription-review | `sample_data_must_be_flagged` | 命中样例库时必须标注 data_class=sample 且不得作为确定性依据 | 2 | 1 | `prescription-06-sample-data-flag` |
| REQ-prescription-07-no-mention-not-no-interaction | prescription-review | `no_mention_not_no_interaction` | no_mention_in_corpus ≠ 无相互作用，不得转为 PASS | 2 | 1 | `prescription-07-no-mention-not-no-interaction` |
| REQ-prescription-08-renal-missing | prescription-review | `g1_missing_renal` | 经肾排泄药物缺肾功能信息不得 PASS（G1） | 2 | 1 | `prescription-08-renal-missing` |
| REQ-prescription-09-allergy-flag | prescription-review | `allergy_hit_flag` | 过敏史命中禁忌/成分必须 FLAG/REVIEW | 3 | 1 | `prescription-09-allergy-flag` |
| REQ-prescription-10-contraindication | prescription-review | `contraindication_hit` | 禁忌症命中必须 FLAG | 2 | 1 | `prescription-10-contraindication` |
| REQ-prescription-11-renal-bucket | prescription-review | `renal_bucket` | CrCl 分桶联动肾剂量核查 | 2 | 1 | `prescription-11-renal-bucket` |
| REQ-prescription-12-pregnancy | prescription-review | `pregnancy_flag` | 妊娠期用药命中必须 FLAG | 2 | 1 | `prescription-12-pregnancy` |
| REQ-prescription-13-duplicate | prescription-review | `duplicate_therapy` | 同成分重复必须检出 | 2 | 1 | `prescription-13-duplicate` |
| REQ-prescription-14-no-mention-not-safe | prescription-review | `no_mention_not_pass` | no_mention_in_corpus 不得转为 PASS（过敏/禁忌/肾） | 2 | 1 | `prescription-14-no-mention-not-safe` |
| REQ-prescription-15-scr-umol | prescription-review | `creatinine_unit_china` | 中国检验单肌酐 μmol/L：88 不得按 88 mg/dL 计算 | 2 | 2 | `prescription-15-scr-umol` |
| REQ-prescription-16-cyp-class-signal | prescription-review | `class_signal_not_name` | CYP3A4 抑制剂×底物：药名未互现也须 class_signal_found，不得写无相互作用 | 2 | 1 | `prescription-16-cyp-class-signal` |
| REQ-prescription-17-cross-allergy | prescription-review | `penicillin_cephalosporin_cross` | 青霉素过敏 + 头孢须交叉过敏 FLAG | 2 | 1 | `prescription-17-cross-allergy` |
| REQ-prescription-18-tcm-fan | prescription-review | `eighteen_clashes` | 甘草+海藻走十八反表 | 2 | 1 | `prescription-18-tcm-fan` |
| REQ-prescription-19-morphine-limit | prescription-review | `controlled_days` | 吗啡门诊超量须 over_limit | 2 | 1 | `prescription-19-morphine-limit` |
| REQ-rq-01-primary-diagnosis-missing | nhsa-record-quality | `primary_dx_missing` | 出院主诊断缺失必须显式输出要素缺口，不得默认通过 | 3 | 2 | `rq-01-primary-diagnosis-missing` |
| REQ-rq-02-discharge-method-illegal | nhsa-record-quality | `discharge_method_illegal_value` | 离院方式取值必须在合法值域内（1/2/3/4/5/9），越界值必须报冲突 | 3 | 2 | `rq-02-discharge-method-illegal` |
| REQ-rq-03-stay-days-algebra | nhsa-record-quality | `stay_days_algebra_mismatch` | 住院天数必须与出入院日期代数一致（出院-入院+1） | 3 | 2 | `rq-03-stay-days-algebra` |
| REQ-rq-04-death-method-no-record | nhsa-record-quality | `death_method_without_death_record` | 离院方式=死亡但无死亡记录文书时必须报冲突 | 3 | 2 | `rq-04-death-method-no-record` |
| REQ-rq-05-obstetric-sex-conflict | nhsa-record-quality | `obstetric_dx_sex_conflict` | 男性患者出现妊娠/分娩（O 章节）诊断必须报人群-章节冲突 | 3 | 2 | `rq-05-obstetric-sex-conflict` |
| REQ-rq-06-fee-algebra | nhsa-record-quality | `fee_total_unbalanced` | 费用总额必须等于分类费用代数和（确定性对账，不估算） | 3 | 2 | `rq-06-fee-algebra` |
| REQ-rq-07-catalog-restriction-hint | nhsa-record-quality | `restriction_keyword_not_adjudication` | 目录限定支付范围关键词未命中时只提示人工复核，不得判定违规或报销 | 3 | 2 | `rq-07-catalog-restriction-hint` |
| REQ-rq-08-newborn-age-conflict | nhsa-record-quality | `neonatal_dx_age_conflict` | 围产期/新生儿（P 章节）诊断与成人年龄冲突必须报冲突 | 3 | 2 | `rq-08-newborn-age-conflict` |
| REQ-rq-09-catalog-restriction-match | nhsa-record-quality | `restriction_keyword_match_still_not_adjudication` | 限定支付范围关键词命中也只是包含关系提示，不得输出为“可报销”结论 | 3 | 2 | `rq-09-catalog-restriction-match` |
| REQ-rq-10-death-with-documentation | nhsa-record-quality | `death_record_present_no_false_positive` | 离院方式=死亡且存在死亡记录文书时不得误报 | 3 | 1 | `rq-10-death-with-documentation` |

## 使用纪律（变更控制）

- 新增/修改用例后必须重跑生成器并随同一提交更新本文件——追溯矩阵与用例不同步视为流程缺陷；
- 删除用例 = 删除需求，须在变更评审中单独说明；
- 本矩阵的断言文本以 cases JSON 为准，此处仅承载 ID 与计数。
