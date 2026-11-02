# Operations runbook

Use this guide for local maintenance, synchronization recovery, backups and
data resets. For initial configuration, see [Deployment setup](deployment-setup.md).
For Azure lifecycle and recovery commands, see
[Azure production deployment](azure-production-deployment.md).

## Start, stop, update, and check

Run from the repository root with the exact installation's project name:

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control
pwsh ./deploy-local.ps1 stop -Project agent-control
pwsh ./deploy-local.ps1 check -Project agent-control
```

- `start` builds and applies the current source, verifies the database and starts
  the application.
- `stop` stops the project while retaining configuration and data.
- `check` builds and runs isolated regression fixtures without deploying.
- `start -ForceChecks` runs checks before applying the same source snapshot.

## Change configuration

```powershell
pwsh ./deploy-local.ps1 edit-config -Project agent-control
pwsh ./deploy-local.ps1 start -Project agent-control
```

Use the [setup instructions](deployment-setup.md#change-local-settings) for
tenant profiles, credentials and callback changes. Keep independent installations
in separate projects.

## Check health

Use the configured port; these examples use the default:

```powershell
Invoke-RestMethod http://localhost:3001/api/health
Invoke-RestMethod http://localhost:3001/api/ready
```

| Endpoint | Meaning |
| --- | --- |
| `/api/health` | The HTTP process is responding. |
| `/api/ready` | The current schema, runtime grants and operational state permit serving. Maintenance returns HTTP 503. |

Neither endpoint verifies provider access, saved-data correctness or interactive
sign-in. Readiness requests share only an in-flight schema check; completed
results are not cached.

## First sign-in and synchronization

Read-only collection starts automatically for eligible signed-in users while the
browser is visible and online. It needs no administrator session, Permissions
visit or additional application approval.

- **Sync** shows Users, Graph packages and Power Platform collection progress.
- The first-sync modal closes after all three sources are saved.
  **Continue to workspace** dismisses it without cancelling synchronization.
- Complete saved sources are shared within the tenant. Another account does not
  need a personal first synchronization.
- Failed or partial attempts do not replace the previous complete publication.
- CSV imports and package-detail enrichment do not block workspace access.
- Routine source collection is due every six hours. Ordinary failed attempts
  wait one hour before automatic retry; real provider backoff and renewed
  authorization can change admission.

Use the [permissions reference](user-roles-and-permissions.md) for collection
access. App roles and Microsoft provider permissions are separate.

## Resolve sign-in and permission problems

1. Confirm the configured tenant, accepted domain, callback and app-role assignment.
2. Open **Permissions > Check status** and inspect the failing provider.
3. Correct the reported consent, role, licensing, sharing or network limitation
   using the [permissions reference](user-roles-and-permissions.md).
4. Sign in again when Microsoft requires MFA, renewed authorization or role
   activation. A provider challenge does not invalidate an otherwise valid
   browser session or prevent other providers from working.
5. For a saved job waiting for authorization, obtain fresh same-account authority
   and explicitly resume eligible unsent work.

Token acquisition alone does not establish provider data access. Do not replay
an uncertain provider mutation. Purview, Defender and investigation-only identity
setup are not ordinary synchronization prerequisites.

## Reload saved agent inventory

Reloading saved views reads PostgreSQL, not Microsoft. Rows remain available
while a successor publication is preparing; errors remain visible.

- Compare source scope and collection time when checking Microsoft portal counts.
  Logical agents and package versions are different counts.
- **Updating** means publication or reconciliation is in progress.
- **Details pending** means package enrichment is incomplete, not that agents
  are absent.
- **Needs attention** identifies a source, authorization or integrity problem.
- A running observation count is not a provider total or an ETA.

Use **Sync** for explicit collection. Changing filters, opening history or
following `/sync?syncRun=<id>` does not resubmit provider work.

### Package and Studio job recovery

Open the saved job under **Access and availability**, or follow
`/agents?controlJob=<id>`.

- **Cancel** stops unstarted work; it does not undo completed effects.
- **Resume** requires current authorization.
- **Check uncertain results** reconciles read-only. A later mutation retry
  requires a fresh preview and confirmation.
- After `selection_invalidated`, refresh status and restart result paging.
  Do not combine pages from different result revisions.

Package controls and Studio quarantine are separate effects. Use the
[permissions reference](user-roles-and-permissions.md) for their requirements.

## Office adoption automatic recovery

Office adoption uses saved directory/license and Office app report sources.
It does not require agent CSVs or a manual synchronization.

If source collection succeeds but Office preparation fails:

1. Keep the successful source data.
2. Allow the next automatic local recovery pass, which runs every 30 seconds.
3. If the failure persists, correlate `office_derivation_failed` or
   `office_publication_cleanup_failed` with source diagnostics and the failing read.
4. Repair the reported derivation, storage or integrity failure; do not clear
   healthy sources or recollect Microsoft data merely to retry local preparation.

Unknown, stale, denied or malformed evidence is not zero adoption. See
[Office adoption](copilot-license-usage.md) for report coverage and history meaning.

## Diagnose synchronization problems

Correlate request, run, source and job IDs. Distinguish:

| Symptom | Check |
| --- | --- |
| Sign-in or permission required | Current account, consent and provider diagnostics |
| Throttled or unavailable provider | Reported backoff and source error; retain the last complete publication |
| Checked targets but stale saved data | Publication outcome; `package_refresh_succeeded` confirms package publication |
| Detail not found | Exact target result, including a confirmed 404; not catalog-wide absence |
| Storage or record limit | Reported bound and accounting failure; do not raise limits to hide the failure |
| Cancelled job | Saved run/job state before starting another operation |

Concurrent request durations overlap; do not add them to derive wall time.
Keep partial observations distinct from completed publications.

## Review logs

Use service logs and request/job correlation IDs. API failures return
`application/problem+json` with a request ID.

Never print environment variables, tenant registries, credentials, tokens,
continuation URLs, report contents or raw provider bodies. Preserve sanitized
diagnostic categories and actual provider retry delays.

Only Admin can read or export local administrative audit logs. This history
is separate from Microsoft Purview Audit Search.

## Operator-only local helpers

Load the existing deployment owner:

```powershell
. ./scripts/local-deployment.ps1
$context = New-LocalContext -Root $PWD.Path -Project agent-control
```

Use only the exact owned project, database and volume. Do not substitute ambient
database credentials or ad hoc SQL.

## Backup and isolated restore

Create a protected current-schema logical backup:

```powershell
Invoke-LocalDeployment $context 'Backup'
```

To select a filename, use a new file in an existing access-restricted directory:

```powershell
Invoke-LocalDeployment $context 'Backup' `
  -BackupFile "$PWD/.local/agent-control/backups/operator-verified.dump"
```

Retain the dump and its adjacent `.dump.json` receipt together. The receipt binds
checksum, schema, table contents and snapshot time. An existing target is never
overwritten. Backups contain sensitive data; protect them outside source control.
Only current-schema backups are supported.

### Restore for review

```powershell
Invoke-LocalDeployment $context 'Restore' `
  -BackupFile "$PWD/.local/agent-control/backups/operator-verified.dump" `
  -RestoreDatabase agentcontrol_restore_review
```

The restore uses a new isolated `agentcontrol_restore_*` database. It revokes
restored authority and reconciles current ownership, deletions and configuration.
Review tenant/private scope, report selection, Office facts, audit and job
integrity before reopening:

```powershell
Invoke-LocalDeployment $context 'Reopen' `
  -RestoreDatabase agentcontrol_restore_review
```

Reopen repeats current-state checks and retention, returning that database to
normal operation. It does **not** switch the running application's database.
Previously issued sessions remain revoked; uncertain provider writes must not
be replayed. See [Disaster recovery](../infra/disaster-recovery.md).

## Run retention

Preview first, then apply bounded slices:

```powershell
Invoke-LocalDeployment $context 'Retain' `
  -ConfirmCleanup 'agent-control/agentcontrol' -CleanupBatchSize 1000 -DryRun
Invoke-LocalDeployment $context 'Retain' `
  -ConfirmCleanup 'agent-control/agentcontrol' -CleanupBatchSize 1000
```

Use the exact lowercase `<project>/agentcontrol` confirmation. Repeat applied
slices until `pending=false` and no changes remain.

Retention makes no provider calls. It expires sessions, transient evidence, jobs,
audit, staging and exports under their defined policies. It does not delete
accepted live CSV reports merely for age; published-report deletion requires
explicit Admin action. Office observations retain twelve UTC calendar months
from provider refresh date, including the cutoff date.

## Existing installation maintenance

Before changing an installation, verify its Docker context, project labels,
container identities, data volume, database, origin and intended source.
Preserve settings, secrets, backups and unrelated projects.

Normal start checks the current schema/grants before draining the app.
An incompatible schema requires an explicit reset, not an automatic migration.
Maintenance protects interrupted database work; successful installation or
recovery returns to normal operation without a second enable step.

If initialization fails, fix the reported cause and retry ordinary `start`.
If an explicit reset completed, resume the unfinished initialization without
requesting another reset. If its outcome is unknown, retain maintenance and
inspect the exact target before any destructive retry.

After an update, verify the served revision, health/readiness, sign-in/out,
authorized saved views, automatic synchronization and affected controls.
Software tests or health alone do not prove these journeys.

## Reset application data

**Destructive:** confirm the exact project/database and intentional data loss
before running:

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control -DbReset
```

The switch authorizes deletion and does not prompt again.

- Deletes inventory, CSV reports/history, Office observations, sessions, audit,
  jobs and database-stored configuration.
- Retains project settings, secret files, PostgreSQL roles, the volume and
  existing backups. Do not delete the volume to reset application data.
- Each new invocation after a completed deployment requests a new reset.
  Use ordinary `start` for a non-destructive restart.
- If reset succeeded but initialization failed, correct the failure and retry
  **without** `-DbReset`. Do not repeat an unknown destructive outcome blindly.

After success, sign in again. Authorized read-only synchronization starts
automatically. Re-enter required database-stored sharing settings and reimport
official CSVs. Provider synchronization cannot reconstruct deleted report,
Office, audit or job history.

## Credential recovery

- Replace an Entra credential through `edit-config`, then `start`.
- Restore missing/corrupt session or database secrets from the same project's
  protected storage. Do not generate replacement database passwords for an
  existing PostgreSQL volume.
- Protect `.local/<project>/settings.json`, its `secrets/` directory and the
  PostgreSQL volume together.

For Azure runtime secret references, use the
[Key Vault contract](azure-production-deployment.md#prepare-key-vault).
Azure Plan/Deploy does not rotate existing credentials; see its
[operating limitations](azure-production-deployment.md#operate-the-deployment).

### Optional MCP recovery and backup

MCP OAuth state and keys have a separate backup/recovery lifecycle from
PostgreSQL. Use [MCP integration](mcp-integration.md) for exact local-volume and
Azure Blob procedures, and [MCP client setup](mcp-clients.md) for reconnecting.
An MCP failure is not an API/database reset request.

## Validation

For documentation-only changes, check local links, heading anchors and
`git diff --check`; do not start infrastructure.

For code changes, use the repository's focused unit, type and lint checks.
`npm run check:unused` runs the configured Knip check. Run infrastructure-backed
fixtures only in an explicitly disposable non-production environment.

Record source/mock checks, browser evidence and real provider/deployment
verification separately. Do not report unrun journeys as passed or turn test
receipts into runtime authorization.

## Production operations

Use the [Azure guide](azure-production-deployment.md) for updates, credential
rotation, monitoring and point-in-time recovery. Keep the exact resource,
network and Key Vault target under the organization's change process.
