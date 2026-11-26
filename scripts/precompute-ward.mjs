#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { assembleAuthorizedHospitalSourceFromEnv } from "../plugins/medcius/lib/authorized-hospital-source.mjs";
import { loadSiteActivationFromEnv } from "../plugins/medcius/lib/site-activation-gate.mjs";
import { precomputeWardPreRound } from "../plugins/medcius/lib/ward-preround.mjs";

try {
  const siteActivation = loadSiteActivationFromEnv();
  if (!siteActivation.ok) throw new Error("WARD_JOB_ACTIVATED_SITE_REQUIRED");
  await assembleAuthorizedHospitalSourceFromEnv();
  const binding = await import(pathToFileURL(process.env.MEDCIUS_HOSPITAL_SOURCE_MODULE).href);
  if (typeof binding.createWardPrecomputeBindings !== "function") throw new Error("WARD_JOB_BINDINGS_REQUIRED");
  const { auth, authorizeWard, loadRoster } = await binding.createWardPrecomputeBindings({ siteActivation });
  const { appendSilentCaptureAudit, appendWardPrecomputeAudit, wardPublicationBeforeDeadline } = await import("../plugins/medcius/servers/audit/src/silent-capture.mjs");
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  const batch = await precomputeWardPreRound({ siteActivation, auth, authorizeWard, loadRoster,
    timeZone: process.env.MEDCIUS_WARD_TIME_ZONE || "Asia/Shanghai", signal: stop.signal,
    auditAppend: event => appendSilentCaptureAudit(event, "ward-preround") });
  const audit = await appendWardPrecomputeAudit(batch);
  const publishedAt = new Date().toISOString();
  const publishedBeforeDeadline = wardPublicationBeforeDeadline(batch, publishedAt);
  const status = stop.signal.aborted ? "interrupted" : publishedBeforeDeadline ? batch.status : "deadline_missed";
  console.log(JSON.stringify({ ward_date: batch.ward_date, status, before_deadline: publishedBeforeDeadline,
    finished_at: batch.finished_at, published_at: publishedAt,
    counts: batch.counts, audit_event_id: audit.event_id }));
  if (status !== "captured") process.exitCode = 1;
} catch (error) {
  // Never log connector errors or roster members from the scheduled process.
  const code = /^(?:WARD_[A-Z_]+|SITE_ACTIVATION_[A-Z_]+|AUTHORIZED_SOURCE_[A-Z_]+)$/.test(error?.message)
    ? error.message : "WARD_PRECOMPUTE_FAILED";
  console.error(code);
  process.exitCode = 1;
}
