# Phase 15 - Live Qualification and Production Hardening

## Mission

Qualify the deployed production admin POC with real role personas and provider contracts, exercise safe canaries and recovery, repair defects by fix-forward deployment, and leave an evidence-backed operational handoff rather than a paper GO/NO-GO.

## Prerequisites

- Read the roadmap and every completion record through Phase 14.
- Phase 14 must be completed with a verified production deployment receipt. If it is `deployment_pending`, do not start Phase 15 or manufacture preproduction-only completion; keep the campaign open at Phase 14 and resume its exact recorded control-plane action when access returns.
- Verify at least one approved production principal or group currently holds `AgentControl.Administrator` before any other persona test. If absent, return to Phase 14's explicit assignment tooling; do not bypass the app role or continue with a synthetic production administrator.
- Obtain approved test principals or groups covering every internal app role, a no-role case, canary package/agent/environment, and transcript test environment through the operator. Use Phase 14's explicit assignment/verification tooling when assignments are authorized; never assign roles silently or request passwords, tokens, or secrets through chat.

## Read first

- Production deployment receipt and exact deployed revision
- Permission Center/capability registry and all provider completion residuals
- Phase 13 threat model/SLOs/runbooks and Phase 14 infra/restore evidence
- All current Microsoft provider references linked from capability definitions

## Required implementation

1. Verify DNS/TLS/security headers, Static Web Apps routing, direct-backend denial, sign-in/out/session expiry, tenant restriction, app-role assignments, incremental consent, PostgreSQL schema, Key Vault/key versions, multi-instance health, readiness, alerts, and deployed revision.
2. Exercise production personas for `AgentControl.Reader`, `Operator`, `SecurityReader`, `TranscriptReader`, and `Administrator`, plus users missing each role/provider permission. Personas may use separate approved principals/groups or explicitly reviewed sequential assignments, but every token/session must be revoked between assignment changes. Record only opaque evidence IDs and timestamps, not personal identifiers. Prove server denial and exact disabled UI/remediation for every unauthorized feature.
3. Refresh every capability probe and record `passed`, `failed`, `not_run`, `unavailable`, or `inconclusive` for exact token mode, permission, role, license, cloud, preview, configuration, and evidence freshness. Never relabel no data as success or failure without contract evidence.
4. Qualify package delegated/application reads. On an explicitly approved reversible canary, qualify delegated block/unblock and access or reassign only when restoration is known and authorized. Before each mutation, persist an audited qualification record containing exact target/source IDs, provider revision, full state needed for restoration, actor, approval, and expiry. Verify the changed state, restore from that record, and verify exact restoration. A failed restoration is an active incident: disable that operation, alert the owner, preserve a manual recovery command/runbook, and do not complete handoff while the canary is unrestored.
5. Qualify Power Platform inventory coverage, paging, source fields, role-scoped visibility, identity links, and refresh latency. Keep app-only Resource Query disabled unless an exact documented assignment and live proof now exists.
6. Qualify official usage by importing an approved sanitized three-file report set through preview/accept, lineage/reconciliation, restart, reporting, export, supersession, and cleanup. Do not place real user/report rows in screenshots or completion evidence.
7. Qualify Graph Audit Search with a narrow recent query and continuous Management Activity with subscription status, one collection cycle, duplicate replay, checkpoint restart, lag/alert visibility, and source-deduplicated display. If the Graph contract remains unavailable or inconclusive, record the exact attempted contract/documentation conflict and leave it visibly disabled with recheck/support ownership; that is `completed_with_disabled_capabilities`, never live qualification. Do not treat event counts as official usage.
8. Qualify Defender `AgentsInfo` and Agent 365 `CloudAppEvents` with bounded queries. Verify RBAC/no-data/license/connector distinctions and exact identity joins; no need to fabricate telemetry.
9. On an approved non-production Copilot Studio canary reachable from production, qualify status and optionally quarantine/unquarantine using the same persisted prestate, approval, verification, restoration, and failed-restoration incident contract as package mutations. Prove classic/missing-ID targets stay disabled and package block remains separate.
10. In an approved test Dataverse environment, qualify delegated and application-user transcript metadata/content ingestion, checkpoint/reassembly, encryption, redaction, raw reveal/revoke, audit, retention/hold/purge, backup/restore, and unsupported-state messaging. Use synthetic conversations and remove them where source controls permit; never expose content in evidence.
11. Exercise exports, durable jobs, cancellation, restart/recovery, lease failover across instances, provider throttling/error containment, capability degradation, schema drift fixture, audit-chain verification, key rotation rehearsal, database backup/restore, and alert delivery.
12. Run browser qualification at mobile/desktop with accessibility checks and major workflows against production using only sanitized data. Verify no overlaps, clipped permission text, focus loss, plaintext content, console errors, failed resources, or layout shifts.
13. Run the production load smoke within established ceilings and observe App Service, PostgreSQL, provider budgets, queue/lease, latency/error SLOs, and autoscale. Stop/contain a profile that risks provider or tenant impact; record the truthful result.
14. For every reproducible defect, add a focused test, repair, rerun local/preproduction checks, redeploy through `deploy-production.ps1`, verify the new exact revision, and repeat the affected canary. Do not patch production out of band.
15. For every unavailable external capability, leave its full disabled UX/remediation, telemetry, alert or recheck cadence, owner, and enablement runbook. The POC is complete with transparently unavailable tenant capabilities; it is not complete if they are omitted or falsely enabled.
16. Update operator and architecture documentation to current implemented behavior, exact permissions/roles, deployment, provider setup, privacy, retention, backup/restore, troubleshooting, preview risk, and known residuals. Remove all stale planned/current and SQLite/client-secret instructions.
17. Produce a final capability matrix and handoff containing deployed revision/URL, data authorities, exact grants/roles, live result/freshness, feature state, residual containment, SLO/RPO/RTO evidence, alert ownership, cost notes, runbooks, and next requalification dates.

## Focused validation

- Run each provider's focused live probe/canary and each persona authorization path.
- Run production browser/accessibility/security-header/direct-backend tests with sanitized data.
- Run backup/restore, lease failover, key/audit checks, alert tests, and bounded load smoke.
- For each fix-forward change, rerun its focused test and the aggregate baseline before redeployment.

## Aggregate validation

Run the global validation baseline, full PostgreSQL integration suite, Playwright suite, security checks, infrastructure/deployment validation, production smoke, and all non-destructive provider probes. Record every real status.

## Production continuation

Do not end with GO/NO-GO. Production is already the convergence environment. Contain unsafe surfaces, fix forward, redeploy, and requalify. External tenant/provider unavailability remains a visible disabled capability. Only unresolved inability to perform control-plane deployment may remain `deployment_pending`, with an exact resumable command and owner.

## Scope guard

Do not grant roles/consent, change source retention, fabricate provider data, or mutate tenant resources without explicit operator authorization. Do not include secrets, tenant content, user prompts, raw transcript/audit/security results, or personal data in evidence.

## Completion record

Create `plans/admin-poc-production/completions/15-live-qualification.md` with final production URL/revision, complete capability matrix, persona/provider/canary/restore/load/accessibility evidence, fix-forward deployments, residual containment, runbook ownership, and operational handoff. This is the final campaign record.

## Done conditions

- The exact deployed production revision and core application paths are healthy and observable.
- Every researched capability is live-qualified or visibly disabled with exact permission/role/license/configuration remediation.
- Approved mutations and sensitive-content paths are restored/cleaned, audited, and evidence-safe.
- Recovery, multi-instance operation, security, accessibility, capacity, alerts, and runbooks have truthful evidence.
- Documentation describes implemented production behavior with no stale SQLite, client-secret, or future-feature claims.
