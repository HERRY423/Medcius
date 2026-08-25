// Clinical Note Extraction Worker
// Isolated, deterministic extraction of Chinese clinical notes.
// No LLM hallucination: extracts verbatim spans with presence/temporality assertions.

import { parseCnNote } from "../../lib/parse-cn-note.mjs";
import { scanText } from "../../servers/phiguard/src/lib.mjs";

export class ExtractWorker {
  constructor(options = {}) {
    this.name = "ExtractWorker";
    this.options = options;
  }

  async run(input) {
    const text = typeof input === "string" ? input : input?.text ?? "";
    const id = typeof input === "object" ? input?.id ?? "note-0" : "note-0";

    if (!text || !text.trim()) {
      return {
        id,
        status: "empty_input",
        record: null,
      };
    }

    // Step 1: Scan for PHI presence to track sensitivity
    const phi = scanText(text);

    // Step 2: Deterministic Clinical Note Parsing
    const parsed = parseCnNote(text);

    // Step 3: Span verification pass
    const verifySpan = (fieldObj) => {
      if (!fieldObj || fieldObj.value == null) return { ...fieldObj, span_verified: true };
      const span = fieldObj.span;
      const verified = Boolean(span && text.includes(span));
      return { ...fieldObj, span_verified: verified };
    };

    const record = {
      note_id: id,
      note_type: parsed.note_type,
      demographics: parsed.demographics,
      labs: parsed.labs,
      admission_diagnosis: verifySpan(parsed.admission_diagnosis),
      discharge_diagnosis_primary: verifySpan(parsed.discharge_diagnosis_primary),
      discharge_diagnosis_other: verifySpan(parsed.discharge_diagnosis_other),
      procedures: verifySpan(parsed.procedures),
      allergy_history: verifySpan(parsed.allergy_history),
      physical_exam: verifySpan(parsed.physical_exam),
      phi_meta: {
        phi_detected: phi.total > 0,
        phi_count: phi.total,
        phi_types: Object.keys(phi.counts),
      },
    };

    return {
      worker: this.name,
      id,
      status: "completed",
      record,
    };
  }
}
