# Third-Party Notices & Provenance

Medcius (this repository, `HERRY423/Medcius`) is a **rebranded, architecturally converged, and extended clinical workflow plugin platform** derived from the [`anthropics/healthcare`](https://github.com/anthropics/healthcare) repository. This notice records the provenance of all codebase assets, explicit module ownership, licensing postures, and independent rewrite audit baselines.

---

## 1. Upstream Status & Terms of Service Boundary

| Field | Upstream Status | Medcius Posture |
|---|---|---|
| **Upstream Repository** | `https://github.com/anthropics/healthcare` | Upstream fork source |
| **Upstream License File** | **None** (`license: null` on GitHub) | Upstream files covered by Anthropic's Terms of Service |
| **Upstream Scope Statement** | *"Provided under Anthropic's terms of service."* | Medcius makes **no broad open-source claim** over upstream-derived files |
| **Bundled Sub-packages** | Manifests declare `"license": "MIT"` | Renamed to `@medcius/*` to indicate independent maintenance |

**Core Compliance Baseline**: Medcius's root MIT license (Copyright © 2026 HERRY423) **strictly applies only to Medcius-original and rewritten files**. Upstream files retain their original status.

---

## 2. Codebase Provenance & Architectural Classification

```text
Medcius Codebase (v0.2.0-pilot)
 ├── 1. Medcius Original Production Core (100% Owned by Medcius)
 │    ├─ Reference Workflow Engines (Patient Evolution, SBAR Shift Handover, Consult Prep, Discharge Readiness)
 │    ├─ Multi-Source Adapters & Real Bridge (NIS, LIS, PACS, HIS, FHIR R4, CDA Document Connector)
 │    ├─ Enterprise Deployment & Security (IdP JWKS Verifier, mTLS Gateway Guard, Clinical Skill Catalog)
 │    ├─ Safety, Privacy & Audit (Enhanced PHI Guard, SHA-256 Audit Chain, SaMD Traceability)
 │    └─ Evaluation & Evals Suite (Real-World Shadow Study, Time-Motion Analyzer, Kappa Benchmark, 37 Gates)
 ├── 2. Rewritten & Adapted Host Connectors
 │    ├─ Codex / Trae / CodeBuddy / Hospital Agent Host Adapters
 │    └─ Read-Only SMART on FHIR R4 Transport & Local Document Extractors
 └── 3. Experimental Quarantine (Strictly Quarantined in experimental/)
      ├─ Legacy Orchestrators (Supervisor/Workers Multi-Agent)
      ├─ US Payer/Provider Tools (Prior-Auth, ICD-10 Coding, Fraud Detection)
      └─ Clinical Trials Registry & Administrative Dashboards
```

---

## 3. Detailed Provenance Ledger

| Module / Component Path | Provenance Classification | Ownership & Maintenance |
|---|---|---|
| `plugins/medcius/lib/patient-evolution-engine.mjs` | **Medcius Original** | 24/72h deterministic clinical evolution computation |
| `plugins/medcius/lib/shift-handover-engine.mjs` | **Medcius Original** | SBAR / I-PASS inpatient handover engine |
| `plugins/medcius/lib/consult-preparation-engine.mjs` | **Medcius Original** | Inter-specialty consultation data pack engine |
| `plugins/medcius/lib/discharge-readiness-engine.mjs` | **Medcius Original** | Diagnostic loop closure & affordability context engine |
| `plugins/medcius/lib/idp-jwks-verifier.mjs` | **Medcius Original** | Enterprise IdP / OIDC / JWKS token verification |
| `plugins/medcius/lib/mtls-gateway-guard.mjs` | **Medcius Original** | On-premises zero-trust mutual TLS gateway guard |
| `plugins/medcius/lib/clinical-skill-catalog.mjs` | **Medcius Original** | Declarative skill catalog governance & kill-switch |
| `plugins/medcius/lib/read-only-hospital-data-bridge.mjs` | **Medcius Original** | Heterogeneous hospital data read-only bridge |
| `plugins/medcius/lib/connectors/{fhir-r4,cda-document}.mjs` | **Medcius Original** | FHIR R4 and CDA narrative document connectors |
| `plugins/medcius/evals/shadow-mode/` | **Medcius Original** | Real-world multi-department shadow study protocol |
| `plugins/medcius/evals/time-motion/` | **Medcius Original** | Clinician time-motion and NASA-TLX workload analyzer |
| `plugins/medcius/servers/phiguard/` | **Medcius Original** | Regex & named pattern PHI redaction/pseudonymization |
| `plugins/medcius/servers/audit/` | **Medcius Original** | Local SHA-256 tamper-evident immutable audit chain |
| `plugins/medcius/servers/fhir/` | **Rewritten from Upstream** | Strictly read-only SMART on FHIR R4 server implementation |
| `plugins/medcius/servers/documents/` | **Rewritten from Upstream** | SQLite / text document citation & extraction engine |
| `experimental/*` | **Quarantined Upstream** | Quarantined non-core / US-specific tools; excluded from CI |

---

## 4. Commercial Redistribution & Independent Rewrite Posture

1. **Production Core Independence**: The entire active production core (`plugins/medcius/lib/`, `contracts/`, `rule-packs/`, `evals/`, `tests/`) consists of Medcius-original or independently rewritten modules.
2. **Third-Party Licensing Clearance**: Prior to commercial deployment or external hospital licensing, any remaining reference dependencies (such as upstream documentation snippets) must pass a formal copyright clearance audit.
3. **No Upstream Warranty or Liability**: Upstream contributors provide code "as is", without warranty of any kind.
