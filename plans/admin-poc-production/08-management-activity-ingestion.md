# Phase 08 - Office 365 Management Activity Ingestion

## Mission

Add unattended, gap-monitored ingestion of Purview unified audit records from the Office 365 Management Activity API for continuous Copilot, Agent 365, Copilot Studio, Power Apps, and administrative event history.

## Prerequisites

- Read the roadmap and completion records for Phases 01-07.
- Durable leases/jobs/checkpoints/observations, application-token auth, capability registry, normalized identities, security roles, and audit projections must exist.
- Do not deploy in this phase.

## Read first

- Phase 01 worker/lease/checkpoint code
- Phase 07 normalized audit event and UI contracts
- Current Office 365 Management Activity API getting-started, reference, and schema documentation
- Current Copilot audit, Power Platform activity logging, and Purview Audit licensing/retention documentation

## Permission contract

- API resource/audience: Office 365 Management APIs (`https://manage.office.com` for the commercial cloud; use the documented cloud endpoint for sovereign tenants).
- Entra application permission: `ActivityFeed.Read`, with tenant admin consent.
- Background collection uses application identity. No signed-in user's delegated token drives the collector.
- Unified audit logging must be enabled and the tenant/workloads must emit the relevant records. Purview licensing controls event availability and retention beyond this collector's seven-day retrieval window.
- Subscribe to `Audit.General`; the API does not provide a server-side Copilot-only content stream, so filter typed records after bounded retrieval.

## Required implementation

1. Implement a typed Management Activity adapter for subscription status/start, available-content listing, content-blob retrieval, and documented cloud endpoint discovery/configuration. Never stop a tenant subscription automatically.
	Probe application grant and `Audit.General` subscription state separately. Missing/inactive subscription or a conclusive service diagnostic for disabled unified auditing is `not_configured`; an empty successful content listing is `no_data`; an ambiguous provider denial remains `unknown` rather than guessing the tenant setting.
2. Use the durable single-writer lease. Poll on a configured interval, page all available content, fetch each content URI only after validating scheme/host, and checkpoint only after transactional record persistence.
3. Treat webhook notifications as hints, not authoritative content. If a webhook is enabled, validate the documented authorization secret, limit request size/rate, enqueue a poll, and always retrieve content through the authenticated API. Polling remains the recovery path.
4. Respect the API's maximum seven-day request/lookback window and content availability. Bootstrap in bounded slices within that window, maintain a high-water mark plus overlap, and monitor lag. Default warning/critical thresholds must leave recovery margin and be configurable; the critical default is five days behind. Never suppress the production alert. After the provider window is exceeded, create an immutable gap record with exact known interval/evidence and direct operators to Purview Audit for any separately retained records; do not imply the feed can recover that interval.
5. Persist content IDs and provider event IDs for idempotency. A duplicate blob/event must be harmless. Detect changed content hashes, clock skew, out-of-order delivery, and missing intervals without overwriting prior evidence.
6. Parse `CopilotInteraction` and relevant Copilot Studio/Power Platform administrative records into the Phase 07 audit domain. Retain unknown operation/schema versions as bounded raw evidence and emit schema-drift telemetry.
7. Preserve message IDs, agent/app identity, host, user, context, accessed resources, plugins/actions, model fields, client/correlation data, and result metadata when present. Do not claim prompt/response text exists if absent.
8. Keep continuous-feed observations distinct from Graph search results while deduplicating identical provider records in the read projection. Expose source badges and ingestion lineage.
9. Add collector administration UI: subscription state, capability prerequisites, last poll/content/event times, lag, checkpoint, overlap, throughput, duplicates, parse failures, throttles, next run, backfill range, webhook health, and pause/resume. Mutations require `AgentControl.Administrator` and confirmation.
10. Add a gap-recovery workflow that accepts only dates within the provider window, previews expected slices, records the actor/reason, and uses durable jobs. Older gaps are permanent, keep their immutable gap record, and remain visibly unresolved even after later collection resumes.
11. Apply configurable raw-record retention, metadata projection retention, privacy classifications, access auditing, encrypted storage where raw data is retained, and deletion/hold semantics. Default the UI to metadata, not raw JSON.
12. Add health thresholds and alerts for no content, lag, failed subscription, expired credential, repeated throttling, poison blob, parser drift, and lease loss. `No matching Copilot events` is distinct from collector failure.

## Focused validation

- Adapter tests for subscription lifecycle/status, list pagination, content download, webhook validation, sovereign endpoints, throttling, malformed/untrusted content URI, and provider errors.
- Worker tests for bootstrap slicing, overlap, seven-day boundary, idempotency, restart, lease fencing, out-of-order blobs, content hash change, poison blob, partial page, checkpoint atomicity, and unrecoverable gaps.
- Parser/projection tests with versioned sanitized CopilotInteraction and Power Platform fixtures, unknown operations, missing optional fields, exact identity links, and no prompt/response text assertion.
- Security/privacy tests for application permission gating, webhook secret handling, raw-record encryption/retention, role-protected views/exports, and redacted logs.
- UI tests for collector states, lag/gap/remediation, pause/resume/backfill confirmation, source distinction, and disabled states.

## Aggregate validation

Run the global validation baseline. With an authorized tenant, prove subscription status, one bounded list/download cycle, checkpoint persistence across restart, and duplicate replay safety. Do not record tenant events in fixtures or completions.

## Production continuation

Missing consent, unified auditing, events, or credentials does not stop the campaign. Keep the collector disabled or paused, preserve Graph search and local audit, expose exact remediation and lag risk, and carry an alert-backed fix-forward record. Never advance a checkpoint past unpersisted content.

## Scope guard

Do not query Defender, ingest Dataverse transcripts, operate quarantine, or compute official usage. Do not automate subscription stop. Do not deploy.

## Completion record

Create `plans/admin-poc-production/completions/08-management-activity-ingestion.md` with subscription mode, endpoint/cloud, seven-day/gap evidence, retention, live-probe status, and Phase 09 preconditions.

## Done conditions

- Continuous audit ingestion is application-owned, idempotent, leased, restart-safe, and gap-monitored.
- Copilot and Power Platform events share a read model with Audit Search without losing source lineage.
- Privacy, retention, role gates, and schema-drift behavior are tested.
- Feed data is never labeled official usage or conversation content.
