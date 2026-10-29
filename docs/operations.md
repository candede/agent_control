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

Normal sign-out revokes session authority and unfinished writes, not complete
saved sources. A fresh sign-in can capture new reads over those retained sources;
observation age alone does not remove them.
An exhausted manual or automatic authorization-waiting run releases its active
slot, so a fresh sign-in can automatically retry eligible sources without
manually resuming that run. Live provider-authorization handoffs are still joined,
and automatic recovery never replays a destructive saved-data reset.
Finished provider workers also release runs with pending CSV uploads, so those
uploads cannot block automatic collection. A later accepted bundle updates the
retained report source and completes the run if every source succeeded, without
restarting incomplete provider work.

Inventory health shows **Updating** while complete, validated saved sources are
being reconciled or newly synced package details are being published. Previous
results remain usable and updates appear automatically; no manual start or
approval is needed. **Details pending** means exact package details are still
being collected or refreshed, not that agents are missing. **Needs attention**
is reserved for actual source, authorization, ownership, accounting or identity
problems. Reconciliation does not hide those problems or certify an older
selection as current.

Retained run links use `/sync?syncRun=<id>`. Opening history, a job detail or
another tab does not resubmit provider work. Explicit refresh starts only the
selected supported sources. Automatic work obeys pause, visibility, online,
backoff and initiating-session fences.
Cancelling retained history affects only that run and any retry already bound
to it; it does not interrupt a new synchronization awaiting admission.

Routine source collection is due every six hours, not on every page visit or
saved-data read. Ordinary failed attempts wait one hour before an automatic
retry; real provider backoff and newer-sign-in recovery remain authoritative.
Missing or invalidated current sources are collected automatically without
waiting for the six-hour interval, even when historical syncs succeeded recently.
Setup readiness checks usable saved publications, not historical success markers;
last successful counts and dates remain visible. Real failed-attempt cooldowns
still apply.
Healthy idle checks run every five minutes. Initial collection and active work
use faster status checks, and genuinely unavailable inventory retries after
thirty seconds. None of these status checks recollects Microsoft data by itself.

When a report becomes active, automatic Users refresh and explicit
incomplete-source retries check its exact report identities even if the saved
directory is still within its routine six-hour collection window, without
recollecting fresh app activity or treating unknown
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
or fail, with their original collection dates. Source ownership, explicit
invalidation and actual selected-read lease deadlines still apply. Search, people
ordering, detail and exports retain the exact evidence required by their
contracts. A fresh read may adopt a new publication; a cursor cannot silently
mix generations. Current mutation authority is stricter than historical read
authority.

The browser retains bounded, principal/role-scoped saved pages in memory for up
to fifteen minutes of reuse and one hour of inactive retention. The actual
server read lease, at most ten minutes, remains the earlier boundary. Navigation
and transient failures can display the last successful rows while PostgreSQL
recaptures a selection; errors remain visible, and historical display rows
cannot authorize actions. Logout clears the cache. Focus checks and read-lease
renewal read PostgreSQL, not Microsoft. Exact administrative/detail queries and
live access/progress evidence retain their separate current-read contracts.

Catalog refresh and exact/detail enrichment are independent. Catalog collection
does not fan out detail reads; detail collection does not relist the catalog.
Published catalog rows remain listable while optional matching and sharing
details are collected. Compatible catalog refreshes retain saved detail
descriptions, including large descriptions stored as child facts, whether fresh
or stale. A new exact/detail read replaces or clears that description; a changed
catalog revision invalidates reuse. Canonical publication batches independent
records even when they have identity metadata. A missing source in an older canonical
publication is not an empty catalog: Agents reports publication in progress
while that work runs, or the actual source unavailability when it is not running.
Available rows remain visible during publication.
Sync labels detail progress as **targets checked**, including exact 404
absences, versus catalog **packages observed**. Collection completion does not
by itself prove publication.
Cancelling a detail batch keeps unrelated automatic checks from claiming another
batch, even while the previous collector is stopping. Starting detail collection
explicitly can resume work after cancellation.

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

### Optional MCP recovery and backup

For the separate Azure profile, use the [Azure contract](azure-production-deployment.md#optional-independent-mcp-app-service)
and [independent leased-Blob recovery](../infra/disaster-recovery.md#independent-azure-mcp-recovery).
The named-volume steps below are **local Compose only**, not Azure POSIX or
persistence evidence. Azure native Key Vault transport does not change the
independent key, encrypted state, no-replay or API-owned recovery boundaries.

Use the [local MCP setup contract](deployment-setup.md#optional-local-mcp-container)
and the same project's `start`, `edit-config`, `check` and `stop` owner.
API/web does not depend on MCP; a failed MCP restart must not be treated as an
API/database reset request. Read `mcp-operation.json` and local bounded logs,
repair the concrete file/identity/permission failure, then run normal `start`.
Do not discard incompatible/undecryptable state silently.

Stop the exact project before taking a coherent encrypted-state backup. Protect
the whole `<project>_mcp-oauth` named volume plus its original three independent
`secrets/mcp-*` files, `settings.json`, `compose.env`, `mcp-storage.json` and MCP receipts. Keep
encryption keys separately protected from the encrypted backup; do not print
them, archive them into source/images or upload them to test reports. Restore
only to the same exact tenant/client/API/resource binding, owned UID/GID and
0700/0600 permissions. API PostgreSQL backup/restore remains separately owned
by the current-schema operator; OAuth files are not an application database.
If an explicitly authorized disaster restore recreates the named volume, its
creation identity necessarily changes. Restore and verify the protected backup's
complete encrypted file inventory/digests, original binding and keys first.
Preserve the old `mcp-storage.json` under a recovery-evidence name outside its
active filename, then ordinary `start` validates ownership/encryption and records
the restored volume's new creation identity. This is an explicit operator
recovery decision, never an automatic response to a missing-volume error or a
way to start with empty replacement state. Keep the original receipt and restore
evidence with the backup.

- **Encryption rotation:** import a protected ring with the new independent
  key first and retained old key(s), then ordinary `start`. Reconnect/expire old
  connections and rewrite required retained records before retiring their key;
  no automatic bulk plaintext/decrypt/reset procedure exists.
- **Signing rotation:** replace only the signing key and `start`; old reference
  tokens fail and clients must reconnect. Encryption keys are unchanged.
- **Confidential credential rotation:** import only the new MCP confidential
  credential and `start`; it is not the API application's credential.
- **Revocation:** the exact OAuth revocation endpoint and encrypted tombstones
  survive MCP restart. Reconnect does not revive a revoked reference.
- **API restart:** API/provider credentials are volatile, never restored from
  MCP state, SQL jobs or browser caches. Saved jobs remain readable within their
  principal scope; reacquire fresh same-account authority and explicitly resume
  eligible unsent work. Sent-unknown writes require read-only reconciliation.

For exact targeted retirement, stop the project, verify container project/
working-directory/service labels and the four MCP mount identities, remove only
that verified MCP container, then remove the `mcp` settings and (only with explicit
data-loss authorization) its three secret files/dedicated named OAuth volume.
Retain `<project>_data`, all PostgreSQL/API/session secrets and backups.
No glob removal, Compose orphan cleanup, volume prune or reset is appropriate.

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
pwsh ./scripts/local-mcp.tests.ps1
```

These do not prove a live deployment. Do not start infrastructure merely to
validate documentation.

When separately authorized for disposable local infrastructure, the existing
fixture runner supports `-Suite mcp-container`. It requires the exact local
`desktop-linux` Unix socket, rejects inherited PG/APP_PG/tenant/client/session/MCP
authority, and uses only a fresh `ac-mcp-fixture-<24 hex>` project, synthetic
configuration, internal network and exact protected mounts. The production
image is checked first; synthetic authenticated calls use a distinct test-only
image. Diagnostics, image/source identities and measured memory/CPU/storage/
shutdown evidence remain in `artifacts/large-tenant-data-platform/<guid>`.
Only exact owned containers/network/images/state are cleaned, with no prune.
`deployment-current` and `fresh-installation-current` separately exercise real
current/empty schema, incompatible refusal, API authentication/recovery and
ordinary API/web operation without any MCP service. Node fixture dependency
manifests must match the exact baseline; a mismatch is not permission to reuse
old installed dependencies or weaken the guard.

### Current release qualification for deployment testing

Use the current [phase11 evidence and handoff](../plans/fastmcp-integration/completions/11-release-qualification.md)
for source/image identities, actual counts, known capacity failures and cleanup.
It is not a production approval, runtime prerequisite or request to deploy.
The existing local snapshot owner freezes tracked and eligible untracked inputs,
but excludes generated `tsx-<numeric uid>` cache directories even when tracked.
Git/Docker exclusions and the Azure ZIP packager/inspector enforce the same
boundary; ordinary TypeScript/TSX sources and nonnumeric source directories remain
eligible. Do not delete or untrack pre-existing repository caches to make a
snapshot match. A changed source manifest requires newly source-labelled images;
retain superseded receipts as history, never relabel old images.
Do not use a historical default operator image: the locked Azure SDK and current
workspace manifests must be present in the baseline. With separately authorized
disposable infrastructure, build the current operator through the approved feed:

```powershell
$operator = "agent-control-qualification-$([Guid]::NewGuid().ToString('N')):local"
docker build --pull=false --provenance=false --target operator `
  -t $operator .
$baseline = (docker image inspect --format '{{.Id}}' $operator).Trim()
./scripts/large-tenant-tests.ps1 -Suite mcp-end-to-end `
  -BaselineImage $operator -BaselineImageId $baseline
./scripts/large-tenant-tests.ps1 -Suite mcp-container `
  -BaselineImage $operator -BaselineImageId $baseline
./scripts/large-tenant-tests.ps1 -Suite fresh-installation-current `
  -BaselineImage $operator -BaselineImageId $baseline
./scripts/azure-oauth-fixture.ps1 -Full
```

Do not supply Docker host/context overrides or inherited database/tenant/client/
session authority. The owners verify the exact existing Desktop socket, unique
synthetic target, manifests and immutable image IDs. `mcp-end-to-end` extends the
existing SQL runner with the current MCP test image: real SDK OAuth/tool calls
reach the actual registered canonical HTTP handlers and SQL; only Entra/provider
transports are synthetic. It must emit `mcp_sql_sdk_journey` receipts, not merely
pass the ordinary SQL selector. No real identity/provider call is authorized.
The fresh-installation fixture collects and recollects through compiled current
API code and synthetic provider records; its reset is confined to its exact
owned disposable database. The full Python command includes real Azurite lease/
ETag failures; an ordinary pytest run with Azure skips is not equivalent.

The MCP container owner separately checks production contents and runtime
UID/mount/security/log/cgroup limits before synthetic authenticated load,
restart, revocation, drain and rotations. Its offline image unit checks use
64MiB of owner-only Linux tmpfs for scratch; durable OAuth restart/rotation
journeys still use the actual verified persistent volume. These tests do not
qualify App Service,
managed identity, real client callbacks, native/guest Entra OBO or provider
writes. The query capacity fixture now traverses all100/1000 pages of its fixed
10k/100k cohorts and validates exact ordered identities; it is not a production
capacity pass or evidence that an unfiltered100k-row export fits a workflow
budget. Preserve unsuccessful and inconclusive capacity gates, never raise caps
or replace complete evidence with a favorable first page.

## Production operations

For Azure use the exact approved resource/network/Key Vault target and existing
deployment tooling; see [Azure deployment](azure-production-deployment.md).
The [API/web release plan](../plans/fastmcp-integration/04C-api-webapp-production-release.md)
uses the confirmed current-host `seha` target. Neither this runbook nor planning
records authorize live provisioning, unrelated cleanup or provider writes.
