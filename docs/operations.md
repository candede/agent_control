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

An ordinary saved-read lease end retains already-rendered authorized rows and
details with a historical notice. Paging, new exports, and new confirmations
require an explicit replacement; that replacement clears targets and unsent
previews while preserving the query, chosen report, and detail intent. Existing
admitted exports keep their exact frozen membership and bounded server lifetime.
There is no automatic recapture, export retry, or action replay. Fresh unpinned
navigation can admit a new read of the saved root. Permission failures, malformed
responses, missing dependencies, and selection conflicts remain errors.

The backend no longer shortens ordinary inventory reads for unrelated people
cache entries or app activity. Search and owner/creator ordering still require
their people evidence, and exported directory labels remain pinned. An authorized
current publication and its required inputs remain readable beyond their former
freshness TTL while a successor runs slowly or fails. Fresh captures still work;
neither a ten-minute read lease nor generation age is a sync-completion deadline.
Staging retains its own worker/admission/resource bounds. The frontend uses the
database validation timestamp and conservative monotonic request timing, not
browser calendar time or nested enrichment freshness, to limit cache reuse and
new selected operations. Observer-startup synchronization is publication-based; see the
[selected lifecycle contract](record-data-foundation.md#lifecycle-simplification-contract).
Reload is not a promise that unavailable or retired evidence will become readable.
“Preparing” means actual first-inventory reconciliation, not a retired
publication. Retired saved inventory offers reload/collection guidance.

### Background publication and status

An unchanged startup performs one selected inventory capture and one page read,
not a second read when automatic status first arrives. A publication racing
startup causes one scoped synchronization regardless of response order.
Subsequent progress, failure (including provider timeouts), or job completion
alone does not reload inventory or reports. Completion can request an eligible
publication check; persisted publication markers decide whether content changed.

Package control jobs publish verified block/unblock and access readbacks into the
saved inventory before releasing the completed job. Read-only reconciliation also
waits for that publication before returning. This lets the following inventory
reload and inverse-action preview use the saved result without waiting for the
background worker. Publication failures propagate without overwriting verified
provider evidence or replaying the write. If a confirmation is rejected because
its inventory changed, the UI clears the stale selection and reloads saved
inventory; the admin must review a new preview and confirm again.

A fresh base query can load the new publication while keeping its filters.
Paging, details, selected reports, targets, previews, and admitted exports keep
their frozen evidence. A relevant publication revalidates that selection without
recapturing or replaying an action; an ended frozen lease keeps visible history until
explicit replacement. Unrelated source changes do not clear every view.

Observation stops while hidden/offline and honors automatic-refresh pause,
request deadlines, backoff and session authorization. Returning to a view may
read its status, but does not resubmit a command. Completed job observations
stop, and consumers of the same in-flight exact-job endpoint share one transport.
These browser checks do not move admission, lost-worker recovery, identity
reconciliation, or bounded garbage collection out of their backend owners.

### Synthetic lifecycle qualification

`pwsh ./scripts/large-tenant-tests.ps1 -Suite lifecycle-read-contract` creates a
uniquely named, disk-backed PostgreSQL fixture, runs selected-read, export,
identity-expiry, report, retention and exact-control tests, then removes its
containers/network/volume. It does not use a running installation's database.
Evidence is written beneath `artifacts/large-tenant-data-platform/`.
`-Suite lifecycle-publication-contract` narrows this to long-build/failed-build
current-anchor, bounded closure GC, identity-projection and explicit reset probes.

For the integrated current frontend/API/database contract, use
`-Suite cutover-browser-contract -BrowserFiles savedBackendLifecycle.spec.ts,savedReadLifecycle.spec.ts,inventoryAcceptance.spec.ts,cacheNavigation.spec.ts`.
This compiles the current frontend, verifies the served bundle bytes, and runs
desktop/mobile Chromium against the isolated application. The saved-backend
fixture publishes 1,001 packages plus a native agent with expired freshness,
holds or fails a real delta, runs GC, and checks fresh HTTP admissions after
reload/navigation and separate source/canonical publication. Its loopback
controls exist only in the test script. Authentication/providers and automatic
dispatch are synthetic; selected reads, publication, retention and HTTP
serialization are real. No live tenant or provider call is authorized.

The browser clock accelerates 45-minute active/idle sessions. Exact ±1 ms
selection boundaries use deterministic client time or the existing SQL-query
clock fixture; database triggers retain their real clock. Separate PostgreSQL
delay tests exercise actual in-flight deadline crossing. These are not claims
of millisecond wall-clock scheduling precision or multi-hour production sync.
Use `-Suite capacity-retention` for physical row/byte GC bounds and
`-Suite report-source-scale` for large-report admission and paging limits.
`-Suite inventory-integration` also checks all 301 responsibility relationships
with 100-row pages and unchanged 15-second read limits. Responsibility and
inventory pages use the same transaction-local set-based planner safeguard;
no database-wide planner setting is changed.

`-Suite production-frontend` runs every frontend test within the same 300-second
deadline as the deployment software gate. The App session cases use three
ordinary isolated test entrypoints sharing unchanged fixture registration;
Vitest schedules these long groups first across the existing two isolated workers inside
the unchanged 1.5-CPU/1,536-MiB fixture budget; this only overlaps test waits and
does not increase the application or fixture CPU, memory, or heap caps.
DOM-free utility and fixture tests use Vitest's Node environment instead of
constructing a browser; DOM tests retain JSDOM and their existing teardown.
Native-download fixtures fast-forward only their synthetic two-second export
sleeps and assert the requested interval; dedicated polling/lease clock tests
retain their explicit time advancement.
No cases, assertions, isolation, individual-test deadlines, or runtime
CPU/memory/heap and read/GC bounds are relaxed. Only the full frontend command's
orchestration budget changed from 180 to 300 seconds for the 5,000-plus-case
suite: a standalone run completed in 175.8 seconds, but a subsequent combined
software run exhausted 180 seconds without memory-limit events. The enclosing
35-minute software-workload deadline and its cleanup reserve remain unchanged.

The runner checks both the cached dependency image's exact SHA-256 identity and
all current manifest hashes before execution. If that baseline is stale, supply
an independently qualified local image with `-BaselineImage <image>` and
`-BaselineImageId sha256:<digest>`; these arguments do not bypass either check.
Never retag or mutate a shared baseline to make the test pass. Dependencies must
use the approved feed, and identical installed dependencies need no reinstall.

`-Suite fresh-installation` exercises the real local deployment entry point on
an absent, uniquely named synthetic project: current initialization, the full
software gate, exact empty-schema restart/backup persistence, compiled first
source collection, isolated restore, then explicit `-DbReset`, initialization
and first re-collection.
It verifies that settings, credentials and backup files do not change. The
compiled read-only application and PostgreSQL run separately from build/test/
Chromium processes, at 1.5 CPU / 1,536 MiB / 768 MiB Node old-space and
0.5 CPU / 1,024 MiB respectively. First collection uses the real compiled
package job, stream, reconciliation and selected HTTP handlers with synthetic
authorization/provider input; it checks `not_collected` → `preparing` → complete,
1,001 rows, bounded pages and three persisted fresh captures. Runtime cgroup
peaks and limit/OOM events are recorded and asserted, not inferred from a
successful browser workload. This is bounded synthetic runtime qualification,
not a production-scale headroom guarantee. The exact installer fingerprint
comparison precedes collection because bounded GC legitimately retires
completed reconciliation scratch rows and advances root collection watermarks.
If reset recreates only the app, the fixture accepts PostgreSQL's earlier
compose paths only for the exact container/image already verified at initial
readiness; all ownership, mount, network, port and resource checks still apply.
`-Suite restart` separately checks populated compiled lost-worker recovery
without replaying completed or ambiguous writes.

The lifecycle schema changes three guard functions and requires the current
schema fingerprint. There is no old-schema compatibility or in-place migration.
For an incompatible installation, use the existing
[explicit reset procedure](#reset-application-data), initialize the current
schema and synchronize objects again. A reset deletes all saved application
data, including imported reports; re-import those reports and restore required
configuration separately. It is never performed automatically on startup.
The intended database and downtime must be confirmed before the later joint
deployment; local qualification does not authorize resetting a running app.

## Diagnose synchronization problems

Use **Sync** to review each source independently.

- A permission error means the current account, app registration, or provider
  does not authorize that source.
- A throttling or provider error can leave existing saved data available. Retry
  after the provider recovers.
- An empty successful result is different from a failed refresh. Review the
  source status before changing permissions.
- CSV report imports are managed under **Sync > Add CSV reports** and
  **Sync > Manage reports**. Management shows saved reports with View/Delete
  actions and pagination only when needed; report details open separately.

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

### Current-schema reset and re-collection rollout

Do not run the example against an assumed/default project. Before the later
supervised rollout, the operator and user must confirm **the exact Docker
context/engine, repository/revision, project name, `.local/<project>` directory,
`<project>-app-1`, `<project>-postgres-1`, `<project>_data` volume, application
database `agentcontrol`, tenant profiles and public origin**. Review ownership
labels, mounts and the intended port without printing environment variables or
secret files. Stop if any identity differs. Do not substitute a shared test
project or remove a whole volume to perform the application reset.

Agree a maintenance window and intentional data loss first. Preflight and
runtime compilation precede application drain; reset, initialization and
readiness happen during downtime. Source re-collection can take much longer
than readiness, so users may see truthful `not_collected`/`preparing` states
after sign-in. No fixed downtime or large-tenant synchronization duration is
promised. Use the confirmed project explicitly:

```powershell
# Destructive: only after joint target/data-loss confirmation.
pwsh ./deploy-local.ps1 start -Project <confirmed-project> -DbReset -ForceChecks
```

This invokes the existing guarded preflight-reset → drain → reset `agentcontrol`
→ initialize current schema/runtime grants → readiness flow. A noncurrent
schema without `-DbReset` is refused before draining the app. There is no
in-place conversion, legacy reader or automatic reset. Compare the operator's
preflight `targetFingerprint` and `currentFingerprint` with the exact deployed
artifact, rather than treating an old version number as compatibility.

- **Retained outside the reset database:** project settings/tenant profiles,
  Entra/database/session credentials, roles, volume and existing backup files.
  Treat them as secrets; do not copy their values into test evidence.
- **Deleted:** inventory and its source/input generations, selections/exports,
  sessions, identity/person caches, source/job/sync history, audit evidence,
  uploaded official reports and saved report sets/history, capability
  configuration/evidence, mutation/quarantine qualification and approvals,
  operational state and other database-stored application state.
- **Rebuilt only with authorization and successful collection:** supported
  directory/activity/package/Power Platform source data and derived inventory.
  A failed provider call does not constitute a complete source or empty result.
- **Not automatically regenerated:** imported CSVs/report history, historic
  audit/job/action records, database-stored capability configuration and prior
  qualifications/approvals. Export/review required settings securely before
  reset, re-enter them, re-import retained source reports and requalify affected
  capabilities. Sign in again; reusing a session secret does not restore deleted
  sessions. Old-schema backups are preservation evidence, not a supported
  shortcut to restore incompatible tables into the current schema.

After readiness, verify the served bundle belongs to the built artifact, first
successful source jobs, complete inventory/counts, and necessary report
re-imports/settings. A subsequent slow or failed replacement must keep the
previous complete authorized publication readable on fresh reload/navigation.
Observe actual provider throttling, duration, memory pressure and idle return
during joint production testing. Stop affected operations and repair forward on
schema mismatch, false empty/partial publication, read outage caused only by
age, authorization leakage, action replay, OOM or sustained resource-limit
events; do not increase caps, relax fences or restore removed compatibility
behavior to mask a failure.

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
