# 中国住院病历对抗集（合成、脱敏）

10 份**合成**住院病历，配合 `../sample-schemas/china-inpatient.json`。禁止当作真实患者资料。

| 文件 | 陷阱 |
|---|---|
| `01-allergy-negation.md` | 否认药物过敏 + 母亲青霉素过敏 ≠ 患者青霉素过敏 |
| `02-family-history.md` | 家族史糖尿病 ≠ 患者糖尿病 |
| `03-uncertain-admission.md` | 入院「疑似/待查」不得作为确定入院诊断 |
| `04-admission-vs-discharge.md` | 入院诊断与出院主诊断不得混用 |
| `05-prior-vs-current-procedure.md` | 既往手术 ≠ 本次手术 |
| `06-planned-procedure.md` | 「拟行」手术 ≠ 已实施 |
| `07-negative-physical-exam.md` | 阴性体征不得抽成阳性 |
| `08-prophylaxis-not-diagnosis.md` | 预防用药适应症 ≠ 该病存在 |
| `09-lab-not-complication.md` | 化验异常 ≠ 可抽取的并发症诊断 |
| `10-rule-out-mi.md` | 「排除」诊断不得当作出院主诊断 |

预期字段见同目录 `expected.json`。评测用例：`plugins/medcius/evals/china-skills/cases/clinical-note-extract.json`。
