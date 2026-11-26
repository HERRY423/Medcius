// Local, deterministic, synthetic-only example. Does not call a hospital/model.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PatientEvolutionEngine } from '../plugins/medcius/lib/patient-evolution-engine.mjs';
import { syntheticTemporalInput } from '../tests/fixtures/temporal-evolution.mjs';

const result = PatientEvolutionEngine.analyzePatientEvolution(syntheticTemporalInput()).blocks.temporal_analysis;
const directory = new URL('../out/temporal-evolution/', import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL('synthetic-demo.json', directory), JSON.stringify(result, null, 2) + '\n');
const lines = ['# 干预前后时间关联：合成示例', '', '全部数值来自合成 fixture。仅用于查看计算与来源追溯，不表示临床疗效或医院验收。', '',
  ...result.interventions.flatMap(c => [`- ${c.summary}`, `  来源：${c.source_references.map(r => `${r.source_system}/${r.source_id}@${r.version_id ?? 'unknown'}`).join('；')}`]), '',
  '| 规则 | 状态 | 实际变化 | 展示权限 |', '|---|---|---|---|',
  ...result.delta_checks.map(c => `| ${c.rule_id} | ${c.status} | ${c.comparison?.delta ?? 'UNKNOWN'} ${c.comparison?.unit ?? ''} | 静默研究候选 |`), '',
  '```mermaid', 'flowchart LR', '  D["呋塞米执行记录"] -->|时间关联| U["随后6h已记录尿量850mL"]',
  '  D -->|时间关联| K["次晨K+ 3.3 mmol/L"]', '  B["给药前K+ 3.9 mmol/L"] -->|数值比较| K',
  '```', '', '图中的边不表示因果；完整节点、时间、原始版本和配对来源见 synthetic-demo.json。', ''];
writeFileSync(new URL('synthetic-demo.md', directory), lines.join('\n'));
console.log('Synthetic temporal example written to out/temporal-evolution/');
