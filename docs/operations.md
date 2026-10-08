# Operations runbook

This runbook covers the supported local commands and common recovery tasks.

## Start, stop, update, and check

Run commands from the repository root:

```powershell
pwsh ./deploy-local.ps1 start
pwsh ./deploy-local.ps1 stop
pwsh ./deploy-local.ps1 check
```

- `start` builds and starts the current application.
- `stop` stops the application and keeps settings and data.
- `check` runs the software validation suite without deploying.

Use `-Project <name>` with every command when operating a named installation.

To validate and deploy the same source snapshot:

```powershell
pwsh ./deploy-local.ps1 start -ForceChecks
```

## Change configuration

```powershell
pwsh ./deploy-local.ps1 edit-config -Project agent-control
pwsh ./deploy-local.ps1 start -Project agent-control
```

The wizard edits tenant profiles, secrets, accepted domains, the port, and the
optional public URL. It does not display saved secrets.

If the URL or port changes, update the Web redirect URI in every Entra app
registration before starting:

```text
<public-origin>/api/auth/callback
```

Do not reuse one project's data for another organization. Create another project
instead.

## Check health

For the default local port:

```powershell
Invoke-RestMethod http://localhost:3001/api/health
Invoke-RestMethod http://localhost:3001/api/ready
```

- `/api/health` reports whether the process is running.
- `/api/ready` reports whether the app is ready to serve requests.

An Agent Control Admin can also call `GET /api/diagnostics` for bounded runtime
status.

## Resolve sign-in and permission problems

1. Confirm the username domain is configured for exactly one tenant.
2. Confirm **Assignment required?** is enabled and the user or group has
   `AgentControl.Viewer` or `AgentControl.Admin`.
3. Confirm the callback URL exactly matches the current public origin.
4. Confirm the required API permissions have tenant-wide admin consent.
5. Confirm the signed-in user has the Microsoft role and license required for
   the action.
6. Sign out and back in, then use **Permissions > Check status**.

See [deployment setup](deployment-setup.md) and
[Microsoft roles](user-roles-and-permissions.md).

## Reload saved agent inventory

Reloading reads saved data; it does not start a new collection from Microsoft.
The Agents page keeps its loading skeleton during the first read, including when
a background publication replaces that read. Subsequent reads show an updating
indicator and retain previous results when available. Export stays disabled
until the current read succeeds.

A retry shows loading status instead of the previous inventory error. If the
current read fails, the error and **Reload saved agent inventory** action remain
available. Confirmed missing inventory or source-coverage issues are shown after
loading finishes; a cancelled, superseded read is not an application failure.

If saved inventory or report evidence expires during a read, Agents makes one
automatic attempt to capture and load a fresh saved-data selection. Filters,
sorting, and the requested agent detail link are preserved; paging restarts at
the first page and target selections and prepared actions are cleared. This does
not collect provider data, retry an export, or replay a management action.
If the replacement also fails or is already expired, the page offers explicit
retry rather than repeatedly reloading. Permission failures, malformed responses,
and selection conflicts without confirmed expiration still surface as errors.

## Diagnose synchronization problems

Use **Sync** to review each source independently.

- A permission error means the current account, app registration, or provider
  does not authorize that source.
- A throttling or provider error can leave existing saved data available. Retry
  after the provider recovers.
- An empty successful result is different from a failed refresh. Review the
  source status before changing permissions.
- CSV report imports are managed under **Sync > Add CSV reports** and
  **Sync > Manage reports**.

Provider actions require current authorization when they run. A successful
permission check does not guarantee that a later provider request will succeed.

## Review logs

Local application and PostgreSQL logs are available through Docker Compose:

```powershell
docker compose logs app
docker compose logs postgres
```

Do not share logs until credentials, tokens, tenant data, and user data have been
removed.

## Back up a local installation

Advanced maintenance functions are loaded from the repository root:

```powershell
. ./scripts/local-deployment.ps1
$context = New-LocalContext -Root $PWD.Path -Project agent-control
```

Create a timestamped backup:

```powershell
Invoke-LocalDeployment $context 'Backup'
```

Or choose a protected destination:

```powershell
Invoke-LocalDeployment $context 'Backup' -BackupFile "$PWD/.local/agent-control/backups/operator-verified.dump"
```

Backups contain tenant data and must remain access-restricted.

## Restore for review

Restore a backup to a new isolated database:

```powershell
Invoke-LocalDeployment $context 'Restore' `
  -BackupFile "$PWD/.local/agent-control/backups/operator-verified.dump" `
  -RestoreDatabase agentcontrol_restore_review
```

Review the restored data and access scope, then reopen it:

```powershell
Invoke-LocalDeployment $context 'Reopen' `
  -RestoreDatabase agentcontrol_restore_review
```

Restoring does not switch the running application to the restored database.
Changing a production database remains a separate maintenance action.

## Run retention

Preview one cleanup batch:

```powershell
Invoke-LocalDeployment $context 'Retain' `
  -ConfirmCleanup 'agent-control/agentcontrol' `
  -CleanupBatchSize 1000 `
  -DryRun
```

Apply the reviewed batch:

```powershell
Invoke-LocalDeployment $context 'Retain' `
  -ConfirmCleanup 'agent-control/agentcontrol' `
  -CleanupBatchSize 1000
```

Repeat until the command reports no pending work.

## Reset application data

Use a reset only when all saved application data may be deleted:

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control -DbReset
```

This deletes reports, audit records, jobs, inventory, and sessions for the
selected project's application database. It keeps project configuration,
credentials, PostgreSQL roles, the volume, and existing backup files.

The switch is the authorization to delete the data and does not prompt again.
Create and verify a backup first when the data must be retained.

## Credential recovery

- Replace an Entra client secret with `edit-config`, then run `start`.
- Restore missing database or session secrets from the approved backup of the
  same project.
- Do not generate replacement database credentials for an existing volume.
- Keep `.local/<project>/settings.json`, `.local/<project>/secrets/`, and the
  PostgreSQL volume together when backing up project configuration.

## Production operations

Use the deployment receipt, monitoring, backup, network, and maintenance
settings approved for the Azure target. See
[Azure production deployment](azure-production-deployment.md).
