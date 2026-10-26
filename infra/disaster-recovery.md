# Disaster recovery

Production recovery is a maintenance action with an exact authorized target.
Use an isolated restore database and verify the current application schema.

The current backup/isolated-restore helper accepts only the compiled current
schema, with exact structure/grants/table inventory and checksum validation.
Restored authority is revoked and current ownership/deletion/configuration is
reconciled automatically before reopening. Only current-schema backups are
supported; incompatible schemas fail without conversion. A database reset needs
explicit exact-target/data-loss confirmation and deletes official report history;
provider resync cannot replace reimport. Successful reconciliation/reopen returns
to normal authenticated operation, without review timestamps or a second
provider-enable step.
See [existing installation maintenance](../docs/operations.md#existing-installation-maintenance)
for the existing start/preflight/recovery contract.

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

Reopen through the same owner, which repeats current-state reconciliation:

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

## Independent Azure MCP recovery

MCP is not part of the PostgreSQL backup, current schema, provider credential
store, audit or job replay owner. PostgreSQL PITR/recovery never copies OAuth
state, reconstructs provider authority or resets the separate encrypted Blob.
See the [exact Azure hosting contract](../docs/azure-production-deployment.md#optional-independent-mcp-app-service).

For an explicitly approved OAuth backup/restore, stop only the MCP site through
the existing owner, verify Stopped and75-second drain, and retain a coherent
the single encrypted object's exact URL, ETag/version and checksum, binding,
image digest and secret-version references. Keep the independent encryption key
ring separately protected in Key Vault. App Service backups do not back up this
object; use the storage owner's separately approved Blob version/backup policy.
After stop, wait for the finite15s lease to expire or observe its release; never
break an active lease to force a second authority. Backup reads do not mutate
the object. Restore writes must obtain their own lease on this exact blob and
use an ETag condition; no unfenced upload or other-object restore is supported.

```powershell
pwsh ./deploy-azure.ps1 -Action Stop -Component Mcp -TargetFile <approved-existing-target.json>
```

The storage owner restores only the exact approved tenant/MCP/API/public
resource and account/container/object binding, through an approved managed-
identity storage administration path. Never copy an old key ring over current
keys automatically. Restoring an old OAuth snapshot can resurrect tokens whose
later revocation tombstones are absent: rotate the signing key/invalidate old
references and reconnect unless the owner proves the coherent revocation
boundary. This does not replay API writes; sent-unknown jobs remain API-owned.

Use a reviewed existing MCP target with exact current/selected digest and secret
versions, the restored original storage identity and a fresh change window:

```powershell
pwsh ./deploy-azure.ps1 -Action Plan -Component Mcp -TargetFile <approved-target.json>
pwsh ./deploy-azure.ps1 -Action Recover -Component Mcp -TargetFile <same-approved-target.json>
```

This reuses stop/apply/start/verify and does not restore/switch PostgreSQL.
It does not create a replacement object or change storage identity. Only the
explicitly prepared empty Block Blob permits first initialization; an encrypted
object with wrong keys/binding or corrupt/plaintext content stays unavailable,
with API/web online. A runtime ambiguous write or unknown renewal permanently
halts that process; reconcile the persisted ETag/outcome and lease holder before
starting a fresh process. Do not automatically replay its failed SDK mutation.
Unknown MCP ARM apply outcomes require explicit resource reconciliation before
resume; do not change a receipt to turn uncertainty into permission to retry.
Retain the original failed receipt and the operator's reconciled evidence.

Rotate only the chosen MCP secret version using `-Component Mcp`: encryption
ring newest-first with retained decrypting keys, signing rotation requiring
reconnect, or confidential credential rotation independently. The runtime checks
independent values; the tool reads only MCP version metadata and native reference
status. API/tenant/session/database versions and business data are unchanged.
An API credential rotation remains with the existing coordinated owner, never
implicitly enabled by an MCP change.

After recovery, separately observe the actual authorized OAuth→OBO→saved-read,
revocation, lease-expiry/host replacement, callback/forwarding rejection and bounded
transport/drain. Health and mock tests cannot certify Azure durability or client
compatibility. No recovery record becomes an application feature-enable gate.
