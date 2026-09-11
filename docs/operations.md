# Operations runbook

This runbook operates the single Express/React application and PostgreSQL database. Commands assume the repository root, PowerShell 7 at `pwsh`, Docker Desktop/Compose v2, and the retained local project `agent-control-phase01`. Run application, database, Node, npm, browser, scanner and load tooling only through Docker or the checked-in PowerShell orchestration.

## Identity, consent and roles

1. Import only the four `appRoles` from `infra/entra-app-manifest.json` into the approved single-tenant Entra application. Preserve its existing registration and grants.
2. Register exactly `http://localhost:3001/api/auth/callback` locally or the approved production origin plus `/api/auth/callback`.
3. Assign the independent Reader, Operator, SecurityReader or Administrator roles in Entra. Administrator does not inherit another role.
4. Start the retained application:

   ```powershell
   pwsh ./deploy-local.ps1 -Action Start -Project agent-control-phase01 -StateRoot ./.local -Port 3001
   ```

5. Sign in and use Permission Center's explicit capability probe. Initial OIDC login requests only `openid profile`; approve provider scopes/roles separately under `docs/deployment-setup.md`. Never repair missing consent by editing capability evidence.
6. After an app-role removal, wait no longer than the documented five-minute claims refresh and verify access is denied. For urgent revocation, sign out or invalidate that account's sessions through the existing logout/revocation path.

Client-supplied identity headers never authenticate. A process restart loses the MSAL cache and requires provider token reacquisition; this is expected and does not authorize replay.

## Status, safe diagnosis and provider incidents

Public probes disclose only status:

```powershell
Invoke-RestMethod http://localhost:3001/api/health
Invoke-RestMethod http://localhost:3001/api/ready
```

An authenticated Administrator may call `GET /api/diagnostics`; it returns only auth-configured, maintenance/provider-work flags, schema version and fixed pool/body/export limits. Do not add record counts, hosts, connection strings or provider bodies.

- **Provider outage/throttling:** liveness/readiness stay healthy. The affected capability records a bounded category/correlation and remains unavailable. Preserve the last complete cache. Retry only an explicitly unsent read within its page/request/deadline limits.
- **No data:** distinguish a complete zero-row observation from missing permission, partial coverage, limit failure or stale cache. Do not turn a provider error into a successful empty snapshot.
- **Schema drift:** an unknown provider shape fails that operation and retains the previous snapshot. An unknown PostgreSQL migration makes readiness `503`; enter maintenance and fix forward.
- **Job age/failure:** inspect the source-specific job route from the workbench. Logs contain only structured request/job/provider IDs, status, durations, ages, attempts and counts.
- **Uncertain write:** leave the sent item `inconclusive`. With the current Operator and provider-read authority, use its existing GET-only reconciliation route. Mark observed-applied, observed-not-applied or conflict; never resend automatically or invert a partial batch automatically.

## Retention

Preview one bounded batch:

```powershell
pwsh ./deploy-local.ps1 -Action Retain -Project agent-control-phase01 -StateRoot ./.local -Port 3001 -ConfirmCleanup 'agent-control-phase01/agentcontrol' -CleanupBatchSize 1000 -DryRun
```

Apply one batch only after reviewing the per-class counts:

```powershell
pwsh ./deploy-local.ps1 -Action Retain -Project agent-control-phase01 -StateRoot ./.local -Port 3001 -ConfirmCleanup 'agent-control-phase01/agentcontrol' -CleanupBatchSize 1000
```

Repeat explicitly until all affected counts are zero. Valid batch size is 1–5,000. One PostgreSQL advisory lock prevents competing cleanup; lock/statement timeouts are 5/15 seconds. A failure rolls back that batch and reports no content. There is no browser cleanup endpoint.

| Data class | Default / expiry | Single cleanup owner |
| --- | --- | --- |
| Server sessions | Cookie/session 8 hours | operator `Retain` |
| Capability evidence | authorization 5 minutes | operator `Retain` |
| Package and Power Platform jobs | 7 days; snapshots 30 days | operator `Retain` |
| Purview and Defender jobs/results | 30 days; qualification/retained scope bounds are schema-defined | operator `Retain` |
| Quarantine jobs | 7 days; observation/audit 30 days | operator `Retain` |
| Official upload staging | 30 minutes; per-tenant pre-admission purge prevents stale quota use | operator `Retain` |
| Accepted official report content | 180 days; explicit Administrator deletion remains confirmed/audited | operator `Retain` for expiry |
| Administrative and minimal import audit | 90 days | operator `Retain` |
| Request export buffers/uploads | request lifetime; never archived | request owner |
| Managed production logs | 30-day initial target | Azure monitoring setting in the approved target |
| Local container logs | `json-file`, 10 MiB maximum per file, three files per `app` and `postgres` service | Docker Compose service configuration |
| Local logical backups | 7 days | PowerShell backup-retention helper after applied `Retain` |

Dependent rows, report selection and source projections are invalidated before parent removal. Administrative audit is ordinary append-only data, not cryptographic evidence against `agentcontrol_admin`.

## Backup and isolated restore

Create a restricted native dump and versioned checksum/fingerprint receipt:

```powershell
pwsh ./deploy-local.ps1 -Action Backup -Project agent-control-phase01 -StateRoot ./.local -Port 3001 -BackupFile "$PWD/.local/agent-control-phase01/backups/operator-verified.dump"
```

Inventory the receipt before cleanup. A current verified backup does not resolve missing historical backup evidence. Backups contain sensitive retained data, provide no automatic cross-backup privacy suppression and must remain access-restricted.

Restore only to a new isolated database:

```powershell
pwsh ./deploy-local.ps1 -Action Restore -Project agent-control-phase01 -StateRoot ./.local -Port 3001 -BackupFile "$PWD/.local/agent-control-phase01/backups/operator-verified.dump" -RestoreDatabase agentcontrol_restore_operator_review
```

Restore verifies the dump checksum, receipt table fingerprints and known migration prefix, migrates forward, invalidates sessions/provider qualifications and official staging/previews/confirmations, fences leases/owners, and marks sent work inconclusive. It repeats bounded retention until a zero-change pass, then compares exact current cache ownership and authority bindings with the live database, including current official set/version deletion and selection and exact Defender retained-scope revocation. Mismatches are purged rather than exposed. It leaves `operational_state.mode=maintenance` and provider work disabled. The restored database is not wired to the retained app by this command.

After an operator reviews current deletions, role/scope changes, report selection, audit/job integrity and retained data scope, reopen the database:

```powershell
pwsh ./deploy-local.ps1 -Action Reopen -Project agent-control-phase01 -StateRoot ./.local -Port 3001 -RestoreDatabase agentcontrol_restore_operator_review
```

Reopen repeats retention to zero and repeats the current-state comparison from one read-only current-database snapshot while holding the restored operational-state row in a transaction. It refuses unavailable or over-bound current review, remaining sessions, Purview/Defender execution ownership, provider qualifications or mutation authority, and keeps provider work disabled. Any official or provider cache whose exact current owner/deletion/access binding cannot be proved is purged. Any future switch of the production app to this database is a separately approved maintenance action followed by restart, core smoke and fresh provider requalification. Never use restored authority to replay an uncertain write. Azure point-in-time restore is Phase 12 work and must use the same reopening checks.

Measure local recovery with elapsed time around `Backup`, `Restore`, review and `Reopen`. For a version-3 receipt, RPO is the difference between `snapshotAt` and the failure/recovery point; `createdAt` is only dump/receipt completion. Version-1/2 receipts have only the legacy completion timestamp and cannot claim a more precise snapshot age. RTO ends only after reviewed reopen and core smoke. These observations are not HA, Azure throughput or Azure PITR guarantees.

## Maintenance, migration and compatible fix-forward

Stop admissions and both retained containers cleanly:

```powershell
pwsh ./deploy-local.ps1 -Action Stop -Project agent-control-phase01 -StateRoot ./.local -Port 3001
```

Start the same artifact, volume, network and secrets:

```powershell
pwsh ./deploy-local.ps1 -Action Start -Project agent-control-phase01 -StateRoot ./.local -Port 3001
```

Apply the worktree through the one root local deployment path:

```powershell
pwsh ./deploy-local.ps1 -Action Deploy -Project agent-control-phase01 -StateRoot ./.local -Port 3001
```

Deploy stops the app, starts PostgreSQL, applies checksum-verified forward migrations, runs the aggregate Docker gate, then starts the app only when readiness succeeds. On migration failure, leave maintenance in place, preserve the database/backup, repair the forward migration or add a new migration, and rerun Deploy. Do not edit an applied migration or start an older artifact against an incompatible schema.

Run lifecycle checks sequentially, never concurrently:

```powershell
pwsh ./scripts/restart-runtime.tests.ps1 -Project agent-control-phase01
pwsh ./scripts/persistence.tests.ps1 -Project agent-control-phase01 -Port 3001
```

## Local secret or volume recovery

Local secrets are restricted files under `.local/agent-control-phase01/secrets`; the PostgreSQL volume is `agent-control-phase01_data`. If an existing-volume secret is missing/corrupt, stop. Restore the original state directory from approved secure storage; do not regenerate a password or reset the volume. Then rerun `Start` and verify health/readiness.

An intentional destructive reset requires a verified backup and the exact target:

```powershell
pwsh ./deploy-local.ps1 -Action Reset -Project agent-control-phase01 -StateRoot ./.local -Port 3001 -ConfirmReset 'agent-control-phase01/agent-control-phase01_data'
```

Reset destroys retained local data and secrets. It is not a credential recovery mechanism.

## Credential expiry and separately approved replacement

Follow the six-name/five-runtime-consumer contract in `docs/deployment-setup.md`. Before expiry, obtain separate administrator approval and a maintenance window. Add new secret versions directly in the prepared vault, preview references/role assignments, stop admissions and drain/reconcile jobs, back up, update native versioned references, use the administrator password only for short-lived bootstrap/migration input, remove that input, restart and verify least privilege. A session-secret replacement invalidates all sessions. A database-password replacement must coordinate the fixed `agentcontrol_admin` and `agentcontrol_app` PostgreSQL roles with their prepared vault versions; no managed-identity/password fallback exists. The deployment wizard never writes or silently rotates a value.

## Release, scanners and load

The repeatable preproduction checks are:

```bash
docker build --target security-scan -t agent-control-phase11-security:local .
docker run --rm agent-control-phase11-security:local
docker build --target production-dependencies -t agent-control-phase11-dependencies:local .
docker run --rm --entrypoint npm agent-control-phase11-dependencies:local audit --omit=dev --audit-level=high
docker exec agent-control-phase01-postgres-1 createdb -U agentcontrol_admin agentcontrol_test_phase11_load
docker run --rm --network agent-control-phase01_default --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets,target=/run/secrets,readonly" -e PGHOST=postgres -e PGUSER=agentcontrol_admin -e PGDATABASE=agentcontrol_test_phase11_load -e PGPASSWORD_FILE=/run/secrets/postgres-admin -e APP_PGPASSWORD_FILE=/run/secrets/postgres-app agent-control-phase01-operator:local backend/scripts/cache-load.ts
docker exec agent-control-phase01-postgres-1 dropdb -U agentcontrol_admin --force agentcontrol_test_phase11_load
docker build --target runtime-inspection -t agent-control-phase11-runtime-inspection:local .
docker run --rm --user "$(id -u):$(id -g)" --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets,target=/run/secrets,readonly" -e SECRET_SCAN_FILES=/run/secrets/postgres-admin:/run/secrets/postgres-app:/run/secrets/session:/run/secrets/client-secret agent-control-phase11-runtime-inspection:local
docker build --platform linux/amd64 --target export --build-arg RELEASE_REVISION=approved-revision -o type=local,dest=artifacts/release .
```

The load script creates/removes its own child database and makes no provider request; always run the final `dropdb`, including after a failure. Inspect the produced ZIP through `package-smoke.ts` against the retained app and run `zip-runtime-smoke.mjs` inside the Linux x64 package image. The ZIP contains `release-manifest.json`; its sidecar contains the archive SHA-256.
The manifest contains only its format version, revision, Linux/x64 platform and Node 24 runtime metadata. It contains no per-file checksum map; the adjacent `.sha256` sidecar verifies archive integrity, not publisher authenticity.

`infra/production-target.example.json` evaluates one B1 App Service instance and PostgreSQL Flexible Server Burstable B1ms/32 GiB/seven-day backup target. CPU credits and local measurements do not prove Azure capacity. Any larger tier requires a new current price estimate, cost preview and approval; never upgrade automatically.

Microsoft's [compute guidance](https://learn.microsoft.com/azure/postgresql/compute-storage/concepts-compute), rechecked 2026-09-10, lists B1ms as 1 vCore and 2 GiB. It explicitly does not recommend Burstable for production, excludes 24/7 support and warns that exhausted credits can cause severe degradation, timeouts or an unreachable server. Phase 12 must obtain explicit acceptance of this limited POC target and monitor CPU Credits Remaining; avoid restart/scaling while credits are near zero. Repeated depletion requires a separately cost-approved capacity decision, not an automatic tier upgrade.

The application operator owns the cache-load thresholds: 120 concurrent paged reads with zero errors and p95 below 2 seconds, database pool at or below four with zero waiters at completion, process RSS growth below 256 MiB, isolated database growth below 128 MiB, accepted queue depth five with the sixth rejected, and oldest newly accepted job below 30 seconds. In production, one observed pool waiter, a finite-deadline worker stop, uncertain dispatched write or cleanup failure is a safety incident; it alerts for review rather than triggering replay. Phase 12's Azure operator owns the five-minute readiness/5xx/two-second latency checks, CPU-credit below 20, storage above 80%, 32-GiB backup-storage cost review, exact release-backup restore-point probe, 0.1-GiB/day ingestion cap, 30-day log retention and approved budget notifications. Backup-storage usage is not backup-health proof. Crossing a local threshold blocks release for investigation; crossing an Azure threshold triggers review/cost preview, never an automatic tier change.

## Azure charges and teardown

Only `pwsh ./deploy-azure.ps1` may release to Azure after an explicit Azure authorization and exact approved target. The legacy script is removed; no old-name wrapper exists. Example target JSON and deterministic mock receipts are never approval or live evidence. Follow [the Azure runbook](azure-production-deployment.md).

Stopping an app does not guarantee charges stop: the App Service Plan, PostgreSQL server/storage/backups, monitoring ingestion/retention, Key Vault operations and networking can continue billing. Before teardown, make and verify any required backup, record retention/deletion decisions, remove resources only under explicit approval, and understand that retained backups or logs may continue charging. Use current Microsoft guidance and the approved estimate:

- [App Service plan management](https://learn.microsoft.com/azure/app-service/app-service-plan-manage)
- [PostgreSQL Flexible Server backup and restore](https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-backup-restore)
- [Cost Management budgets](https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-create-budgets)
- [Key Vault pricing](https://azure.microsoft.com/pricing/details/key-vault/)
