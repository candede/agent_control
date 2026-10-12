# Optional mutation canaries

Agent Control package and quarantine changes do not require a canary. An
authorized Admin can perform a supported change after reviewing the exact target
and confirmation.

Canaries are optional production validation exercises for organizations that
require separate approval and verified restoration.

## Requirements

- A dedicated, approved test target
- Two Admin approvals for exact opposite states
- A third Admin account to execute the cycle
- Current provider permissions and licensing
- A maintenance window and restoration owner
- Monitoring until both the change and restoration are verified

Do not use production user targets or an agent whose interruption would affect
business operations.

## Package canary

For a block/unblock cycle:

1. Record and verify the package's current state.
2. Create an approval for the intended change.
3. Create a separate approval for the exact inverse change.
4. Use a different Admin account to execute the pair.
5. Verify provider readback after the first change.
6. Restore the original state and verify provider readback again.
7. Record the job IDs, actors, timestamps, target, and final state.

Package approval creation revalidates the current Admin and fences persistence against logout or session replacement without requesting a provider token. Execution retains its starting session generation from approval lookup through both durable-job submissions, job authorization, and qualification publication. Signing in again as the same principal cannot authorize an older cycle to continue or publish qualification.

Approval and execution also retain their initiating capability generation across awaited authority reads and persistence. Cycle claims, durable-job submissions and qualification publication are fenced immediately before commit; maintenance or provider-admission closure prevents claim and qualification publication. Failure completion remains available to record an interrupted cycle safely.

Package targets are exact opaque strings, including significant case and whitespace; they are never trimmed or coerced from numbers, arrays or objects. Approval UUIDs compare case-insensitively without changing package identities.

Canary job status/history marks `isCanary: true` and never advertises ordinary resume. An abandoned queued or paused canary cannot use the normal package worker or `/bulk-jobs/{id}/resume`, even after a new sign-in or failed cycle completion. Cancel unsent work and review any uncertain provider outcome before obtaining new approvals. Status reads, cancellation and read-only reconciliation remain available.

There is no API that accepts a caller's success claim or directly marks a capability qualified. An accepted or sent write is never automatically replayed. Startup changes an interrupted current workflow cycle to `inconclusive`; old workflow/database formats are not converted. Real-tenant execution requires separate authorization for the exact deployed release.

The current schema separates seven-day job retention from thirty-day verified qualification evidence. Publication still verifies both durable jobs and items before recording qualification. Afterwards their UUIDs are evidence references, not foreign keys or resumable jobs. Expiring either qualification removes its paired cycle atomically; runtime users cannot delete qualification records. Both retention boundaries are covered by current-schema fixtures, not historical upgrade tests.

Access cycles use the same action for both directions. Creating their inverse approval preserves the current exact reverse transition under the same revisions; a replacement approval still expires the prior same-direction intent. Current DDL makes verified access evidence unique per cycle stage so both directions can publish atomically while retaining the block/unblock uniqueness boundary. A canary never initializes, upgrades or resets the database; deployment requires its exact compiled schema fingerprint.

Both directions must also preserve a writable untouched scope: `none` with no principals or `some` with principals. Untouched all-users access, inactive entries under `none`, and empty `some` collections are rejected before approval storage or cycle claim because the full collection-only PATCH cannot preserve their exact semantic state. Selected collections still require at most 500 typed native directory IDs in both directions; valid opaque provider IDs remain exact in the untouched collection.

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

The original job stops before dispatch if current state differs from its approved prestate. Restoration is not dispatched automatically unless the original direction succeeds with exact provider readback. Any sent but unverified direction is `inconclusive` and cannot be retried automatically. Deterministic HTTP, worker, repository, current-schema, restart, browser, and packaged-runtime fixtures prove these local properties; they do not constitute a live provider canary.

If a durable package job result is missing, queued, still running, waiting for authorization, has unfinished items, or cannot be loaded during failure handling, the cycle remains `inconclusive`, not a definite pre-dispatch failure or restoration conflict. Result-loading failures emit the redacted `package_canary_result_unavailable` event; failure to persist the terminal cycle emits `package_canary_completion_failed`. The error response retains available job IDs for operator inspection. Restoration dispatch errors, including cancellation or a lost response after sending, also remain inconclusive; never infer that no write occurred or replay automatically.

## Copilot Studio quarantine canary

Use a dedicated Copilot Studio agent in an approved environment.

Two unused inverse approval records created by `AgentControl.Admin` are required for one exact target. The same Admin may create both; the executing Admin principal must differ from every approving principal. Each approver selects the exact native target from their own current private inventory snapshot; different approvers must not reuse another principal's snapshot UUID. Admin includes Viewer inventory access, but tenant/principal isolation still prevents one Admin from reusing another principal's private snapshot UUID. The original approval contains the exact direct provider prestate and exact `lastUpdateTimeUtc`; the future inverse approval must set `prestateProviderUpdatedAt` to `null`. The application binds restoration to the original direction's verified readback timestamp. A caller cannot predict, fabricate or replace that future timestamp.

Approval creation revalidates the current Admin and fences persistence against logout or session replacement without requesting a provider token. Execution retains its starting session generation through both durable-job submissions, job authorization, and qualification publication. Signing in again as the same principal does not authorize a previously interrupted cycle to continue.

The executor also needs their own current private inventory observation resolving that same exact native resource, environment and bot, plus provider-issued delegated authorization for `CopilotStudio.AdminActions.Invoke` under approved consent. The executor's snapshot UUID may differ from the approver's; matching names or associations cannot bridge the difference. Agent Control does not reconstruct quarantine eligibility from optional `wids` claims or hard-deny solely because such a claim is absent; provider authorization and the provider response remain authoritative. An application credential or package qualification is not delegated quarantine authority. No additional grant or provider role is assigned by these commands.

Microsoft documentation rechecked on 2026-09-10 conflicts on the version: the [Copilot Studio guide](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine) specifies `api-version=1`, while the generated [status](https://learn.microsoft.com/en-us/rest/api/power-platform/copilotstudio/bots/get-bot-quarantine-status), [quarantine](https://learn.microsoft.com/en-us/rest/api/power-platform/copilotstudio/bots/set-bot-as-quarantined) and [restoration](https://learn.microsoft.com/en-us/rest/api/power-platform/copilotstudio/bots/set-bot-as-unquarantined) request examples specify `2024-10-01`. The implemented contract uses `1` only, with no version, namespace, token-mode or permission fallback. The three REST references describe HTTP 200 with `isBotQuarantined` and `lastUpdateTimeUtc`; no conditional-write header is documented. Timestamps detect observed changes but cannot prevent an external race after the final pre-read. Resolve version/rollout eligibility through an approved exact-target read before approving live writes; do not infer eligibility from fixtures.

Provider timestamps must contain a valid UTC calendar date and time, without day rollover. Impossible provider dates or times fail with `provider_schema` rather than becoming status evidence; impossible approval timestamps fail with `invalid_qualification_state` before persistence. Valid timestamps retain their exact original text, including up to seven fractional-second digits, for prestate and restoration comparisons.

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

Each direction is a separate durable one-target job. Under the exact environment/bot lock, the worker performs two current GET pre-reads, compares semantic state and exact provider timestamp, marks the one permitted POST sent durably, dispatches once, and requires bounded GET convergence. Only a verified original result supplies the restoration prestate timestamp. Qualification is appended only after both job/item records independently prove their approved transition and the final state equals the original state. Qualification and failure completion must use the same reciprocal approval pair claimed at execution. Evidence expires after 30 days; normal startup never calls the provider.

A state flip without a changed provider timestamp is not verified canary evidence. If the original result lacks that evidence, restoration is not submitted; if either direction lacks it, the cycle remains inconclusive and no qualification is published.

Stop without restoration overwrite or replay when direct state/timestamp changes, authority changes, an approval is stale, a POST outcome is uncertain, readback does not converge, or another actor changes state before restoration. A sent item becomes `inconclusive` and only `POST /api/quarantine/jobs/{id}/reconcile` may inspect it by GET. Reconciliation can verify applied, verify the exact original state and timestamp, or record conflict; it never POSTs. Ordinary unsent work after restart becomes `waiting_authorization` and requires explicit resume. Canary jobs never advertise or accept ordinary resume, even if terminal cycle persistence failed and the approvals remain claimed: their original session-bound cycle is the only execution authority. Cancel abandoned unsent canary work and inspect any sent outcome before considering a newly approved cycle. Never approve a new operation on a target with unresolved sent work.

Maintenance or disabled provider work stops quarantine dispatch, further convergence reads, and reconciliation reads/publication at asynchronous admission boundaries. An unsent ordinary active item pauses for explicit authorized resume; paused canary work remains non-resumable. A durably sent item remains inconclusive and is never replayed. Logout preserves the active item's lease until its worker can pause unsent work or record a sent outcome; interrupted workers remain recoverable through the normal lease-expiry/restart path.

If job execution or loading its durable result fails, the cycle is `inconclusive`; the initial queued receipt does not prove that no POST occurred. Failure to persist a terminal cycle emits the redacted `quarantine_canary_completion_failed` event while preserving the original execution error. If target unlock, pausing, recording a worker failure, or releasing its lease also fails, `quarantine_job_cleanup_failed` records the cleanup stage without replacing the primary error. A release failure after verified publication never overwrites the committed job/item outcome. Cancellation stops unfinished work; a late request never relabels committed success or failure as cancellation. Inspect the durable jobs and approval records; do not replay the cycle or assume restoration occurred.

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

An access canary uses a replace operation derived from each approval's exact poststate. The selected target must be writable in both directions: `none` with an empty principal collection, or `some` with at most 500 native user/group IDs. A selected `all` scope or opaque non-directory principal is rejected before approval or execution because it cannot be restored through the confirmed write contract. An unchanged unselected `all` scope is preserved and verified normally. Unselected provider collections retain their exact opaque principal IDs and support the ordinary 5,000-principal observation bound; they are not rewritten as caller-entered directory assignments.

## Failure handling

- Stop if the current state differs from the approved prestate.
- Do not send the inverse action until the first action has verified readback.
- Treat an accepted write without verified readback as inconclusive.
- Do not automatically repeat an inconclusive write.
- Escalate to the restoration owner and inspect provider state directly.
- Keep the target unavailable until its final state is known.

Canary evidence does not grant permissions or make future provider operations
safe. Every operation still performs current authorization and target checks.
