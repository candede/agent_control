# Phase 14 - Production Infrastructure and Deployment

## Mission

Perform the global PostgreSQL authority cutover, provision production-grade Azure resources and identity, harden the release tooling, and deploy the exact validated revision to production with migrations, smoke tests, telemetry, and rollback/fix-forward controls.

## Prerequisites

- Read the roadmap and all completion records for Phases 01-13.
- Security artifacts, runbooks, tested migrations, backup/restore, capacity ceilings, disabled-feature containment, and deterministic build artifacts must exist.
- Production Azure subscription/resource group, Entra tenant/app registration, DNS decisions, permissions, and approved provider grants may be supplied interactively. Never request secrets through chat or commit them.

## Read first

- `infra/main.bicep`, `infra/main.bicepparam`, `deploy-production.ps1`
- Root/backend/frontend package manifests and lockfile
- Backend persistence/migrations/config/health/startup code
- `frontend/public/staticwebapp.config.json`
- Phase 13 threat model, SLOs, artifacts, runbooks, and completion residuals
- Current Azure PostgreSQL Flexible Server, App Service, managed identity federation, private endpoint, Key Vault, Static Web Apps, deployment slots, autoscale, diagnostics, and Bicep guidance

## Required implementation

1. Replace the SQLite adapter globally with PostgreSQL repositories and migrations. Use parameterized queries, explicit transactions/isolation, pooled connections, UTC values, constraints/indexes, advisory or row-lock leasing, `FOR UPDATE SKIP LOCKED` job claiming, and integration tests against a real PostgreSQL instance.
2. Provide local/test PostgreSQL through checked-in Docker Compose or Testcontainers and update commands/docs. Remove `node:sqlite`, SQLite migrations/adapters/config, `/home/data` database behavior, WAL backup code, and all runtime dual-database branches in the same cutover.
3. Build a one-time, resumable, checksum/count-verified SQLite-to-PostgreSQL migration utility for existing data. It must quiesce writers, take a safe SQLite checkpoint/backup, import in dependency order, verify every data class/audit chain/content hash, and record a signed migration receipt. Execute one ordered cutover with one PostgreSQL-only application artifact: validate the utility in isolated preproduction; deploy that artifact to the production staging slot without traffic; quiesce the still-running old production revision; checkpoint SQLite; import and verify PostgreSQL; verify staging readiness against that exact database; then swap traffic and remove quiesce state. The new artifact contains no SQLite runtime adapter; only the one-time operator utility may read the backup. A pre-swap mismatch rolls back the PostgreSQL import transaction, records exact class/count/hash evidence, and unquiesces the unchanged old production revision only after safety checks; fix the utility and retry. The authority switches exactly once at the verified slot swap. After that boundary, rollback/fix-forward uses the prior PostgreSQL-compatible slot or PostgreSQL restore, never SQLite. Do not split runtime removal into a later deployment or introduce dual reads/writes.
4. Provision Azure Database for PostgreSQL Flexible Server with supported private networking, TLS, native automatic backups and point-in-time restore as the primary recovery mechanism, a production default of 35 days backup retention, zone/high-availability setting appropriate to the selected region/budget, diagnostic settings, deletion protection/locks where policy allows, and no public data-plane access. A shorter retention value requires an explicit cost/policy decision in the production parameter file and completion record; it is not an implicit downgrade.
5. Upgrade App Service from the single B1 constraint to a supported Premium plan with at least two production instances, health checks, autoscale bounds based on Phase 13 capacity, VNet integration, Always On, TLS 1.2+, HTTP/2, FTPS off, remote debugging off, and a staging deployment slot.
6. Use system-assigned or user-assigned managed identity for Key Vault and PostgreSQL. Configure workload identity federation/client assertion for the Entra confidential web app where supported so the production app no longer depends on a client secret. Retain no secret fallback after the cutover.
7. Add Key Vault keys/secrets/certificates required for session/token-cache encryption, transcript envelope encryption, audit-checkpoint signing, webhook authorization, and any provider credentials. Provision the separately authorized immutable Blob checkpoint store required by Phase 13. Pin each workload to least-privilege data-plane roles, enable rotation/expiry/immutability alerts, and keep private connectivity.
8. Add Log Analytics/Application Insights workspace integration, diagnostic settings, action group, dashboards/workbook links, and alerts for availability, 5xx/latency, restart, database connections/storage, provider errors/throttles, capability loss, collector lag/gaps, lease stalls, failed jobs, schema drift, audit-chain failure, encryption/key expiry, backup/restore age, and transcript access anomalies.
9. Check in an Entra app manifest/configuration specification containing redirect URIs, internal Agent Control app roles, delegated permissions, application permissions, and no implicit assignment. Add idempotent verification and an explicit operator-invoked app-role assignment script/command that accepts object IDs (not ambiguous display names), resolves exact app-role IDs, previews additions/removals, requires confirmation for writes, avoids duplicates, and verifies the resulting assignments. It uses the operator's control-plane identity and does not add directory-write permission to Agent Control. Before production swap, require the operator to use this tooling to assign and verify at least one approved production principal or group as `AgentControl.Administrator`; no internal administrator is a core-auth failure, not an optional disabled provider capability. Record role ID, assignment count, verification time, and safe correlation evidence without display names or principal object IDs. Never grant tenant admin consent or assign human/provider roles silently.
10. Report each exact provider grant separately: Graph package read delegated/application, each package write operation delegated, directory delegated, Power Platform delegated scopes, Graph audit delegated/application, Office Management `ActivityFeed.Read` application, Graph hunting delegated/application, and per-environment Dataverse delegated/application-user role. Missing grants deploy as disabled capabilities and do not fail deployment; core auth, tenant isolation, PostgreSQL migration/readiness, encryption, and release-health failures do block the production swap until repaired.
11. Harden `deploy-production.ps1` to run prerequisites, clean install, tests/typecheck/lint/build/security/artifact checks, Bicep lint/build/what-if, database backup/migration, slot deployment, slot smoke/readiness/migration checks, production swap, post-swap smoke, exact revision verification, alert check, and bounded rollback/fix-forward. Create `infra/disaster-recovery.md` for the selected primary mechanism: Azure PostgreSQL Flexible Server point-in-time restore to a new isolated server. Include exact Azure CLI commands with non-secret source server, restore timestamp, target server, resource group, network/DNS, and managed-identity placeholders; verify schema/data/audit/encryption integrity against the isolated server; then update the staging slot's database host, run readiness/smoke, and promote by slot swap. Logical export/import may supplement portability but is not the production recovery authority and does not replace the native restore drill.
12. Make deployment noninteractive when all non-secret parameters are supplied, preserve interactive Azure sign-in when needed, avoid command-line secrets, clean temporary files/tokens, verify downloaded tool checksums, and emit a redacted machine-readable deployment receipt.
13. Configure Static Web Apps/custom domain if supplied, API routing, CSP/security headers, linked backend, and direct-backend denial. Prove direct App Service access cannot bypass the Static Web Apps/auth boundary while health monitoring still works through approved paths.
14. Create preproduction and production parameter files with no secrets. Deploy an isolated preproduction stack through the same Bicep modules before production; a production staging slot alone is not isolation for database/network/identity recovery tests. Use resource-name, SKU, region, network, retention, scale, alert, provider-preview, raw-transcript/export, and advanced-KQL parameters explicitly; production sensitive/preview defaults remain fail-closed.
15. Perform the production deployment in this phase. Observe the exact deployed revision, migration version, instance/database/key health, capability endpoint, and telemetry. If a provider grant is absent, deploy its disabled UX and diagnostics rather than stopping.
16. Clean staging artifacts/test data and verify cost-bearing resources match the parameterized architecture. Record any cleanup failure as an active production incident with owner and command.

## Focused validation

- PostgreSQL repository/migration parity, concurrency, lease/job/session, retention, encryption, audit-chain, and real-engine integration tests.
- SQLite migration utility tests on sanitized current/older/large/corrupt fixtures containing every persisted data class, interruption/resume, transaction rollback, exact per-class row/count/content-hash/audit-chain equality, and a signed receipt before cutover.
- Bicep lint/build/what-if plus policy/security scan; PowerShell parser/PSScriptAnalyzer and mocked command tests.
- Slot deployment, readiness, migration lock, multi-instance job claim, direct-backend denial, Key Vault/PostgreSQL private connectivity, and rollback/fix-forward rehearsal in preproduction.
- Backup/point-in-time restore to an isolated server, application smoke and integrity verification against restored data, and rehearsal of the exact recovery/promote commands documented in `infra/disaster-recovery.md`.

## Aggregate validation

Run the global validation baseline against PostgreSQL, full Playwright/security/load smoke suites, infrastructure validation, deployment preflight, and production smoke. Capture exact command statuses in the completion record without secrets.

## Production continuation

This phase must attempt deployment. Repair and redeploy reproducible failures. Noncritical provider/preview failures remain disabled with telemetry. Only literal inability to execute Azure/Entra control-plane actions may leave `deployment_pending`; record the exact command, identity, missing action, current deployed state, and resumable next command. Do not call an undeployed app production-ready.

## Scope guard

Do not widen provider permissions to make smoke tests pass. Do not retain SQLite fallback/dual writes. Do not seed real tenant content or execute package/quarantine mutations as deployment smoke.

## Completion record

Create `plans/admin-poc-production/completions/14-production-deployment.md` with production URL, redacted Azure resource inventory, deployed revision/artifact checksum, schema/data migration receipt, infrastructure/deployment/restore/smoke evidence, 35-day native point-in-time recovery configuration (or explicit approved override), recovery runbook commands with non-secret placeholders, verified `AgentControl.Administrator` role ID/count/time/correlation evidence without principal identifiers, capability states, residuals, and Phase 15 preconditions.

## Done conditions

- PostgreSQL is the sole runtime database in every environment and old SQLite data is verified or explicitly absent.
- Production infrastructure, identity, networking, scale, secrets/keys, telemetry, alerts, backup, and release tooling are deployed.
- The exact production revision is healthy and direct backend bypass is denied.
- Missing provider prerequisites appear as contained disabled capabilities, not hidden deployment failures.
