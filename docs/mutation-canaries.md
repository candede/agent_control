# Mutation canaries

Implemented package access, block/unblock and Copilot Studio quarantine writes run on demand for an authorized, confirming Admin. No prior canary, qualification record or additional mode/configuration is required. Current sign-in, Admin role, provider permissions, same-origin/CSRF, exact targets, confirmation, immediate prestate checks, audit and provider readback remain mandatory. A successful read, delegated consent, HTTP acceptance, or local test is not live write verification. No live provider write was authorized or performed during Phase 05 or Phase 09 implementation.

The canary workflows below are optional, separately approved qualification exercises. Their approval, principal separation, restoration and publication requirements apply when explicitly executing a canary, never as prerequisites for ordinary writes. Access writes lack provider conditional concurrency protection and can overwrite an external administrator's concurrent change; local prestate checks do not eliminate that risk. Owner reassignment has no implemented product workflow or documented owner readback. Application/shared modes retain their separate configuration and scope requirements.

Automatic permission checks are read-only and never create, approve, claim or execute a mutation canary. They do not submit provider writes or weaken the preview, confirmation, reauthorization, ownership, restoration or readback requirements below.

Package access, block/unblock and quarantine management declare `on_demand` probing. With no prior evidence, initial decision verification is `on_demand`, allowing the current Admin to attempt a confirmed operation without claiming token or provider proof. Automatic permission checks acquire only the required delegated token, replacing that initial decision with expiring `token` evidence or a failure. Missing consent, interaction failures and expired evidence are not bypassed by on-demand readiness. The submitted operation validates delegated provider authorization again and performs its own immediate prestate and readback checks. Optional qualification evidence expires independently and never changes ordinary write availability. Automatic checks never execute a canary or provider write.

## Qualification boundary

Optional package qualification is tenant-, action-, contract-revision-, configuration-revision-, and delegated-auth-mode-specific. Current evidence must use workflow version 3, must be backed by a succeeded durable job and item, and expires no later than 30 days after execution. A full block qualification exercise records both `block` and `unblock`; access evidence records its exact `update-availability` or `update-installation` action and restored state. Missing or expired evidence does not prevent an ordinary Admin-confirmed operation.

The full cycle requires two current, unused, exact-inverse approvals. Each approval is created by an `AgentControl.Admin`; the authenticated Admin principal who executes the cycle must be different from both approving principals. The runtime stores the exact package target, approver and actor identities, code-derived contract/configuration revisions, minimal typed prestate/poststate, code-derived restoration criteria, paired approval and job IDs, cycle stage, correlation, terminal outcome, restoration time, and expiry. It never stores a token or unrestricted provider response. Approvals expire after 30 minutes. Attempted and qualified evidence expires after 30 days.

`POST /api/agents/mutation-canaries` creates one workflow-v3 approval. `POST /api/agents/mutation-canaries/{original-id}/execute` atomically claims the exact-inverse pair, runs the original direction as a normal durable job, and runs restoration as a second normal durable job only after the original job is durably verified. Qualification publishes atomically only after both job/item records prove the approved actions, target, prestates, poststates, and provider readbacks and after the executing Admin account, role, capability identity, contract, auth mode, and configuration are revalidated.

There is no API that accepts a caller's success claim or directly marks a capability qualified. An accepted or sent write is never automatically replayed. Startup changes an interrupted workflow-v3 cycle to `inconclusive`; migration 11 invalidates prior workflow-v1/v2 qualification and converts interrupted workflow-v2 work without replay. Phase 13 owns authorized real-tenant execution for a deployed release.

Migration 12 separates seven-day job retention from thirty-day verified qualification evidence. Publication still verifies both durable jobs and items before recording qualification. Afterwards their UUIDs are evidence references, not foreign keys or resumable jobs. Expiring either qualification removes its paired cycle atomically; runtime users cannot delete qualification records. The nonempty schema-11 upgrade and both retention boundaries are covered by isolated PostgreSQL tests.

## Executable full-cycle command

From an authenticated same-origin Admin session, obtain the current CSRF value from `/api/me` and create the original approval. The request accepts exactly `action`, `targetId`, `prestate`, and `poststate`; unknown keys, arrays of targets, caller-supplied criteria/revisions, no-op transitions, action mismatches, and malformed access principal IDs are rejected.

```http
POST /api/agents/mutation-canaries
Content-Type: application/json
X-CSRF-Token: <current session CSRF value>

{
	"action": "block",
	"targetId": "<dedicated approved package ID>",
	"prestate": { "kind": "block", "isBlocked": false },
	"poststate": { "kind": "block", "isBlocked": true }
}
```

Create a second approval for the exact inverse transition. For block qualification, the inverse action is `unblock` and its prestate/poststate are reversed.

```http
POST /api/agents/mutation-canaries
Content-Type: application/json
X-CSRF-Token: <current session CSRF value>

{
	"action": "unblock",
	"targetId": "<same dedicated approved package ID>",
	"prestate": { "kind": "block", "isBlocked": true },
	"poststate": { "kind": "block", "isBlocked": false }
}
```

A different authenticated Admin principal executes the pair using the two returned opaque approval IDs. The body accepts only `confirmed: true` and `restorationApprovalId`. Delegated Graph tokens are acquired in process for each job and are never accepted in the body or written to disk/database.

```http
POST /api/agents/mutation-canaries/<original-approval-id>/execute
Content-Type: application/json
X-CSRF-Token: <current executing Admin session CSRF value>

{
	"confirmed": true,
	"restorationApprovalId": "<inverse-approval-id>"
}
```

The original job stops before dispatch if current state differs from its approved prestate. Restoration is not dispatched automatically unless the original direction succeeds with exact provider readback. Any sent but unverified direction is `inconclusive` and cannot be retried automatically. Deterministic HTTP, worker, repository, migration, restart, browser, and packaged-runtime fixtures prove these local properties; they do not constitute a live provider canary.

## Copilot Studio quarantine canary

Optional quarantine qualification is separate from package qualification and requires one restored full cycle for the exact environment/bot under the current tenant, delegated auth mode, `CopilotStudio.AdminActions.Invoke` permission revision, contract revision and configuration revision. Evidence for one bot proves nothing about another bot, including another bot in the same environment, and is not an authorization requirement for ordinary writes. The only target source is one current principal-private `microsoft.copilotstudio/agents` inventory row with exact native resource, environment and CDS bot IDs. The inventory observation must be less than 24 hours old. Classic bots, names, package IDs, manually entered environment/bot IDs, Defender IDs, blueprints and cross-source associations are invalid targets.

Two unused inverse approval records created by `AgentControl.Admin` are required for one exact target. The same Admin may create both; the executing Admin principal must differ from every approving principal. Each approver selects the exact native target from their own current private inventory snapshot; different approvers must not reuse another principal's snapshot UUID. Admin includes Viewer inventory access, but tenant/principal isolation still prevents one Admin from reusing another principal's private snapshot UUID. The original approval contains the exact direct provider prestate and exact `lastUpdateTimeUtc`; the future inverse approval must set `prestateProviderUpdatedAt` to `null`. The application binds restoration to the original direction's verified readback timestamp. A caller cannot predict, fabricate or replace that future timestamp.

The executor also needs their own current private inventory observation resolving that same exact native resource, environment and bot, plus provider-issued delegated authorization for `CopilotStudio.AdminActions.Invoke` under approved consent. The executor's snapshot UUID may differ from the approver's; matching names or associations cannot bridge the difference. Agent Control does not reconstruct quarantine eligibility from optional `wids` claims or hard-deny solely because such a claim is absent; provider authorization and the provider response remain authoritative. An application credential or package qualification is not delegated quarantine authority. No additional grant or provider role is assigned by these commands.

Microsoft documentation rechecked on 2026-09-10 conflicts on the version: the [Copilot Studio guide](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine) specifies `api-version=1`, while the generated [status](https://learn.microsoft.com/en-us/rest/api/power-platform/copilotstudio/bots/get-bot-quarantine-status), [quarantine](https://learn.microsoft.com/en-us/rest/api/power-platform/copilotstudio/bots/set-bot-as-quarantined) and [restoration](https://learn.microsoft.com/en-us/rest/api/power-platform/copilotstudio/bots/set-bot-as-unquarantined) request examples specify `2024-10-01`. The implemented contract uses `1` only, with no version, namespace, token-mode or permission fallback. The three REST references describe HTTP 200 with `isBotQuarantined` and `lastUpdateTimeUtc`; no conditional-write header is documented. Timestamps detect observed changes but cannot prevent an external race after the final pre-read. Resolve version/rollout eligibility through an approved exact-target read before approving live writes; do not infer eligibility from fixtures.

Create the original approval after an explicit direct status read. The body accepts only the six fields shown:

```http
POST /api/quarantine/canary-approvals
Content-Type: application/json
X-CSRF-Token: <current approving Admin session CSRF value>

{
	"action": "quarantine",
	"snapshotId": "<current private inventory snapshot UUID>",
	"nativeId": "<exact inventory native resource ID>",
	"prestate": false,
	"prestateProviderUpdatedAt": "<exact lastUpdateTimeUtc from direct status>",
	"poststate": true
}
```

An Admin creates the exact inverse approval using their own snapshot of the same native target. For an initially non-quarantined bot:

```http
POST /api/quarantine/canary-approvals
Content-Type: application/json
X-CSRF-Token: <current approving Admin session CSRF value>

{
	"action": "unquarantine",
	"snapshotId": "<approver's current private snapshot UUID>",
	"nativeId": "<same exact native resource ID>",
	"prestate": true,
	"prestateProviderUpdatedAt": null,
	"poststate": false
}
```

If the original state is quarantined, reverse both actions and boolean states. The original direction still carries the exact direct provider timestamp and the restoration approval still carries `null`. Approvals expire after 30 minutes and can be claimed once.

The distinct Admin principal executes the pair:

```http
POST /api/quarantine/canary-approvals/<original-approval-id>/execute
Content-Type: application/json
X-CSRF-Token: <current executing Admin session CSRF value>

{
	"confirmed": true,
	"restorationApprovalId": "<exact inverse approval ID>"
}
```

Each direction is a separate durable one-target job. Under the exact environment/bot lock, the worker performs two current GET pre-reads, compares semantic state and exact provider timestamp, marks the one permitted POST sent durably, dispatches once, and requires bounded GET convergence. Only a verified original result supplies the restoration prestate timestamp. Qualification is appended only after both job/item records independently prove their approved transition and the final state equals the original state. Evidence expires after 30 days; normal startup never calls the provider.

Stop without restoration overwrite or replay when direct state/timestamp changes, authority changes, an approval is stale, a POST outcome is uncertain, readback does not converge, or another actor changes state before restoration. A sent item becomes `inconclusive` and only `POST /api/quarantine/jobs/{id}/reconcile` may inspect it by GET. Reconciliation can verify applied, verify the exact original state and timestamp, or record conflict; it never POSTs. Unsent work after restart becomes `waiting_authorization` and requires explicit resume. Never approve a new operation on a target with unresolved sent work.

Before live execution, record the tenant, dedicated nonproduction environment/bot and native inventory IDs, snapshot/observation time, direct state and exact provider timestamp, both approving Admin principals, the distinct executing Admin principal, both approval IDs, capability revisions, 30-minute window, stop conditions, and channel-owner confirmation. Quarantine can prevent channel use while makers may still see/test the bot in Copilot Studio. Package blocking is not part of this canary and must not be used as restoration.

The only requested field is `isBotQuarantined`; `lastUpdateTimeUtc` is provider-owned evidence, never a field to restore. Use `GET /api/quarantine/jobs` and `GET /api/quarantine/jobs/{id}` to recover durable job IDs and results after connection loss. Read-only reconciliation accepts an empty body and current Admin/delegated authority without a qualified write. A new write requires a fresh preview, confirmation and idempotency key after reconciliation; an identical transport retry keeps the original intent/key. Never rerun the claimed canary `/execute` after an uncertain response. A changed restoration prestate requires incident review and separately approved recovery, not automatic inversion.

Recovery is fixture-tested before any live approval through `scripts/restart-runtime.tests.ps1`, the quarantine job/canary repository and service tests, and the shared permission browser harness, all inside Docker. Jobs/items/attempts expire after seven days, direct observations and qualification evidence after 30 days, approvals after 30 minutes for dispatch, and ordinary audit after 90 days. Retention performs no provider requests. A 30-day evidence record does not extend the short approval window or make an expired job resumable. No live target or canary was approved for Phase 09; no provider status or write was attempted, and no live restoration or cleanup is claimed.

## Approval record

Before creating either application approval, record change approval outside the application with:

- Exact global-cloud tenant and dedicated nonproduction package ID.
- One action only and its exact preview endpoint.
- Executing Admin account and both approval records; the executor must differ from both approving principals.
- Intended minimal change and expected provider state.
- Original semantic state plus the exact inverse action and state transition.
- Time window, stop conditions, and an expiry no more than 30 days away.
- Current capability contract hash and configuration revision.

Do not use a production package merely to satisfy validation. Do not authorize a general batch, owner reassignment, or an application token. Package writes require delegated `CopilotPackages.ReadWrite.All` and a Microsoft Agent 365 license; the operation pages name no additional human Entra administrator role.

## Reversible procedure

1. Read the exact dedicated package through Microsoft Graph and capture only mutation-relevant semantic state.
2. Create the original and exact-inverse approvals. Verify the same target, reversed typed states, current code-derived revisions, expiry, approving principals, and a distinct intended Admin executor.
3. Invoke `/execute` once. The application atomically claims both approvals and attaches the original durable job before provider work.
4. Under the target lock, the worker reauthorizes the current account, rereads the exact target, compares approved prestate, records sent-before-provider, dispatches once, and performs bounded readback. HTTP acceptance alone is not success.
5. Only after the original job succeeds, the application attaches and runs the restoration durable job through the same controls. It restores only the approved field and requires exact original-state readback.
6. The repository revalidates both jobs and the current Admin/capability identities, then atomically publishes both directional qualification records. A newer verified record expires an older record for the same qualification key.
7. On any uncertain dispatch, account/role loss, external state change, timeout, or process interruption, stop. Preserve redacted durable evidence, use read-only reconciliation where applicable, and never replay sent work automatically.

For block/unblock, the touched field is `isBlocked`. Access writes and restoration preserve the unselected collection and verify both collections. The documented beta endpoint has no `If-Match` or equivalent lost-update protection: a concurrent external change after the final pre-read can be overwritten. This is a disclosed risk, not a prerequisite to enabling access management. Reassignment has no implemented product workflow or documented owner readback. A canary that changes both access targets, makes no semantic transition, or mismatches its action is invalid; restoration criteria are generated by application code rather than accepted from a caller.

## Failure handling

- Accepted but unobserved, timeout-after-dispatch, provider error after dispatch, or process interruption: leave the durable item/cycle `inconclusive`; use read-only reconciliation and do not replay automatically.
- Current state differs before dispatch: return conflict and obtain a new preview.
- Original state differs before dispatch, or restoration prestate differs after the original direction: stop. Do not overwrite the external change.
- Restoration cannot be verified: keep the canary inconclusive, retain the incident evidence under normal finite retention, and escalate to the package owner/provider administrator. Reconcile the affected target before new work; an unsuccessful optional canary is not a global ordinary-write gate.
- Contract, permission, auth mode, configuration revision, account generation, or required internal role changes: execution/publication fails closed; obtain new approvals for the deployed revision.

Microsoft operation references: [list](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackages-list), [detail](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-get), [update access](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-update), [block](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-block), [unblock](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-unblock), and [reassign](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-reassign).
