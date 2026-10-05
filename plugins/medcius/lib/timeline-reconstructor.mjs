// Timeline Reconstructor (双时间戳时序重构引擎)
// Resolves EHR documentation time (t_record) vs actual clinical event time (t_event) inversion.
// Provides causal topological sorting, delta window extraction, and uncertainty flagging.

/**
 * Parses or estimates clinical event time (t_event) vs record time (t_record).
 * @param {Object} item - Observation, Note segment, or Order
 * @param {Object} options
 * @returns {{ t_event: number, t_record: number, uncertainty: boolean }}
 */
export function extractDualTimestamp(item = {}, { fallbackRecordTime = Date.now() } = {}) {
  let tEventMs = null;
  let tRecordMs = null;
  let uncertainty = false;

  // 1. Direct timestamps if provided
  if (item.timing) {
    if (item.timing.t_event) tEventMs = new Date(item.timing.t_event).getTime();
    if (item.timing.t_record) tRecordMs = new Date(item.timing.t_record).getTime();
    if (item.timing.timestamp_uncertainty != null) uncertainty = Boolean(item.timing.timestamp_uncertainty);
  }

  // 2. FHIR-style properties
  if (tEventMs == null) {
    const rawEventTime = item.event_time || item.effectiveDateTime || item.effectiveInstant || item.occurredDateTime || item.effective_time || item.sample_time || item.sampled_at || item.collected_at;
    if (rawEventTime) {
      tEventMs = new Date(rawEventTime).getTime();
    }
  }

  if (tRecordMs == null) {
    const rawRecordTime = item.recorded_at || item.received_at || item.recorded || item.auth_time || item.created_at;
    if (rawRecordTime) {
      tRecordMs = new Date(rawRecordTime).getTime();
    }
  }

  // Missing source times stay missing; neither fetch nor wall-clock time is evidence.
  if (!Number.isFinite(tEventMs)) tEventMs = null;
  if (!Number.isFinite(tRecordMs)) tRecordMs = null;
  if (tEventMs == null || tRecordMs == null) uncertainty = true;

  return {
    t_event: tEventMs,
    t_record: tRecordMs,
    uncertainty,
  };
}

export class TimelineReconstructor {
  /**
   * Reconstruct clinical timeline using true event occurrence time (t_event) as primary axis.
   * Resolves late-entry nursing notes or post-round documentation lag.
   *
   * @param {Array} items - List of clinical items (observations, notes, medications, alerts)
   * @param {Object} options
   * @returns {Array} Topologically sorted items with unified timestamps
   */
  static reconstructTimeline(items = [], { fallbackTime = Date.now() } = {}) {
    if (!Array.isArray(items) || items.length === 0) return [];

    const decorated = items.map((item, idx) => {
      const dualTime = extractDualTimestamp(item, { fallbackRecordTime: fallbackTime });
      return {
        originalIndex: idx,
        item,
        t_event: dualTime.t_event,
        t_record: dualTime.t_record,
        uncertainty: dualTime.uncertainty,
        type: item.type || item.resourceType || (item.conceptName ? "OBSERVATION" : "GENERIC"),
      };
    });

    // Sort primarily by t_event (actual occurrence), then prioritize objective tests over subjective notes
    decorated.sort((a, b) => {
      const diff = (a.t_event ?? Infinity) - (b.t_event ?? Infinity);
      if (Number.isFinite(diff) && diff !== 0) return diff;
      if (a.t_event == null && b.t_event != null) return 1;
      if (b.t_event == null && a.t_event != null) return -1;

      // Same event timestamp: observations & critical values before subjective notes
      const priorityOrder = {
        CRITICAL: 1,
        Observation: 2,
        OBSERVATION: 2,
        DiagnosticReport: 3,
        MedicationRequest: 4,
        NOTE_SEGMENT: 5,
        GENERIC: 6,
      };

      const pA = priorityOrder[a.type] || 99;
      const pB = priorityOrder[b.type] || 99;
      if (pA !== pB) return pA - pB;

      return a.originalIndex - b.originalIndex;
    });

    return decorated.map((d) => ({
      ...d.item,
      _timeline_meta: {
        t_event: d.t_event == null ? null : new Date(d.t_event).toISOString(),
        t_record: d.t_record == null ? null : new Date(d.t_record).toISOString(),
        timestamp_uncertainty: d.uncertainty,
        lag_minutes: d.t_event == null || d.t_record == null ? null : Math.round((d.t_record - d.t_event) / (60 * 1000)),
      },
    }));
  }

  /**
   * Filter and extract delta changes within a designated pre-round window (e.g. 24h / 72h).
   *
   * @param {Array} timelineItems - Output of reconstructTimeline
   * @param {number} windowStartMs - Cutoff timestamp in milliseconds
   * @param {number} windowEndMs - Now timestamp in milliseconds
   */
  static extractDeltaWindow(timelineItems = [], windowStartMs, windowEndMs = Date.now()) {
    if (!Array.isArray(timelineItems)) return [];
    return timelineItems.filter((item) => {
      const tEvent = item._timeline_meta?.t_event ? new Date(item._timeline_meta.t_event).getTime() : null;
      if (tEvent == null) return false;
      return tEvent >= windowStartMs && tEvent <= windowEndMs;
    });
  }
}
