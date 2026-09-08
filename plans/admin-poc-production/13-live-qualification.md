# Phase 13 - Live Qualification and Production Hardening

## Mission

Observe the exact deployed reduced-scope application, qualify retained provider paths and approved reversible canaries, fix forward and leave a factual operations handoff.

## Prerequisites

- Follow the README's fresh-session contract. Read Phase 12's completed deployment receipt/linked issues, Phase 11 operations, Phase 05 canary runbook and each exercised provider's qualification contract.
- A healthy actual deployment is required. If Phase 12 is `deployment_pending`, resume it instead of manufacturing preproduction-only completion here.
- Verify an approved current `Administrator` assignment and exact qualification target/action approvals. Missing optional personas/canaries are unavailable checks, not permission to invent identities or assign roles. Secrets go directly into secure tools, never chat.

## Read first

- Exact deployed artifact/revision, canonical URL and Phase 12 receipt
- Delivered Permission Center and source contracts, `docs/operations.md`, `docs/security-model.md`, `docs/mutation-canaries.md`, `infra/disaster-recovery.md`
- Current Microsoft references for the specific endpoint/role/licensing contracts being exercised

## Required implementation

1. Verify the one App Service origin: DNS/TLS/headers, built assets/deep links, API errors, login/callback/logout/session expiry, tenant restriction, four-role access, schema, protected settings, single-instance limits, maintenance/job state and telemetry. Confirm served revision matches the Docker-exported artifact checksum/receipt. Verify prepared vault references resolve for the five runtime values, app identity cannot read the DB admin secret and runtime cannot migrate/mutate audit history. No SWA transport, separate frontend release or database VM/container remains.
2. Exercise Reader, Operator, SecurityReader and Administrator personas and authorized underprivileged tests. Roles are additive; administrator alone cannot read hunting/user reports or execute mutations. Use approved accounts/groups or explicitly approved assignment changes with fresh authentication after changes. Do not put personal identifiers or result bodies in evidence.
3. Explicitly refresh retained capability probes and record exact token mode, permission, role, scope, preview/configuration, contract and freshness with `passed`, `failed`, `not_run`, `unavailable` or `inconclusive`. No background probing schedule. Empty data can prove a successful contract but never complete tenant coverage by itself.
4. Qualify delegated/application package reads as separately approved. Run package writes only on approved reversible exact targets with Phase 05 prestate/restoration. Verify semantic touched-field state, preserve intervening changes and never retry ambiguous writes automatically. Keep access/reassign unqualified if readback or restoration is not safely provable. Failed restoration is an owned incident with disabled affected writes until verified recovery or explicit isolated-target retirement/containment acceptance; never label it restored without proof.
5. Qualify delegated Power Platform manual refresh, paging, role-scoped coverage, exact ID associations, null/preview fields and stale/partial behavior. App-only inventory is not an implemented alternate path. Navigation/restart must not launch scheduled refresh; no identity-review workflow is expected.
6. Exercise official three-file import preview/accept, lineage, reporting/export and cleanup with an approved sanitized set. Do not silently replace an existing real active set for testing. Prefer acceptance only where no production set exists or the operator approves the exact selection/restoration procedure; otherwise test preview and current read/export live and record live replacement as unavailable, using isolated evidence for publication. Preserve existing reports and explicitly restore approved selection after a temporary test; no original-file archive or real rows in screenshots.
7. Run one approved narrow Purview saved query and verify create/poll/record pagination, actual scope, partial/empty results and ordinary local expiry. Routine probes do not create queries; cancellation is local, not invented provider deletion. Keep local administrative audit separate. No feed subscription or collection test.
8. Run approved bounded `AgentsInfo` and `CloudAppEvents` templates, validating RBAC/no-data/license/connector and exact identity scope. Do not fabricate telemetry, broaden grants, expose arbitrary KQL or require a scheduled snapshot.
9. Qualify direct quarantine status on an exact approved target. Only with explicit reversible canary approval test quarantine/unquarantine and verified restoration under Phase 05/09 policy. Classic/missing IDs stay disabled; package state remains independent.
10. Exercise user jobs, bounded exports, cancellation and role/scope revocation. In an approved maintenance window, separately test App Service restart, managed PostgreSQL restart and repeat application deployment through `deploy-azure.ps1`. Capture bounded before/after database identity and authorized non-sensitive integrity evidence for retained audit, report selection and durable jobs, using existing approved data or an isolated sanitized dataset without replacing real report selection. Verify committed records persist, the same managed server/database is reused, the app reconnects and no reset/reimport or remote write replay occurs. Allow documented retention and intentional job-state transitions, not unexplained data loss. Lost in-memory tokens require login; durable delegated jobs wait for authorization and uncertain mutations never replay. Test fixture fault injection locally, not by changing real provider grants. Verify backup health and alert delivery; reuse Phase 12's isolated restore proof when the artifact/schema/recovery contract is unchanged, otherwise rerun the targeted isolated check.
11. Run desktop/mobile browser and accessibility checks against production using approved sanitized data/accounts. Check overflow, focus, keyboard, stale/disabled messages, missing assets and console errors. Capture no real tenant data. Verify removed features are absent, not broken or disabled tabs.
12. Run bounded cache-only production load smoke within approved cost/admission limits; observe latency/errors, CPU credits, pool/storage and job age against Phase 11 thresholds. Verify actual App Service/database SKUs, retention, telemetry/budget alerts and resource inventory match the approved estimate; record billing latency/estimate limits, not a guaranteed monthly price. Real provider calls remain separately budgeted minimal probes, not load traffic. Stop and contain a profile that risks tenant impact; a larger tier needs renewed approval, not automatic scale-up.
13. For reproducible defects add focused regression coverage, repair the owning code, run focused/applicable aggregate checks in Docker and redeploy through `deploy-azure.ps1` using the approved target/vault/budget/maintenance contract. Verify new artifact/revision and rerun affected canaries. Do not patch production out of band, write vault values, silently rotate credentials or reopen unsafe actions merely to finish.
14. Reconcile only retained capability issues. Each unavailable provider has exact disabled UX/remediation, safe evidence, containment, operator/recheck trigger and enablement criteria. Future ideas are absent from the app/grants/resources and never count as unimplemented campaign work. Link origin issues rather than copying every prior table.
15. Update application/operations/setup documentation to the actual two script workflows, Docker-only local app/database, managed low-cost Azure resources, prepared vault names/access, single-app/PostgreSQL behavior, supported credentials, four roles, manual provider workflow, finite retention, backup/restore limits, preview risk and current residuals. Remove stale old-script/host-Node-runtime/SQLite runtime/SWA/collector/transcript/certificate-only claims; do not remove the supported client-secret setup merely because the old plan did.
16. Finish the production capability/operations handoff with URL/revision/checksum, actual live results/coverage/freshness, data authorities, role/grant boundaries, restore/load/alert evidence, cost/availability limits, cleanup/restoration status, responsible operators and exact next requalification triggers. Restore/delete temporary approved test data/resources and keep unresolved cleanup incidents owned.

## Focused validation

- Approved retained-provider probe/canary contracts and four-role positive/negative paths.
- Built production app headers/routing/auth and desktop/mobile accessibility with sanitized evidence.
- Manual-only provider initiation, cache-loss reauthentication, durable job safety, authorized export revocation and backup/alert checks.
- Before/after data integrity and database identity across app restart, managed database restart and repeat Azure deployment; retained local Docker-volume evidence remains required separately. No automatic reset, empty replacement or backup restore on ordinary release.
- Bounded cache-only load and targeted isolated recovery when required; no transcript/feed/slot/multi-instance test obligations.
- Every fix-forward change has regression proof and deployed-revision confirmation.

## Aggregate validation

Run the README baseline and applicable PostgreSQL, packaged-app/browser/security checks inside the existing Docker test targets, plus infrastructure/deployment and production smoke suites. Verify `deploy-local.ps1` still preserves local data and two-service operation; use `deploy-azure.ps1` for approved fix-forward releases. Attempt all required live checks within approved boundaries; record unavailable evidence honestly. Local fixtures do not prove live provider eligibility.

## Production continuation

Keep production observation and fix-forward active until the healthy retained application has a real handoff. Contain uncertain providers while safe paths run. Only control-plane inability to perform a needed deployment is `deployment_pending`, with exact resume action and an open phase. No test-only readiness or GO/NO-GO ending.

## Scope guard

No unapproved roles/consent, source retention changes, fabricated telemetry, tenant mutations or future-feature implementation. No secrets, personal identifiers or sensitive result payloads in completion evidence.

## Completion record

Create `plans/admin-poc-production/completions/13-live-qualification.md` with final production URL/revision/checksum, retained capability matrix, persona/provider/canary/browser/recovery/load evidence, before/after persistence evidence for each restart/redeployment case, fix-forward releases, linked open issues, cleanup/restoration status and operational handoff. This is the final campaign record.

## Done conditions

- Exact deployed core paths are healthy and observable; retained provider features are live-qualified or truthfully disabled with concrete remediation.
- Approved canaries are restored or explicitly contained with an owned incident; evidence never claims unproved success.
- Security, jobs, ordinary backup/recovery, accessibility, limits and operations have truthful proof at the single-instance POC scope.
- Current docs describe the implemented reduced product; future ideas remain non-executable and absent from runtime.
