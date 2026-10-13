# 07 - Thin MCP block/unblock and job tools

## Mission

Wrap the already deployed, user-accepted 04A control APIs with thin MCP preview/execute/job tools. Support interactive and externally scheduled client workflows without redesigning API routes, jobs, provider effects, or the web app.

## Prerequisites

Read [README](README.md), [03A](03A-shared-api-and-audit-origin.md), [04A](04A-api-agent-controls.md), [05](05-fastmcp-service-and-auth.md), [06](06-mcp-read-tools.md), and their completion records, plus the actual `completions/PART-1-ACCEPTANCE.md`. Preserve current changes; use the accepted API operation map, principal, origin context, HTTP adapter and discovery contracts.

## Read first

- [Package mutations](../../backend/src/routes/inventoryMutations.ts), [package jobs](../../backend/src/routes/agents.ts), [mutation stages](../../backend/src/db/inventoryMutationStages.ts), [bulk workers](../../backend/src/services/bulkJobs.ts).
- [Quarantine routes](../../backend/src/routes/copilotStudioQuarantine.ts), [control service](../../backend/src/services/copilotStudioQuarantineControl.ts), [quarantine jobs](../../backend/src/services/copilotStudioQuarantineJobs.ts), [native inventory](../../backend/src/db/nativeInventory.ts).
- [Control canaries](../../docs/mutation-canaries.md), [audit](../../backend/src/services/auditLog.ts), [operational admission](../../backend/src/services/operationalState.ts), and current prestate/readback/idempotency tests.

## Required implementation

1. Implement typed MCP preview/execute/status/item-results/cancel/resume/reconcile adapters for 04A's canonical HTTP routes where supported. Use the same operation names/defaults/receipts as the web app; no MCP-only API routes or control execution state.
2. Forward exact current canonical/source/environment identities discovered through 06. The API alone resolves platform/provider eligibility and effects. Preserve explicit package-only versus Studio-only operations separately from generic controls; never route by name/description in Python.
3. Return complete API preview evidence: target IDs/names, provider effects, prestate, eligible/ineligible/already-in-state counts/reasons and opaque immutable receipt. Preserve selection/revision/expiry; stale targets or authority failures remain explicit API errors, not MCP target substitutions.
4. Submit stable caller operation/idempotency identities and poll existing jobs/child results with bounded requests. API owns mixed-provider correlation, schemas, cancellation/recovery and sent-unknown reconciliation. Never automatically retry an uncertain provider write or claim cross-provider atomicity.
5. Scheduled clients obtain the same current receipt and execute without a human pause; interactive clients display preview and ask first. No approval-task storage, schedule flag bypass, or self-asserted `confirmed=true` security guarantee. Interactive clients must reconfirm changed receipts.
6. Preserve accepted/final/verified and partial/ineligible/failed/authorization-wait/readback-unknown outcomes. Carry 05 request-local origin automatically; 03A/04A remain durable audit writers. Origin changes on replay cannot replace the initial provenance; lifecycle requests keep their own context.
7. Use truthful annotations/docstrings and client recipes, including Admin/provider requirements, effects, exact preview/expiry, no ordinary canary prerequisite and bounded job polling. Add protocol/catalog/HTTP-capture/attribution tests against the accepted control contract.
8. Do not perform the first API routing/schema/frontend implementation here. Repair adapter defects locally. If a genuine shared API/web defect is discovered, repair its 04A/03A owner and update records; material changes require README's redeployed web validation/user reacceptance before affected MCP work continues.

## Scope guard

No new API route/control schema/frontend cutover, Python provider routing, double-blocking by default, guessed identity, approval policy, scheduler, LLM decisions, broad tenant canary, or provider/access/consistency bypass.

## Validation

- Reuse `src/routes/sharedAgentControls.test.ts` and 03A's origin/parity suites from Part 1; do not create a second API routing authority. Run changed API tests/typecheck only when a root fix actually changes the API.
- Run `python -m pytest mcp/tests/test_control_tools.py mcp/tests/test_tool_catalog.py`.
- Prove both providers/action directions, >1 page discovery, unknown dates/identity, exact receipt binding, concurrent changes, duplicate submission, mixed-provider partial failure, revocation, restart/resume, uncertain write/readback, and no canary prerequisite.
- Protocol tests must demonstrate scheduled preview-to-execute without human input. 09 owns actual interactive conversation proof; server fixtures must not claim it.
- Prove identical canonical web/MCP routes, receipt validation, provider effects, eligibility, and domain errors on matched synthetic prestate. Confirm both package and quarantine audits retain channel/client/calling-agent/evidence, including mixed children, retry and web resume of an MCP-origin job; frontend filters/CSV and MCP audit reads agree.
- Use isolated synthetic providers/DB; live writes only on explicitly approved disposable targets in 12. Run `git diff --check` and obey README feeds.

## Production continuation

Apply README's Always-Deploy and accepted-Part-2 contracts. A provider-specific residual contains that MCP write surface, not the accepted web release. Never bypass authority checks or silently change web effects. Carry exact restoration canaries and alert/fix-forward owners to 12.

## Completion record

Write `completions/07-mcp-agent-controls.md`: thin tool-to-accepted-route map, preserved effects/receipts/job outcomes, HTTP/protocol/origin/retry proofs, tests, root impacts, any owner-directed repairs/reacceptance, client confirmation limitation, and live-write obligations.

## Done and handoff

An authorized agent can preview and execute exact package or Studio changes through MCP and inspect verified outcomes. Both client workflows share normal API execution; no new customer approval gate or hidden provider-control authority exists.
