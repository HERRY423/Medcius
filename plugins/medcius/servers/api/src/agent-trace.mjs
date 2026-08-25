// Medcius Agent Observability & Reasoning Trace Engine
import { randomUUID } from "node:crypto";

export class AgentTracer {
  constructor(sessionId = null, workflowName = "prescription-review") {
    this.sessionId = sessionId || `session-${randomUUID().slice(0, 8)}`;
    this.workflowName = workflowName;
    this.startTime = Date.now();
    this.spans = [];
    this.currentSpan = null;
  }

  /**
   * Begin a new step/span in the reasoning tree.
   */
  startSpan(name, metadata = {}) {
    const span = {
      spanId: `span-${randomUUID().slice(0, 8)}`,
      name,
      metadata,
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      status: "RUNNING",
      toolCalls: [],
      decisions: [],
      insights: [],
    };
    this.spans.push(span);
    this.currentSpan = span;
    return span;
  }

  /**
   * Record a tool invocation inside the current span.
   */
  recordToolCall(span, { server, tool, args, result, durationMs = 0, status = "SUCCESS" }) {
    const targetSpan = span || this.currentSpan;
    if (!targetSpan) return;

    targetSpan.toolCalls.push({
      toolCallId: `call-${randomUUID().slice(0, 6)}`,
      server,
      tool,
      args: sanitizeArgs(args),
      resultSummary: summarizeResult(result),
      durationMs,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Record a key clinical reasoning decision point.
   */
  recordDecision(span, { question, options, chosen, rationale, evidenceCitation = null }) {
    const targetSpan = span || this.currentSpan;
    if (!targetSpan) return;

    targetSpan.decisions.push({
      decisionId: `dec-${randomUUID().slice(0, 6)}`,
      question,
      options,
      chosen,
      rationale,
      evidenceCitation,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Close a span.
   */
  endSpan(span, { outcome = "COMPLETED", confidence = 1.0 } = {}) {
    const targetSpan = span || this.currentSpan;
    if (!targetSpan) return;

    targetSpan.endTime = Date.now();
    targetSpan.durationMs = targetSpan.endTime - targetSpan.startTime;
    targetSpan.status = outcome;
    targetSpan.confidence = confidence;
  }

  /**
   * Export the complete reasoning trace as an immutable JSON audit object.
   */
  exportTrace() {
    const endTime = Date.now();
    return {
      traceId: this.sessionId,
      workflowName: this.workflowName,
      startTime: new Date(this.startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      totalDurationMs: endTime - this.startTime,
      totalSpans: this.spans.length,
      totalToolCalls: this.spans.reduce((sum, s) => sum + s.toolCalls.length, 0),
      totalDecisions: this.spans.reduce((sum, s) => sum + s.decisions.length, 0),
      spans: this.spans,
    };
  }
}

// In-memory trace cache for recent inspection via UI/REST
const traceStore = new Map();

export function saveTrace(trace) {
  traceStore.set(trace.traceId, trace);
  // Keep last 100 traces
  if (traceStore.size > 100) {
    const oldestKey = traceStore.keys().next().value;
    traceStore.delete(oldestKey);
  }
}

export function getTrace(traceId) {
  return traceStore.get(traceId) || null;
}

export function listRecentTraces(limit = 20) {
  return Array.from(traceStore.values()).slice(-limit).reverse();
}

function sanitizeArgs(args) {
  if (!args) return {};
  const copy = { ...args };
  if (copy.patient_name) copy.patient_name = "***";
  if (copy.id_card) copy.id_card = "***************";
  if (copy.phone) copy.phone = "***********";
  return copy;
}

function summarizeResult(result) {
  if (!result) return null;
  if (typeof result === "string") return result.slice(0, 150);
  if (result.verdict) return `Verdict: ${result.verdict}`;
  if (result.findings) return `Findings count: ${result.findings.length}`;
  if (result.labels) return `Labels count: ${result.labels.length}`;
  return JSON.stringify(result).slice(0, 150);
}
