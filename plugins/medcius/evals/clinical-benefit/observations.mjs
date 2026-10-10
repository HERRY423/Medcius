// Descriptive measurement only. Caller-supplied observations never establish
// independent clinical truth, non-inferiority, or a clinical benefit claim.
export const TIME_COMPONENTS = ["retrieval_seconds", "reading_seconds", "verification_seconds", "correction_seconds", "documentation_seconds", "waiting_seconds"];
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const count = value => Number.isSafeInteger(value) && value >= 0;

function armSummary(arm) {
  if (!arm || arm.status !== "completed") return { complete: false, total_seconds: null, accuracy: null, safety: null };
  const times = TIME_COMPONENTS.map(key => arm[key]);
  const timeComplete = times.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const a = arm.accuracy;
  let accuracy = null;
  if (a && ["reference_facts", "matched_facts", "omitted_facts", "incorrect_facts", "unsupported_facts"].every(key => count(a[key]))) {
    if (a.matched_facts + a.omitted_facts + a.incorrect_facts !== a.reference_facts) throw new Error("BENEFIT_ACCURACY_DENOMINATOR_MISMATCH");
    accuracy = { ...a, recall: a.reference_facts ? a.matched_facts / a.reference_facts : null };
  }
  const s = arm.safety;
  let safety = null;
  if (s?.assessed === true && ["critical_opportunities", "critical_omissions", "wrong_patient", "wrong_time", "wrong_unit", "false_closure", "adverse_events"].every(key => count(s[key]))) {
    if (s.critical_omissions > s.critical_opportunities) throw new Error("BENEFIT_SAFETY_DENOMINATOR_MISMATCH");
    safety = { ...s, critical_omission_rate: s.critical_opportunities ? s.critical_omissions / s.critical_opportunities : null };
  }
  return { complete: timeComplete && accuracy != null && safety != null,
    total_seconds: timeComplete ? times.reduce((a, b) => a + b, 0) : null, accuracy, safety };
}

export function summarizeBenefitObservations({ expected_episode_ids, observations = [] } = {}) {
  if (!Array.isArray(expected_episode_ids) || expected_episode_ids.some(id => typeof id !== "string" || !id.trim())
      || new Set(expected_episode_ids).size !== expected_episode_ids.length || !Array.isArray(observations)) throw new Error("BENEFIT_ROSTER_INVALID");
  const indexed = new Map();
  for (const observation of observations) {
    if (!observation || !expected_episode_ids.includes(observation.episode_id) || indexed.has(observation.episode_id)) throw new Error("BENEFIT_EPISODE_DUPLICATE_OR_UNREGISTERED");
    indexed.set(observation.episode_id, observation);
  }
  const episodes = expected_episode_ids.map(episode_id => {
    const observation = indexed.get(episode_id);
    const control = armSummary(observation?.control), intervention = armSummary(observation?.intervention);
    const anchorPresent = /^[a-f0-9]{64}$/.test(observation?.packet_sha256 || "")
      && Number.isSafeInteger(observation?.review_event_id) && observation.review_event_id > 0;
    const reference = observation?.reference;
    const independentRatingMetadata = !!reference && reference.source_first === true
      && [reference.rater_a, reference.rater_b].every(id => typeof id === "string" && id.trim())
      && reference.rater_a !== reference.rater_b && reference.adjudication_complete === true
      && /^[a-f0-9]{64}$/.test(reference.reference_sha256 || "");
    // These are reported metadata checks, not external verification of raters,
    // the reference, study approval, or the audit event.
    return { episode_id, status: observation ? "observed" : "missing", control, intervention,
      anchor_metadata_present: anchorPresent, reference_metadata_present: independentRatingMetadata,
      descriptive_complete: control.complete && intervention.complete && anchorPresent && independentRatingMetadata,
      paired_saved_seconds: control.total_seconds != null && intervention.total_seconds != null
        ? control.total_seconds - intervention.total_seconds : null };
  });
  const timed = episodes.filter(e => e.paired_saved_seconds != null);
  const complete = episodes.filter(e => e.descriptive_complete);
  return { schema_version: "medcius.benefit-observations.v1", evidence_class: "caller_reported_unverified",
    expected_episodes: episodes.length, observed_episodes: indexed.size,
    missing_episodes: episodes.filter(e => e.status === "missing").length,
    incomplete_episodes: episodes.length - complete.length,
    paired_timing_episodes: timed.length, complete_episodes: complete.length,
    descriptive_mean_saved_seconds: mean(timed.map(e => e.paired_saved_seconds)),
    complete_case_mean_saved_seconds: mean(complete.map(e => e.paired_saved_seconds)),
    episodes, clinical_evidence_pass: false, safety_non_inferiority: null, accuracy_benefit: null, efficiency_benefit: null,
    safety_benefit: null, blocked_reason: "APPROVED_STUDY_AND_INDEPENDENT_ANALYSIS_REQUIRED",
    limitations: ["Missing and failed episodes remain in the enrolled denominator", "No inferential CI, causal benefit or safety non-inferiority is computed",
      "Do not treat reviewer metadata or a packet hash as independent reference verification", "Review agreement alone does not measure omissions"] };
}
