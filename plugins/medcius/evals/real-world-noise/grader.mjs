// Field-spec grader shared by the noise robustness benchmark and the
// desensitized real-data ingest channel. Mirrors the gold annotation spec used
// by `skills/clinical-note-extract/assets/china-notes/expected.json` (and the
// china-skills deterministic grader), so results are directly comparable:
//   value_contains / must_not_contain / presence / temporality /
//   span_contains / null_or_none / allowed_contains
// Negative-result semantics stay separate from "not mentioned" (AGENTS.md).

import { parseCnNote } from "../../lib/parse-cn-note.mjs";

function has(value, needle) {
  return String(value ?? "").includes(needle);
}

/** Grade one field spec against one parsed field. Returns list of failure strings. */
export function gradeFieldSpec(name, spec, field) {
  const failures = [];
  if (!spec) return failures;
  const value = field?.value;
  if (spec.value_contains) {
    for (const needle of spec.value_contains) if (!has(value, needle)) failures.push(`${name} missing ${needle}`);
  }
  if (spec.must_not_contain) {
    for (const needle of spec.must_not_contain) if (has(value, needle)) failures.push(`${name} must not contain ${needle}`);
  }
  if (spec.presence && field?.presence !== spec.presence) failures.push(`${name}.presence=${field?.presence} want ${spec.presence}`);
  if (spec.temporality && field?.temporality !== spec.temporality) failures.push(`${name}.temporality=${field?.temporality} want ${spec.temporality}`);
  if (spec.span_contains) {
    for (const needle of spec.span_contains) if (!has(field?.span, needle) && !has(value, needle)) failures.push(`${name} span missing ${needle}`);
  }
  if (spec.null_or_none) {
    const empty = value == null || value === "" || value === "无" || value === "无手术";
    if (!empty) failures.push(`${name} should be empty, got ${value}`);
  }
  if (spec.allowed_contains && value) {
    const ok = spec.allowed_contains.some((needle) => has(value, needle));
    if (!ok) failures.push(`${name} unexpected ${value}`);
  }
  return failures;
}

const GRADED_FIELDS = [
  "admission_diagnosis",
  "discharge_diagnosis_primary",
  "discharge_diagnosis_other",
  "procedures",
  "allergy_history",
  "physical_exam",
];

/**
 * Grade one note against one gold entry.
 * Returns { exact, fieldResults: {field: {pass, failures}}, failures }.
 * Gold-level must_not bans are enforced by the china-skills grader; this
 * benchmark scores the structured field specs only.
 */
export function gradeRecord(record, gold) {
  const fieldResults = {};
  const failures = [];
  let total = 0;
  let passed = 0;
  for (const name of GRADED_FIELDS) {
    const spec = gold?.[name];
    if (!spec) continue;
    const specFailures = gradeFieldSpec(name, spec, record[name]);
    fieldResults[name] = { pass: specFailures.length === 0, failures: specFailures };
    total += 1;
    if (specFailures.length === 0) passed += 1;
    else failures.push(...specFailures);
  }
  return { exact: total > 0 && failures.length === 0, fieldResults, failures, fields_total: total, fields_passed: passed };
}

/** Parse + grade one note text in one call. */
export function gradeNoteText(text, gold) {
  const record = parseCnNote(text);
  return { record, ...gradeRecord(record, gold) };
}
