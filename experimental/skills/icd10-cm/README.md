# ICD-10-CM Coding Skill

Extract billable ICD-10-CM diagnosis codes from clinical notes the way a professional coder builds a claim.

US ICD-10-CM only. Medcius does **not** bundle an ICD-10-CM connector or any Claude-hosted MCP. For China settlement codes use `nhsa-coding` + local `china-codes`. If no user-provided ICD-10-CM lookup is available, this skill stops.

## What it does

Given a clinical note (visit note, encounter summary, discharge note), the skill produces the diagnosis codes a coder would submit on the claim for that encounter:

1. **Claim selection** — decides which conditions belong on the claim (reason for visit, conditions managed this visit) and which stay off (history mentions, uncertain diagnoses, symptoms already explained by a coded diagnosis).
2. **Documented specificity** — codes exactly what the clinician documented: unspecified when the note doesn't subtype, specific when it does, never inferring complications from labs or imaging alone.
3. **Verified lookup** — every code is confirmed against a current ICD-10-CM source rather than recalled from memory, so post-2022 code-set changes (e.g. F32.A) are handled correctly.

## Lookup

All code lookup goes through a **user-provided** ICD-10-CM tool. If it is unavailable, the skill stops rather than coding from memory.

## Scope

Written for and validated on **outpatient encounter coding** (primary care, ambulatory follow-ups, minor injury visits). Inpatient-specific conventions (POA indicators, DRG considerations) and specialty regimes with heavy 7th-character logic (poisonings/adverse effects, obstetrics) are not specifically covered.

This skill assists coding workflows; it does not replace certified coder review. Final claim responsibility remains with the billing provider.
