# Operations runbook

## MCP-led adoption content lifecycle

Adoption recommendations, briefs, actions, learning-card authoring and follow-up
are driven by the connected AI agent through the typed MCP adoption operations.
There is no dedicated Adoption page or manual browser editor. The existing app
retains analytics, collection, MCP setup and safe employee-learning discovery.
The backend owns evidence, authorization and durable tenant content; the AI
consumer interprets evidence and saves only on explicit user intent.
Drafts need no inventory/report prerequisite. Expected-revision conflicts retain
the consumer's unsaved work; interrupted create retries must retain the original
timestamped UUID request and exact canonical payload. MCP content and employee
learning reads accept smaller bounded pages when the response limit is reached.
Employee browser continuations clear the prior projection before revalidating privacy.
Exact creator/Admin deletion requires `delete:<record UUID>` confirmation through
the existing authorized API/bearer policy, not a provider job.

Ordinary sign-out/session cleanup does not delete tenant business content.
For an actual principal privacy deletion, use the existing database operator CLI:
`node node_modules/tsx/dist/cli.mjs backend/scripts/database.ts erase-adoption-private <tenant-id> <actual-principal-id> <database-name>/<tenant-id>/<actual-principal-id>`.
It requires the existing `agentcontrol_admin` connection and current schema,
serializes exact tenant content, removes authored payloads/receipts/references,
clears assignment/progress in independently authored records and retains/increments
revocation authority. It does not remove independently authored cards/actions.
The principal's separate create-request cutoff preserves erased retry identities,
including accepted clock-skewed timestamps, across reset and restore. It does not
advance the bearer-issuance cutoff into the future or delay fresh authentication.
Use the exact saved `creatorId`/session `homeAccountId` authority key, not a guessed
email, display name or different local object identifier.
The existing explicitly confirmed database reset is the tenant/database-wide
content-erasure owner; never drop a volume or erase revocation authority instead.

Receipt retention uses the existing bounded lifecycle worker. Full capacity is a
concrete storage limitation, not a release, approval or feature-enable gate.
Current-schema backup/restore cannot resurrect content erased/corrected after
the snapshot. Current bounded receipts preserve deleted outcomes even for content
created/deleted after that snapshot. Independent unchanged content survives with
removed-reference markers. Existing principal epoch/cutoff revocations are merged
monotonically from the current database, including post-snapshot privacy deletions,
before preparation and again before reopening. After a clean reset, expect business-content and imported CSV loss;
automatic application reads repopulate provider evidence on normal authenticated
entry, while genuine CSV reimport remains explicit. A successful reset/deployment
does not prove recovery until a real caller completes sign-in and the applicable
sources publish.

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
2. Open **Sync**: expect applicable **Users** and **Graph packages** application
   reads to publish saved counts. Eligible staff separately collect delegated
   **Power Platform**; roleless entry does not acquire that authority. Provider
   denial remains explicit and does not block unrelated supported sources.
   **Continue to workspace** dismisses the notice without cancelling sync.
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

Office report collection preserves cancellation and authorization diagnostics,
including during download cleanup, without starting another download retry.

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
runs every 30 seconds during normal operation. A future-dated saved report is
automatically reconsidered when its UTC date arrives, provided both saved sources
are still fresh and valid; it needs no recollection or manual start.
For persistent failure, correlate
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

Before a schema-changing deployment replaces the operator tag, inspect and
preserve the installed operator's immutable image ID and attempt this backup
with `$context.OperatorImageId` set to that verified matching image. Use a
distinct dependency-base tag for rebuilding; do not use a tag the deployment
will overwrite. Record the actual checksum, receipt and backup outcome.
An installed-schema dump remains a protected recovery artifact; it is not
compatible with a different current runtime and does not justify an old-schema
serving path. Qualify current-schema restore separately in isolation.

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
Saved inventory and people cleared since the backup stay unavailable in the
restored database; source fences and inventory publication revisions still permit
normal authorized recollection.
Cleared inventory heads retain an advanced revision fence rather than restarting
publication at revision zero; already-empty heads keep their existing revision.
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
Repository source files and candidate artifacts must stay inside their trees without
symbolic links in either files or parent directories. Failed snapshot setup removes
its disposable build directory; it does not change application configuration or data.

| Failure | Safe action |
| --- | --- |
| Initialization failed, reset not uncertain | Repair and retry ordinary `start`; a completed reset is not repeated. |
| Reset outcome unknown | Keep maintenance; inspect the exact target before destructive retry. |
| Ownership, credential or schema mismatch | Recover exact project state/secrets or use current-schema recovery. Never bypass checks, edit receipts or delete volumes. |

Success returns to normal operation without another enable step. Verify served
revision, health/readiness, sign-in/out, authorized saved views, automatic sync
and affected controls; tests/health alone do not prove these journeys.

If the original operator output explicitly reports `database_reset_denied` in
phase `validation`, no DROP occurred. After inspecting the exact unchanged
database, load the pending candidate/preflight identities into `$context` and
call `Resolve-LocalDeniedReset $context $originalFailureJson`. It preserves the
original operation and denial in protected adjacent files, verifies retained
PostgreSQL/schema/configuration and drained maintenance, and permits a fresh
guarded preflight. It rejects unknown/drop/create outcomes; never fabricate the
failure JSON or edit receipts. Pool-derived operator connections explicitly
retain their nonenumerable protected password, rather than ambient credentials.

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
- The protected operator preserves actual per-principal revocation epochs and
  signed-token cutoffs in the PostgreSQL maintenance database before deletion.
  It locks the canonical principal owner through DROP; a missing owner in an
  initialized database, a failed security publication, or an observed loss of
  either the reset-lock or principal-lock connection before DROP prevents deletion.
  Maintenance connection errors retain the exact validation/drop/create failure
  phase rather than escaping as uncaught events. Reset targets
  must fit PostgreSQL's 63-byte identifier limit; truncated names are rejected.
  Fresh initialization transactionally restores that minimum authority to the
  current principal owner, including after an interrupted reset. It reads the
  saved revocations only after acquiring the target initialization transaction;
  retries against an already current schema need no maintenance-database read.
  Genuinely revoked bearer credentials remain denied. Reset does not invent a global
  issuance cutoff: an otherwise valid fresh Entra OAuth/OBO login works
  immediately even when Entra backdates `iat`/`nbf` by five minutes. Never clear
  actual revocation records or rewrite signed timestamps to recover access.
- Initialization is transactional. A failure during DDL leaves an empty target;
  ordinary initialization/resume retries it, verifies the exact current
  fingerprint and least-privilege grants, and does not reset again. Failure
  before a validated reset leaves existing application data unchanged.

After success, sign in: read-only sync starts automatically. Re-enter stored sharing
settings and [reimport CSVs](official-usage-import.md). Provider sync cannot rebuild
deleted report, Office, audit or job history.
Discovery search becomes useful as automatic inventory collection publishes;
workplace requires saved directory fields, and champions/popularity require a
genuine report import. Missing report evidence does not block sign-in or catalog
use. Preserve the separate encrypted MCP OAuth volume and keys: application
database reset neither rotates nor restores that external state.

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

Use **MCP settings** (`/mcp-settings`) for read-only, tenant-scoped runtime
visibility. A metadata outage never requires disabling ordinary MCP/web use or
automatic synchronization. Local normal startup creates/reuses only the new
`secrets/mcp-metadata` credential. An invalid/link/unreadable file produces a scoped
warning and is not mounted; restore that independent file or remove only that
file before normal startup to regenerate it. Never rotate the original three
OAuth secrets or clear OAuth/database state to repair visibility. Azure uses the
same prepared pinned metadata secret version on API/MCP; unresolved optional
references remain explicit settings failures. No credential appears in the page.

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

The MCP-only image suite no longer needs a Node baseline:
`pwsh ./scripts/large-tenant-tests.ps1 -Suite mcp-container`.
Its synthetic key generation and rotations use the same immutable locked
container Python as the journeys, not a host virtual environment.
For the real browser/API/Python metadata fixture, run
`-Suite cutover-browser-contract -BrowserFiles "mcpSettings.spec.ts,signIn.spec.ts,permissions.spec.ts"`
with explicit `-BaselineImage`/`-BaselineImageId` and
`-BrowserImage`/`-BrowserImageId` values for verified installed current images.
The runner checks immutable identities, matching architectures/manifests, Node
engine, Playwright package version and installed browser revisions. It reuses
the current fixture authentication/loopback/provider/resource-ownership guards;
the catalog case does not intercept settings requests. Evidence belongs to the
runner's project-owned artifact directory, not a host `/evidence` directory.

The existing `adoption-content` and `mcp-end-to-end` suites also execute the
complete selected department/SDK/browser-account journey and compact capacity
case. `mcp-agent-discovery-capacity` retains the original 100k-person/200k-agent/
1m-edge scenario and adds 10,000 frozen people in 500 exact company/department
groups with overlapping reports and ambiguous identities. Compact qualification
uses five warm-ups and twenty measured correct reads, retaining every HTTP/SQL
sample and separate MCP envelope bytes; nearest-rank p95 must be at most two
seconds. Exact 128-KiB UTF-8 acceptance and one-byte-over rejection are tested.
Settings browser failures retain their request timeline and Playwright trace;
the ordinary 20-second deadline is unchanged.
Complete tool schemas are materialized on expansion rather than eagerly
rendered while hidden; complete-schema search and exact accessible disclosure
remain available. This is a rendering optimization, not an access prerequisite.
Inventory and package capture return only the canonical selected-read fields
and their transaction-pinned publication revisions, never internal endpoint or
query-hash fields.
