/**
 * LLM Inference Config & Adapter (LLM 推理路径配置管理 · 缺口六).
 *
 * Closes the "LLM path is unmanaged" gap: model selection, version pinning,
 * prompt-pack versioning, capacity budgets and topology enforcement become
 * validated, digest-pinned deployment configuration instead of tribal memory.
 *
 * Topology discipline (docs/ops/PRODUCTIZATION-OPERATIONS.md §3.2 / ARCH-02 / D1):
 *   A 全本地  — private model inside the hospital network. Target state.
 *   B 混合    — hosted API processes ONLY desensitized extraction text; the
 *               judge chain (PASS/FLAG/verdicts) stays local. Requires explicit
 *               attestations in config.
 *   C 全托管  — judge chain leaves the hospital. **REJECTED at validation**
 *               (fail-closed, not a warning).
 *
 * Structural enforcement of D1 ("LLM 无判定权"): the client object exposes
 * ONLY extract() — there is no decide()/adjudicate()/recommend() method to
 * call, so the judge chain physically cannot route through the LLM adapter.
 *
 * Every response carries {model_id, model_version, prompt_pack_version,
 * config_digest, latency_ms} so downstream audit records can answer
 * "这个抽取是哪个模型哪个提示词版本做的" (MNT-03 spirit).
 */

import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";

export const LLM_TOPOLOGIES = {
  A: { id: "A", name_cn: "全本地（院内私有化推理）", judge_chain_local: true, desensitization_required: false },
  B: { id: "B", name_cn: "混合（托管 API 仅处理脱敏抽取文本）", judge_chain_local: true, desensitization_required: true },
  C: { id: "C", name_cn: "全托管（判定链出域）", judge_chain_local: false, desensitization_required: true },
};

/**
 * Validate an LLM inference deployment config.
 * @returns {{ok: boolean, errors: string[], config_digest: string|null}}
 */
export function validateLlmConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") {
    return { ok: false, errors: ["LLM_CONFIG_OBJECT_REQUIRED"], config_digest: null };
  }
  const topology = config.topology;
  if (!LLM_TOPOLOGIES[topology]) {
    errors.push(`LLM_TOPOLOGY_INVALID: must be A|B|C, got ${JSON.stringify(topology)}`);
  } else if (topology === "C") {
    // Fail-closed, not a warning: a fully-hosted judge chain violates ARCH-02/D1.
    errors.push("LLM_TOPOLOGY_C_REJECTED: 全托管拓扑会使判定链出域，违反 ARCH-02/D1（fail-closed）。判定必须在院内本地规则引擎完成。");
  }
  for (const field of ["model_id", "model_version", "prompt_pack_version", "endpoint"]) {
    if (typeof config?.[field] !== "string" || !config[field].trim()) {
      errors.push(`LLM_CONFIG_FIELD_REQUIRED: ${field}`);
    }
  }
  if (config.endpoint && !/^(http|https):\/\//.test(config.endpoint)) {
    errors.push("LLM_ENDPOINT_INVALID: endpoint must be an http(s) URL");
  }
  if (LLM_TOPOLOGIES[topology]?.desensitization_required) {
    if (config.desensitization_attestation !== true) {
      errors.push("LLM_B_ATTESTATION_REQUIRED: B 档必须声明 desensitization_attestation=true（出域文本已过 PHI 出口守卫）");
    }
    if (config.provider_registration_ref && !/^(R20|gen-ai filing)\b/i.test(String(config.provider_registration_ref)) && String(config.provider_registration_ref).length < 4) {
      errors.push("LLM_PROVIDER_REG_REF_INVALID: provider_registration_ref 须引用服务商生成式 AI 备案核验记录（R20）");
    }
  }
  const capacity = config.capacity ?? {};
  if (capacity.max_concurrency !== undefined && (!Number.isInteger(capacity.max_concurrency) || capacity.max_concurrency < 1 || capacity.max_concurrency > 512)) {
    errors.push("LLM_CAPACITY_CONCURRENCY_INVALID: max_concurrency must be 1..512");
  }
  if (capacity.latency_budget_ms_p95 !== undefined && (!Number.isInteger(capacity.latency_budget_ms_p95) || capacity.latency_budget_ms_p95 < 50 || capacity.latency_budget_ms_p95 > 600000)) {
    errors.push("LLM_CAPACITY_LATENCY_INVALID: latency_budget_ms_p95 must be 50..600000 ms");
  }
  const ok = errors.length === 0;
  return { ok, errors, config_digest: ok ? sha256Hex(canonicalJson({ ...config, secrets: undefined })) : null };
}

/**
 * Create the extraction-only LLM inference client.
 *
 * @param {object} options
 * @param {object} options.config - validated LLM deployment config
 * @param {(req: {endpoint: string, model: string, prompt: string, timeoutMs: number}) => Promise<{text: string}>} [options.transport]
 *        injected transport (OpenAI-compatible / vLLM / Ollama adapter provided by deployment); tests inject fakes
 * @param {number} [options.timeoutMs] default 30000; hard fail-closed ceiling
 */
export function createLlmInferenceClient({ config, transport, timeoutMs = 30000 } = {}) {
  const validation = validateLlmConfig(config);
  if (!validation.ok) {
    const err = new Error(`LLM_CONFIG_INVALID: ${validation.errors.join("; ")}`);
    err.code = "LLM_CONFIG_INVALID";
    err.detail = validation.errors;
    throw err;
  }
  if (typeof transport !== "function") throw new Error("LLM_TRANSPORT_REQUIRED");

  let inflight = 0;
  const maxConcurrency = config.capacity?.max_concurrency ?? 8;
  const budgetP95 = config.capacity?.latency_budget_ms_p95 ?? null;

  return {
    topology: config.topology,
    config_digest: validation.config_digest,

    /**
     * Extraction ONLY. There is deliberately no decide()/adjudicate() method
     * on this object — the judge chain cannot route through the LLM (D1).
     */
    async extract({ text, schemaVersion = "unversioned", timeoutMs: perCallTimeout } = {}) {
      if (typeof text !== "string" || !text.trim()) throw new Error("LLM_EXTRACT_TEXT_REQUIRED");
      if (LLM_TOPOLOGIES[config.topology].desensitization_required && config.desensitization_attestation !== true) {
        throw new Error("LLM_B_ATTESTATION_REQUIRED");
      }
      if (inflight >= maxConcurrency) {
        const err = new Error("LLM_CONCURRENCY_BUDGET_EXCEEDED: 并发预算已满（fail-closed，不排队堆积）");
        err.code = "LLM_CONCURRENCY_BUDGET_EXCEEDED";
        throw err;
      }
      const effectiveTimeout = Math.min(perCallTimeout ?? timeoutMs, timeoutMs);
      const started = Date.now();
      inflight += 1;
      try {
        const result = await Promise.race([
          transport({ endpoint: config.endpoint, model: config.model_id, prompt: text, timeoutMs: effectiveTimeout }),
          new Promise((_resolve, reject) => setTimeout(() => {
            const err = new Error(`LLM_TIMEOUT: ${effectiveTimeout}ms（fail-closed：超时不降级、不补造）`);
            err.code = "LLM_TIMEOUT";
            reject(err);
          }, effectiveTimeout)),
        ]);
        const latencyMs = Date.now() - started;
        if (budgetP95 != null && latencyMs > budgetP95) {
          // Not an error: latency budget breach is a capacity signal, surfaced for the probe.
          return { ...result, latency_ms: latencyMs, latency_budget_breached: true, model_id: config.model_id, model_version: config.model_version, prompt_pack_version: config.prompt_pack_version, schema_version: schemaVersion, config_digest: validation.config_digest };
        }
        return { text: String(result?.text ?? ""), latency_ms: latencyMs, latency_budget_breached: false, model_id: config.model_id, model_version: config.model_version, prompt_pack_version: config.prompt_pack_version, schema_version: schemaVersion, config_digest: validation.config_digest };
      } finally {
        inflight -= 1;
      }
    },

    /** Capacity probe for the resident monitor: current in-flight vs budget. */
    capacity() {
      return { inflight, max_concurrency: maxConcurrency, latency_budget_ms_p95: budgetP95 };
    },
  };
}
