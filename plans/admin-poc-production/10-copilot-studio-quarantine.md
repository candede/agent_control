# Phase 10 - Copilot Studio Quarantine Controls

## Mission

Add exact Power Platform quarantine status, quarantine, and unquarantine controls for eligible Copilot Studio agents, using delegated admin identity, provider-native environment/bot IDs, explicit confirmation, local audit, and provider read-after-write verification.

## Prerequisites

- Read the roadmap and completion records for Phases 01-09.
- Power Platform delegated auth, normalized Power Platform agent identities, durable jobs/audit, capability gates, and internal app roles must exist.
- Do not deploy in this phase.

## Read first

- Phase 02 Power Platform token/capability code
- Phase 04 inventory identity and quarantine observations
- Phase 05 mutation safety, audit, and bulk-job patterns
- Current [Copilot Studio quarantine API](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine) and REST operation references
- Existing AgentTable/detail/bulk components

## Permission and endpoint contract

- Token mode: delegated user access token only.
- Power Platform API permission: `CopilotStudio.AdminActions.Invoke`.
- Signed-in user must be Global Administrator, AI Administrator, or Power Platform Administrator. Show those exact roles; do not substitute Global Reader, AI Reader, Environment Maker, or a Power Platform built-in RBAC role.
- Status: `GET https://api.powerplatform.com/copilotstudio/environments/{EnvironmentId}/bots/{BotId}/api/botQuarantine?api-version=1`.
- Quarantine: `POST .../botQuarantine/SetAsQuarantined?api-version=1`.
- Unquarantine: `POST .../botQuarantine/SetAsUnquarantined?api-version=1`.
- The deprecated `powervirtualgents` namespace must not be used.
- Mutations do not support classic chatbots and return 405 for those targets.

## Required implementation

1. Build a typed quarantine adapter with exact URL construction, strict environment/bot ID validation, timeouts, retry only for safe documented transient failures, response validation, and provider correlation IDs.
2. Use only Power Platform inventory's environment ID and Dataverse/CDS bot ID for the target. If either is absent, ambiguous, stale, or linked only by name, keep controls disabled with exact remediation.
3. Add a status probe that reads `isBotQuarantined` and `lastUpdateTimeUtc` per eligible agent. Cache briefly, display freshness, and distinguish unavailable/unsupported/unknown from false.
4. Add single and bounded bulk quarantine/unquarantine. Require `AgentControl.Operator`, delegated scope, one supported Microsoft admin role, preview/API availability, exact identity, and an explicit confirmation summarizing channels and maker/test behavior.
5. State the semantic boundary in UI: quarantined agents remain visible and testable by makers in Copilot Studio but cannot be used through other channels. This is distinct from Graph package block/unblock.
6. Immediately pre-read status before each mutation and fence against a changed source revision. Skip idempotent targets. After the POST, poll status boundedly until expected state and a suitable `lastUpdateTimeUtc` are observed.
7. Treat HTTP acceptance without verified status as `inconclusive`, not succeeded. Reconcile ambiguous outcomes by GET before any retry. Never automatically invert state as rollback for a partially completed bulk operation.
8. Store immutable audit events containing normalized agent/source IDs, environment/bot IDs, actor, requested/current/verified state, provider times, operation/job/correlation IDs, and errors. Do not store tokens.
9. Surface classic chatbot 405, removed agent, environment access, role/scope, preview/rollout, conditional access, throttling, and provider errors as separate states with remediation.
10. Add quarantine status and actions to agent detail and bulk workbench. When both package blocking and quarantine exist, show two independently sourced controls and an `effective restrictions` summary without synthesizing one provider state into the other.
11. Refresh the Power Platform observation after successful mutation so the inventory projection converges, while retaining the direct status response as operation evidence.

## Focused validation

- Adapter tests for exact URLs/versions, encoded IDs, status parsing, role/scope errors, classic 405, removed target, throttling, timeout, malformed responses, and conditional access.
- Mutation tests for pre-read fencing, idempotency, accepted-but-not-applied, delayed convergence, ambiguous timeout/reconciliation, bulk partial results, restart, and stale worker fencing.
- Identity tests proving package ID/name can never become a quarantine target and that environment/bot ambiguity disables writes.
- Audit tests for all state transitions and redaction.
- UI tests for exact scope/role text, unavailable IDs, maker/test semantics, classic bots, preview warning, confirmation, verified/inconclusive results, and distinct package/quarantine state.

## Aggregate validation

Run the global validation baseline. In an authorized non-production test environment, optionally quarantine and unquarantine one approved canary, verifying both states and restoring its original status. If no canary is approved, a read-only live status probe is sufficient and the mutation remains unqualified for Phase 15.

## Production continuation

Missing role/scope, classic target, or mutation qualification does not stop the campaign. Keep status/read-only features where available, disable mutations with precise evidence, preserve package controls, and continue. Never target a guessed environment or bot ID.

## Scope guard

Do not change DLP policies, delete agents, alter package block/access, assign roles, or retrieve transcripts. Do not deploy.

## Completion record

Create `plans/admin-poc-production/completions/10-copilot-studio-quarantine.md` with endpoint/role evidence, identity targeting proof, read/mutation qualification status, canary restoration evidence if used, and Phase 11 preconditions.

## Done conditions

- Eligible quarantine state is readable with exact freshness and provenance.
- Mutations are delegated, role-gated, confirmed, fenced, audited, and provider-verified.
- Classic/missing/stale identities remain safely disabled with remediation.
- Package block and Copilot Studio quarantine remain independent controls.
