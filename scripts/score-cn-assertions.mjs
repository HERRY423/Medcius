#!/usr/bin/env node
// Offline scoring against independently labelled UTF-16 spans in a guarded note.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { extractConTextAssertions } from "../plugins/medcius/lib/cn-assertions.mjs";
import { CN_ASSERTION_RULE_VERSION } from "../plugins/medcius/lib/cn-assertion-rules.mjs";
import { guardPatientSourceInput } from "../plugins/medcius/lib/patient-source-phi.mjs";
import { loadSiteActivationFromEnv } from "../plugins/medcius/lib/site-activation-gate.mjs";

import { temporalTimestamp } from "../plugins/medcius/lib/calculation-reference.mjs";

const classes = ["positive", "negative", "uncertain", "not_evaluated", "not_mentioned"];
const rate = (n, d) => d ? n / d : null;
export async function scoreAssertionCohort(cohort) {
  if (!["synthetic","site_deidentified"].includes(cohort?.data_class) || !Array.isArray(cohort.notes) || !cohort.notes.length)
    throw new Error("ASSERTION_COHORT_REQUIRED");
  const clinical = cohort.data_class === "site_deidentified";
  if (clinical) {
    const site = loadSiteActivationFromEnv();
    if (!site.ok || cohort.tenant_id !== site.tenant_id || cohort.protocol_id !== site.irb_protocol_id
        || cohort.adjudicated !== true) throw new Error("ASSERTION_AUTHORIZED_ADJUDICATION_REQUIRED");
  }
  const matrix = Object.fromEntries(classes.map(k=>[k,Object.fromEntries([...classes,"abstained"].map(col=>[col,0]))]));
  const heldByClass = Object.fromEntries(classes.map(k => [k, 0]));
  let heldNotes = 0, heldSpans = 0, total = 0, correct = 0;
  const noteIds = new Set();
  for (const note of cohort.notes) {
    const { context, source_id, text, labels } = note;
    if (temporalTimestamp(context?.as_of) == null || !context.patient_id || !context.encounter_id || !context.tenant_id || context.tenant_id !== cohort.tenant_id
        || !source_id || typeof text !== "string" || !text.length || !text.isWellFormed() || !Array.isArray(labels) || !labels.length)
      throw new Error("ASSERTION_NOTE_INVALID");
    const key = JSON.stringify([context.patient_id,context.encounter_id,source_id]);
    if (noteIds.has(key)) throw new Error("ASSERTION_NOTE_DUPLICATE");
    noteIds.add(key);
    const coordinates = new Set();
    for (const l of labels) {
      const span = l.start + ":" + l.end;
      if (!classes.includes(l.presence) || !Number.isInteger(l.start) || !Number.isInteger(l.end) || l.start < 0 || l.end <= l.start
          || l.end > text.length || coordinates.has(span) || typeof l.exact !== "string" || !l.exact.isWellFormed()
          || text.slice(l.start,l.end) !== l.exact) throw new Error("ASSERTION_GOLD_SPAN_INVALID");
      coordinates.add(span);
    }
    const { input, session } = await guardPatientSourceInput({ context, patient: { id: context.patient_id },
      encounter: { id: context.encounter_id }, notes:[{id:source_id, text}] });
    try {
      if (input.notes[0].text !== text) {
        heldNotes++; heldSpans += labels.length;
        for (const label of labels) heldByClass[label.presence]++;
        continue;
      }
      const mentions = extractConTextAssertions(input.notes[0].text).flatMap(c=>c.mentions);
      for (const l of labels) {
        const found=mentions.filter(m=>m.start<=l.start && m.end>=l.end);
        const predicted=found.length===1 && classes.includes(found[0].presence) ? found[0].presence : "abstained";
        matrix[l.presence][predicted]++; total++; correct+=Number(l.presence===predicted);
      }
    } finally { session.dispose(); }
  }
  const perClass = Object.fromEntries(classes.map(k=>{
    const tp=matrix[k][k], support=Object.values(matrix[k]).reduce((a,b)=>a+b,0);
    const predicted=classes.reduce((n,g)=>n+matrix[g][k],0);
    const trueNegatives = total - support - predicted + tp;
    return [k,{ support, held_spans:heldByClass[k], correct:tp, one_vs_rest_accuracy:rate(tp+trueNegatives,total),
      precision:rate(tp,predicted), recall:rate(tp,support), f1:rate(2*tp,support+predicted) }];
  }));
  return { rule_version:CN_ASSERTION_RULE_VERSION, data_class:cohort.data_class, note_count:cohort.notes.length,
    held_notes:heldNotes, held_spans:heldSpans, evaluated:total, evaluation_coverage:rate(total,total+heldSpans), correct, accuracy:rate(correct,total),
    per_class:perClass, confusion_matrix:matrix, scope:"classification_at_gold_spans", clinical_evidence_pass:false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const cohort=JSON.parse(readFileSync(process.argv[2],"utf8"));
    console.log(JSON.stringify(await scoreAssertionCohort(cohort),null,2));
  } catch (error) {
    console.error(/^ASSERTION_[A-Z_]+$/.test(error.message) ? error.message : "ASSERTION_EVALUATION_BLOCKED");
    process.exitCode=1;
  }
}
