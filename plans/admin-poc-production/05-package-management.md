# Phase 05 - Microsoft 365 Package Management Hardening

## Mission

Move the existing Microsoft Graph Copilot package experience onto normalized agent identities, split read and write consent, and harden preview block, access, and ownership-reassignment controls with confirmation, concurrency fencing, local audit, and provider read-after-write verification.

## Prerequisites

- Read the roadmap and completion records for Phases 01-04.
- Durable jobs/audit, internal app roles, package capability groups, Permission Center, and normalized agent/source identifiers must exist.
- Do not deploy in this phase.

## Read first

- `backend/src/services/graphPackages.ts` and tests
- `backend/src/routes/agents.ts` and tests
- `backend/src/services/bulkJobs.ts` and tests
- `backend/src/services/directoryPrincipals.ts` and tests
- `backend/src/types/copilotPackage.ts`
- `frontend/src/components/AgentTable.tsx`
- `frontend/src/components/AgentDetailModal.tsx`
- `frontend/src/components/AccessAssignmentModal.tsx`
- `frontend/src/components/BulkActions.tsx`
- Current Microsoft Copilot package catalog list/get/update/block/unblock/reassign documentation

## Permission contract

- List and detail support delegated or application Microsoft Graph `CopilotPackages.Read.All` and an authorized Agent Control reader role. Use the read-only permission even though `CopilotPackages.ReadWrite.All` is accepted as a higher privilege.
- Block, unblock, access update, and reassign require delegated Microsoft Graph `CopilotPackages.ReadWrite.All`, `AgentControl.Operator`, and successful capability probes.
- Directory search/resolve requires delegated `User.ReadBasic.All` and `Group.Read.All`.
- A Microsoft Agent 365 license is required. The package endpoint docs name no additional human Entra administrator role; the UI must say so and rely on the live probe.
- Application permission is supported for list/detail collection but not update, block, unblock, or reassign. Do not silently switch package mutations to app identity.
- List/get use the current Graph v1.0 package catalog endpoints where available. Mutation endpoints remain beta/preview unless Microsoft has promoted them when this phase executes.

## Required implementation

1. Replace direct list-route pass-through with a package provider adapter that stores source observations and projects them into normalized agents. Preserve all package fields and exact provider IDs.
2. Request delegated `CopilotPackages.Read.All` independently from delegated `CopilotPackages.ReadWrite.All`. Neither belongs in the Phase 02 baseline login. The Permission Center requests package read on demand; a write action with missing write consent links to the package-write-only consent group and never requests unrelated scopes. Support application `CopilotPackages.Read.All` for background read refresh. Read-only inventory must remain usable when delegated write consent is absent.
3. Keep and strengthen the existing retry, bounded concurrency, full access-payload preservation, and read-after-write verification. Add finite timeouts, `Retry-After` support, abort propagation, correlation IDs, and durable per-item bulk attempts.
4. Require an explicit preview confirmation for every mutation. Show operation, package/normalized agent, current state, requested state, exact provider, affected principal count, permission, actor, and whether rollback is possible.
5. For access writes, resolve and display users/groups before confirmation, reject unresolved/deleted/duplicate principals, preserve the unselected access target, reject ambiguous provider scope, and verify both selected and preserved access collections. Implement the documented adapter and deterministic fixtures, but gate the mutation separately from block/reassign. Because the current app records provider unreliability for this endpoint, enable it only after an approved reversible canary proves request acceptance and provider read-back convergence. Until then, preserve read-only access display and a visible disabled action with exact endpoint evidence and requalification trigger; do not redirect users to a different provider as though it controlled the same package access state.
6. Add optimistic fencing using a provider ETag where supplied; otherwise use a hash/revision of the exact pre-read state and repeat the pre-read immediately before mutation. Return a conflict rather than overwriting a changed state.
7. Verify block/unblock with repeated bounded detail reads until the expected state appears or a deadline expires. An accepted request is not success without observed provider state.
8. Implement preview ownership reassignment as `POST https://graph.microsoft.com/beta/copilot/admin/catalog/packages/{id}/reassign` with JSON `{ "userId": "<Entra user object ID>" }`, delegated `CopilotPackages.ReadWrite.All`, and no application permission. Resolve the target user, require confirmation, perform the write once, and verify ownership by provider read. If the current API is removed or tenant-ineligible, retain a visible disabled `Reassign owner` action with exact evidence and a supported manual workflow link.
9. Preserve partial bulk results and resumability. Retry only provider-documented transient failures. An accepted or timed-out mutation whose provider outcome cannot be verified remains a durable per-item `inconclusive` result in the job center. Reconcile it by provider read; expose operator-reviewed retry eligibility only after reconciliation and never schedule an automatic mutation retry.
10. Record immutable local audit events for requested, started, succeeded, skipped, failed, inconclusive, and verified states. Redact tokens and unnecessary principal attributes; include operation/correlation/job IDs and before/after hashes.
11. In the unified agent detail, display package availability, deployment, block state, assignment principals, ownership, freshness, API maturity, and source. Keep package block distinct from Copilot Studio quarantine.
12. Add a dedicated mismatch state when a normalized identity is linked but the package mutation target is stale or absent. Never fall back to another source's ID.

## Focused validation

- Adapter and route tests for read-only versus write consent, v1/beta endpoint selection, retry/timeouts, throttling, ETag/revision conflicts, malformed Graph data, and capability enforcement.
- Mutation tests for block/unblock convergence, access payload preservation, ambiguous scopes, directory resolution, accepted-but-not-applied responses, changed unselected access, and inconclusive outcomes.
- Reassign tests for supported, ineligible, missing-contract, concurrent-change, and provider-verification paths; fixtures must match the exact documented contract captured in test comments/source links.
- Durable bulk-job tests for restart, cancellation, partial completion, stale worker fencing, and ambiguous-outcome reconciliation.
- UI tests for read-only operation, exact disabled-state remediation, confirmation, partial results, mismatch, preview badges, and distinct package/quarantine labels.

## Aggregate validation

Run the global validation baseline. Against an authorized tenant, perform list/detail probes and only a specifically approved reversible canary mutation; restore the original state and verify both transitions. Do not mutate production tenant data merely to satisfy automated validation.

## Production continuation

Preview mutation or tenant-contract failure does not stop the campaign. Keep package reads available, disable only affected writes, record provider evidence and remediation, and continue. Never mark a write successful from HTTP acceptance alone.

## Scope guard

Do not implement Power Platform quarantine, usage, audit, Defender, or transcripts. Do not use display names to choose a mutation target. Do not deploy.

## Completion record

Create `plans/admin-poc-production/completions/05-package-management.md` with exact endpoint/version evidence for every operation, test/live-probe results, any disabled preview operation, and Phase 06 preconditions.

## Done conditions

- Package reads work with read-only consent and map to normalized identities.
- Every available package mutation is confirmed, fenced, audited, durable, and provider-verified.
- Reassignment is implemented from a proven contract or truthfully visible as unavailable.
- No package state is confused with Copilot Studio quarantine or inferred from another source.
