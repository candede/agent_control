# Phase 07 - Microsoft Graph Purview Audit Search

## Mission

Add bounded, on-demand Microsoft Purview Audit searches through the Microsoft Graph v1.0 asynchronous Audit Search API, with a live proof-of-contract gate for Microsoft's documented permission and property inconsistencies.

## Prerequisites

- Read the roadmap and completion records for Phases 01-06.
- Multi-resource Graph auth, durable jobs, capability probes, normalized identities, app roles, and Permission Center must be available.
- Do not deploy in this phase.

## Read first

- Phase 02 auth/capability code and Phase 01 jobs/checkpoints
- `backend/src/services/auditLog.ts` and `backend/src/routes/audit.ts`
- `frontend/src/components/AuditLogView.tsx`
- Current Graph v1.0 `auditLogQuery`, create/list/get query, and list-records documentation
- Current Purview Audit licensing, role, retention, and Copilot audit schema documentation

## Permission contract

- Resource: Microsoft Graph.
- Intended delegated/application permission for cross-workload searches: `AuditLogsQuery.Read.All`.
- Delegated users additionally need the Purview **Audit Logs** or **View-Only Audit Logs** role.
- Search availability and record retention depend on Purview Audit licensing, unified audit logging, workload support, and tenant rollout.
- Microsoft documentation has conflicted on the single-query GET permission and `serviceFilter` versus `serviceFilters`. The capability must remain disabled until a non-mutating create/poll/list/delete-or-expire proof verifies the exact live contract used by this implementation.

## Required implementation

1. Build a Graph Audit Search adapter for the documented v1.0 lifecycle: create an `auditLogQuery`, poll boundedly to a terminal state, retrieve all record pages, and track provider query ID/status/error/expiry. Validate every response.
2. At phase start, capture current official contract links and fixture shapes. Run a non-mutating live contract probe where authorized. If docs and service disagree, adapt only to observed, least-privileged behavior and record the evidence without tokens or tenant data.
3. A missing grant, unavailable tenant, or inconclusive live contract produces a registered, visible, disabled capability with the exact attempted request shape, safe provider response classification, documentation conflict, and recheck/support trigger. Fixture-complete adapter/jobs/UI work may finish the phase, but the completion record must not call the live API qualified.
3. Expose safe structured filters for UTC start/end, supported services/workloads, operations, users, IPs, object IDs, and administrative units where the API supports them. Do not accept arbitrary provider filter JSON or unbounded date ranges.
4. Provide curated Copilot and agent searches using the current `CopilotInteraction` and relevant Power Platform/Copilot Studio administrative operations. Treat provider record schemas as versioned unions and retain unknown fields in bounded raw evidence.
5. Normalize event metadata including record/event ID, creation time, operation, workload/service, result, actor, object, client IP, agent/app identity, host, message IDs, accessed resources, plugins/actions, correlation IDs, and source provenance when present.
6. Never claim Purview supplies prompt/response text: it records message identifiers and metadata, not conversation content. Render explicit `Content not present in Purview audit` states.
7. Link records to normalized agents only through exact `AgentId`, app identity, package/app/blueprint IDs, or reviewed identity links. Preserve unmatched and ambiguous events.
8. Keep on-demand search results separate from continuous Management Activity ingestion and local Agent Control audit. Dedupe only identical provider event IDs/content hashes; retain source and query lineage.
9. Add a search history UI with status, filters, actor, requested/available range, record count, pages, expiration/freshness, retry/cancel, and export. Sensitive result access requires `AgentControl.SecurityReader`; query creation requires `AgentControl.Administrator` or a dedicated search role.
10. Add retention and deletion for locally cached results. Default to metadata-oriented storage; store bounded raw audit data only under the configured security retention policy. All views/exports are audited.
11. Implement throttling/backoff, query concurrency limits, poll jitter, cancellation, restart recovery, stale-query reconciliation, pagination limits, and provider correlation IDs.
12. Add a prominent statement that Audit Search is compliance/security evidence and is not official Microsoft 365 Copilot Agents usage.

## Focused validation

- Protocol tests for create, running/succeeded/failed states, timeout, pagination, throttling, expiration, malformed `auditData`, unknown fields, duplicate records, cancellation, and restart recovery.
- Contract tests for documented property-name variants and permission failures; accepted variants must be isolated in the adapter, not spread through the domain.
- Security tests for app roles, delegated/application distinction, date/row limits, injection attempts, raw-data retention, export auditing, and log redaction.
- Projection tests for Copilot and Power Platform records, exact identity linking, unmatched records, and absent message content.
- UI tests for status polling, partial/failed queries, stale data, filters, exact remediation, content-absent labels, and export.

## Aggregate validation

Run the global validation baseline. If authorized, create one narrow live query over a small recent window, poll and page it, then verify local cleanup/expiry handling. A tenant with no matching records is valid if the contract succeeds.

## Production continuation

An inconclusive or failing live proof does not stop the campaign. Leave Graph Audit Search visible but disabled with exact evidence, keep local audit and later Management Activity work independent, and carry a fix-forward trigger. Do not broaden to an unrelated permission such as `ThreatIntelligence.Read.All` without current authoritative proof.

## Scope guard

Do not start a Management Activity subscription, query Defender, retrieve transcripts, or compute official usage. Do not deploy.

## Completion record

Create `plans/admin-poc-production/completions/07-graph-audit-search.md` with exact live request property contract, permission/role evidence, probe status, retention, and Phase 08 preconditions.

## Done conditions

- When live-qualified, bounded Graph audit searches are durable, restart-safe, permission-gated, and source-provenanced; otherwise the complete surface is visibly disabled with truthful evidence and remediation.
- Copilot/agent audit metadata is normalized without claiming message content or official usage.
- Microsoft contract ambiguity is resolved by evidence or truthfully gates the feature.
- Continuous feed ingestion can be added without sharing checkpoints or authority.
