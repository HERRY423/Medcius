# Local Chinese PHI NER

Host-neutral CPU detector, mandatory at production ingress/egress, for `EnhancedPhiGuard.sanitizeDual`,
`createPatientSourceSnapshotAsync`, and `HospitalAgentAdapter.executePreRoundWorkflowAsync`.
Inference uses local files only. The adapter contains no model hub calls,
text logging, or telemetry client; runtime validation was performed with network
access restricted. Deployment network policy remains the host's responsibility.

## Install and verify

From the repository root, with an authorized network connection:

```powershell
npm ci --prefix plugins/medcius/runtimes/cn-phi-ner --ignore-scripts --omit=dev --no-audit --no-fund
node scripts/setup-cn-phi-model.mjs C:\Medcius\output\models\bert-base-chinese-ner-int8
$env:MEDCIUS_CN_NER_MODEL_DIR = 'C:\Medcius\output\models\bert-base-chinese-ner-int8'
node --test tests/test-cn-phi-onnx.mjs
node --test tests/test-production-dual-phi.mjs
node --test tests/test-ner-batch-equivalence.mjs
```

Pinned assets total 103,402,382 bytes. The runtime dependency set's registry
unpacked-size sum was 260,596,295 bytes on 2026-11-02. Installation scripts are
disabled to avoid optional GPU downloads. Windows x64 CPU was exercised locally;
other platforms require their own runtime acceptance. On an offline host, stage
the pinned packages and verified model assets through the local deployment process.

Weights are separately downloaded into an ignored directory, not included in
the plugin. The upstream [CKIP model card](https://huggingface.co/ckiplab/bert-base-chinese-ner)
declares GPL-3.0 and a traditional-Chinese model. The
[pinned ONNX conversion](https://huggingface.co/Xenova/bert-base-chinese-ner/tree/be592940bc954f32492c831bdd1d086a04036597)
is general Chinese NER, not a clinical PHI model. Its licensing and deployment
acceptance remain distinct from Medcius's own license and engineering tests.

## API

```javascript
import { createLocalChineseNer } from '../../lib/local-cn-ner.mjs';
import { createPatientSourceSnapshotAsync } from '../../lib/patient-source-snapshot.mjs';

const detector = await createLocalChineseNer({ modelDirectory: absoluteLocalDirectory });
try {
  const snapshot = await createPatientSourceSnapshotAsync(hisInput, { detector });
  // Only this guarded snapshot may cross into host context or downstream logs.
} finally {
  await detector.close();
}
```

The session dictionary extracts patient HumanName/text, supplied aliases and
homophone variants, contacts, encounter participants, practitioners/careTeam,
note authors, and address lines/street terms. Tone-free character readings from
the bundled pinyin-pro table additionally match same-length name homophones.
Only active-session names seed this matching; there is no global patient cache.
Pass an explicit `phi_session_id` when independent sessions share one encounter.
Session handles are opaque, bound to tenant/patient/encounter/session, and can be
disposed. New snapshots inject newly supplied names into a reused, matching
session. Snapshot handles are held through a WeakMap; names are not serialized.

`getPatientSnapshotPhiSession(snapshot, context)` supplies the same dictionary to
later `EnhancedPhiGuard.sanitizeDual(text, {entitySession, context, detector})`
or `llmClient.extract({text, entitySession, context})` calls. These methods do not
authorize remote processing; the existing deployment/egress controls still apply.

Outside production, synchronous compatibility methods execute the deterministic dictionary and
heuristics only. `createPatientSourceSnapshot` reports `ner_status: NOT_RUN` and
rejects a `phiPolicy` other than `dictionary`; use the async entry point for a
dual-track policy. The legacy `PHI_BARE_NAME_LIMITATION` export remains truthful
for heuristic-only callers. It is not an approval to bypass the async guard.

Production (`NODE_ENV`/`MEDCIUS_PROFILE=production`, a production context, or
live hospital data enabled) rejects synchronous snapshot, pre-round, direct
evolution-engine and archive APIs with `PHI_PRODUCTION_ASYNC_REQUIRED`.
Use their `Async` counterparts. HIS capture, bridge/connector exits, archive
write/read/replay and research review HTTP routes await this guard. Both A and
B model topologies require a bound entity session and guard prompt/response.
Production accepts only factory-created, manifest-verified CPU detectors;
objects declaring `execution: local`, forged receipts and copied handles fail.
`startServer` loads the required model before listening. Request flags cannot
downgrade these requirements. A failed model replacement never falls back to
the previous instance. No operational path downloads model assets.

Exact bounded ASCII evidence identifiers/version coordinates and closed status
enums are preserved. Unknown values and narrative fields still execute NER.
A fixed list of full medicine dosage-form names suppresses neural PERSON false
positives; injected patient/session names override it. Callers cannot extend
this list. Archive checks reject newly detected PHI without rewriting anchors.

## Fail-closed contract and scope

- SHA-256 and size of model, config and tokenizer must match the pinned manifest.
- CPU execution provider only; 2 intra-op threads per session by default, no remote fallback.
- Overlapping windows cover the whole input, with original UTF-16 coordinates;
  no silent truncation. Default 256 tokens, 32-token overlap, maximum 100,000
  UTF-16 units. A bounded FIFO admits operations (32 waiting requests by
  default). Four local workers execute independent batches of at most 12
  windows; a bulk operation has at most 512 windows. The unchanged single-text
  path uses the original graph. The 30-second deadline includes queue waiting. Overflow, closed,
  aborted or timed-out work fails explicitly; none falls back to heuristics.
- Only registered local detector results with complete scan status and matching
  text hash are accepted. Invalid spans, residual detections, exceptions and
  incomplete scans block output. A timed-out native call retains its concurrency
  slot until it settles; callers cannot build an unbounded queue.
- PER/PERSON, LOC/GPE/FAC and ORG are guarded; specific adjacent house numbers
  are retained in the redaction span. A second scan checks the transformed text.
- Receipts contain model/version and execution status, not original entities.
  `complete_deidentification: NOT_ESTABLISHED` is intentional: two tracks and a
  repeated scans cannot prove zero false negatives. Homophones can over-redact;
  dialects, unusual names, clinical-domain shift and tokenizer vocabulary gaps
  require authorized clinical evaluation and human sampling.

Residual spans trigger bounded further model scans (at most five total passes);
residuals after that limit block the operation. Failure is never interpreted as
an empty entity list. Request-local text reuse applies only after actual clean
scans and a fresh session-dictionary check.

The standalone ONNX test reports missing configuration as **skipped / NOT_RUN**.
The full runner additionally requires the production regression; missing model
configuration therefore **fails the full check**, rather than passing by skip.
The fixed 80 ms pre-round performance gate is retained separately: successful
PHI checks do not establish that this neural path meets that latency budget.

Default MCP (including CLI `runOnce`) now requires the same verified local CPU
runtime in production regardless of `phiGuard` flags. Nested serialized JSON is
scanned, and structured names seed an ephemeral request dictionary before sealing.
This request dictionary does not claim clinical patient/encounter authorization;
HIS snapshots and model extraction retain their stricter patient-bound sessions.
Audit ingress and legacy-row export reject detected PHI without rewriting signed
or stored bytes. Production document ingestion, exports and observation logs await
the guard; arbitrary document SQL is disabled because SQL could synthesize text
after input scanning. Synchronous diagnostics withhold their payload explicitly.
Production PHI tools use full redaction, including requests for partial masks;
their output reports this mode and never claims complete recall.

`node scripts/verify-runtime.mjs` verifies assets, native loading and a real
synthetic inference. The deployer installs locked dependencies from an offline
npm cache into the staged release and runs this probe before activation. Docker
uses a glibc base, locked dependencies and a read-only external model mount.

## Independent batching and request-local reuse

`independent-batch-graph.mjs` accepts only the pinned original model hash. It
rewrites execution in memory without changing weights, tokenizer, precision,
labels, windows or thresholds. Ordinary dynamic-quantized batching changes
activation ranges across texts and is prohibited. The rewrite computes each
example's extrema, scale and zero point independently, excludes padding from
those extrema, and uses the original attention mask. Q/K/V weights are only
concatenated. Integer GEMM zero-point compensation precedes the original
scale multiplication; an enforced weight-derived bound (7,292,745 < 2^24)
keeps its intermediate integers exactly representable in float32. No new
weights, calibration data or model download are involved.

The locked graph parser is `onnx-proto` 8.0.1 with `protobufjs` overridden to
8.8.1. These dependencies and the workers must initialize successfully before
the detector is registered. `verify-runtime.mjs` executes both single and
batched synthetic inference. Failure of a worker quarantines the whole
detector: queued operations fail, active native calls drain, and sessions are
released gracefully. Force-terminating a worker during ORT execution is not a
safe cancellation mechanism. There is no fallback to another graph after an
error, and a dead worker cannot be replaced by a heuristic or cached success.

Native intra/inter-op threads block while idle (`allow_spinning=0`) so the
four sessions do not busy-wait against each other or the JavaScript guard.
This is a scheduling option only: numerical approximations, denormal handling
and model precision are unchanged. The equivalence test compares this exact
production scheduling configuration against the original graph's defaults.

HIS ingress gathers the same strings selected by the existing field policy and
awaits real batched NER before ordinary per-field dictionary, span/hash and
residual validation. Identical token windows are evaluated once within that
bulk operation; offsets and hashes are reconstructed for each original text.
`phi-inference-scope.mjs` binds reusable results to the current clinical
operation and detector identity. Every new request performs fresh inference;
no patient text, token input or result is cached across requests. A neural
failure poisons the entire operation even if an inner exception is caught.

Pure regex clean results and normalized field keys are bounded to the same
operation. Dictionary scan caches belong to one opaque entity session and are
cleared on injection/disposal. An empty dictionary avoids projection work,
but does not attest neural clearance. None of these caches changes the field
allowlist, clinical-literal exemptions, audit chain or 80 ms gate.
Known marker prefixes cannot start valid JSON; they avoid futile JSON parsing
but still undergo ordinary text checks, including trailing names/identifiers.

`test-ner-batch-equivalence.mjs` compares every logit against original CPU
inference for 261 synthetic texts / 278 windows and two different batch
layouts, then checks offsets, overlap, UNK-token collisions, fresh requests,
patient isolation, cancellation and actual native worker failure. These are
execution-equivalence checks, not a clinical recall or zero-leakage claim.
