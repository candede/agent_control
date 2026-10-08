# Disaster recovery

Production recovery is an approved maintenance action. Use an isolated restore
target, verify the current application schema, and keep provider changes disabled
until review is complete.

## Local recovery rehearsal

Load the operator helpers from the repository root:

```powershell
. ./scripts/local-deployment.ps1
$context = New-LocalContext -Root $PWD.Path -Project agent-control
```

Restore a protected backup to a new review database:

```powershell
Invoke-LocalDeployment $context 'Restore' `
  -BackupFile "$PWD/.local/agent-control/backups/operator-verified.dump" `
  -RestoreDatabase agentcontrol_restore_review
```

Verify:

- backup checksum and schema fingerprint;
- expected tenants and report selection;
- current user, role, and provider scope;
- audit and job integrity;
- no active sessions or provider execution owners.

Reopen the reviewed database:

```powershell
Invoke-LocalDeployment $context 'Reopen' `
  -RestoreDatabase agentcontrol_restore_review
```

The restore workflow does not switch the running application to the review
database. See the [operations runbook](../docs/operations.md#restore-for-review).

## Azure point-in-time restore

Obtain approval for the source server, UTC restore point, temporary server,
maintenance window, cost, and cleanup owner.

```powershell
pwsh ./deploy-azure.ps1 -Action PointInTimeRestore `
  -TargetFile <approved-target.json> `
  -RestorePoint <approved-UTC-timestamp>
```

The workflow creates an isolated PostgreSQL Flexible Server for review. It does
not repoint the application.

## Serving recovery

Switching the application requires separate approval of the restore point,
expected data loss, reviewed server identity, release, network rules, Key Vault
references, and rollback ownership.

```powershell
pwsh ./deploy-azure.ps1 -Action Recover `
  -TargetFile <approved-target.json> `
  -RestorePoint <approved-UTC-timestamp>
```

Before reopening:

1. Confirm the application schema and release checksum.
2. Confirm runtime and operator database privileges.
3. Confirm every Key Vault reference.
4. Confirm sign-in, callback, and session invalidation.
5. Review report selection and tenant data scope.
6. Confirm no provider job can replay an uncertain write.
7. Verify health, readiness, static routes, and API routes.

If verification fails, keep maintenance enabled, stop the application, and
contain the reviewed restore target.
