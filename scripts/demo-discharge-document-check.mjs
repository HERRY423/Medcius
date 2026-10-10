// Local synthetic preview; does not access a hospital or decide discharge suitability.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import vm from 'node:vm';
import { DischargeReadinessEngine as Engine } from '../plugins/medcius/lib/discharge-readiness-engine.mjs';
import { dischargeFixture } from '../tests/fixtures/discharge-documentation.mjs';
const { args, source } = dischargeFixture();
const corrected = Engine.createSnapshot({ ...source, diagnosticReports: source.diagnosticReports.map(r => ({ ...r, version_id: 'r2', status: 'corrected', updated_at: '2026-10-06T09:50:00Z', impression: '合成报告更正内容' })) });
const cases = [Engine.evaluateDischargeReadiness({ ...args, dischargeMedications: [], medicationTransitions: [], followUpPlans: [], patientInstructions: [] }), Engine.evaluateDischargeReadiness(args), Engine.evaluateDischargeReadiness({ ...args, snapshot: corrected })];
const template = readFileSync(new URL('../plugins/medcius/servers/api/src/ui/workstation.html', import.meta.url), 'utf8');
const ui = vm.createContext({ sessionStorage: { getItem: () => null } });
vm.runInContext(template.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>出院资料核对 · 合成预览</title><style>body{font:16px/1.65 system-ui;max-width:1050px;margin:32px auto;padding:0 20px;background:#f5f7fa;color:#173042}.card{padding:16px;margin:12px 0;border:1px solid #d4e0e8;border-radius:10px;background:white}.muted{color:#596e7d}button,summary{cursor:pointer}button{padding:10px 18px;margin:8px;border:1px solid #557287;border-radius:6px;background:white}button[aria-pressed=true]{background:#173f56;color:white}</style><h1>出院资料核对 · 合成预览</h1><p>仅展示三个预先生成的合成场景，不执行签字、处方、预约或医院写回。三组字段齐备也不产生医学出院结论。</p>${['资料不足','所提供记录字段齐备','报告更正，原链接失效'].map((s,i)=>`<button aria-pressed="${i===0}" onclick="show(${i})">${s}</button>`).join('')}${cases.map((d,i)=>`<section ${i?'hidden':''}>${ui.renderDischarge(d)}</section>`).join('')}<script>function show(n){document.querySelectorAll('section').forEach((e,i)=>e.hidden=i!==n);document.querySelectorAll('button').forEach((e,i)=>e.setAttribute('aria-pressed',String(i===n)));}</script></html>`;
const out = new URL('../out/discharge-document-check/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('synthetic-preview.html', out), html, 'utf8');
writeFileSync(new URL('synthetic-replay.json', out), JSON.stringify(cases, null, 2), 'utf8');
console.log(cases.map(d => ({ domains: Object.fromEntries(Object.entries(d.domains).map(([k,v])=>[k,v.status])), clinical_suitability: d.clinical_suitability.is_suitable_for_discharge })));
