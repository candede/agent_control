# 04A - Shared API agent controls and web consumers

## Mission

Complete API-owned control routing, preview/execute/status contracts, durable jobs, and corresponding web consumers before any MCP implementation. Preserve every current web control's business effect while making the same canonical operations usable by an authorized bearer caller.

## Prerequisites

Read [README](README.md), [01](01-contracts-and-feasibility.md), [03](03-api-auth-integration.md), [03A](03A-shared-api-and-audit-origin.md), [04](04-api-read-contracts.md), and their exact completion records. Use the operation map, shared principal/credentials, origin context, and exact discovery contracts. Inspect scoped status and repository/worker instructions.

## Read first

- [Package mutations](../../backend/src/routes/inventoryMutations.ts), [package jobs](../../backend/src/routes/agents.ts), [mutation stages](../../backend/src/db/inventoryMutationStages.ts), [bulk workers](../../backend/src/services/bulkJobs.ts).
- [Quarantine routes](../../backend/src/routes/copilotStudioQuarantine.ts), [control service](../../backend/src/services/copilotStudioQuarantineControl.ts), [quarantine workers](../../backend/src/services/copilotStudioQuarantineJobs.ts), [native inventory](../../backend/src/db/nativeInventory.ts).
- [Frontend HTTP adapters](../../frontend/src/api/client.ts), [package confirmation](../../frontend/src/App.tsx), [package control regressions](../../frontend/src/components/PackageManagement.test.tsx), [bulk actions](../../frontend/src/components/BulkActions.tsx), [Studio controls](../../frontend/src/components/CopilotStudioQuarantineControls.tsx).
- [Audit](../../backend/src/services/auditLog.ts), [operational admission](../../backend/src/services/operationalState.ts), [control canaries](../../docs/mutation-canaries.md), and existing prestate/readback/idempotency tests.

## Required implementation

1. Implement one narrow API-owned canonical preview/execute/status operation map used by the web app and future MCP tools. Reuse existing package/quarantine services and sole writers. Generic block/unblock routes verified Studio targets to quarantine/unquarantine and other supported agents to package controls. Preserve explicitly named package-only and Studio-only operations separately; route reuse is preferred to gratuitous renaming.
2. Resolve exact current canonical/source/environment identities. Report-only, ambiguous, unsupported/classic-bot, missing-platform, missing-permission, or incomplete-inventory targets return explicit eligibility results. Never derive a provider target from a name/description.
3. Preserve native selections/snapshots/receipts, exact membership, prestate, tenant/principal, action/effect, revision, expiry, and authority binding. Return exact IDs/names, provider effects, already-in-state items, eligible/ineligible counts/reasons, and immutable receipt. Changed membership/prestate or revoked authority rejects stale execution.
4. Execute through existing jobs with stable operation/idempotency identities. Mixed provider selections are independent child jobs, not cross-provider atomicity. Keep existing repositories as item/outcome authority. Own only necessary non-secret parent correlation, schema/index upgrade, fresh-init/fingerprint parity, retention, and child status/cancel/resume/reconcile contracts; no duplicate execution state.
5. Preserve Admin/provider authorization, inventory authority, prestate, readback, audit, maintenance/capacity limits, cancellation, and no canary prerequisite for ordinary controls. Reconcile sent-unknown items before retry; never automatically replay uncertain writes.
6. Return accepted/final/verified outcomes separately, including partial, ineligible, failed, authorization-wait, and readback-unknown states. Persist 03A initiating origin transactionally and propagate it through parents/children/items for both providers. Idempotent replay preserves original provenance; later lifecycle requests get separate context. Attribution labels never alter operation identity.
7. Cut over corresponding web preview/submission/status/recovery adapters to these exact routes in the same phase. Preserve current defaults, filters, selection, labels, confirmation, eligibility, provider effects, and final-state presentation. Do not silently change an existing explicit package action into generic Studio quarantine; if contracts differ, retain distinctly named canonical operations. No intentional behavioral UI shift without explicit user approval.
8. Expose the same API lifecycle operations to permitted cookie and bearer transports. Direct synthetic bearer calls can submit a current receipt without a human pause; this is client workflow ownership, not a new schedule/confirmation bypass flag. No MCP package/server is needed to prove API readiness.
9. Add backend/frontend parity, receipt, job, origin, and effect regressions; update the shared operation map and security/control documentation. All API control decisions and frontend cutover are finished here, not deferred to 07.

## Scope guard

No MCP/Python code or dependency, scheduler, business approval engine, guessed targets, double-blocking by default, new provider authority, live customer bulk mutation, or intentional change to current web control effects.

## Validation

- Add `src/routes/sharedAgentControls.test.ts`; run it with directly affected package/quarantine/job/audit suites and backend typecheck.
- Run changed frontend API/control/job tests together; build/lint the affected frontend.
- Prove both providers/action directions, multi-page discovery, unknown identity/dates, receipt binding/expiry, concurrent changes, duplicate submission, mixed partial failure, revocation, restart/resume, uncertain readback, and no canary prerequisite.
- Use 03A parity fixtures with matched synthetic prestate to prove the same registered method/route, defaults, eligibility, effects, and errors for browser/bearer calls. Verify explicit package versus generic Studio effects remain distinct.
- Prove origin survives direct/quarantine writers, children, retry, replay and separate lifecycle requests. Do not require actual MCP metadata or real protocol proof.
- Live writes wait for 04C and explicitly approved disposable exact targets. Run `git diff --check`; obey README feeds.

## Production continuation

Apply README's Always-Deploy and two-part contracts. 04C owns the first API/web production release and browser control canaries; 12 later proves MCP adapters. Record provider gaps truthfully with containment and fix-forward owners. Never defer a missing API control contract or web consumer to Part 2.

## Completion record

Write `completions/04A-api-agent-controls.md`: exact canonical routes and explicit/generic effects, source identity proof, receipt/idempotency/child-job/schema contracts, unchanged web consumers, origin/lifecycle evidence, tests, root impacts, residuals, and 04B/04C/07 handoffs.

## Done and handoff

The web app uses the final shared control APIs with its prior business behavior. Direct bearer fixtures exercise the same controller/services/jobs. 04B can qualify the complete app; 07 only wraps these accepted contracts in MCP tools.
