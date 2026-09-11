# Disaster recovery

Production recovery is an approved maintenance action, never normal initialization. Keep the prior ZIP only for schema-compatible recovery. After an incompatible migration, repair forward or restore the database; never start an old writer against a newer schema and never replay uncertain writes.

## Local logical rehearsal

Use only an isolated `agentcontrol_restore_*` database and a protected dump/receipt pair. These are existing operator-only PowerShell helpers, not `deploy-local.ps1` arguments or a separate maintenance executable. In PowerShell 7 at the repository root:

```powershell
. ./scripts/local-deployment.ps1
$context = New-LocalContext -Root $PWD.Path -Project agent-control-phase01
Invoke-LocalDeployment $context 'Restore' `
  -BackupFile "$PWD/.local/agent-control-phase01/backups/<protected>.dump" `
  -RestoreDatabase agentcontrol_restore_operator_review
Invoke-LocalDeployment $context 'Reopen' `
  -RestoreDatabase agentcontrol_restore_operator_review
```

The context reads the saved configuration and port from the fixed repository-root `.local/agent-control-phase01/` directory. Follow the [backup and restore runbook](../docs/operations.md#backup-and-isolated-restore), including operator review before `Reopen`. Restore verifies the archive checksum, table fingerprints and immutable migration prefix; migrates forward; invalidates sessions, provider qualifications, previews and execution owners; preserves uncertain sent writes as inconclusive; reconciles current deletion/access scope; runs retention to convergence; and leaves provider work disabled. Reopen repeats review transactionally. It never changes the retained app database. Remove only the exact reviewed synthetic target.

## Future native Azure PITR drill

After explicit approval of the source server, UTC restore point, temporary server name/cost, maintenance window and cleanup owner:

```powershell
pwsh ./deploy-azure.ps1 -Action PointInTimeRestore -TargetFile <approved-target.json> `
  -RestorePoint <approved-UTC-timestamp>
```

The wizard restores to one isolated PostgreSQL Flexible Server, never a duplicate app stack. It keeps provider dispatch closed, runs the same session/qualification invalidation, current deletion/access review and convergent retention contract, does not repoint the serving app, and deletes only the run-owned restored server after validation. Its receipt must distinguish local rehearsal, mock orchestration and actual Azure PITR. The local-only Phase 12 session ran only deterministic mocks; no native restore occurred.

## Future serving recovery

An actual switch additionally requires explicit approval of the RPO/data-loss boundary, reviewed restored-server identity, retained old-server ownership and canonical app:

```powershell
pwsh ./deploy-azure.ps1 -Action Recover -TargetFile <approved-target.json> `
  -RestorePoint <approved-UTC-timestamp>
```

Recovery closes admission, drains without replay, backs up the current server, restores and reviews the isolated server while it remains in maintenance, then changes only `PGHOST` with `MAINTENANCE_MODE=true`. It starts the exact release contained, performs read-only route/configuration checks and requires the exact-run human login/callback/session receipt. Only then does it transactionally reopen the restored database with provider work disabled and remove application maintenance before bounded readiness/auth verification. The old server is retained until separate backup/retention approval; the verified restored server is transferred out of temporary cleanup ownership. Any post-switch failure reapplies maintenance, stops the app and records containment; it never silently falls back.

Before reopening, verify schema 26 or the exact approved forward migration, runtime/admin privilege separation, five resolved vault references, login/callback/session invalidation, current report selection and source-scoped deletion/access, static/deep-link/API behavior and no execution owners. Record restored/source IDs, restore point, backup and release checksum, cleanup and operator approval without data or secret values.
