# Phase 08 - On-Demand Defender and Agent 365 Hunting

## Mission

Add curated, bounded Microsoft Graph hunting for `AgentsInfo` inventory and Agent 365 `CloudAppEvents`. Retain useful allowlisted investigation fields, not a telemetry warehouse or official usage substitute.

## Prerequisites

- Follow the README's fresh-session contract. Read Phase 07's completion, Phase 02 auth/data scope, Phase 04 exact-ID helpers and Phase 01 durable jobs.
- Graph delegated/application acquisition, capability gates, scoped persistence and Phase 03 UI/test helpers exist. No Azure deployment in this phase; use Phase 01/03's Docker deployment/test commands locally.

## Read first

- Delivered Phase 02 Graph auth, Phase 04 identity and Phase 07 query/job/UI artifacts
- Current Graph v1.0 `security/runHuntingQuery`, Defender advanced-hunting limits/RBAC, `AgentsInfo` and `CloudAppEvents` references
- Current Agent 365 observability exposure/attribute documentation

## Permission contract

- `POST https://graph.microsoft.com/v1.0/security/runHuntingQuery` uses delegated/application `ThreatHunting.Read.All`.
- Delegated data also obeys Defender XDR RBAC/data-source assignment. App consent alone does not prove data visibility.
- Application access requires separate administrator enablement and approved shared dataset scope, and still serves explicit user requests only.
- `AgentsInfo` is preview; do not use retired `AIAgentsInfo`. Cloud App/Agent 365 data needs the applicable Defender connectivity, rollout and licensing. Do not grant Agent Control observability-write permissions or emit activity for other agents.

## Required implementation

1. Build a typed adapter with finite timeout, retries for safe read-query failures, correlation IDs and dynamic schema/row validation. Capture the selected current contract and limits with source links and sanitized fixtures.
2. Own minimal query/result/snapshot migrations and repositories using existing jobs. Publish shared result types for Phase 10, tenant/principal/application visibility scope, requested/observed window, query version, counts, truncation and observation time. Apply finite result retention and dependent export cleanup.
3. Add a fixed `AgentsInfo` query with explicit field projection and limits: exact identifiers, platform, lifecycle, owner and useful permission/risk metadata. Allowlist bounded typed detail fields; discard original response, unknown fields, instructions, memory, message content, tool arguments/results and secrets. No opt-in raw archive.
4. Preserve preview/null/empty/unavailable distinctions. Apply Phase 04's exact typed-ID relationships without merging a blueprint's children or overwriting package/Power Platform state. Unmatched records stay separately visible. All joins preserve source visibility; inventory placement does not bypass `SecurityReader` for Defender data.
5. Add fixed `CloudAppEvents` investigation templates for Agent 365 operations with only the documented metadata needed by filters/detail: event/agent/app/blueprint IDs, operation, actor IDs, timestamps/duration, result, correlation and bounded model/tool/token-count metadata where actually exposed. Unexposed fields are absent, never inferred.
6. Explain the actual observability boundary: emitted input/output or tool content may not be exposed through hunting, and child-only spans do not establish an admin-center run with a valid root `invoke_agent`. Do not reconstruct conversations or claim content retrieval.
7. Require `SecurityReader` for queries/results/exports; configuration additionally requires `Administrator`. Use explicit template selection and typed escaped filters, a bounded `Timespan`, and row/byte/time/request budgets. No arbitrary KQL editor. Link to Defender's own portal for unrestricted investigation.
8. Do not expose `workspaceId` selection: the [Graph contract](https://learn.microsoft.com/en-us/graph/api/security-security-runhuntingquery?view=graph-rest-1.0) may silently fall back to a primary workspace. Label only proven actual scope, never promise requested-workspace isolation.
9. Submit a durable job promptly and execute only explicit refresh/search requests. No scheduled snapshots, activity-summary harvesting or startup/navigation queries. Delegated cache loss moves unsent work to `waiting_authorization`; no app-identity fallback. Result polling completes an existing request, not a recurring collector.
10. Hunting is not an unlimited paginated export API. Respect provider caps; any bounded time slicing must report uncovered intervals and a smallest slice that still overflows. Capped snapshots never delete unseen agents or claim complete totals. Retain the prior successful result with new attempt status on failure.
11. Provide fixed-template investigation UI, source-safe export and readiness diagnostics for license/rollout, connector, table and observed range. Empty valid results mean `no_data`, not automatically missing permission. Audit query/export actions without result bodies. Keep official usage, Purview and hunting visibly separate.

## Focused validation

- Protocol fixtures: delegated/application scope, RBAC ambiguity, malformed dynamic fields, throttling, timeout, quotas/truncation and valid empty results.
- Fresh/upgrade schema, finite retention, unknown/raw-field discard, principal/application result isolation and loss-of-cache reauthorization.
- Exact IDs across kinds/tenants, blueprint children, source disagreement, preview/null fields, absent content and root/child spans.
- Typed filter escaping, rejection of arbitrary KQL/workspace selection, hard budgets, incomplete coverage and no automatic collection after startup/navigation.
- Component tests for explicit search, status, freshness, source labels, permission/connector/no-data states and bounded result/export views.

## Aggregate validation

Run the README baseline and Phase 03's applicable UI checks. Attempt one authorized bounded `AgentsInfo` query and one narrow `CloudAppEvents` query; empty data can prove protocol success, not complete tenant coverage. No tenant-sensitive fixtures or record contents in handoffs.

## Production continuation

Missing license/RBAC/connectivity or preview rollout leaves only the affected retained capability disabled with evidence and remediation. Empty telemetry is not a defect by itself. Link residuals for Phase 13 qualification; do not broaden grants or invent telemetry.

## Scope guard

No schedules, collectors, raw archives, arbitrary KQL, detections, telemetry emission, transcripts or official-usage substitution. No Azure deployment. Future ideas are not optional work here.

## Completion record

Create `plans/admin-poc-production/completions/08-defender-agent365-hunting.md` using the shared template. Record query/field contracts, data scope, caps, actual tests/probes, linked issues and Phase 09 preconditions.

## Done conditions

- Curated manual hunting is fixture-complete, scoped and source-provenanced. Ordinary delegated investigations establish evidence through the explicit request without prior qualification; actual provider limitations are reported truthfully. Application/shared mode retains its separate Admin approval and qualification.
- Only needed allowed fields are retained; exact IDs and incomplete coverage remain honest.
- Phase 09 can reuse established auth/jobs and Phase 10 can consume typed hunting results without collector infrastructure.
