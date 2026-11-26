import { splitSectionSpans } from "./parse-cn-note.mjs";
import { createTextAnchor } from "./evidence-anchors.mjs";
import { currentEncounterDocument, encounterDocumentReference } from "./encounter-document-ref.mjs";

const documentKinds = ["discharge_summary", "front_sheet", "settlement_list"];
const templateHeadings = ["入院原因", "住院经过", "出院情况", "出院时情况", "主要诊断"];
const present = value => typeof value === "string" && value.trim().length > 0;
const noValue = (status = "not_provided", evidence = []) => ({ value: null, status, evidence });

function findField(document, headings) {
  if (!document.entry) return noValue(document.status);
  const { entry, sections } = document;
  const matches = sections.filter(section => headings.includes(section.name) && section.text);
  const evidence = matches.map(section => createTextAnchor(entry.record, section)).filter(Boolean);
  if (matches.length > 1) return noValue("ambiguous", evidence);
  if (evidence.length !== 1) return noValue();
  return { value: evidence[0].exact, status: "source_linked", evidence };
}

export function buildDischargeTemplate(snapshot, domains) {
  const documents = Object.fromEntries(documentKinds.map(kind => {
    const document = currentEncounterDocument(snapshot, kind);
    return [kind, { ...document, sections: document.entry ? splitSectionSpans(document.entry.record.text, templateHeadings) : [] }];
  }));
  const summary = documents.discharge_summary;
  const fields = {
    admission_reason: findField(summary, ["入院原因", "主诉"]),
    hospital_course: findField(summary, ["住院经过", "诊疗经过"]),
    discharge_condition: findField(summary, ["出院情况", "出院时情况"]),
  };
  const comparisons = {};
  for (const [field, headings] of Object.entries({ discharge_diagnoses: ["出院诊断", "出院主诊断", "主要诊断"],
    procedures: ["手术及操作", "手术操作"] })) {
    const compared = Object.fromEntries(documentKinds.map(kind => [kind, findField(documents[kind], headings)]));
    const known = Object.values(compared).filter(section => section.value != null);
    const evidence = known.flatMap(section => section.evidence);
    const differs = new Set(known.map(section => section.value.replace(/\s+/g, " "))).size > 1;
    const ambiguous = Object.values(compared).some(section => ["ambiguous", "conflict"].includes(section.status));
    comparisons[field] = { status: ambiguous ? "source_conflict" : differs ? "recorded_text_differs" :
      known.length === documentKinds.length ? "recorded_text_agrees" : "coverage_unknown", documents: compared };
    fields[field] = differs || ambiguous ? noValue("requires_review", Object.values(compared).flatMap(section => section.evidence)) :
      known.length ? { value: known[0].value, status: "source_linked", evidence } : noValue();
  }
  const ambiguousMedications = new Set(domains.medications.findings.filter(f => f.code === "SAME_CODE_MULTIPLE_ENTRIES")
    .flatMap(f => f.evidence.map(e => e.content_sha256)));
  const medications = domains.medications.discharge.flatMap(({ record, evidence }) => {
    if (ambiguousMedications.has(evidence.content_sha256)) return [];
    const links = domains.medications.items.filter(row => row.discharge?.evidence.content_sha256 === evidence.content_sha256);
    const values = [record.drug_name, record.dosage, record.route, record.frequency, record.duration_or_stop_rule];
    return links.length === 1 && !links[0].problems.length && values.every(present)
      ? [{ value: values.join(" / "), source_status: record.status ?? null, evidence: [evidence, links[0].evidence] }] : [];
  });
  const arrangement = { planned: "来源记录为计划", requested: "来源记录已申请", booked: "来源记录已预约，待回源核对" };
  const followUp = domains.follow_up.items.filter(row => !row.missing_fields.length).map(({ record, evidence }) => ({
    value: [record.purpose, record.scheduled_at || record.timing_text, record.destination, record.responsible_party,
      record.contact_route, arrangement[record.arrangement_status]].join(" / "), source_status: record.arrangement_status, evidence: [evidence],
  }));
  for (const [key, items] of Object.entries({ discharge_medications: medications, follow_up: followUp })) {
    fields[key] = items.length ? { value: items.map(row => row.value), status: "source_linked",
      evidence: items.flatMap(row => row.evidence), items } : noValue();
  }
  const labels = { admission_reason: "入院原因", hospital_course: "住院经过", discharge_diagnoses: "出院诊断", procedures: "手术及操作",
    discharge_condition: "出院情况", discharge_medications: "带药资料（来源记录）", follow_up: "后续安排资料（来源记录）" };
  const copy = Object.entries(labels).flatMap(([key, label]) => fields[key].value == null ? [] :
    [`${label}\n${[fields[key].value].flat().join("\n")}`]).join("\n\n");
  return { schema_version: "medcius.discharge-template.v1", snapshot_id: snapshot.snapshot_id, as_of: snapshot.as_of,
    status: "clinician_review_required", fields, comparisons,
    document_sources: Object.fromEntries(documentKinds.map(kind => [kind, { status: documents[kind].status,
      reference: documents[kind].entry ? encounterDocumentReference(documents[kind].entry) : null }])),
    copy_text: copy || null, writeback: false };
}
