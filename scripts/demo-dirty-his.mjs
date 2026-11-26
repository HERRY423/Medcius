// Deterministic synthetic fixture; no patient, hospital or model service.
import { mkdirSync, writeFileSync } from 'node:fs';
import { normalizeRichText, prepareRichTextTree } from '../plugins/medcius/lib/rich-note-normalization.mjs';
import { createTextAnchor, resolveRichSourceAnchor } from '../plugins/medcius/lib/evidence-anchors.mjs';
import { normalizeLaboratoryMeasurement, inspectLaboratoryTerminology } from '../plugins/medcius/lib/laboratory-terminology.mjs';
import { PatientEvolutionEngine } from '../plugins/medcius/lib/patient-evolution-engine.mjs';
import { parseHl7v2Message } from '../plugins/medcius/lib/connectors/hl7v2-connector.mjs';
import { validatePrivateZProfile, projectPrivateZCandidates } from '../plugins/medcius/lib/connectors/private-z-profile.mjs';

const context = { tenant_id: 'synthetic-site', doctor_id: 'synthetic-doctor', patient_id: 'synthetic-patient', encounter_id: 'synthetic-encounter' };
const html = '<div>现病史：</div><div>患者胸闷，否认气促。</div><table><tr><th>项目</th><th>数值</th></tr><tr><td>血钾</td><td>3.3 mmol/L</td></tr></table>';
const note = prepareRichTextTree({ id: 'synthetic-note', source_system: 'synthetic-emr', version_id: '1', text: html });
const start = note.text.indexOf('患者胸闷'), anchor = createTextAnchor(note, { start, end: start + '患者胸闷'.length });
const sourceProjection = resolveRichSourceAnchor(anchor, note, html);
const rtf = normalizeRichText(String.raw`{\rtf1\ansi\ansicpg936\uc1 \u-32520?\u-27145?\par \'c4\'e3\'ba\'c3}`, 'rtf');
const troponin = normalizeLaboratoryMeasurement({ name: 'hs-cTnI', value: 0.012, unit: 'ng/mL' });
const ambiguous = inspectLaboratoryTerminology({ name: '高敏肌钙蛋白T/I' });
const creatinine = normalizeLaboratoryMeasurement({ name: '肌酐', value: 0.9, unit: 'umol/L' });
const evolution = PatientEvolutionEngine.analyzePatientEvolution({ context, now: '2026-11-05T12:00:00Z',
  patient: { id: context.patient_id, age: 60, gender: 'male' },
  observations: [{ id: 'synthetic-creatinine', ...context, source_system: 'synthetic-lis', code: 'scr', value: 0.9,
    unit: 'umol/L', specimen_type: 'serum', status: 'final', effective_time: '2026-11-05T10:00:00Z' }] });
const rawHl7 = ['MSH|^~\\&|LAB|HOSP|MEDCIUS|HOSP|20261105100000+0800||ORU^R01|MSG1|P|2.5',
  'PID|1||synthetic-patient', 'PV1|1|I|||||||||||||||||synthetic-encounter', 'ZLB|LOCAL-SCR|0.9|umol/L'].join('\r');
const profile = validatePrivateZProfile({ schema_version: 'medcius.hl7-private-profile.v1', profile_id: 'synthetic-profile',
  version: '1', tenant_id: context.tenant_id, status: 'unapproved_research_candidate',
  segments: [{ segment: 'ZLB', fields: { code: 1, value: 2, unit: 3 } }] });
const z = projectPrivateZCandidates(parseHl7v2Message(rawHl7), profile, context, { sourceSystem: 'hl7v2-lis' });
const output = { synthetic_only: true, html: { input: html, normalized_text: note.text, metadata: note.rich_text_normalization,
  anchor, source_projection: sourceProjection }, rtf: { normalized_text: rtf.text, status: rtf.status },
  laboratory: { troponin, ambiguous, creatinine, egfr: evolution.patient.egfr,
    quality_gap: evolution.blocks.data_gaps.find(g => g.gap_type === 'CREATININE_DATA_QUALITY_HOLD') ?? null },
  private_z: z, clinical_acceptance: 'NOT_ESTABLISHED' };
const dir = new URL('../out/dirty-his/', import.meta.url); mkdirSync(dir, { recursive: true });
writeFileSync(new URL('synthetic-demo.json', dir), JSON.stringify(output, null, 2) + '\n');
const lines = ['# 异构医院数据接入：合成演示', '', '全部输入与名称均为合成，仅展示本地工程行为。', '',
  '## 富文本与来源定位', '', `- HTML 清洗结果：${note.text.replaceAll('\n', ' / ').replaceAll('\t', ' | ')}`,
  `- 表格结构：${note.rich_text_normalization.tables[0].rows.length} 行，分别 ${note.rich_text_normalization.tables[0].rows.map(r => r.cells.length).join('、')} 格。`,
  `- “患者胸闷”原始来源定位：${sourceProjection.status}，UTF-16 区间 ${sourceProjection.source_spans.map(s => `[${s.start},${s.end})`).join('、')}。`,
  `- RTF Unicode 与 GBK 转义示例：${rtf.text.replaceAll('\n', ' / ')}（${rtf.status}）。`, '',
  '## 检验与私有字段', '', `- hs-cTnI 0.012 ng/mL → ${troponin.quantity.normalized_value} ng/L，LOINC 候选 ${troponin.mapping.candidates.join('、')}；尚无医院映射批准。`,
  `- “高敏肌钙蛋白T/I”：${ambiguous.status}，未猜测 I 或 T。`,
  `- 肌酐 0.9 μmol/L：${creatinine.quantity.status}；原值保留，eGFR ${evolution.patient.egfr === null ? '未计算' : evolution.patient.egfr}。`,
  `- ZLB 配置提取候选 ${z.candidates.length} 条，clinical_observation=false，calculation_authorized=false。`, '',
  '偏移仅针对精确原始字符串；脱敏改变文本后或出现无法映射的分隔符时，原文定位不可用。以上不证明厂商适配、临床有效性或医院验收。', ''];
writeFileSync(new URL('synthetic-demo.md', dir), lines.join('\n'));
console.log('Synthetic dirty-HIS demo written to out/dirty-his/.');
