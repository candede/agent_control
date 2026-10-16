# Operations runbook

Use the current application schema and ordinary authenticated workflows.
Deployment records and software test results are evidence, not runtime access
controls. Real app roles, provider permissions and destructive-action
confirmation remain required.

## Start, stop, update, and check

Run from the repository root:

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control
pwsh ./deploy-local.ps1 stop -Project agent-control
pwsh ./deploy-local.ps1 check
```

`start` builds/starts the app; `stop` retains settings and data; `check` validates
software without deploying. `start -ForceChecks` validates before starting.
Use the exact intended project name with every installation command.

## Change configuration

```powershell
pwsh ./deploy-local.ps1 edit-config -Project agent-control
pwsh ./deploy-local.ps1 start -Project agent-control
```

The wizard edits tenant profiles, secrets, domains, port and optional public
URL without displaying saved secrets. Update every Entra Web redirect URI
to `<public-origin>/api/auth/callback` when the origin changes. Keep each
organization in its own project.
See [setup](deployment-setup.md) and [provider requirements](provider-contracts.md).

## Check health

```powershell
Invoke-RestMethod http://localhost:3001/api/health
Invoke-RestMethod http://localhost:3001/api/ready
```

Liveness is process health; readiness checks serving prerequisites. Neither
proves provider access, successful sync, correct saved data or working user
journeys. Provider outages/throttling leave the previous complete publication
available and do not turn missing evidence into zero.

Persisted operational state is deployment-wide `normal` or `maintenance`.
Process drain and maintenance markers take precedence. An unavailable state
read pauses background dispatch until a successful reload. Completing verified
installation/reset/restore returns to normal operation without a second enable
step. Saved reads and explicit cancellation retain their normal authorization.

## First sign-in and synchronization

Eligible signed-in Viewer/Admin sessions start read-only collection
automatically while visible and online. Setup tracks Users, Graph packages and
Power Platform, opening the workspace when those sources are saved. CSV imports
and package-detail enrichment do not block setup. Retry/cancel and sign-in
recovery appear only when needed; Permissions is recovery guidance after a
genuine permission failure, not a prerequisite visit.

Sync shows current-attempt observations separately from last saved counts and
last successful publication. A running count is not a provider total or ETA.
Failed/partial attempts do not replace a complete saved source.

Retained run links use `/sync?syncRun=<id>`. Opening history, a job detail or
another tab does not resubmit provider work. Explicit refresh starts only the
selected supported sources. Automatic work obeys pause, visibility, online,
backoff and initiating-session fences.

When a report becomes active, automatic Users refresh and explicit
incomplete-source retries check its exact report identities even if the saved
directory is still within its normal 15-minute
freshness window, without recollecting fresh app activity or treating unknown
licensing as unpaid. A report changed during collection remains due until a
collection starts with that report active. It joins active work and rechecks
after publication when required. Completed run history does not consume an
hourly sync allowance or block automatic or explicit synchronization. Actual
concurrent execution limits and provider retry/backoff still apply. Collection
and authorization errors remain visible in Sync.

## Resolve sign-in and permission problems

Provider-specific MFA or token-renewal requirements are reported as capability
diagnostics. They do not sign out a valid browser session or prevent other
providers from working. Actual browser-session expiry, revocation and identity
revalidation failures still invalidate the request authority.

- Confirm configured domain, tenant/app binding, callback, app-role assignment
  and current sign-in.
- Use **Permissions > Check status** to inspect actual provider diagnostics.
  Token readiness is not proof of complete provider role, licensing or data scope.
- A configured application hunt/audit search runs directly for an authorized
  Viewer/Admin within its current tenant/client/configuration/shared scope.
  Delegated results remain private. No prior qualification query is required.
- Correct consent, provider role, licensing, connectivity or sharing settings
  when the actual operation reports that limitation.
- Restart/expired credentials can leave accepted jobs waiting for authorization.
  Obtain fresh same-principal authority and use explicit resume for unsent work.
  Never replay an uncertain mutation.

See [security](security-model.md), [Microsoft roles](user-roles-and-permissions.md),
[Purview](purview-audit-search.md) and [Defender](defender-agent365-hunting.md).

## Reload saved agent inventory

Reloading reads saved data, not Microsoft. Initial reads show loading; subsequent
reads retain prior rows while updating. Failed reads keep their explicit error
and retry action. Cancelled/superseded reads are not false collection failures.
Export/selection actions remain revision-bound.

Authorized complete publications remain readable while successors run slowly
or fail. Source/selection revocation or expiry still applies. Search, people
ordering, detail and exports retain the exact evidence required by their
contracts. A fresh read may adopt a new publication; a cursor cannot silently
mix generations. Current mutation authority is stricter than historical read
authority.

Catalog refresh and exact/detail enrichment are independent. Catalog collection
does not fan out detail reads; detail collection does not relist the catalog.
Sync labels detail progress as **targets checked**, including exact 404
absences, versus catalog **packages observed**. Collection completion does not
by itself prove publication.

### Agent inventory views and portal count comparison

**Microsoft 365 catalog** contains saved Graph package-backed agents.
**Additional Power Platform agents** contains native agents without a confirmed
catalog match; that is not proof they are unpublished. **Combined inventory**
includes both and consolidates only supported exact matches, never names.

Logical agent counts differ from package-version counts. Compare matching
source scope and observation time with Microsoft portals; unavailable means
unknown, not zero. Inventory scopes are independent of table filters and do
not change imported usage totals. See [data architecture](data-architecture.md)
and the [frontend flows](../frontend/README.md).

### Package and Studio job recovery

**Access and availability** shows package-job progress/outcome counts and
recovery controls, including `/agents?controlJob=<id>`. Cancel stops unstarted
work but cannot undo completed effects. Resume requires current authorization.
**Check uncertain results** reconciles read-only; a later retry needs a fresh
preview. Status polling never performs recovery writes.

Package status/history return counts and `resultRevision`; bounded item pages
must use that revision. Refresh status/restart paging after
`selection_invalidated`. Preview counts cover the whole target set even when
only a bounded sample of names is shown. Unblock preserves availability and
installation settings; it is not an access grant. Studio quarantine remains a
separate effect.

### Administrative audit provenance

Origin identifies authenticated `webapp|mcp|unknown` provenance, not provider
source or authorization. Reported labels are displayed as reported. Unknown
historical attribution remains unknown. Resume/cancel/reconcile attribution
does not replace the accepted initiator or replay provider effects.
See [API contracts](mcp-integration.md).

## Diagnose synchronization problems

<a id="graph-package-sync-diagnostics"></a>

Correlate request, run, source and job IDs. Check failed authorization,
provider status, throttling, cancellation, publication and storage-limit stages
separately. `package_refresh_succeeded` confirms publication; completed checks
alone do not.

Collection diagnostics include settled request/retry/throttle counts,
request duration, admission wait, retry wait and collection wall time.
Concurrent durations overlap: do not add them to derive elapsed time.
`data_residual_limit_exceeded` reports bounded byte counts/field labels,
not payload contents. Preserve existing request/body/deadline/resource limits
rather than raising them to conceal an error.

## Review logs

Use the deployment's service logs and safe request/job correlation. Do not print
environment variables, tenant registries, secret files, tokens, continuation
URLs, report contents or raw provider bodies. Normal provider diagnostics use
bounded categories and sanitized correlation.

## Operator-only local helpers

```powershell
. ./scripts/local-deployment.ps1
$context = New-LocalContext -Root $PWD.Path -Project agent-control
```

Use only the exact owned project. These helpers do not authorize a change to
another database, organization or Docker project.

## Backup and isolated restore

Create a protected current-schema logical backup:

```powershell
Invoke-LocalDeployment $context 'Backup'
```

Or choose a new file in an existing access-restricted directory:

```powershell
Invoke-LocalDeployment $context 'Backup' `
  -BackupFile "$PWD/.local/agent-control/backups/operator-verified.dump"
```

The receipt binds dump checksum, current schema, table content and snapshot
time. Backups contain sensitive retained data; never commit or publicly share
them. Current-only restore does not convert incompatible schemas.

### Restore for review

```powershell
Invoke-LocalDeployment $context 'Restore' `
  -BackupFile "$PWD/.local/agent-control/backups/operator-verified.dump" `
  -RestoreDatabase agentcontrol_restore_review
```

Restore uses a separately named database. It revokes sessions/execution
authority, fences owners, marks uncertain work honestly and compares current
ownership/deletion/configuration before exposing restored caches. Review report
selection, tenant/private scope, audit and job integrity, then reopen:

```powershell
Invoke-LocalDeployment $context 'Reopen' `
  -RestoreDatabase agentcontrol_restore_review
```

Reopen repeats current-state checks and bounded retention. It returns to normal
operation, not an additional provider-enable mode. This does not switch the
running application's database. Never replay an uncertain write.
See [disaster recovery](../infra/disaster-recovery.md).

## Run retention

```powershell
Invoke-LocalDeployment $context 'Retain' `
  -ConfirmCleanup 'agent-control/agentcontrol' -CleanupBatchSize 1000 -DryRun
Invoke-LocalDeployment $context 'Retain' `
  -ConfirmCleanup 'agent-control/agentcontrol' -CleanupBatchSize 1000
```

The confirmation is the exact lowercase project/database. Preview first;
repeat applied bounded slices until `pending=false` and no changes remain.
Retention makes no provider calls. Dependent selections/projections are
invalidated before parent deletion. Accepted live report history is not
deleted merely for age; explicit confirmed Admin deletion governs that content.
Sessions, ephemeral evidence, jobs, audit, staging and exports retain their
code-defined expiries.

## Existing installation maintenance

Normal start verifies the candidate's current schema/grants before draining.
An incompatible installation needs the explicit reset below; startup never
guesses an upgrade or silently deletes data. Maintenance protects active schema
work and interrupted installation, not a release-acceptance process.

Verify exact Docker context, project labels, app/PostgreSQL identities, data
volume, application database, configured origin and artifact before a live
change. Preserve configuration, secrets, volume and unrelated projects.
Use the existing local deployment owner, not ad hoc SQL, forged schema markers
or a second installation system.

After installation, check the actual served revision, health/readiness,
sign-in/out, Viewer/Admin/private scope, automatic first sync, saved views,
reports, job recovery and affected controls. Record failures/unavailable
provider proof honestly. Software checks or health alone do not establish
working first-run/user journeys.

## Reset application data

Only after explicit confirmation of the exact project/database and intentional
data loss:

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control -DbReset
```

The switch authorizes deletion and does not prompt again. Preflight precedes
drain; the guarded database-only reset is followed by current initialization,
runtime grants and readiness. It deletes inventory, reports/history, sessions,
audit, jobs and database-stored configuration/evidence. Settings, credentials,
roles, PostgreSQL volume and existing backups stay outside the database reset.
Do not remove the volume to perform an application reset.

After a deployment completes, each new ordinary `start -DbReset` invocation
requests a new reset. Completed deployment receipts do not require the previous
candidate or suppress that request. Use `start` without `-DbReset` for a
non-destructive restart.

After success, sign in again. Read-only sync starts automatically under real
authorization. Re-enter required database-stored application-sharing settings
and reimport official CSVs; provider sync cannot reconstruct report history or
past audit/jobs. Empty/preparing states remain truthful until collection
succeeds. No additional qualification/enable/acceptance step is required.

If a reset was attempted but its outcome is unknown, keep maintenance and inspect
the exact target; do not blindly repeat destruction. If the reset completed but
deployment was interrupted, resume that unfinished operation to finish
initialization without replaying the reset. Create and verify a current backup
first when data must be retained.

## Credential recovery

Follow the 4-name/3-runtime-consumer contract in the
[Azure guide](azure-production-deployment.md#prepare-key-vault) when rotating
versioned secrets: runtime receives `TENANTS_JSON`, `SESSION_SECRET` and
`PGPASSWORD`; the PostgreSQL administrator password stays operator-only.

- Replace an Entra client secret through `edit-config`, then `start`.
- Restore missing/corrupt database or session secrets from protected storage
  belonging to the same project; do not generate replacement database passwords
  for an existing volume.
- Keep `.local/<project>/settings.json`, `.local/<project>/secrets/` and its
  PostgreSQL volume together when protecting configuration.

## Validation

Use existing focused Node/Vitest and PowerShell tests for changed contracts.
Run `npm run check:unused` for the configured Knip dead-code/dependency check.
Its real-entrypoint configuration is `knip.json`; it complements, rather than
replaces, runtime and route-contract tests.
The [isolated fixture runner](../scripts/large-tenant-tests.ps1) owns disposable
database/browser/capacity fixtures; inspect its selectors and ownership guards
before use. Tests must never target production databases, ports or volumes.
Mock/source tests, real provider evidence and live browser evidence are distinct.
Record `passed`, `failed`, `not_run`, `unavailable` or `inconclusive` accurately.

Local source-only examples:

```powershell
pwsh ./scripts/local-deployment.tests.ps1
pwsh ./scripts/local-runtime.tests.ps1
```

These do not prove a live deployment. Do not start infrastructure merely to
validate documentation.

## Production operations

For Azure use the exact approved resource/network/Key Vault target and existing
deployment tooling; see [Azure deployment](azure-production-deployment.md).
The [API/web release plan](../plans/fastmcp-integration/04C-api-webapp-production-release.md)
uses the confirmed current-host `seha` target. Neither this runbook nor planning
records authorize live provisioning, unrelated cleanup or provider writes.
