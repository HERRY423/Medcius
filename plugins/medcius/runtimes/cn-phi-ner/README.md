# Local Chinese PHI NER

Host-neutral CPU detector for `EnhancedPhiGuard.sanitizeDual`,
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

## Live hospital configuration

Use the CKIP assets above for synthetic integration and performance fixtures.
A live deployment (`MEDCIUS_LIVE_HOSPITAL_DATA=1`) requires a locally reviewed
Simplified Chinese clinical PHI model for its configured `MEDCIUS_TENANT_ID`.
Site assembly and PHI ingress reject a missing pin, an incompatible model,
or a tenant mismatch before reading patient data.

Point `MEDCIUS_CN_NER_MODEL_DIR` at the site's read-only model directory.
The deployment administrator pins the SHA-256 of the exact
`clinical-model-manifest.json` bytes via
`MEDCIUS_CN_CLINICAL_PHI_MANIFEST_SHA256`. The manifest binds the tenant,
model revision, license review, clinical validation reference, and every asset.
Accepted SPDX licenses for the clinical backend are Apache-2.0, MIT, BSD-2-Clause,
BSD-3-Clause and CC0-1.0. The runtime rejects the general CKIP weights even if
their manifest is renamed. The synthetic contract test uses a tiny generated
MIT-licensed graph and supplies no clinical performance evidence.
Clinical validation and the decision to set the pin belong to the hospital.

| Manifest field | Value |
|---|---|
| `schema_version` | `medcius.cn-clinical-phi-assets.v1` |
| `model_kind`, `language` | `clinical_phi_ner`, `zh-Hans` |
| `model_id`, `revision`, `tenant_id` | Reviewed model identity and deployed tenant |
| `license`, `license_review_ref`, `clinical_validation_ref` | Model license and site review references |
| `files` | Entries for `model_quantized.onnx`, `config.json`, `tokenizer.json`, each with `bytes` and `sha256` |

The supported model contract is BERT WordPiece with a case-preserving
BertNormalizer, three `int64` BERT inputs, and `logits` with shape
`[1, tokenCount, classCount]`. The contiguous `id2label` table includes
`O` and BIO/BIOES/BILOU tags covering `PERSON`, `ADDRESS`, `ORGANIZATION`,
`CONTACT`, and `IDENTIFIER`. The CPU runtime executes independently per row
and retains the session dictionary, regex checks, and residual inference.
Leave `MEDCIUS_CN_NER_PROCESSES` unset for this backend. The guard receipt
records the manifest digest used for inference.

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
write/read/replay and research review HTTP routes await this guard. The local model in production requires a bound entity session and guard prompt/response.
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
- CPU execution provider. The default is one intra-op thread per session with
  up to four available logical CPUs, and two threads per session above four.
- Overlapping windows cover the whole input, with original UTF-16 coordinates;
  no silent truncation. Default 256 tokens, 32-token overlap, maximum 100,000
  UTF-16 units. A bounded FIFO admits operations (32 waiting requests by
  default). Up to four local workers execute independent batches of at most 12
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

## Clinical metadata coverage and ward preparation

The supplied metadata dictionary now also accepts `organizations` and
`locations` arrays, their `name` / `display` / `aliases` / `short_name`, encounter
`serviceProvider` / `managingOrganization`, and FHIR address city/district/state.
Nested tenant/patient/encounter conflicts are rejected. Names and aliases retain
original Unicode coordinates, including astral Han characters and whitespace.
Known clinician names generate bounded surname-plus-title variants (for example,
`郄主任`, `欧阳大夫`); familiar forms such as `老郄` require a supplied alias.
Generic surnames, arbitrary abbreviations and departments are not inferred.
Session terms still override the fixed medicine-literal exceptions.

`lib/phi-ward-cache.mjs` provides an optional `createWardPhiSessionCache` for an
authorized local host. This is a **dictionary cache**, never a cache of scanned
notes, snapshots, NER clearance or model outputs. Default capacity is 64 sessions,
TTL is 5 minutes (maximum 15 minutes), and idle expiry is swept at most one second
later. Its key requires tenant, ward, patient, encounter and explicit PHI session;
each entry also requires a source metadata version. Reusing a version with changed
metadata is rejected. A source version change replaces the entry; in-flight
leases drain before disposal. Full capacity with all entries leased rejects.
Transferred/discharged patients must be invalidated, and logout closes the cache.
The internal metadata digest and entities never appear in diagnostics.

```javascript
import { createWardPhiSessionCache } from '../../lib/phi-ward-cache.mjs';
const dictionaries = createWardPhiSessionCache({ maxSessions: 64, ttlMs: 300000 });
// Metadata must come from the authorized local HIS, not from model guesses.
dictionaries.prewarm([{ source, sourceVersion: metadataVersion }]);
const snapshot = await dictionaries.withSession(source, { sourceVersion: metadataVersion },
  entitySession => createPatientSourceSnapshotAsync(source, {
    detector, entitySession, signal: AbortSignal.timeout(30000),
  }));
// The async snapshot performs fresh CPU inference even on a dictionary hit.
dictionaries.invalidate(source.context); // transfer, discharge or session end
dictionaries.close();
```

Clinical model transfer remains unestablished. The authored development fixture
includes unresolved unseeded rare-name misses; passing its metadata cases does
not establish recall on real clinical notes. See
`docs/engineering/PHI-CPU-HARDENING-2026-11-15.md` in the source repository.

## Optional process pool and bounded peak admission

The default `createLocalChineseNer` retains the original single-request FIFO and
four **worker threads within a bulk request**. They do not make independent
requests concurrent. `createLocalChineseNerPool` adds 1–4 separate local processes
with one globally bounded FIFO (default 32 waiting requests). Each process has
its own verified model, tokenizer and configurable independent batch workers.
Single and batch synthetic inference must succeed in **every process** before
the factory returns a production-accepted detector. The parent checks each reply's
request ID, source hash, spans, Unicode boundaries and model identity.

```javascript
import { createLocalChineseNerPool } from '../../lib/local-cn-ner.mjs';
const detector = await createLocalChineseNerPool({
  modelDirectory: absoluteLocalDirectory, processes: 2,
  threads: 1, batchWorkers: 1, cpuBudget: 4, maxPending: 32, timeoutMs: 30000,
});
// Close the detector explicitly when the host shuts down.
```

For the standard `resolvePhiDetector` / production server startup path, set
`MEDCIUS_CN_NER_PROCESSES` to opt in. Optional positive integer environment
variables are `MEDCIUS_CN_NER_THREADS`, `MEDCIUS_CN_NER_BATCH_WORKERS`,
`MEDCIUS_CN_NER_CPU_BUDGET`, `MEDCIUS_CN_NER_MAX_PENDING`, and
`MEDCIUS_CN_NER_TIMEOUT_MS`. Malformed values reject. Pool defaults are two
processes, one thread and one batch worker per process. Changing a loaded path or
configuration closes the previous runtime before loading its replacement; failure
does not fall back. A failed process pool requires explicit host recovery.

The enforced native execution ceiling is
`processes * threads * batchWorkers <= cpuBudget <= availableParallelism()`.
The original single session and the batch sessions in a process cannot run at
the same time. This is an ORT concurrency cap, not OS CPU affinity or a host-wide
quota: JS/IPC, other services and additional host instances also consume CPU.
Each process holds `1 + batchWorkers` native sessions; memory and cold startup
must be measured on the deployment machine. The conservative defaults can be
slower than the legacy path. Select a configuration from a representative local
load test rather than increasing workers blindly.

An aborted or expired request retains its process slot until the actual reply.
The queue limit and runtime timeout apply to a NER operation, not an entire
multi-pass snapshot or pre-round workflow. Hosts should pass an end-to-end
AbortSignal deadline (and propagate client cancellation) to the async workflow.
Queue overflow rejects immediately. An exited/broken child quarantines the whole
pool and kills its remaining isolated processes; it never respawns or returns
cached clearance. A 65-second hard stall watchdog terminates the pool; explicit
shutdown waits for drain/exit and forcibly reclaims isolated processes after five
seconds. Transient text crosses local IPC only; child stdout/stderr are suppressed.
No network client, automatic asset download or text persistence is added.

`getLocalNerDiagnostics(detector)` returns aggregate queue wait/service histograms,
active/pending/expired/overflow counts, startup and warmup state, local worker PIDs
and worker RSS measurements. It contains no note text, patient/ward identifiers,
session dictionaries or entity digests. Treat PIDs as local operational data.
Hosts should surface overload as retryable unavailability, stagger admission and
avoid automatic retry storms; they must not release unguarded text on failure.

Warm the model on synthetic text before readiness. Prewarm authorized dictionaries
in small ward batches shortly before the locally measured busy interval. NER
results remain request-local; every new clinical operation executes the model.
Removing the pool environment variables and restarting selects the legacy
topology without changing mandatory PHI guarding or the original 80-ms gate.

Run the real process, coverage and burst checks from the repository root:

```powershell
node --test --test-concurrency=1 tests/test-phi-clinical-coverage.mjs tests/test-ner-process-pool.mjs
node scripts/measure-phi-clinical-development.mjs out/phi-coverage.json
node scripts/benchmark-phi-peak.mjs out/phi-peak.json
```

The burst script fixes synthetic inputs, reports completed and rejected requests
separately, checks source hashes before/after the measurement, and records hardware,
thread configuration, warmup, rounds and distributions. It measures PHI ingress,
not full pre-round latency, real hospital arrivals or clinical recall.

## Independent batching and request-local reuse

### Opt-in burst collection

The process pool defaults to one logical request per IPC packet. Enable bounded
collection with `MEDCIUS_CN_NER_MICROBATCH_REQUESTS=8` and an explicit
`MEDCIUS_CN_NER_PROCESSES` setting. The measured configuration uses two processes,
two batch workers per process, two threads per session, and CPU budget eight.
The default collection uses the next microtask without an artificial timer;
`MEDCIUS_CN_NER_MICROBATCH_WAIT_MS` accepts an explicit 0–10 ms delay. Small
bursts distribute across free processes. Collection does not extend a caller's
deadline. It shares the independent computation
graph and IPC packet; patient dictionaries and output objects stay separate.

With collection enabled, `MAX_PENDING` counts **independent native batches**,
not logical callers. Separate hard admission caps default to 128 outstanding
logical requests, 1,000,000 UTF-16 input units, and 8,192 text strings. They are
configured by `MEDCIUS_CN_NER_MAX_OUTSTANDING_REQUESTS`,
`MEDCIUS_CN_NER_MAX_OUTSTANDING_UTF16`, and `MEDCIUS_CN_NER_MAX_OUTSTANDING_TEXTS`.
Active timed-out/cancelled requests remain counted until native completion.
Diagnostics explicitly label `pending`/`peak_pending` as logical request counts;
`waiting_batches`/`peak_waiting_batches` include packets awaiting the collection
flush and are bounded by `maxPending + free native lanes` at admission.
The UTF-16 cap bounds retained raw input, not total process memory. Batch groups
are additionally limited to eight requests, 128 texts, 32,000 UTF-16 units and
512 conservatively estimated windows. A larger individual request runs alone
under the original per-operation limits. Overflow, deadline, invalid output or
worker failure rejects; nothing retries automatically or releases unguarded text.

Token-window deduplication is partitioned by logical request even when inputs
are identical. Every result is checked against its original input hash and span
bounds, split by the immutable request layout, then copied before delivery.
Closing waits for actual drain/exit. Setting microbatch requests back to `1`
restores ordinary FIFO admission; remove the extra collection/cap environment
settings as well (inapplicable settings reject configuration). Compare the
64-request workload with the larger
ordinary FIFO control before selecting a deployment configuration:

```powershell
node --test --test-concurrency=1 tests/test-phi-oov-subjects.mjs tests/test-ner-request-batcher.mjs tests/test-ner-microbatch.mjs
node scripts/measure-phi-subjects-v2.mjs out/phi-subjects-v2.json
node scripts/benchmark-phi-burst-v2.mjs out/phi-burst-v2.json
```

### Supplemental OOV subjects

The unchanged model can omit a rare name whose Han character is absent from its
pinned tokenizer vocabulary. After successful NER, a separate bounded screen
marks 2–4 character clause-initial subjects with an actual OOV Han character and
an explicit clinical reporting/negative predicate. It records exact UTF-16 spans
and a separate `cn-oov-clinical-subject-v1` receipt, never a neural prediction or
confirmed identity. Clinical/anatomical/role and herb vetoes affect this screen
only, not supplied identity dictionaries. Candidates do not seed any dictionary
or propagate to later notes. Span/hash checks and residual NER still run; model
failure cannot be replaced by this screen. Known-vocabulary names and unsupported
grammar can still be missed, and unseen medical terms can still be misclassified.
The authored development fixtures are not independent clinical validation;
`complete_deidentification` remains `NOT_ESTABLISHED`.

### Exact source-crop review

A known-vocabulary name can be missed in its full sentence while the same pinned
model recognizes its isolated source substring. `cn-source-subject-probe-v3`
reviews uncovered 2–4 Han clinical subjects using the **exact original crop**,
without a name prompt, inserted context, different weights or altered logits.
The `source_crop_ner` method requires a full PERSON span. After a successful
negative crop, `surname_subject_rule` can mask a clinical subject with a
compound or distinctive single surname and a one- or two-character given name.
For ambiguous compounds and other supported single surnames the given name must
match a limited character list. Candidate selection excludes clinical and role
terms. Direct speech can qualify outside the enumerated symptom vocabulary
when the subject has the required shape. Medication-context protection includes
泽兰 under the existing PERSON and administration/dosage restrictions.
The guard counts these rule-based spans separately. IPC and egress both check
the source subject position and its spelling for this method.
The crop hash and original UTF-16 range are checked at the IPC and egress boundaries.
Raw full-note spans and context-review spans remain separate evidence fields.

The original native admission/deadline covers both passes. Up to 64 distinct exact
crops and 512 candidate occurrences are allowed per logical operation; overflows
reject instead of silently skipping candidates. Crops are deduplicated only
inside that operation's partition. Eight grouped callers can use at most 512
probe windows, with the same independent batch graph and native CPU budget.
There is no cross-request result cache, inferred identity dictionary or recursive
queue entry. Process readiness also requires a successful actual source-crop
warmup; older IPC protocols or missing review receipts reject. Failure of the
crop pass cannot fall back to a clean result from the full-note pass.

If an exact crop was itself already an original input of the **same partition**,
its just-computed raw NER result is reused; supplemental guesses are never used
as the evidence for another crop. `reused_input_count` records these lookups.
`probe_count` counts distinct crop evidence lookups for that text, including
those reuses; `context_probe_windows` in in-process diagnostics counts actual
additional native crop windows. Neither text nor a result survives the operation.

The crop-only pass balances short rows across the existing workers. Each wave
uses at most the configured worker count, each batch has at most 12 independent
rows, and batch sizes differ by at most one row. For example, two workers split
eight crops into two four-row batches; 25 crops use four batches of six or seven
rows. This avoids an idle worker behind one large batch and an uneven final wave.
Rows exceeding six tokens (four subject tokens plus CLS/SEP) reject. Short
notes are grouped by length to limit padding. Within each short-length group,
batch sizes are balanced across the assigned workers. Original CPU logits
are compared across 1/2/4 workers, mixed and odd batch sizes, cancellation
and native failure.

Closed clinical-subject/role/anatomy vocabularies veto supplemental candidates.
Herbs are ambiguous: a direct patient subject may request neural crop review,
whereas an explicit prescription with a bounded drug list plus dose/unit, or
an administration cue plus medication continuation, protects that medication
occurrence. Fixed prescription headers can protect ADDRESS/ORGANIZATION false
positives. A medication-qualified exact 牡丹皮 can protect an ADDRESS prediction.
Clause-initial rhythm and nerve-exam phrases protect PERSON spans within their
matched boundaries. CONTACT/IDENTIFIER spans remain subject to masking.
Known source identities always override clinical-literal protection. Clinical
ranges are computed once per text, not once per detected span. No caller can
supply a protection list. Unsupported wording and unseen ambiguities remain
outside the synthetic coverage claim.

```powershell
node --test tests/test-phi-context-subjects.mjs
node scripts/measure-phi-subjects-v3.mjs out/phi-subjects-v3.json
```

This version scores clinical preservation at the annotated original positions;
an intact repeated word cannot hide deletion of a different annotated occurrence.
The original 24 cases, the 80-case challenge and the new 125-case development
set remain separate cohorts. See the [v3 engineering report](../../../../docs/engineering/PHI-CONTEXT-SUBJECTS-V3-2026-11-15.md) for before/after
measurements, failures retained during development and concurrency measurements.
`benchmark-phi-paired.mjs BASELINE_ROOT BASELINE_REPORT OUTPUT` verifies every
baseline source hash, keeps both local pools resident, and alternates six paired
rounds with one active arm at a time. It never changes installed source files.

The [v4 engineering report](../../../../docs/engineering/PHI-PROBE-LATENCY-V4-2026-11-19.md)
records component and end-to-end latency separately, along with the new frozen
120-case synthetic challenge. The challenge was opened once after implementation
freeze and did not tune this optimization. Both versions retain five incomplete
identity redactions and seven damaged clinical segments in that set; identical
outputs establish no observed regression there, not complete de-identification.
The challenge is authored by the same agent, not an independent blinded study.

```powershell
node --test tests/test-ner-crop-scheduling.mjs
node scripts/benchmark-ner-crops-v4.mjs BASELINE_ROOT OUTPUT
node scripts/benchmark-phi-probes-v4.mjs BASELINE_ROOT BASELINE_REPORT OUTPUT legacy
node scripts/benchmark-phi-probes-v4.mjs BASELINE_ROOT BASELINE_REPORT OUTPUT crop_heavy
```

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
