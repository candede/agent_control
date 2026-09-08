# Phase 09 - Copilot Studio Quarantine Controls

## Mission

Add exact Copilot Studio quarantine status and reversible controls using delegated admin identity, native environment/bot IDs, confirmation, ordinary audit and provider verification.

## Prerequisites

- Follow the README's fresh-session contract. Read Phase 08's completion, Phase 05 mutation/canary contract, Phase 04 native-ID artifacts and Phase 02 Power Platform auth.
- Durable jobs/audit, capability gates and app roles exist. No Azure deployment in this phase; use Phase 01/03's Docker deployment/test commands locally.

## Read first

- Delivered Power Platform auth, inventory identity/status and package mutation/recovery artifacts
- Current [quarantine API](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine) and REST operation references
- Existing agent detail/table/bulk components and their tests

## Permission and endpoint contract

- Delegated Power Platform `CopilotStudio.AdminActions.Invoke` only; never application credentials.
- Human role: Global Administrator, AI Administrator or Power Platform Administrator. Reader, Environment Maker and Power Platform built-in RBAC roles are not substitutes.
- Status: `GET https://api.powerplatform.com/copilotstudio/environments/{EnvironmentId}/bots/{BotId}/api/botQuarantine?api-version=1`.
- Quarantine: `POST .../botQuarantine/SetAsQuarantined?api-version=1`.
- Unquarantine: `POST .../botQuarantine/SetAsUnquarantined?api-version=1`.
- Never use the deprecated `powervirtualgents` namespace. Classic chatbot mutations are unsupported (405).

## Required implementation

1. Build a typed adapter with strict environment/bot validation, exact URL/version construction, timeouts and correlation IDs. Separate safe GET retries from write-once mutation dispatch using Phase 05's policy.
2. Target only the inventory's native environment and bot IDs. These identify the bot without any Dataverse API or transcript dependency. Absent, ambiguous or stale targets disable controls; package/name/manual links never supply substitutes.
3. Add explicit status reads of `isBotQuarantined` and `lastUpdateTimeUtc`, with a short cache and observation time. Distinguish unknown/unavailable/unsupported from false. Mutation pre-read/readback is part of the submitted operation, not scheduled inventory harvesting.
4. Implement single and bounded bulk quarantine/unquarantine with `Operator`, delegated capability, supported provider role and explicit confirmation. Freeze exact target lists. Explain that makers may still see/test a quarantined bot while other channels cannot use it; package blocking is a separate control.
5. Reuse Phase 05 intent/idempotency/qualification. Serialize local writes per native target, pre-read current state, reject changed prestate and skip already-correct targets. A status timestamp is evidence, not provider atomicity; use conditional writes only if documented. Qualify preview/API behavior explicitly.
6. Dispatch once and read back boundedly. HTTP acceptance alone is not success. Persist `inconclusive` outcomes and reconcile by GET before an operator can approve new work. No automatic replay or inversion of partial bulk results. Delegated cache loss follows Phase 02 reauthentication rules.
7. Append ordinary audit events with exact target, actor, job/correlation, requested/observed state and safe errors; no tokens, cryptographic ledger or custom encrypted-content store. Own minimal direct-status/qualification schema extensions with finite retention using Phase 01/05 contracts.
8. Show distinct classic-405, removed-target, missing-scope/role, rollout, conditional-access, throttling and provider-error states without guessing a specific cause from ambiguous responses.
9. Add detail/bulk controls with independent package and quarantine state. Preserve direct verification separately from lagging Resource Query data; show times/disagreement. Offer an explicit inventory refresh, never schedule it automatically or let older inventory overwrite direct verification.
10. Extend `docs/mutation-canaries.md` with exact canary scope/approval, prestate, touched fields, restoration and conflict handling. Test recovery commands before live writes and invalidate qualification when contract/auth/configuration changes.

## Focused validation

- Exact endpoints/IDs, status schema, conditional access, timeout/throttling, classic 405 and role/scope errors.
- Idempotency, pre-read conflict, delayed convergence, accepted-but-not-applied, ambiguous write, partial bulk, restart and stale-attempt rejection.
- Package IDs/names and other environments never become targets. Unmatched agents remain usable without identity-review tooling.
- Audit redaction, finite retention, stale inventory versus direct state, and no post-write scheduled inventory query.
- UI confirmation, maker/test semantics, two independent controls, disabled remediation and canary restoration with intervening external changes.

## Aggregate validation

Run the README baseline. Attempt a read-only status probe on an authorized exact target. If a reversible isolated canary is explicitly approved, test both transitions and restore/verify the original state; otherwise record write qualification as unavailable for Phase 13, never passed from fixtures.

## Production continuation

Missing provider eligibility or canary approval leaves affected mutations disabled, preserving qualified status/package paths. Carry exact evidence and remediation. Never guess a bot/environment to satisfy a test.

## Scope guard

No DLP policy changes, deletions, role assignments, package mutations, transcripts or recurring refresh. No Azure deployment.

## Completion record

Create `plans/admin-poc-production/completions/09-copilot-studio-quarantine.md` with endpoints/roles, exact targeting proof, tests, live read/write evidence, restoration if attempted, linked issues and Phase 10 preconditions.

## Done conditions

- Direct quarantine state is source-provenanced; qualified writes are delegated, exact, confirmed, durable, audited and verified.
- Classic/missing/stale targets stay safely disabled; partial or uncertain outcomes never become success.
- Package and quarantine controls remain independent, with no transcript/identity-review dependency.
