# Phase 07 - Microsoft Graph Purview Audit Search

## Mission

Add bounded, on-demand Microsoft Purview Audit searches through the Microsoft Graph v1.0 asynchronous Audit Search API, recording actual request evidence for Microsoft's documented permission and property inconsistencies without a separate delegated-qualification gate.

## Prerequisites

- Follow the roadmap's manual fresh-session contract; read Phase 06's completion record and the Phase 01 job, Phase 02 auth/data-scope, and Phase 04 identity artifacts.
- Multi-resource Graph auth, durable jobs, capability probes, normalized identities, app roles, and Permission Center must be available.
- Do not deploy to Azure in this phase; use Phase 01's Docker deployment/test commands locally.

## Read first

- Phase 02 auth/capability code and Phase 01 on-demand jobs
- `backend/src/services/auditLog.ts` and `backend/src/routes/audit.ts`
- `frontend/src/components/AuditLogView.tsx`
- Current Graph v1.0 `auditLogQuery`, create/list/get query, and list-records documentation
- Current Purview Audit licensing, role, retention, and Copilot audit schema documentation

## Permission contract

- Resource: Microsoft Graph.
- Intended delegated/application permission for cross-workload searches: `AuditLogsQuery.Read.All`.
- Delegated users additionally need the Purview **Audit Logs** or **View-Only Audit Logs** role.
- Search availability and record retention depend on Purview Audit licensing, unified audit logging, workload support, and tenant rollout.
- Microsoft documentation has conflicted on the single-query GET permission and `serviceFilter` versus `serviceFilters`. An explicit bounded delegated search establishes exact create/poll/list-records evidence using current least-privileged credentials; no separate qualification approval/start ritual is required. Application/shared mode retains its separate Admin approval and qualification. Creating a saved query is bounded remote state and consumes service quota, even though it does not mutate audited business resources. A routine capability refresh must not create a new query. Do not invent remote delete/cancel/expiry operations that the current contract does not expose.

## Required implementation

1. Build a Graph Audit Search adapter for the documented v1.0 lifecycle: create an `auditLogQuery`, poll boundedly to a terminal state and retrieve bounded record pages. Track provider ID/status/error and separately configured local expiry; claim remote expiry only when documented/supplied. Validate every response.
2. At phase start, capture current official contract links and fixture shapes. The [create reference](https://learn.microsoft.com/en-us/graph/api/security-auditcoreroot-post-auditlogqueries?view=graph-rest-1.0) specifies `POST /security/auditLog/queries` and singular `serviceFilter`; reverify GET and records independently. If authorized, record one explicit bounded lifecycle's evidence, storing its provider query ID before polling; never require this prior exercise for ordinary delegated searches. Keep exactly one selected request contract; fixture variants document rejected/previous shapes, not runtime fallback requests or extra privilege grants.
   Report actual grant, tenant or request-contract failures with safe evidence and a recheck/support trigger. Absent optional live proof is an evidence gap, not a delegated activation gate. Fixture-complete adapter/jobs/UI work may finish the phase but is not live qualification.
3. Expose safe structured filters for UTC start/end, supported services/workloads, operations, users, IPs, object IDs, and administrative units where the API supports them. Do not accept arbitrary provider filter JSON or unbounded date ranges.
4. Provide curated Copilot and agent searches using `CopilotInteraction` and relevant Power Platform/Copilot Studio administrative operations. Parse versioned typed records; discard raw responses and unknown fields with safe schema diagnostics.
5. Allowlist the metadata needed for investigation: native event ID, event time, operation, workload/service, result, actor/object IDs, client IP, agent/app IDs and correlation/source fields where documented. Additional bounded metadata needs an explicit display/filter use; no unrestricted `auditData` or content payload storage.
6. Never claim Purview supplies prompt/response text: it records message identifiers and metadata, not conversation content. Render explicit `Content not present in Purview audit` states.
7. Associate records only through Phase 04's exact documented source-ID rules. Package, app, bot, agent and blueprint IDs are not interchangeable; unmatched/ambiguous events stay separate with no manual-link queue.
8. Own scoped query/record tables and the provider-audit read contract consumed by Phase 10. Distinguish tenant/native event ID from query/wrapper IDs; deduplicate within a result only with documented native identity and preserve query provenance. No continuous-feed or cross-channel merge framework. Local administrative audit remains a separate source in the combined UI.
9. Add a search history UI with status, filters, actor, requested/available range, record count, page completeness, local retention/freshness, retry/cancel, and export. `SecurityReader` authorizes bounded query execution and results; `Administrator` additionally controls application-backed shared search configuration. Delegated searches stay principal-scoped. Return a durable job ID promptly; do not keep HTTP open while polling Graph.
10. Add finite ordinary retention/deletion for cached allowlisted results and dependent exports. Raw audit response archives are prohibited, including opt-in ones. Audit authorized views/exports without logging result bodies.
11. Implement throttling/backoff, query concurrency limits, poll jitter, cancellation, restart recovery, stale-query reconciliation, pagination limits, and provider correlation IDs.
    Cancellation stops local polling/download and records that remote execution may continue; it does not claim provider cancellation. Ambiguous create timeout is reconciled with the saved operation marker/list-query contract when available, not blindly retried. Record all request/page/row/byte/time caps and expose `partial` plus unobserved range if reached. Local deletion removes results under policy, not the remote query or source events.
12. Add a prominent statement that Audit Search is compliance/security evidence and is not official Microsoft 365 Copilot Agents usage.

## Focused validation

- Protocol tests for create, running/succeeded/failed states, timeout, pagination, throttling, expiration, malformed `auditData`, unknown fields, duplicate records, cancellation, and restart recovery.
- Contract tests for the selected documented property shape, rejected variants, permission failures, create timeout without duplicate submission, local-only cancellation, and incomplete paging without complete coverage claims.
- Event identity tests for repeated wrapper rows, distinct native IDs, cross-tenant collisions and principal-scoped results/exports.
- Security tests for app roles, delegated/application distinction, date/row limits, injection attempts, unknown/raw-field discard, ordinary retention, export auditing and log redaction.
- Projection tests for Copilot and Power Platform records, exact identity linking, unmatched records, and absent message content.
- UI tests for status polling, partial/failed queries, stale data, filters, exact remediation, content-absent labels, and export.

## Aggregate validation

Run the global validation baseline. If authorized, create one narrow live query over a small recent window, poll and page it, then verify local cleanup/expiry handling. A tenant with no matching records is valid if the contract succeeds.

## Production continuation

An inconclusive or failing live proof does not stop the campaign. Report actual request/authorization failures with exact evidence, keep local administrative audit independent and link the fix-forward issue. Do not make optional qualification a prerequisite for ordinary delegated searches or broaden to an unrelated permission such as `ThreatIntelligence.Read.All` without current authoritative proof.

## Scope guard

Do not start a Management Activity subscription, query Defender, retrieve transcripts, or compute official usage. Do not deploy to Azure.

## Completion record

Create `plans/admin-poc-production/completions/07-graph-audit-search.md` with exact live request property contract, permission/role evidence, probe status, retention, and Phase 08 preconditions.

## Done conditions

- Bounded delegated Graph audit searches are on demand, durable, restart-safe, permission-gated and source-provenanced; actual request failures have truthful evidence and remediation without a prior-qualification gate.
- Copilot/agent audit metadata is normalized without claiming message content or official usage.
- Microsoft contract ambiguity is disclosed and actual outcomes are recorded; absent optional proof is not an activation prerequisite.
- Phase 08 hunting and Phase 10's two-source audit UI can reuse scoped jobs/read contracts without any feed infrastructure.
