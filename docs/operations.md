# Operations runbook

This runbook operates the single Express/React application and PostgreSQL database. Commands assume the repository root, PowerShell 7 at `pwsh`, Docker Desktop/Compose v2, and the retained local project `agent-control-phase01`. Run application, database, Node, npm, browser, scanner and load tooling only through Docker or the checked-in PowerShell orchestration.

## Identity, consent and roles

1. Import only the two `appRoles` from `infra/entra-app-manifest.json` into the approved single-tenant Entra application. Preserve its existing registration and grants.
2. Register exactly `http://localhost:3001/api/auth/callback` locally (substitute the saved wizard port if different) or the approved production origin plus `/api/auth/callback`.
3. Set Enterprise application **Assignment required?** to **Yes** and assign each approved user `AgentControl.Viewer` or `AgentControl.Admin`. One assignment is sufficient and recommended because Admin includes Viewer access; overlapping current direct/group assignments are accepted as the Admin superset. Unassigned and legacy-role-only users receive no protected data.
4. Start the retained application:

   ```powershell
   pwsh ./deploy-local.ps1 start -Project agent-control-phase01
   ```

   `start` is also the default when omitted and runs the full build/migrate/test/start deployment for both new and retained installations. If settings are incomplete, complete the terminal wizard for tenant ID, client ID, hidden client secret and port (default `3001`); configured starts reuse all saved values, including the port. See [deployment setup](deployment-setup.md) for configuration and unattended-run prerequisites.

5. Sign in. Sign-in requests outstanding consent for all implemented delegated capabilities, including package changes. Existing installations should sign in again after redeployment to request newly included scopes. See `docs/deployment-setup.md` for tenant-wide consent and separate provider-role requirements. For an assigned Viewer/Admin session, Permission Center loads the capability catalog and immediately runs one bounded session-scoped delegated check, including token-only checks for Admin writes; consent return follows the same flow. Evidence expiry schedules one visible-tab check, while hidden tabs wait for visibility/focus. Interactive consent, MFA or Conditional Access still requires user action. Consent-required Entra errors are distinguished from expired/revoked authorization; a generic `invalid_grant` is not proof of expiry. The top-level **Check status** action is optional failure recovery, not an onboarding prerequisite. Request consent is shown for detected missing permission, not merely an untried operation. Never repair missing consent by editing capability evidence.
6. After an app-role change or removal, require a fresh login and use the approved restart/session-invalidation cutoff. Verify removed, unassigned, and legacy-only claims are denied; never rely on auto-promotion.

Client-supplied identity headers never authenticate. A process restart loses the MSAL cache and requires provider token reacquisition; this is expected and does not authorize replay.

## Local configuration changes

The public interface is only positional `start`, `stop`, or `edit-config`, plus `-Project` (default `agent-control`). State is fixed at repository-root `.local/<lowercase-project>/`; neither port nor state location is a public command-line option.

```powershell
pwsh ./deploy-local.ps1 edit-config -Project agent-control-phase01
```

All four settings are prompted; Enter preserves each current value and the current secret is never displayed. Unchanged settings are not rewritten and do not stop a running app. Accepted client ID, client-secret or port changes safely stop the app and leave it stopped. Register the exact new Entra callback if the port changed, then run `start` explicitly. The wizard validates input, not live credentials, permissions or consent.

The tenant ID is editable before a database volume exists, and a previously missing tenant ID can be filled in. Changing a nonempty saved tenant ID on an existing volume is rejected before stopping the app or writing settings. Edits do not migrate data between tenants; use a separate project for another tenant.

Changing the saved client/application ID on an existing volume stops the app and records `.local/<lowercase-project>/control/reauthenticate`. On the next `start`, the deployment helper executes `DELETE FROM public.sessions` before reopening the app, clearing only persisted login sessions and requiring sign-in under the new app registration. The session-signing secret and all business data remain untouched. Secret-only and port-only edits do not schedule a session purge. Do not remove the pending marker to bypass this reauthentication step.

## Operator-only local helpers

Advanced maintenance is not part of the `deploy-local.ps1` argument surface. In a PowerShell 7 session at the repository root, load the existing internal functions and select the retained project:

```powershell
. ./scripts/local-deployment.ps1
$context = New-LocalContext -Root $PWD.Path -Project agent-control-phase01
```

The helper reads this project's saved configuration, including its port, from the fixed `.local/agent-control-phase01/` directory. Run this setup in each new PowerShell session before the helper calls below, and recreate `$context` after a configuration edit. These are operator-only function calls, not a new maintenance executable. Their backup/restore, cleanup and reset switches belong to `Invoke-LocalDeployment`, never to `deploy-local.ps1`.

To rebuild the operator image and run the aggregate test gate against an initialized installation:

```powershell
Invoke-LocalDeployment $context 'Test'
```

## Status, safe diagnosis and provider incidents

Public probes disclose only status:

```powershell
Invoke-RestMethod http://localhost:3001/api/health
Invoke-RestMethod http://localhost:3001/api/ready
```

An authenticated Admin may call `GET /api/diagnostics`; it returns only auth-configured, maintenance/provider-work flags, schema version and fixed pool/body/export limits. The provider-work flag reports effective availability, not just the persisted enable bit: it is false during maintenance or while provider work awaits requalification. Do not add record counts, hosts, connection strings or provider bodies.

- **Provider outage/throttling:** liveness/readiness stay healthy. The affected capability records a bounded category/correlation and remains unavailable. Preserve the last complete cache. Retry only idempotent reads within their page/request/deadline limits; never automatically replay mutations.
- **Automatic permission-check transport failure:** earlier decisions and saved-data permissions remain unchanged. The UI reports **Automatic permission check failed. Existing decisions and saved-data permissions are unchanged. Use Check status to retry.** An expiry or transport failure receives exactly one delayed automatic retry after 30 seconds; if that fails, further automatic retries are suppressed for the evidence signature. Do not repeatedly focus or reload the page.
- **Catalog check timeout:** this is not evidence of a missing permission, role, or license. The UI shows **Check timed out** and identifies token acquisition versus provider read when stage evidence is available. Token acquisition is bounded to ten seconds; the first catalog page has a separate thirty-second budget, including bounded response consumption. **Check status** explicitly retries failed delegated checks instead of reusing a fresh failure for five minutes; successful evidence and provider-throttling cooldowns are retained. Persistent timeouts require testing Microsoft connectivity and provider latency from the approved deployment location, not bypassing geographic or Conditional Access policy.
- **Slow package reads after readiness succeeds:** inventory pages and package detail reads use the same thirty-second per-request limit as the readiness check, so a provider response taking more than ten seconds is not accepted by readiness and then rejected by the actual read path. Overall inventory-job deadlines remain enforced. Package writes retain their ten-second timeout and never retry automatically.
- **Failed Graph identity collection / duplicate-looking agents:** keep the saved data and retry the normal refresh from Sync; clearing data cannot repair a provider failure. Inspect `package_provider_read_retry`, `package_provider_read_failed`, `package_refresh_execution_failed` and `package_refresh_failed` events, correlated by job ID. Events identify catalog/detail/publication stage, HTTP status, bounded provider code and provider request ID where available, but never raw provider messages or package definitions. Sync stores HTTP errors as `graph_http_<status>` rather than discarding mixed-case Graph error codes. Reads retry transient 500/502/503/504 responses, network/body interruptions and individual timeouts at most three times. Permanent failures preserve the previous complete snapshot; cancellation and the overall deadline remain authoritative. An old generic `provider_error` without these events cannot retrospectively establish the original Graph status.
- **Graph 424 / UnknownError throttling:** Graph can wrap a "too many requests" response in HTTP 424. `outcome: throttled` distinguishes this from other dependency failures. Inventory reads are paced at least 250 milliseconds apart across jobs; throttling pauses other queued reads, not just the failed request. Without `Retry-After`, cooldowns are 30, 60, then 120 seconds, with at most six attempts. Valid `Retry-After` values up to five minutes are honored in full, including on 503; a longer requested cooldown fails rather than retrying early. Sync displays the wait and identities already checked. Do not repeatedly click retry or clear the inventory during a cooldown. The complete collection still has its 15-minute deadline, and writes never retry.
- **Ready to try:** token-only quarantine-status, Purview and Defender readiness does not prove target-operation access. Package access/block and quarantine management use `on_demand` authorization and show the same **Ready to try** status, with **Microsoft validates permission on the actual operation** metadata—not a token-success or live-write claim. Both kinds count as ready to try, never provider-verified. Open the applicable view and explicitly select the intended bounded operation. Implemented writes validate current Admin/provider authority and confirmation when submitted, without prior canaries. Optional reversible canaries are described in [mutation-canaries.md](mutation-canaries.md); neither consent nor Check status executes them.
- **Authorization actions:** delegated `missing_permission` with the current internal role renders **Request consent**. `interaction_required` remains unknown and renders **Continue sign-in / consent** because the required Microsoft interaction may include consent, MFA, or Conditional Access. `authorization_expired` remains unknown and renders **Sign in again** without implying missing permission or a new consent requirement. Every action is explicit and capability-scoped; none redirects automatically.
- **No data:** distinguish a complete zero-row observation from missing permission, partial coverage, limit failure or stale cache. Do not turn a provider error into a successful empty snapshot.
- **Explicit clean full resync:** `POST /api/data-sync/runs` with `{"mode":"full","clearSavedData":true}` clears only the requesting tenant/principal's saved directory/app-activity, Graph package (broad and exact), and Power Platform snapshots/resources, source state, and core success markers. Omit `sources`; selected-source cleanup and non-boolean flags are rejected. Without the flag, full sync remains nondestructive. Migration 31 performs cleanup atomically with admission through a restricted insert trigger, without granting runtime table deletion. Deduplicated, conflicting, rate-limited, or rolled-back runs do not clear data. Finish or cancel unfinished package/inventory refresh jobs if admission returns `data_sync_source_active`; publication locks and user-attempt fences prevent old work from restoring cleared data. Accepted official usage history and its marker, audit, jobs/control outcomes, configuration, shared identity mappings, and other accounts/tenants are preserved. A failed, interrupted, or cancelled replacement leaves those sources missing until explicitly retried successfully; it does not restore the old snapshots or report a successful zero-row sync.
- **Power Platform inventory timeout:** `provider_timeout` is a failed read, not missing authorization. The inventory client permits 120 seconds for complete enumeration, and the enclosing job permits 150 seconds for enumeration, revalidation and publication. In-flight progress recording is awaited before returning, but cancellation or an expired enumeration deadline prevents success even after the final page; progress writes are not abandoned during shutdown. Individual pages remain capped at 100 rows, ten seconds including the body, and the existing response-byte limit; full scans remain limited to 50 pages/5,000 rows. A tenant with thousands of resources can legitimately take more than 30 seconds. Use the logged failing page, elapsed duration and progress to distinguish the total deadline from a slow page; retry a failed refresh explicitly or narrow its scope. No partial snapshot is published.
- **Catalog verified but Agents empty:** the Permissions check validates only the first catalog page; it does not persist inventory. While Agents is open, a successful saved-data response with `snapshot: null` and no discovered refresh jobs or prior attempt/success metadata allows one initial delegated read-only refresh per account/UI session; saved data can load afterwards. Existing or failed work is not restarted automatically. Progress, terminal error and saved observation are separate from readiness. Use **Refresh agents** to retry deliberately; a failed or interrupted attempt must not become an empty successful snapshot.
- **Preparing access changes:** opening the access editor refreshes the exact package read-only and fetches current detail; bulk preparation refreshes each selected target before confirmation. Loading these details changes no provider settings and does not replace confirmation, immediate dispatch-time prestate checks or post-write readback.
- **Duplicate-looking agents after successful sync:** source collection and canonical identity reconciliation are separate checks. Apply migration 32 and the matching runtime together. Reconciliation serializes against both publishers and records one scoped membership per exact source target before paging. Declarative packages need matching package manifest, resource native ID, and GUID schema name; they do not need Studio `AgentMetadatas`. Studio native proofs are not rejected merely because Graph and Power Platform report different source-specific agent identity IDs. A unique native proof can associate another custom-engine package with the same corroborated bot application identity. Different native/environment claims and same-name template copies remain distinct; never repair counts with display-name deduplication or bot-ID substitution.
- **Canonical links across refresh and retention:** publication hands existing memberships to the selected replacement source observations within the publication transaction, using exact package IDs or normalized native environment/ID keys. It clears old matching evidence without extending snapshot expiry or granting control proof. Retention can then remove superseded payloads without discarding unchanged canonical UUIDs before the next Agents read. Truly removed targets and explicitly cleared account inventories do not retain phantom memberships.
- **Corrupt saved matching details:** older package projection sliced every element definition at 32,768 characters. `agent_identity_unresolved` with `reason: invalid_json` can therefore describe an already-corrupted saved definition, not a Microsoft failure. The updated collector parses complete native metadata and retains whole definitions within the byte budget, including configuration used by Connected services; malformed or oversized responses fail explicitly. Refresh affected package details, refresh agents, or run a confirmed clean resync to replace the old observations. **Sync > View diagnostics** shows invalid matching details separately from checked identities. Migration 32 also removes that account's canonical registry during confirmed clean resync; it does not delete accepted reports, audit, jobs, or other accounts' inventory.
- **Unified Agents export:** `POST /api/agent-inventory/export.csv` requires Viewer, CSRF and the `revision` from the saved Agents response. Supply unified `query` filters without pagination to export all filtered pages, or `recordIds` with only sorting to export an exact canonical/source-qualified selection. Aliases collapse into one row retaining all packages. CSV rows are projected incrementally under the 5,000-row, 8 MB and 15-second limits; exceeding a limit rejects the export rather than returning truncated success. Snapshot publication (including exact package and environment-only observations), expiry, cleanup, changed audit-reference selection, or revoked session/role stops publication. Refresh Agents before retrying a `409`; never substitute a new revision for a stale selection automatically. The CSV carries `inventoryPartial`, native observed state and package provenance, not raw definitions or principal collections. Its audit action is `export-agent-inventory`; the Power Platform explorer retains its separate technical resource export.
- **Package identity refresh lifecycle:** full agent sync collects exact package identities automatically (four concurrent reads; 15-minute execution bound). Progress and failures are retained in Sync/Jobs, and publication is all-or-nothing. Existing saved summaries are backfilled once per snapshot when Agents is opened with current delegated read authorization; an already-running broad refresh is followed, and failed/cancelled attempts require an explicit Sync retry. The operation survives tab navigation but never changes agent settings. A process restart requires real sign-in to reacquire delegated tokens. A freshly read alias package never extends expired native-control proof from another package.
- **On-demand provider writes:** no extra mode/configuration or prior qualification is required in local or Azure deployments. Sign-in, Admin role, provider permissions, same-origin/CSRF, exact targets, confirmation, immediate prestate checks, audit, one-shot dispatch and readback remain enforced. Package access lacks conditional concurrency protection and can overwrite a concurrent external change after the final pre-read. No write runs automatically. Owner reassignment has no implemented product workflow or documented owner readback.
- **Schema drift:** an unknown provider shape fails that operation and retains the previous snapshot. An unknown PostgreSQL migration makes readiness `503`; enter maintenance and fix forward.
- **Job age/failure:** inspect the source-specific job route from the workbench. Logs contain only structured request/job/provider IDs, status, durations, ages, attempts and counts.
- **Uncertain write:** leave the sent item `inconclusive`. With current Admin and provider-read authority, use its existing GET-only reconciliation route. Mark observed-applied, observed-not-applied or conflict; never resend automatically or invert a partial batch automatically.

### Troubleshooting a remote frontend through local container logs

For a frontend reached through a dev tunnel, the approved remote browser performs sign-in and user actions; the local `app` container is the troubleshooting surface. If geographic or Conditional Access policy prevents local sign-in, **do not open a local browser, use another identity, or bypass the restriction**. Have the operator use their authorized production browser and report when they clicked the action. A container restart can require fresh sign-in from that approved location.

For the retained `seha` project:

```bash
docker logs --since 10m --timestamps -f seha-app-1
```

For a focused history, without any frontend console access:

```bash
docker logs --since 10m seha-app-1 2>&1 \
  | grep -E '"event":"inventory_|"provider":"power_platform"|"route":"/inventory/|"event":"request_rejected"|"event":"request_error"'
```

Each structured entry has a UTC `timestamp`, severity `level`, and `event`. HTTP logs include the server-generated `requestId`, the **code-owned route template** (never the raw URL/query or native path parameter), method in `mode`, status and safe `errorCode` when rejected. Non-GET actions log `http_request_started` before route authorization. `http_request_aborted` means the HTTP response did not finish; it does not mean an accepted background job was cancelled.

Data-sync worker failures (`data_sync_worker_failed`, `data_sync_worker_status_failed`) retain the bounded `runId` shown in **Sync history > View details**, together with sanitized error classifications. Database-pool and session-store errors use the same timestamped error envelope without connection or exception details.

Power Platform inventory adds:

| Event | Meaning |
| --- | --- |
| `inventory_refresh_submitted`, `inventory_refresh_started` | Durable job creation/reuse and successful authorization/dispatch. Includes `jobId`; background events retain the initiating `requestId`. |
| `inventory_refresh_start_failed` | Start failed at `load_job`, `revalidate_user`, `authorization`, `delegated_token`, `mark_running`, or `dispatch`. |
| `inventory_provider_request`, `inventory_provider_response`, `inventory_provider_retry`, `inventory_provider_failure` | Page and attempt number, HTTP status, duration, continuation **presence only**, retry delay/reason, and valid GUID provider correlation headers. Transport and response-body failures are distinguished. |
| `inventory_page_validated`, `inventory_refresh_progress` | Validated page metadata versus successfully recorded progress. Includes counts, total, omissions and the number of catalog rows using query-derived tenant scope. Omission warnings are aggregated per page, not per resource. |
| `inventory_query_failed` | Exact failing page, completed-page/row counts, stage, safe error category and schema diagnostics. Identity failures identify `field`, allowlisted `resourceType`, `resourceIndex` (1-based within the page), `length`, and `maximumLength`. Duplicate diagnostics include `firstSeenPage`, never the identity itself. |
| `inventory_query_completed` | Provider enumeration completed; snapshot publication has not necessarily succeeded. |
| `inventory_refresh_execution_failed`, `inventory_refresh_failed`, `inventory_refresh_waiting_authorization`, `inventory_refresh_succeeded` | Execution failure and its stage, followed by the recorded durable outcome. Only `inventory_refresh_succeeded` confirms snapshot publication; it includes `queriedTypeCount`, the number of resource types queried for that snapshot (not their names). |
| `inventory_refresh_status_failed` | A background refresh could not persist or confirm its failure, authorization-wait, or cancellation outcome. Includes `jobId` and sanitized error classification; the durable job may still show running. An in-flight shutdown drain also reports the persistence failure. |

`package_refresh_status_failed` means a background package refresh could not record or confirm its failure, authorization-wait, or cancellation outcome. It includes `jobId` and sanitized error classification, not raw exception details. The durable status may still show running; this is not a successful refresh. An in-flight shutdown drain also reports the persistence failure.

`source: capability_check` identifies the bounded Permissions probe, not an inventory refresh. HTTP `200` from a check or saved-data read and HTTP `202` accepting a refresh do **not** prove inventory success. If **Refresh selected scope** fails, trace its `requestId`, then its `jobId`; a `401`/`403` rejection before job creation explains why no new refresh appears. If no new matching request arrives, the displayed saved failure is not evidence of a new provider attempt.

Older builds can log `inventory_query_completed` with matching observed/total counts, followed by `incomplete_inventory_coverage` at `publication` with **Unknown role scope omitted previously retained resources**. That cross-snapshot guard incorrectly required the visible inventory to grow monotonically. Deploy the corrected build and use **Retry incomplete** for Power Platform; do not clear saved data or elevate roles to bypass the failure. Complete, validated enumeration may replace changed identities; absence does not prove provider deletion. Actual incomplete enumeration still fails and preserves the prior snapshot.

Schema 33 records actual `queried_types` instead of persisting coverage inferred from optional role claims. `inventory_refresh_succeeded` includes the executed type count and whether the query was environment-filtered. Saved reads verify actual row counts, normalized unique identities, provider totals, page count, and captured scope. A damaged snapshot produces `inventory_verification_failed`; it is not returned as complete or silently empty. Graph unified reads also check broad/exact counts, including distinguishing a legitimate zero-row exact observation from a missing saved row.

Saved inventory is checked automatically; administrators do not approve it after sync. For troubleshooting, open **Sync > Inventory health > View diagnostics** to inspect the receipt or use **Verify saved inventory** to recheck the complete saved source set and reconciliation without provider calls. Opening the diagnostic dialog starts no sync or verification action. Agents retains only a concise attention notice rather than the diagnostic panel, and Sync keeps a health summary visible while diagnostics are closed. The unified API and CSV expose the check time, scope, source/unique/logical counts and identity checks. Scope limitations and matching problems remain explicit. Missing optional `wids` alone is not a partial-completion condition and does not require an app-registration change or broader role. Verification time does not advance source freshness or prove access beyond the recorded authenticated query.

Data sync separates **Last saved count** in Workspace data from current-attempt counts in the progress/detail panel. Workspace counts and **Last successful sync** come from persisted successful Data sync publications, not the latest limited/failed attempt or an older standalone inventory refresh. These timestamps are not a live-provider freshness guarantee. Running counts are actual observations, not provider target totals; Graph can reset its counter between list collection and identity checks, with the phase in its message. Users counts distinct **directory users checked** from products that can include paid Copilot features. This includes candidates whose Copilot is inactive/unverified; it is not a paid-license count, tenant headcount, basic Chat count or a sum across overlapping product queries. The successful refresh message reports verified active M365 Copilot licensed users separately. Failed/partial attempt counts remain labelled as reported, not saved totals. No total-object percentage or ETA is inferred.

A Users sync completing around 4,000 in a 30,000-account tenant is not itself evidence of truncation: Graph applies the Copilot-capable product filter across the directory and returns bulk license/feature evidence. Every matching continuation page must reconcile with its filtered `@odata.count`. A bundle assignment, including E7 with Copilot disabled, is only a discovery candidate: licensed labels, the default roster and paid-adoption metrics require verified active paid features. Inactive/unverified candidates remain under **All checked users**. This classification correction reads existing service-format snapshots and requires no destructive reset or extra Graph calls. Directory paging supports 1,000 pages of up to 100 requested users, retaining the 100,000-observed-row and 16 MiB response bounds; the catalog remains at 200 pages/1,000 rows. See [license scope and count diagnostics](copilot-license-usage.md#investigating-an-unexpectedly-small-count). Paid features **Not enabled** never means basic Copilot Chat is disabled.

**Sync history** shows recent retained runs in a table; its scope and duration refer to the original run, including waits/retries. Open **View details** for exact source messages and run/child-job IDs. **Source jobs** preserves standalone and underlying provider jobs; it is not another count of full syncs. Report snapshots are in **Report history**, while upload drafts and legacy-browser cleanup are in **Manage reports**. New default syncs collect only automatic sources. A retained older run waiting for CSVs still needs its import completed or the waiting run cancelled before another sync can start.

Apply all pending migrations through **37** with the migration operator and verify readiness with the restricted runtime role before deploying this sync workflow. Migration 36 changes only the clean-full admission constraint: all three automatic source IDs are required, and retained legacy runs may additionally contain `usage_reports`. Migration 37 deletes cached directory/license and Copilot app-activity snapshots, their source state, and Users success markers across this app database once. Run Users sync after deployment; inventory, imported reports, sessions, agent-people caches and Microsoft user/license assignments are untouched. Current-format snapshots are required afterward; there is no old-data conversion. This adds no runtime DELETE access, changes no old run intent, and does not apply migrations from the in-app reset action.

To isolate an exact attempt, copy its server-generated ID from the structured logs:

```bash
docker logs --since 15m seha-app-1 2>&1 | grep -F '"requestId":"REQUEST_UUID"'
docker logs --since 15m seha-app-1 2>&1 | grep -F '"jobId":"JOB_UUID"'
```

Logs intentionally exclude tokens, cookies, authorization headers, native resource/tenant/environment IDs, names, continuation values, request/response bodies, raw exception messages/stacks and arbitrary provider header values. Do not enable raw payload logging to diagnose an identity error. Counts, types, lengths, stages and correlation are sufficient to distinguish malformed data, unsupported identity bounds, scope failures, pagination overlap, throttling, timeouts and publication failures. Existing authorization, pagination limits, snapshot publication rules and log retention remain unchanged.

## Retention

After the [operator helper setup](#operator-only-local-helpers), preview one bounded batch:

```powershell
Invoke-LocalDeployment $context 'Retain' -ConfirmCleanup 'agent-control-phase01/agentcontrol' -CleanupBatchSize 1000 -DryRun
```

Apply one batch only after reviewing the per-class counts:

```powershell
Invoke-LocalDeployment $context 'Retain' -ConfirmCleanup 'agent-control-phase01/agentcontrol' -CleanupBatchSize 1000
```

The exact case-sensitive confirmation is `<lowercase-project>/agentcontrol`, including for preview. Repeat explicitly until all affected counts are zero, at least daily while the POC is active. Valid batch size is 1–5,000. One PostgreSQL advisory lock prevents competing cleanup; lock/statement timeouts are 5/15 seconds. A failure rolls back that batch and reports no content. Retention makes no provider calls. There is no browser cleanup endpoint.

| Data class | Default / expiry | Single cleanup owner |
| --- | --- | --- |
| Server sessions | Cookie/session 8 hours | operator `Retain` |
| Capability evidence | authorization 5 minutes | operator `Retain` |
| Package and Power Platform jobs | 7 days; snapshots 30 days | operator `Retain` |
| Coordinated sync runs and saved user/license/app-activity snapshots | 30 days; successful-source markers survive expiry so zero-row success is not mistaken for first use | operator `Retain` |
| Purview and Defender jobs/results | 30 days; qualification/retained scope bounds are schema-defined | operator `Retain` |
| Quarantine jobs | 7 days; observation/audit 30 days | operator `Retain` |
| Official upload staging | 30 minutes; per-tenant pre-admission purge prevents stale quota use | operator `Retain` |
| Accepted official report content | Until explicit confirmed Admin deletion; shared observations survive while another retained set references them | operator `Retain` removes deleted/orphaned content, not aged live history |
| Administrative and minimal import audit | 90 days | operator `Retain` |
| Request export buffers/uploads | request lifetime; never archived | request owner |
| Managed production logs | 30-day initial target | Azure monitoring setting in the approved target |
| Local container logs | `json-file`, 10 MiB maximum per file, three files per `app` and `postgres` service | Docker Compose service configuration |
| Local logical backups | 7 days | PowerShell backup-retention helper after applied `Retain` |

Dependent rows, report selection and source projections are invalidated before parent removal. Administrative audit is ordinary append-only data, not cryptographic evidence against `agentcontrol_admin`.

## Backup and isolated restore

After the [operator helper setup](#operator-only-local-helpers), create a restricted native dump and versioned checksum/fingerprint receipt:

```powershell
Invoke-LocalDeployment $context 'Backup' -BackupFile "$PWD/.local/agent-control-phase01/backups/operator-verified.dump"
```

Omit `-BackupFile` to create a timestamped dump/receipt pair in the protected project backup directory. Explicit destinations must have an existing restricted parent directory; files are never overwritten. Inventory the receipt before cleanup. A current verified backup does not resolve missing historical backup evidence. Backups contain sensitive retained data, provide no automatic cross-backup privacy suppression and must remain access-restricted.

Restore only to a new isolated database:

```powershell
Invoke-LocalDeployment $context 'Restore' -BackupFile "$PWD/.local/agent-control-phase01/backups/operator-verified.dump" -RestoreDatabase agentcontrol_restore_operator_review
```

Restore verifies the dump checksum, receipt table fingerprints and known migration prefix, migrates forward, invalidates sessions/provider qualifications and official staging/previews/confirmations, fences leases/owners and source-sync coordinators, and marks sent work inconclusive. It repeats bounded retention until a zero-change pass, then compares exact current cache ownership and authority bindings with the live database, including private saved user/license/app-activity snapshots, current official set/version deletion and selection, and exact Defender retained-scope revocation. Mismatches are purged rather than exposed; missing user snapshots require explicit resync. It leaves `operational_state.mode=maintenance` and provider work disabled. The restored database is not wired to the retained app by this command.

After an operator reviews current deletions, role/scope changes, report selection, audit/job integrity and retained data scope, reopen the database:

```powershell
Invoke-LocalDeployment $context 'Reopen' -RestoreDatabase agentcontrol_restore_operator_review
```

Reopen repeats retention to zero and repeats the current-state comparison from one read-only current-database snapshot while holding the restored operational-state row in a transaction. It refuses unavailable or over-bound current review, remaining sessions, Purview/Defender execution ownership, provider qualifications or mutation authority, and keeps provider work disabled. Any official or provider cache whose exact current owner/deletion/access binding cannot be proved is purged. Any future switch of the production app to this database is a separately approved maintenance action followed by restart, core smoke and fresh provider requalification. Never use restored authority to replay an uncertain write. Azure point-in-time restore is Phase 12 work and must use the same reopening checks.

Measure local recovery with elapsed time around `Backup`, `Restore`, review and `Reopen`. For a version-3 receipt, RPO is the difference between `snapshotAt` and the failure/recovery point; `createdAt` is only dump/receipt completion. Version-1/2 receipts have only the legacy completion timestamp and cannot claim a more precise snapshot age. RTO ends only after reviewed reopen and core smoke. These observations are not HA, Azure throughput or Azure PITR guarantees.

## Maintenance, migration and compatible fix-forward

Stop admissions and both retained containers cleanly:

```powershell
pwsh ./deploy-local.ps1 stop -Project agent-control-phase01
```

Apply the current worktree and start with the same volume, network, secrets and saved port:

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control-phase01
```

Public `start` maps to the existing internal `Deploy` workflow: it builds operator/runtime images, stops the app, starts PostgreSQL, applies checksum-verified forward migrations, runs the aggregate Docker gate, then starts the app and verifies readiness. It is not an existing-image-only shortcut. On migration failure, leave maintenance in place, preserve the database/backup, repair the forward migration or add a new migration, and rerun `start`. Do not edit an applied migration or start an older artifact against an incompatible schema.

Run lifecycle checks sequentially, never concurrently:

```powershell
pwsh ./scripts/restart-runtime.tests.ps1 -Project agent-control-phase01
pwsh ./scripts/persistence.tests.ps1 -Project agent-control-phase01
```

## Local secret or volume recovery

Local secrets are restricted files under `.local/agent-control-phase01/secrets`; the PostgreSQL volume is `agent-control-phase01_data`. If an existing-volume DB/session secret is missing/corrupt, stop. Restore the original state directory from approved secure storage; do not regenerate a password or reset the volume. Then rerun `start` and verify health/readiness. A missing client secret is handled by the secure configuration wizard, not by replacing database/session secrets.

An intentional destructive reset requires a verified backup outside the project state directory, the [operator helper setup](#operator-only-local-helpers), and the exact case-sensitive `<project>/<project>_data` confirmation:

```powershell
Invoke-LocalDeployment $context 'Reset' -ConfirmReset 'agent-control-phase01/agent-control-phase01_data'
```

Reset destroys that project's containers, volume and local state, including secrets and backups. It is not a credential recovery mechanism or a public deployment command.

## Credential expiry and separately approved replacement

Follow the six-name/five-runtime-consumer contract in `docs/deployment-setup.md`. Before expiry, obtain separate administrator approval and a maintenance window. Add new secret versions directly in the prepared vault, preview references/role assignments, stop admissions and drain/reconcile jobs, back up, update native versioned references, use the administrator password only for short-lived bootstrap/migration input, remove that input, restart and verify least privilege. A session-secret replacement invalidates all sessions. A database-password replacement must coordinate the fixed `agentcontrol_admin` and `agentcontrol_app` PostgreSQL roles with their prepared vault versions; no managed-identity/password fallback exists. The Azure deployment wizard never writes or silently rotates a vault value.

## Release, scanners and load

The repeatable preproduction checks are:

```bash
docker build --target security-scan -t agent-control-phase11-security:local .
docker run --rm agent-control-phase11-security:local
docker build --target production-dependencies -t agent-control-phase11-dependencies:local .
docker run --rm --entrypoint npm agent-control-phase11-dependencies:local audit --omit=dev --audit-level=high
docker exec agent-control-phase01-postgres-1 createdb -U agentcontrol_admin agentcontrol_test_phase11_load
docker run --rm --network agent-control-phase01_default --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets,target=/run/secrets,readonly" -e PGHOST=postgres -e PGUSER=agentcontrol_admin -e PGDATABASE=agentcontrol_test_phase11_load -e PGPASSWORD_FILE=/run/secrets/postgres-admin -e APP_PGPASSWORD_FILE=/run/secrets/postgres-app agent-control-phase01-operator:local backend/scripts/cache-load.ts
docker exec agent-control-phase01-postgres-1 dropdb -U agentcontrol_admin --force agentcontrol_test_phase11_load
docker build --target runtime-inspection -t agent-control-phase11-runtime-inspection:local .
docker run --rm --user "$(id -u):$(id -g)" --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets,target=/run/secrets,readonly" -e SECRET_SCAN_FILES=/run/secrets/postgres-admin:/run/secrets/postgres-app:/run/secrets/session:/run/secrets/client-secret agent-control-phase11-runtime-inspection:local
docker build --platform linux/amd64 --target export --build-arg RELEASE_REVISION=approved-revision -o type=local,dest=artifacts/release .
```

The load script creates/removes its own child database and makes no provider request; always run the final `dropdb`, including after a failure. Inspect the produced ZIP through `package-smoke.ts` against the retained app and run `zip-runtime-smoke.mjs` inside the Linux x64 package image. The ZIP contains `release-manifest.json`; its sidecar contains the archive SHA-256.
The manifest contains only its format version, revision, Linux/x64 platform and Node 24 runtime metadata. It contains no per-file checksum map; the adjacent `.sha256` sidecar verifies archive integrity, not publisher authenticity.

`infra/production-target.example.json` evaluates one B1 App Service instance and PostgreSQL Flexible Server Burstable B1ms/32 GiB/seven-day backup target. CPU credits and local measurements do not prove Azure capacity. Any larger tier requires a new current price estimate, cost preview and approval; never upgrade automatically.

Microsoft's [compute guidance](https://learn.microsoft.com/azure/postgresql/compute-storage/concepts-compute), rechecked 2026-09-10, lists B1ms as 1 vCore and 2 GiB. It explicitly does not recommend Burstable for production, excludes 24/7 support and warns that exhausted credits can cause severe degradation, timeouts or an unreachable server. Phase 12 must obtain explicit acceptance of this limited POC target and monitor CPU Credits Remaining; avoid restart/scaling while credits are near zero. Repeated depletion requires a separately cost-approved capacity decision, not an automatic tier upgrade.

The application operator owns the cache-load thresholds: 120 concurrent paged reads with zero errors and p95 below 2 seconds, database pool at or below four with zero waiters at completion, process RSS growth below 256 MiB, isolated database growth below 128 MiB, accepted queue depth five with the sixth rejected, and oldest newly accepted job below 30 seconds. In production, one observed pool waiter, a finite-deadline worker stop, uncertain dispatched write or cleanup failure is a safety incident; it alerts for review rather than triggering replay. Phase 12's Azure operator owns the five-minute readiness/5xx/two-second latency checks, CPU-credit below 20, storage above 80%, 32-GiB backup-storage cost review, exact release-backup restore-point probe, 0.1-GiB/day ingestion cap, 30-day log retention and approved budget notifications. Backup-storage usage is not backup-health proof. Crossing a local threshold blocks release for investigation; crossing an Azure threshold triggers review/cost preview, never an automatic tier change.

## Azure charges and teardown

Only `pwsh ./deploy-azure.ps1` may release to Azure after an explicit Azure authorization and exact approved target. The legacy script is removed; no old-name wrapper exists. Example target JSON and deterministic mock receipts are never approval or live evidence. Follow [the Azure runbook](azure-production-deployment.md).

Stopping an app does not guarantee charges stop: the App Service Plan, PostgreSQL server/storage/backups, monitoring ingestion/retention, Key Vault operations and networking can continue billing. Before teardown, make and verify any required backup, record retention/deletion decisions, remove resources only under explicit approval, and understand that retained backups or logs may continue charging. Use current Microsoft guidance and the approved estimate:

- [App Service plan management](https://learn.microsoft.com/azure/app-service/app-service-plan-manage)
- [PostgreSQL Flexible Server backup and restore](https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-backup-restore)
- [Cost Management budgets](https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-create-budgets)
- [Key Vault pricing](https://azure.microsoft.com/pricing/details/key-vault/)
