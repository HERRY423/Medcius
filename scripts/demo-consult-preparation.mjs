// Generate a local, synthetic, two-specialty review artifact from one snapshot.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import vm from "node:vm";
import { ConsultPreparationEngine as Engine } from "../plugins/medcius/lib/consult-preparation-engine.mjs";
import { getCardiologyMultiSourceFeeds } from "../plugins/medcius/servers/fhir/sandbox/hospital-cardiology-sandbox.mjs";

const feeds = getCardiologyMultiSourceFeeds()[1];
const snapshot = Engine.createSnapshot({
  context: { tenant_id: "synthetic-demo", patient_id: feeds.patient.id, encounter_id: feeds.encounter.id },
  patient: feeds.patient, encounter: feeds.encounter, asOf: new Date().toISOString(), notes: feeds.notes,
  observations: feeds.lis, diagnosticReports: feeds.pacs, medications: feeds.his_orders.filter(r => r.is_medication),
  orders: feeds.his_orders.filter(r => !r.is_medication), allergies: feeds.allergies,
  nursing: feeds.nis,
});
const result = Engine.prepareConsultViews({ snapshot, consultRequests: [
  { department: "肾内科", purpose: "整理血钾、肌酐及利尿相关资料", question: "请专科核对电解质与肾功能资料", focus_terms: ["血钾", "肌酐", "利尿"] },
  { department: "心内科", purpose: "整理心衰相关资料与现有用药医嘱", focus_terms: ["心衰", "BNP"] },
] });
const template = readFileSync(new URL("../plugins/medcius/servers/api/src/ui/workstation.html", import.meta.url), "utf8");
const ui = vm.createContext({ sessionStorage: { getItem: () => null } });
vm.runInContext(template.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>会诊资料整理 · 合成演示</title>
<style>body{font:16px/1.65 system-ui;max-width:1080px;margin:32px auto;padding:0 20px;background:#f5f7fa;color:#173042}
.card{padding:14px;margin:12px 0;border:1px solid #d4e0e8;border-radius:10px;background:white}.muted{color:#596e7d;font-size:14px}
button,summary{cursor:pointer}button{padding:10px 22px;border:1px solid #557287;border-radius:6px;background:white;margin:10px 10px 10px 0}
button[aria-pressed=true]{background:#173f56;color:white}details{padding:10px 0}table{border-collapse:collapse;width:100%;font-size:13px}td{padding:5px;border-bottom:1px solid #e1e8ed;word-break:break-word}.k{width:180px;color:#596e7d}</style>
<h1>会诊前资料整理</h1><p>合成资料演示 · 两个专科共用同一份冻结资料 · 不用于临床决策</p>
<p class="muted">切换专科只改变资料视图，不刷新资料。数据截至 ${result.as_of}</p>
<button aria-pressed="true" onclick="show(0)">肾内科资料</button><button aria-pressed="false" onclick="show(1)">心内科资料</button>
${result.views.map((view, i) => `<section id="view-${i}" ${i ? "hidden" : ""}>${ui.renderConsult(view)}</section>`).join("")}
<details><summary>快照标识（两个视图一致）</summary>${result.snapshot_id}</details>
<script>function show(n){document.querySelectorAll('section').forEach((e,i)=>e.hidden=i!==n);document.querySelectorAll('button').forEach((e,i)=>e.setAttribute('aria-pressed',String(i===n)));}</script></html>`;
const output = new URL("../out/consult-preparation/", import.meta.url);
mkdirSync(output, { recursive: true });
writeFileSync(new URL("synthetic-preview.html", output), html, "utf8");
writeFileSync(new URL("synthetic-views.json", output), JSON.stringify(result, null, 2), "utf8");
console.log("Synthetic consultation preview and shared-snapshot views written to out/consult-preparation.");
