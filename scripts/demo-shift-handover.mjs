// Local synthetic replay, with an isolated signing key and complete fixture event stream.
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import vm from "node:vm";
import { ShiftHandoverEngine as Engine } from "../plugins/medcius/lib/shift-handover-engine.mjs";
import { canonicalJson, sha256Hex } from "../plugins/medcius/servers/shared/crypto.mjs";

const context = { tenant_id: "synthetic-demo", patient_id: "synthetic-patient", encounter_id: "synthetic-encounter" };
const session = { handover_id: "synthetic-shift", outgoing_doctor_id: "doctor-day", incoming_doctor_id: "doctor-night" };
const source = { context, patient: { id: context.patient_id }, encounter: { id: context.encounter_id }, asOf: "2026-10-06T10:00:00Z",
  observations: [{ id: "synthetic-lab", name: "血钾", value: 2.5, unit: "mmol/L", is_critical: true, status: "final", version_id: "v1", issued: "2026-10-06T09:00:00Z", effective_time: "2026-10-06T08:30:00Z" }],
  notes: [{ id: "synthetic-note", text: "合成病程：补充检查资料仍需核对。", timestamp: "2026-10-06T08:00:00Z" }],
  sourceAvailability: [{ kind: "lis", status: "available" }] };
const snapshot = Engine.createSnapshot(source);
const sign = raw => ({ ...raw, signature: createHmac("sha256", "synthetic-demo-only").update(canonicalJson(raw)).digest("hex") });
const verify = ({ signature, ...raw }) => signature === sign(raw).signature;
const make = (events, sourceSnapshot = snapshot) => Engine.analyzePatientHandover({ snapshot: sourceSnapshot,
  windowStart: "2026-10-06T00:00:00Z", eventsAsOf: "2026-10-06T12:00:00Z", handoverContext: session,
  handoverEvents: events, verifyHandoverEvent: verify,
  verifyHandoverHistory: envelope => envelope.history_digest === sha256Hex(canonicalJson(events))
    && envelope.events_as_of === "2026-10-06T12:00:00Z" && canonicalJson(envelope.context) === canonicalJson(context)
    && canonicalJson(envelope.handover_context) === canonicalJson(session),
});
const baseEvent = { ...context, handover_id: session.handover_id };
const plan = sign({ ...baseEvent, event_id: "plan-1", type: "plan_recorded", actor_id: session.outgoing_doctor_id,
  occurred_at: "2026-10-06T10:01:00Z", plan_id: "source-check", trigger_text: "收到补充报告时", action_text: "核对报告标识与版本，再联系交班医师澄清记录中的问题。" });
const prepared = make([plan]);
const offer = sign({ ...baseEvent, event_id: "offer-1", type: "transfer_proposed", actor_id: session.outgoing_doctor_id,
  occurred_at: "2026-10-06T10:02:00Z", packet_digest: prepared.packet_digest });
const accept = sign({ ...baseEvent, event_id: "accept-1", type: "transfer_accepted", actor_id: session.incoming_doctor_id,
  occurred_at: "2026-10-06T10:03:00Z", packet_digest: prepared.packet_digest, target_event_id: offer.event_id });
const revised = Engine.createSnapshot({ ...source, observations: [...source.observations,
  { ...source.observations[0], version_id: "v2", status: "corrected", value: 4.1, is_critical: false, updated_at: "2026-10-06T09:40:00Z" }] });
const cases = [make([plan, offer]), make([plan, offer, accept]), make([plan, offer, accept], revised)];
const ui = vm.createContext({ sessionStorage: { getItem: () => null } });
const template = readFileSync(new URL("../plugins/medcius/servers/api/src/ui/workstation.html", import.meta.url), "utf8");
vm.runInContext(template.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>交接班准备 · 合成事件回放</title>
<style>body{font:16px/1.65 system-ui;max-width:1080px;margin:32px auto;padding:0 20px;background:#f5f7fa;color:#173042}.card{padding:14px;margin:12px 0;border:1px solid #d4e0e8;border-radius:10px;background:white}.muted{color:#596e7d;font-size:14px}button,summary{cursor:pointer}button{padding:10px 18px;margin:8px;border:1px solid #557287;border-radius:6px;background:white}button[aria-pressed=true]{background:#173f56;color:white}td{padding:5px;border-bottom:1px solid #ddd;word-break:break-word}table{width:100%;font-size:13px}.k{width:180px}</style>
<h1>交接班准备 · 合成回放</h1><p>三个预先生成的场景；切换仅用于查看，不执行签字、责任变更或医院写回。</p>
${["已提出，待接班", "来源接班确认", "资料更正，重新确认"].map((label, i) => `<button aria-pressed="${i === 0}" onclick="show(${i})">${label}</button>`).join("")}
${cases.map((d, i) => `<section ${i ? "hidden" : ""}>${ui.renderHandover(d)}</section>`).join("")}
<script>function show(n){document.querySelectorAll('section').forEach((e,i)=>e.hidden=i!==n);document.querySelectorAll('button').forEach((e,i)=>e.setAttribute('aria-pressed',String(i===n)));}</script></html>`;
const out = new URL("../out/shift-handover/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("synthetic-preview.html", out), html, "utf8");
writeFileSync(new URL("synthetic-replay.json", out), JSON.stringify(cases, null, 2), "utf8");
console.log(cases.map(d => d.responsibility.status).join(" -> "));
