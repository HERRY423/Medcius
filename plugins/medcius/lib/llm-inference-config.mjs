// Version-pinned extraction on the hospital network. Transport never performs clinical adjudication.
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { guardFreeTextEgress } from './local-phi-egress.mjs';
import { requiresProductionPhi } from './production-phi-policy.mjs';
import { resolvePhiDetector, assertProductionDetector } from './phi-runtime.mjs';
import { assertPhiEntitySession } from './phi-entity-session.mjs';
import { randomUUID } from 'node:crypto';
import { CN_CANDIDATE_TASK, CN_CANDIDATE_PROMPT_VERSION, CN_CANDIDATE_LIMITS, buildCnCandidateRequest, validateCnCandidates } from './cn-note-candidate-contract.mjs';

// Private provenance handles prevent a plain object from impersonating the
// guarded extraction path. They are process-local, never serialized.
const managedClients = new WeakSet();
const managedResults = new WeakSet();
export const isManagedLlmClient = value => managedClients.has(value);
export const isManagedLlmResult = value => managedResults.has(value);

export const LLM_TOPOLOGIES = Object.freeze({
  A: Object.freeze({ id: "A", name_cn: "院内本地推理", judge_chain_local: true, desensitization_required: false }),
});

function localEndpoint(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
    const host = url.hostname;
    return host === "localhost" || host === "[::1]" || /^\[f[cd][0-9a-f]{2}:/.test(host)
      || /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) && /^\d+\.\d+\.\d+\.\d+$/.test(host);
  } catch { return false; }
}

// Deployment-injected transports are trusted local integration code. The built-in
// transport never follows a redirect or discovers a provider.
async function localChat({ endpoint, model, prompt, messages, response_format, max_output_tokens, signal }) {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/$/, "") + "/chat/completions";
  const response = await fetch(url, { method: "POST", redirect: "error", signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: messages ?? [{ role: "user", content: prompt }],
      temperature: 0, ...(response_format ? { response_format, max_tokens: max_output_tokens } : {}) }) });
  if (!response.ok) throw new Error("LLM_LOCAL_PROVIDER_FAILED");
  const body = await response.json();
  return { text: body.choices?.[0]?.message?.content };
}

/**
 * Validate an LLM inference deployment config.
 * @returns {{ok: boolean, errors: string[], config_digest: string|null}}
 */
export function validateLlmConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") {
    return { ok: false, errors: ["LLM_CONFIG_OBJECT_REQUIRED"], config_digest: null };
  }
  const topology = config.topology ?? "A";
  if (topology !== "A") errors.push(topology === "C" ? "LLM_TOPOLOGY_C_REJECTED" : "LLM_LOCAL_ONLY_REQUIRED");
  for (const field of ["model_id", "model_version", "prompt_pack_version", "endpoint"]) {
    if (typeof config?.[field] !== "string" || !config[field].trim()) {
      errors.push(`LLM_CONFIG_FIELD_REQUIRED: ${field}`);
    }
  }
  if (!localEndpoint(config.endpoint)) errors.push("LLM_LOCAL_ENDPOINT_REQUIRED");
  const capacity = config.capacity ?? {};
  if (capacity.max_concurrency !== undefined && (!Number.isInteger(capacity.max_concurrency) || capacity.max_concurrency < 1 || capacity.max_concurrency > 512)) {
    errors.push("LLM_CAPACITY_CONCURRENCY_INVALID: max_concurrency must be 1..512");
  }
  if (capacity.latency_budget_ms_p95 !== undefined && (!Number.isInteger(capacity.latency_budget_ms_p95) || capacity.latency_budget_ms_p95 < 50 || capacity.latency_budget_ms_p95 > 600000)) {
    errors.push("LLM_CAPACITY_LATENCY_INVALID: latency_budget_ms_p95 must be 50..600000 ms");
  }
  const ok = errors.length === 0;
  return { ok, errors, config_digest: ok ? sha256Hex(canonicalJson({ ...config, topology, secrets: undefined })) : null };
}

export function localLlmConfigFromEnv(env = process.env) {
  return { topology: env.MEDCIUS_LLM_TOPOLOGY ?? "A",
    model_id: env.MEDCIUS_LLM_MODEL_ID ?? "Qwen2.5-7B-Instruct", model_version: env.MEDCIUS_LLM_MODEL_VERSION,
    prompt_pack_version: env.MEDCIUS_LLM_PROMPT_PACK_VERSION, endpoint: env.MEDCIUS_LLM_ENDPOINT ?? "http://127.0.0.1:11434/v1" };
}

/**
 * Create the extraction-only LLM inference client.
 *
 * @param {object} options
 * @param {object} options.config - validated LLM deployment config
 * @param {(req: {endpoint: string, model: string, prompt: string, timeoutMs: number}) => Promise<{text: string}>} [options.transport]
 *        injected transport (OpenAI-compatible / vLLM / Ollama adapter provided by deployment); tests inject fakes
 * @param {number} [options.timeoutMs] default 30000; hard fail-closed ceiling
 * @param {object} [options.localPhiDetector] local PHI detector; see local-phi-egress.mjs
 */
export function createLlmInferenceClient({ config = localLlmConfigFromEnv(), transport = localChat, localPhiDetector, timeoutMs = 30000 } = {}) {
  config = structuredClone(config);
  if (config && typeof config === "object") config.topology ??= "A";
  const validation = validateLlmConfig(config);
  if (!validation.ok) {
    const err = new Error(`LLM_CONFIG_INVALID: ${validation.errors.join("; ")}`);
    err.code = "LLM_CONFIG_INVALID";
    err.detail = validation.errors;
    throw err;
  }
  if (typeof transport !== "function") throw new Error("LLM_TRANSPORT_REQUIRED");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('LLM_TIMEOUT_INVALID');
  const productionAtCreation = requiresProductionPhi(config);
  if (productionAtCreation && localPhiDetector) assertProductionDetector(localPhiDetector);

  let inflight = 0;
  const maxConcurrency = config.capacity?.max_concurrency ?? 8;
  const budgetP95 = config.capacity?.latency_budget_ms_p95 ?? null;

  const client = {
    topology: config.topology,
    config_digest: validation.config_digest,

    /**
     * Extraction ONLY. There is deliberately no decide()/adjudicate() method
     * on this object — the judge chain cannot route through the LLM (D1).
     */
    async extract({ text, schemaVersion = "unversioned", task, timeoutMs: perCallTimeout, entitySession, context } = {}) {
      if (typeof text !== "string" || !text.trim()) throw new Error("LLM_EXTRACT_TEXT_REQUIRED");
      if(task!==undefined && task!==CN_CANDIDATE_TASK) throw new Error('LLM_EXTRACTION_TASK_INVALID');
      const bounded=task===CN_CANDIDATE_TASK;
      if(bounded && config.prompt_pack_version!==CN_CANDIDATE_PROMPT_VERSION) throw new Error('LLM_PROMPT_PACK_MISMATCH');
      if(bounded && (text.length>CN_CANDIDATE_LIMITS.input_chars || !text.isWellFormed() || text.includes('\ufffd'))) throw new Error('CN_EXTRACTION_INPUT_INVALID');
      context = context == null ? context : structuredClone(context);
      const production = productionAtCreation || requiresProductionPhi(config, context);
      const mustGuard = production || bounded || localPhiDetector != null || entitySession != null;
      if (production) assertPhiEntitySession(entitySession, context);
      if (inflight >= maxConcurrency) {
        const err = new Error("LLM_CONCURRENCY_BUDGET_EXCEEDED: 并发预算已满（fail-closed，不排队堆积）");
        err.code = "LLM_CONCURRENCY_BUDGET_EXCEEDED";
        throw err;
      }
      const effectiveTimeout = Math.min(perCallTimeout ?? timeoutMs, timeoutMs);
      if (!Number.isInteger(effectiveTimeout) || effectiveTimeout < 1) throw new Error('LLM_TIMEOUT_INVALID');
      const started = Date.now();
      inflight += 1;
      let timeout;
      const controller = new AbortController();
      let egressReceipt = null;
      const requestId=bounded ? randomUUID() : null;
      let sourceDigest=null;
      let responseChanged=false;
      let candidateBatch=null;
      // Keep the concurrency slot until the underlying work actually stops.
      // A timed-out provider or detector may ignore AbortSignal.
      const pending = (async () => {
        let prompt = text;
        const detector = mustGuard ? await resolvePhiDetector({ detector: localPhiDetector, context }) : null;
        if (production) assertProductionDetector(detector, context);
        if (mustGuard) {
          const guarded = await guardFreeTextEgress(text, { detector, signal: controller.signal, entitySession, context });
          prompt = guarded.text; egressReceipt = guarded.receipt;
        }
        if (controller.signal.aborted) throw new Error('LLM_TIMEOUT');
        const request=bounded ? buildCnCandidateRequest(prompt,requestId) : {prompt};
        sourceDigest=bounded ? request.source_sha256 : null;
        let result;
        try { result = await transport({ endpoint: config.endpoint, model: config.model_id, model_version:config.model_version,
          ...request, timeoutMs: effectiveTimeout, signal: controller.signal }); }
        catch { throw new Error('LLM_TRANSPORT_FAILED'); }
        if (controller.signal.aborted) throw new Error('LLM_TIMEOUT');
        if (typeof result?.text !== 'string') throw new Error('LLM_EXTRACT_RESPONSE_INVALID');
        if(bounded && result.text.length>CN_CANDIDATE_LIMITS.response_chars) throw new Error('LLM_RESPONSE_LIMIT');
        if(bounded) {
          // Validate all keys, types and local bindings before treating any
          // hash/UUID as integrity metadata. Arbitrary fields are never exempt
          // from PHI checks. Invalid content is discarded without echoing it.
          candidateBatch=validateCnCandidates(result.text,{text:prompt,requestId});
          if(!candidateBatch.ok) return {text:''};
          for(const c of candidateBatch.candidates) {
            const checked=await guardFreeTextEgress(c.span,{detector,signal:controller.signal,entitySession,context});
            if(checked.text!==c.span) {responseChanged=true;break;}
          }
          if(responseChanged) {
            candidateBatch={ok:false,reason:'RESPONSE_REDACTED',candidates:[],rejected:[],coverage:'unknown'};
            return {text:''};
          }
          return {text:JSON.stringify({schema_version:CN_CANDIDATE_TASK,request_id:requestId,source_sha256:sourceDigest,
            coverage:candidateBatch.coverage,candidates:candidateBatch.candidates.map(({index,offset_unit,...c})=>c)})};
        }
        if (mustGuard) {
          const guarded=await guardFreeTextEgress(result.text, { detector, signal: controller.signal, entitySession, context });
          responseChanged=guarded.text!==result.text;
          return {text:guarded.text};
        }
        return { text: result.text };
      })().finally(() => { inflight -= 1; });
      try {
        const result = await Promise.race([
          pending,
          new Promise((_resolve, reject) => { timeout = setTimeout(() => {
            controller.abort();
            const err = new Error(`LLM_TIMEOUT: ${effectiveTimeout}ms（fail-closed：超时不降级、不补造）`);
            err.code = "LLM_TIMEOUT";
            reject(err);
          }, effectiveTimeout); }),
        ]);
        const latencyMs = Date.now() - started;
        const output={ text: String(result?.text ?? ""), egress_receipt: egressReceipt, latency_ms: latencyMs,
          latency_budget_breached:budgetP95!=null && latencyMs>budgetP95, model_id: config.model_id,
          model_version: config.model_version, prompt_pack_version: config.prompt_pack_version,
          schema_version: bounded ? CN_CANDIDATE_TASK : schemaVersion, config_digest: validation.config_digest,
          ...(bounded ? {request_id:requestId,source_sha256:sourceDigest,response_redacted:responseChanged,candidate_batch:candidateBatch} : {}) };
        managedResults.add(output);
        return output;
      } finally {
        clearTimeout(timeout);
      }
    },

    /** Capacity probe for the resident monitor: current in-flight vs budget. */
    capacity() {
      return { inflight, max_concurrency: maxConcurrency, latency_budget_ms_p95: budgetP95 };
    },
  };
  managedClients.add(client);
  return Object.freeze(client);
}
