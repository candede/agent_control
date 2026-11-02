# Operations runbook

For initial setup, use [Deployment setup](deployment-setup.md); for hosted
updates, monitoring and recovery, use [Azure deployment](azure-production-deployment.md).
Identity and data-scope rules are in the [security model](security-model.md).

## Start, stop, update, and check

Run from the repository root with the installation's exact project name:

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control
pwsh ./deploy-local.ps1 stop -Project agent-control
```

`start` applies current source and verifies the database, reusing configuration
and data; an unchanged healthy app needs no restart. `stop` retains state.
Never add `-DbReset` to a restart. Optional [checks](#validation) do not gate use.

## Change configuration

Run `pwsh ./deploy-local.ps1 edit-config -Project agent-control`, then ordinary
`start`; follow [Change local settings](deployment-setup.md#change-local-settings).
Edits may stop the app; identity/domain changes require sign-in again.

## Check health

Use the configured origin/port; the local default is:

```powershell
Invoke-RestMethod http://localhost:3001/api/health
Invoke-RestMethod http://localhost:3001/api/ready
Invoke-RestMethod http://localhost:3001/api/auth/status
```

| Check | Expected result | If it fails |
| --- | --- | --- |
| `/api/health` | HTTP 200, `ok: true`: process responds. | Check origin/port and [service logs](#review-logs). |
| `/api/ready` | HTTP 200, `ok: true`: schema/grants valid, normal operation. | 503: database/schema failure or maintenance. Follow [installation recovery](#existing-installation-maintenance). |
| `/api/auth/status` | `authConfigured: true`, correct callback. | Repair configuration with `edit-config`, then `start`. |

Health does not prove sign-in, provider access or saved-data correctness.
Never clear maintenance markers or alter operational state to force readiness.

## First sign-in and synchronization

1. Sign in; keep the browser visible and online. Read-only sync starts automatically,
   including after reset: no Admin session, Permissions visit or enable step.
2. Open **Sync**: expect **Users**, **Graph packages** and **Power Platform** complete
   with saved counts. The modal closes when all three are saved;
   **Continue to workspace** dismisses it without cancelling sync.
3. Check saved **Agents** and **Users**. Complete sources are tenant-shared;
   another account needs no personal first sync.

Collection is browser-driven, not unattended: normally due every six hours,
with a one-hour retry after ordinary failures. Provider backoff/renewed authority
can change eligibility. Failed/partial attempts retain the last complete data.
CSV imports and package enrichment do not block workspace access.

## Resolve sign-in and permission problems

Check tenant, accepted domain, callback and app-role assignment. Use
**Permissions > Check status** and the [permissions reference](user-roles-and-permissions.md)
for source failures: app roles/token acquisition do not prove provider access.
Complete requested MFA, renewed authorization or role activation; provider challenges
do not invalidate a valid browser session or block other providers.
Purview, Defender and investigation setup are not ordinary sync prerequisites.

## Diagnose synchronization problems

Open **Sync**; correlate request/run/source/job IDs with [logs](#review-logs).
Saved reloads read PostgreSQL, not Microsoft; complete data stays readable during refresh.

| Symptom | Check and action | Safe recovery / expected result |
| --- | --- | --- |
| Sync not starting / authorization required | Check visibility/connection, source status and [permissions](#resolve-sign-in-and-permission-problems). | Reconnect or renew authority as reported; **Retry sync** if explicitly paused. |
| Provider throttled/unavailable | Read source error and actual retry delay. | Respect backoff; keep last complete data. |
| **Updating** / **Details pending** | Check publication/reconciliation or enrichment progress. | Wait; pending detail does not mean absent agents. |
| **Needs attention** / stale or different portal counts | Compare scope/time and integrity diagnostics; logical agents differ from package versions. | Repair the cause, then collect the affected source in **Sync**. `package_refresh_succeeded` confirms package publication. |
| Detail not found | Check exact target result, including confirmed 404. | One missing target is not catalog-wide absence. |
| Storage/record limit | Check reported bound and accounting failure. | Repair the cause; do not hide it by raising limits or clearing healthy data. |

Running counts are not totals/ETAs; concurrent durations overlap.
Filters, history and `/sync?syncRun=<id>` never submit new work.

### Package and Studio job recovery

Inspect the saved job before starting another:

| Job | Open | Read-only reconciliation |
| --- | --- | --- |
| Package control | **Access and availability** or `/agents?controlJob=<id>` | **Check uncertain results** |
| Studio quarantine | **Copilot Studio quarantine** or `/agents?quarantineJob=<id>` | **Reconcile by status read** |

- **Cancel** stops unstarted work, not in-flight/completed effects.
- **Resume** eligible unsent work explicitly with fresh same-account authority.
- Never replay uncertain writes; later mutation retries need fresh preview and confirmation.
- After `selection_invalidated`, refresh status and restart paging; never mix revisions.

Package controls and Studio quarantine have separate [requirements](user-roles-and-permissions.md).

## Office adoption automatic recovery

Office uses saved directory/license and Office app reports, not agent CSVs/manual sync.
If preparation fails after collection succeeds, keep the sources: local recovery
runs every 30 seconds during normal operation. For persistent failure, correlate
`office_derivation_failed` / `office_publication_cleanup_failed` with source/read
diagnostics and repair derivation, storage or integrity; do not recollect healthy
sources. Unknown/stale/denied/malformed is not zero adoption.
See [Office adoption](copilot-license-usage.md).

## Operator-only local helpers

For status/logs, backup, restore and retention below, load the existing owner:

```powershell
. ./scripts/local-deployment.ps1
$context = New-LocalContext -Root $PWD.Path -Project agent-control
```

Verify Docker context, project labels, container identities, volume, database and
origin. Use only this project's secrets and `agentcontrol`, never ambient credentials
or ad hoc SQL.

## Review logs

```powershell
docker context show
Get-OwnedLocalContainers $context | Select-Object Service, Id, Image
Invoke-DockerCommand ($context.Compose + @('ps'))
Invoke-DockerCommand ($context.Compose + @('logs','--tail','200','app','postgres'))
```

Stop if context/identities are unexpected; the owner rejects mismatched labels.
Expect `app` and `postgres` running and healthy after start. Correlate API
`application/problem+json` errors with `X-Request-ID` and job/run IDs.
Only Admin can read/export local administrative audit; it is not Purview Audit Search.

Restrict log access. Never print environment/tenant registries, credentials, tokens,
continuation URLs, report contents or raw provider bodies. Share sanitized categories,
IDs and actual retry delays only.

## Backup and isolated restore

Choose a new filename in an existing access-restricted directory:

```powershell
Invoke-LocalDeployment $context 'Backup' `
  -BackupFile "$PWD/.local/agent-control/backups/operator-verified.dump"
```

Expect `Backup verified: <path>`. Keep the dump and adjacent `.dump.json` receipt
together, access-restricted and outside source control. The receipt binds checksum,
schema, contents and snapshot time. Only current-schema backups work.
Incomplete pairs are not verified; repair failures and use a new filename.
Existing targets are never overwritten.
Omitting `-BackupFile` chooses a timestamped file in `.local/<project>/backups/`.

### Restore for review

```powershell
Invoke-LocalDeployment $context 'Restore' `
  -BackupFile "$PWD/.local/agent-control/backups/operator-verified.dump" `
  -RestoreDatabase agentcontrol_restore_review
```

Expect `Restore verified: <path>` and a new isolated `agentcontrol_restore_*`
database in maintenance. Sessions/provider execution authority are revoked;
ownership, deletions and configuration reconcile against the current database,
which must remain available. Review tenant/private scope, report selection,
Office facts, audit and jobs before reopening:

```powershell
Invoke-LocalDeployment $context 'Reopen' `
  -RestoreDatabase agentcontrol_restore_review
```

Reopen repeats reconciliation/retention and returns the review database to normal.
Neither command switches the app's database. Sessions stay revoked; never replay
uncertain writes. After failure, keep any created target isolated, repair and use
a new name. Follow [Disaster recovery](../infra/disaster-recovery.md) for serving
recovery; successful restore alone is not a database switch.

## Run retention

**Backup deletion:** apply removes dump/receipt pairs in `.local/<project>/backups/`
older than seven days by receipt creation time. Preserve longer-lived pairs
elsewhere securely first. Preview, then apply bounded slices:

```powershell
Invoke-LocalDeployment $context 'Retain' `
  -ConfirmCleanup 'agent-control/agentcontrol' -CleanupBatchSize 1000 -DryRun
Invoke-LocalDeployment $context 'Retain' `
  -ConfirmCleanup 'agent-control/agentcontrol' -CleanupBatchSize 1000
```

Use exact lowercase `<project>/agentcontrol`. Check `affected`/`pending`; repeat
until `pending=false` and no changes remain. Retention makes no provider calls.
It expires sessions, evidence, jobs, audit, staging and exports, not live accepted
CSVs merely for age; report deletion requires explicit Admin action. Office
observations retain twelve UTC calendar months from provider refresh date, including cutoff.
Dry-run rolls back database changes and deletes no backup files.

## Existing installation maintenance

Preserve settings/secrets/backups and unrelated projects. `start` checks schema/grants
before draining; incompatible schemas need explicit reset/current-schema recovery.

| Failure | Safe action |
| --- | --- |
| Initialization failed, reset not uncertain | Repair and retry ordinary `start`; a completed reset is not repeated. |
| Reset outcome unknown | Keep maintenance; inspect the exact target before destructive retry. |
| Ownership, credential or schema mismatch | Recover exact project state/secrets or use current-schema recovery. Never bypass checks, edit receipts or delete volumes. |

Success returns to normal operation without another enable step. Verify served
revision, health/readiness, sign-in/out, authorized saved views, automatic sync
and affected controls; tests/health alone do not prove these journeys.

## Reset application data

**Destructive:** authorize exact project/database `agentcontrol` and data loss.
The switch confirms it; no second prompt. Keep a verified backup first if schema permits.

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control -DbReset
```

- Deletes inventory, CSV reports/history, Office observations, sessions, audit,
  jobs and database-stored configuration.
- Retains project settings, secret files, PostgreSQL roles, the volume and
  existing backups. Do not delete the volume to reset application data.
- Each invocation after completed deployment requests a new reset.
- If reset succeeded but initialization failed, correct the failure and retry
  **without** `-DbReset`. For an unknown outcome, retain maintenance.

After success, sign in: read-only sync starts automatically. Re-enter stored sharing
settings and [reimport CSVs](official-usage-import.md). Provider sync cannot rebuild
deleted report, Office, audit or job history.

## Credential recovery

Replace Entra credentials with `edit-config`, then `start`. Restore missing/corrupt
session/database secrets from the same project's protected storage; never generate
replacement database passwords for an existing volume.

| State owner | Preserve / recover |
| --- | --- |
| `.local/<project>/` | `settings.json`, `secrets/`, control/deployment state. `compose.env` is generated; do not edit it. |
| Docker `<project>_data` volume | PostgreSQL data and roles, not project settings/secrets. |
| Protected backups | Dump and receipt together; never commit backups/secrets. |

For Azure, use the [Key Vault contract](azure-production-deployment.md#2-prepare-key-vault).
Plan/Deploy does not rotate existing credentials; see [limitations](azure-production-deployment.md#operate-the-deployment).

### Optional MCP recovery and backup

MCP OAuth state/keys are separate from PostgreSQL; MCP failure is not an API/database
reset request. Follow [MCP storage recovery](mcp-reference.md#storage-rotation-and-recovery)
and [client reconnection](mcp-clients.md).

## Validation

Docs: check links/anchors and `git diff --check`, without infrastructure.
Code: focused unit/type/lint checks; `npm run check:unused` runs Knip.
`pwsh ./deploy-local.ps1 check -Project agent-control` builds/runs isolated fixtures
without deploying; `start -ForceChecks` checks before applying the same source.
Use a disposable non-production environment for infrastructure-backed checks.
Record local/mock, browser and provider/deployment evidence separately.
Unrun journeys are not passed; test receipts never authorize application use.
