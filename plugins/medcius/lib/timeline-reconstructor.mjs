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
  if (!tEventMs) {
    const rawEventTime = item.effectiveDateTime || item.effectiveInstant || item.occurredDateTime || item.sampled_at || item.collected_at;
    if (rawEventTime) {
      tEventMs = new Date(rawEventTime).getTime();
    }
  }

  if (!tRecordMs) {
    const rawRecordTime = item.issued || item.recorded || item.auth_time || item.created_at || item.timestamp;
    if (rawRecordTime) {
      tRecordMs = new Date(rawRecordTime).getTime();
    }
  }

  // 3. Fallbacks and cross-resolution
  if (!tRecordMs) {
    tRecordMs = tEventMs || fallbackRecordTime;
  }

  if (!tEventMs) {
    // If event time is not explicitly noted, fall back to record time but mark uncertainty
    tEventMs = tRecordMs;
    uncertainty = true;
  }

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
      const diff = a.t_event - b.t_event;
      if (diff !== 0) return diff;

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
        t_event: new Date(d.t_event).toISOString(),
        t_record: new Date(d.t_record).toISOString(),
        timestamp_uncertainty: d.uncertainty,
        lag_minutes: Math.round((d.t_record - d.t_event) / (60 * 1000)),
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
