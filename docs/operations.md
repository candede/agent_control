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

- **Operational-state recovery:** the persisted singleton is deployment-wide, not tenant-specific. Startup and periodic recovery refresh the provider-admission snapshot and recheck process/persisted maintenance between recovery slices, including each bounded restart batch. Failed startup reads prevent HTTP startup; failed periodic reads close provider admissions, log only sanitized failure classifications and leave later recovery for another pass. A successful explicit load restores the gate; diagnostic and saved-data runtime reads never reopen it. Superseded loads and modifications to returned snapshots cannot replace a newer admission fence. Provider requalification alone does not block local interrupted-job recovery or saved-data exports.
- **Saved-data export maintenance:** the durable CSV dispatcher pauses for process/marker maintenance and persisted database maintenance, including a closure during queue/status reads and between retention/history cleanup slices. An unavailable operational-state read closes dispatch and logs a sanitized failure without failing queued exports. Unstarted exports remain queued and are reconsidered after maintenance clears, subject to their existing selection and expiry fences. Shutdown aborts active builds immediately while joining any already-started cleanup slice; it does not admit further slices. Provider requalification alone does not block local saved-data exports. Status, cancellation and already-ready downloads retain their existing saved-read authorization.
- **Inventory publication maintenance:** canonical reconciliation rechecks persisted maintenance between principals and publication slices. Its default runtime also fences process/marker maintenance around authorization and before control, canonical, and retention commits; a closure rolls back the current transaction rather than advancing its publication or collection cursor. Removing the marker permits later background passes, but a draining process never reopens. This does not change saved-read authorization or replay provider mutations.
- **Closed provider admissions:** automatic/manual provider sync (including full-sync saved-data cleanup) and saved Package, Power Platform, and Audit Search job resumes honor the same operational gate. Workers recheck it after asynchronous authorization/activation and before publication; Audit Search also checks around each durable provider-request accounting step, including reconciliation and record pages. A closure pauses resumable jobs rather than recording a provider permission failure. Saved reads and explicit cancellation remain available. Upload-only sync still uses the ordinary maintenance gate and does not require provider requalification. The workbench distinguishes maintenance from missing permissions: retry after maintenance ends, or contact the deployment administrator for restored-provider access review and requalification; neither response clears saved inventory or starts an automatic mutation retry.
- **Provider outage/throttling:** liveness/readiness stay healthy. The affected capability records a bounded category/correlation and remains unavailable. Preserve the last complete cache. Retry only idempotent reads within their page/request/deadline limits; never automatically replay mutations.
- **Queued package mutation retries:** retrying an identical confirmed request with the same idempotency key returns the same durable job. A still-queued job is dispatched again so a rejected initial worker launch does not strand it; running, waiting-for-authorization, and terminal jobs are returned without automatic replay. Changed intent or confirmation remains a conflict.
- **Sync readiness failures:** a cached timeout, transport error or throttling result is a failed check, not evidence of missing permission. Sync retains that cause. Explicit API retries recheck failed Graph package and Power Platform readiness for selected incomplete sources, retaining current successes and throttling cooldowns. The Sync UI starts fresh source syncs instead of retrying retained runs; cancel a waiting run first. A successful later permission check removes the Permissions issue; it does not replay failed sync work. Diagnose `data_sync_source_failed` by run/source/job IDs; `data_sync_cleanup` means internal cleanup, not user cancellation.
- **Sync interruption and cleanup:** admission, Users phases, and Graph/Power Platform child execution retain the initiating account-session generation; a replacement sign-in cannot authorize older work. Inventory child publication finalizes the aggregate run state in the same transaction, including partial or authorization-blocked siblings, rather than leaving settled work marked running. Sign-out/shutdown joins automatic detail admission and final status persistence, while successful detail admission leaves collection independently owned. Cancellation still joins and cleans children when a status write fails. Failed child cleanup, including automatic terminal cleanup, remains tracked for the next retry, cancellation, sign-out, or shutdown; repeating cancellation of an already-cancelled run is safe and does not abort a different committed admission. Run-ID letter case does not bypass execution ownership. Retrying a cancelled manual usage source immediately returns to awaiting upload (or accepts the current complete bundle), never provider collection.
- **Sync admission and retention fences:** manual starts, retries, and automatic due checks reassert the initiating session, cancellation, and operational admission gate synchronously before COMMIT, including saved-data reset. Admission readback uses the same transaction, so a failed read rolls back admission and saved-data reset. Committed provider work acquires its worker before auxiliary usage-status reads; a later response failure does not strand or replay that work. Check saved status to observe it. Expired active runs release their account's unique active slot during the next admission; they cannot accept child attachment, progress, or success publication. Child monitoring stops and cleans up when the parent source is expired or superseded, but accepts an already-committed matching source success. A stopped child handoff is cleaned up without provider dispatch. Startup drains every bounded interrupted-source batch before serving requests, and automatic runs remain active until all remaining queued/running sources have been paused.
- **Shutdown persistence failures:** Purview and Defender reject late starts and keep shutdown joined to activation release and in-flight publication. Failed pause/release writes propagate to an in-flight drain; `audit_worker_failed` and `hunting_worker_failed` contain only sanitized classifications and job IDs, not raw database errors. The server waits for admitted HTTP requests as well as worker drains before closing sessions and PostgreSQL. `shutdown_failed` or the 125-second `shutdown_timeout` exits nonzero; retain maintenance and investigate rather than assuming all work was persisted.
- **Permission-check transport failure:** catalog/check network failures and HTTP 408/500/502/503/504 retry once after one second before a warning appears. Denials, invalid requests and throttling do not use that retry. Persistent check failure says **Permission checks failed after retrying. Use Check status to retry.** Transient failures preserve earlier decisions and saved-data permissions; a permission/session denial instead withdraws capability evidence. There are no periodic or expiry-triggered retry cycles.
- **Concurrent permission checks:** equivalent automatic and targeted checks share provider work, but each request owns its cancellation. Closing one request does not cancel another active caller's check; the last caller's cancellation stops the shared work and permits an immediate new check.
- **Persistent check timeout:** this does not prove a missing permission, role or license. Open the failed feature's **Details > Technical details** for token/provider stage and sanitized diagnostics. Safe checks have bounded token/read attempts and cancellation. **Check status** retries failed delegated checks while retaining successes and throttling cooldowns. Test Microsoft connectivity and latency from the approved deployment; do not bypass Conditional Access or geographic policy.
- **Slow package reads after readiness succeeds:** inventory pages and package detail reads use the same thirty-second per-request limit as the readiness check, so a provider response taking more than ten seconds is not accepted by readiness and then rejected by the actual read path. Overall inventory-job deadlines remain enforced. Package writes retain their ten-second timeout and never retry automatically.
- **Stalled Graph error bodies:** once package response headers establish an HTTP failure, a body timeout retains that status, safe request ID and `Retry-After`. A known denial is not retried as a transport timeout, and a known HTTP 429 retains its cooldown. Without a complete error body, HTTP 424 cannot be identified as wrapped throttling. Caller cancellation remains authoritative, including during final progress reporting and mutation readback; cancellation after dispatch does not prove the write was rolled back.
- **Failed Graph identity collection / duplicate-looking agents:** keep the saved data and retry the normal refresh from Sync; clearing data cannot repair a provider failure. Inspect `package_provider_read_retry`, `package_provider_read_failed`, `package_refresh_execution_failed` and `package_refresh_failed` events, correlated by job ID. Events identify catalog/detail/publication stage, HTTP status, bounded provider code and provider request ID where available, but never raw provider messages or package definitions. Sync distinguishes permission denials from expired sign-ins; other HTTP failures retain `graph_http_<status>` rather than discarding mixed-case Graph error codes. Reads retry transient 500/502/503/504 responses, network/body interruptions and individual timeouts at most three times. Permanent failures preserve the previous complete snapshot; cancellation and the overall deadline remain authoritative. An old generic `provider_error` without these events cannot retrospectively establish the original Graph status.
- **Automatic refresh:** use the current schema and matching application. The visible, online signed-in workbench posts due checks approximately once a minute; the backend admits only due 15-minute inventory/user sources and separate hourly detail batches. Copilot app activity has a six-hour cadence and automatic people enrichment uses cached references. An active manual run takes precedence. Ordinary failures back off for 15 minutes; source-level permission/authorization failures back off for an hour, including either Users subsource when the other source remains available. Explicit API retries bypass automatic collection cadence even for an originally automatic run; they still skip successful, unexpired Users sources and honor provider admission and readiness gates. Pausing automatic refresh prevents further admissions from that workbench session, not cancellation of already-started jobs. No CSV import, hunt or mutation is scheduled.
- **Sign-in warning returning after sign-in:** the server records successful sign-in separately from periodic role validation. The next due check retries older authentication-blocked automatic sources and detail enrichment once with the renewed session; a newly failing attempt retains its cooldown. Data sync source attempts persist their own start boundary, reset only when the attempt changes, so retrying a retained run does not inherit its original sign-in recovery eligibility. Automatic detail recovery likewise compares sign-in with the latest persisted attempt start, falling back to claim creation only if execution never started. Resuming an older claim after sign-in cannot reuse that sign-in to bypass backoff after another authorization failure. The current schema includes that boundary and its guard; use the matching schema/application artifact, not an older database schema. Reloads and permission checks do not count as a new sign-in. HTTP 403/missing permissions or provider roles are not expired sessions: review Permissions instead. Detail admission failures retain their error code and emit `package_detail_admission_failed`; authorization failures pause the whole detail lane for an hour rather than rotating through every package. Startup and active retries display as refreshing, and other eligible sources continue without clearing saved data.
- **Slow Graph package sync:** broad automatic and manual collection publish catalog pages independently, without catalog-wide detail fan-out. Exact matching/detail checks run separately: explicit selected refreshes read their persisted targets, while slower automatic detail enrichment prioritizes new/changed/missing packages in bounded batches of at most 20. Automatic detail batches retain a five-minute execution ceiling and a ten-minute persisted dispatch/recovery deadline; the longer persisted deadline does not extend the worker's execution budget. Use the [package sync diagnostics](#graph-package-sync-diagnostics) to compare actual catalog/detail responses and waiting times before attributing the difference to paging, necessary enrichment, or throttling. An hourly detail interval is a due threshold, not a completion guarantee.
- **Graph 424 / UnknownError throttling:** Graph can wrap a "too many requests" response in HTTP 424. `outcome: throttled` distinguishes this from other dependency failures. Throttling pauses queued inventory reads, not just the failed request. Inventory pacing starts at 250 ms after a throttle and doubles after subsequent throttled request generations, capped at two seconds; failures already in flight share one rate penalty. A minute of successful reads allows a gradual rate increase. `package_provider_pacing_changed` reports the new interval and `reason: throttled` / `recovering`. Without `Retry-After`, cooldowns are 30, 60, then 120 seconds. Broad catalog and explicit exact inventory jobs can retry throttles until the four-hour execution deadline or cancellation; transient non-throttling reads retain a three-failure budget. Valid `Retry-After` up to four hours is honored within those jobs' remaining execution budget. Automatic detail reads instead retain a six-throttle-failure budget per logical read and a five-minute batch execution ceiling; default non-inventory read clients retain their five-minute `Retry-After` and three-failure bounds. A wait beyond the applicable budget fails rather than retrying early. Sync retains its progress and wait explanation. Do not repeatedly click retry or clear inventory during a cooldown. Writes never retry automatically.
- **Package read admission:** default inventory streams share one process-local Graph read client across refresh jobs. One logical budget covers admission, token renewal, durable request preparation, retries, body parsing and progress callbacks; elapsed monotonic time remains authoritative even if deadline timer delivery is delayed. Ordinary reads use the configured maximum `Retry-After` plus thirty seconds for the entire operation (five minutes thirty seconds by default), not a fresh budget for each phase or retry. Extended inventory throttling requires both caller cancellation and an absolute execution deadline, bounded by the persisted generation deadline. A cooldown must fit the remaining budget; oversized positive `Retry-After` fails closed rather than becoming fallback backoff, and prematurely settled timers never authorize early dispatch. Physical dispatch spacing includes token renewal and durable request preparation. Cooldowns are rechecked after either await, and tokens aged by queued work or preparation are renewed before dispatch. HTTP 429 headers establish the shared cooldown before body parsing, even if that caller later expires; parsing must not extend the same cooldown again. Token-service throttling does not change the shared Graph read rate. Cancellation or expiry releases the queue without a late reservation delaying other jobs. Progress persistence failures/timeouts remain failed refreshes, never completed empty observations.
- **Package collection complete but readiness unavailable:** `package_publication_readiness_retry` means the already-collected result is retained in staged storage while current authorization/readiness is checked again. Transient timeout/network/provider failures retry with bounded 1-30 second backoff; cached throttling waits until the evidence cooldown expires. Counts remain complete and the job remains running. No package re-download or partial publication occurs during these retries. Genuine denial, sign-out, cancellation, supersession and publication/database errors still stop the job. Publication requires fresh principal/role checks and available capability evidence, under the account-generation fence. Restarting the process interrupts the active worker; staged records are not an automatically resumable published snapshot. Do not restart merely because this recovery message appears.
- **Package execution lifetime:** current package dispatch deadlines are four hours; admission starts a fresh four-hour execution window for broad, selected and single-package reads. Use the exact current schema; incompatible development databases require explicit reset. Shorter 45-second, two-minute and fifteen-minute package execution bounds are removed, as are five/sixteen-minute package read monitoring cutoffs. The Sync coordinator continues following the durable child job. Individual thirty-second read/token-renewal limits remain retryable request safeguards, not the overall sync deadline; tokens are renewed before each read through the existing scoped token cache. An authorization handoff after the execution or retention deadline fails the job instead of leaving it running without a worker. Publication rechecks both deadlines after snapshot writes; expiry rolls back the replacement and preserves the previous complete inventory. The four-hour ceiling, cancellation and security boundaries still apply.
- **Permissions page:** use **Issues** for actual recent failures, **App prerequisites > Required API permissions** for the exact grant-to-feature reference, and **Log collection setup** for connector and auditing steps. Unused features have no readiness warning. Recent failed license/report/identity/control operations can appear without claiming the whole capability was tested. Successful operations clear those reports. Select the intended agent or user to perform work; Permissions controls never start a sync, hunt, import or mutation. The independent signed-in workbench scheduler can still refresh due inventory while this page is open.
- **Authorization prerequisites:** `missing_permission` links to **Admin setup** in Entra. Add the listed API permission using its delegated/application type and grant tenant admin consent outside the app. Delegated `interaction_required` and `authorization_expired` expose normal **Sign in again** for MFA/session recovery, without a feature-consent request. Application-mode authorization failures instead link to **Admin setup**: an administrator must verify the app registration's credentials and application grants, then retry the explicit application-scope operation. User sign-in does not repair app-only authorization. No action redirects automatically.
- **No data:** distinguish a complete zero-row observation from missing permission, partial coverage, limit failure or stale cache. Do not turn a provider error into a successful empty snapshot.
- **Explicit clean full resync:** `POST /api/data-sync/runs` with `{"mode":"full","clearSavedData":true}` clears only the requesting tenant/principal's saved directory/app-activity, Graph package (broad and exact), and Power Platform snapshots/resources, source state, and core success markers. Omit `sources`; selected-source cleanup and non-boolean flags are rejected. Without the flag, full sync remains nondestructive. The current schema performs cleanup atomically with admission through a restricted insert trigger, without granting runtime table deletion. Deduplicated, conflicting, rate-limited, or rolled-back runs do not clear data. Finish or cancel unfinished package/inventory refresh jobs if admission returns `data_sync_source_active`; publication locks and user-attempt fences prevent old work from restoring cleared data. Accepted official usage history and its marker, audit, jobs/control outcomes, configuration, shared identity mappings, and other accounts/tenants are preserved. A failed, interrupted, or cancelled replacement leaves those sources missing until explicitly retried successfully; it does not restore the old snapshots or report a successful zero-row sync.
- **Power Platform inventory timeout:** `provider_timeout` is a failed read, not missing authorization. The persisted thirty-minute job deadline includes authorization waiting, enumeration, revalidation and publication; resume never renews it. Once the waiting job is loaded, that same deadline interrupts stalled startup authorization with `inventory_job_expired` and releases its lane. Start a new refresh explicitly rather than signing in to resume an exhausted deadline. In-flight progress recording is awaited before returning, but cancellation or an expired enumeration deadline prevents success even after the final page; progress writes are not abandoned during shutdown. Individual pages remain capped at 100 rows, ten seconds including the body, and the existing response-byte limit; streamed sources remain limited to 10,000 pages/100,000 unique source rows. A tenant with thousands of resources can legitimately take more than 30 seconds. Use the logged failing page, elapsed duration and progress to distinguish the total deadline from a slow page; retry a failed refresh explicitly or narrow its scope. No partial snapshot is published.
- **Catalog verified but Agents empty:** the Permissions check validates only the first catalog page; it does not persist inventory. While Agents is open, a successful saved-data response with `snapshot: null` and no discovered refresh jobs or prior attempt/success metadata allows one initial delegated read-only refresh per account/UI session; saved data can load afterwards. Existing or failed work is not restarted automatically. Progress, terminal error and saved observation are separate from readiness. Use **Refresh agents** to retry deliberately; a failed or interrupted attempt must not become an empty successful snapshot.
- **Preparing access changes:** opening the access editor refreshes the exact package read-only and fetches current detail; bulk preparation refreshes each selected target before confirmation. Loading these details changes no provider settings and does not replace confirmation, immediate dispatch-time prestate checks or post-write readback.
- **Duplicate-looking agents after successful sync:** source collection and canonical identity reconciliation are separate checks. Use the current schema and matching runtime together. Reconciliation serializes against both publishers and records one scoped membership per exact source target before paging. Declarative packages need matching package manifest, resource native ID, and GUID schema name; they do not need Studio `AgentMetadatas`. Studio native proofs are not rejected merely because Graph and Power Platform report different source-specific agent identity IDs. A unique native proof can associate another custom-engine package with the same corroborated bot application identity. Different native/environment claims and same-name template copies remain distinct; never repair counts with display-name deduplication or bot-ID substitution.
- **Counts jumping after catalog/detail refresh:** current catalog manifest/type evidence can reconcile declarative agents even when hourly details are missing or stale; it does not refresh detail timestamps or grant Studio control proof. Automatic detail responses may omit catalog app/manifest/asset IDs. Those omissions are compatible only with the unchanged catalog revision reserved for that detail read; changed revisions, positive identity disagreements, authoritative absence, ambiguous native targets, and control-only observations still cannot establish a link. Expired detail-only Studio/custom-engine evidence still requires enrichment. Complete source commits enqueue changed-key canonical work; the maintenance-aware worker drains and recovers it off GET. A saved read never repairs or republishes inventory.
- **Block/unblock and saved inventory:** use the current schema and matching runtime. A successful mutation still requires Microsoft readback and an atomic job/audit/database commit. Block state and access state are saved as separate, typed control observations, not replacement identity snapshots. Saved list/detail/batch reads and unified filters/exports apply verified state while retaining the original inventory identity, creator association, canonical ID and identity observation timestamps. No full Microsoft sync is required after a successful action. A refresh that started before the control readback cannot undo it merely by finishing later; a subsequent refresh can observe external changes. Control receipts carry their own timestamps and share the existing scoped retention and clear-saved-data boundaries.
- **Repairing a post-action split:** there is no legacy mutation-snapshot conversion. If current identity evidence has expired, was superseded, or changed, refresh the affected package's identity and its Power Platform source as needed. New or contradictory native/bot identity evidence, changed exact version markers, or malformed identity metadata in a readback is flagged for revalidation, even without a previously complete bot identity. Later sparse controls and catalog reuse of the old details cannot clear that flag; a new exact identity read is required. Missing optional metadata, complementary bot groups, or source-agent aliases in a control receipt is not an authoritative inventory deletion. Never delete one same-name source record as a repair.
- **Canonical links across refresh and retention:** publication hands existing memberships to the selected replacement source observations within the publication transaction, using exact package IDs or normalized native environment/ID keys. It clears old matching evidence without extending snapshot expiry or granting control proof. Retention can then remove superseded payloads without discarding unchanged canonical UUIDs before the next Agents read. Truly removed targets and explicitly cleared account inventories do not retain phantom memberships.
- **Corrupt saved matching details:** older package projection sliced every element definition at 32,768 characters. `agent_identity_unresolved` with `reason: invalid_json` can therefore describe an already-corrupted saved definition, not a Microsoft failure. The collector parses complete native identity metadata and retains whole package definitions within the byte budget; malformed or oversized responses fail explicitly. Arbitrary package JSON, names and URLs do not establish native connector or invoked-flow relationships. Refresh affected package details, refresh agents, or run a confirmed clean resync to replace the old observations. **Sync > View diagnostics** shows invalid matching details separately from checked identities. The current schema also removes that account's canonical registry during confirmed clean resync; it does not delete accepted reports, audit, jobs, or other accounts' inventory.
- **Inventory exports:** use `POST /api/data-exports` with Viewer, same-origin CSRF, `selectionId`, and `kind` equal to `unified_agents`, `graph_packages`, or `power_platform_agents`. Omit `ids` to export the entire pinned filtered selection, including more than 5,000 matching agents. Explicit selections accept 1–5,000 references; unified exports resolve exact canonical/source-qualified references against the pinned generation, reject missing or ambiguous references, deduplicate aliases, and retain the selected sort without applying list filters. Graph IDs remain case-sensitive. The old inventory `export.csv` endpoints have been removed, not redirected.
- **Control readback recovery:** verified job/audit/control observations commit together and immediately fence previous inventory selections. The durable `inventory_control_pending` queue references those existing control receipts; it is not another control authority. The inventory worker republishes at most twenty exact pending targets per pass, then enqueues canonical reconciliation only when the control queue is drained. Restart recovery uses the same queue and current account authorization. Unchanged source memberships survive the changed-key publication; a control-only receipt cannot introduce a target missing from the catalog. While publication is pending, current write authority remains unavailable. Do not clear receipts or force a full resync to bypass that fence.
- **User responsibility tab:** responsibility is available only in the user modal, not as a Users cohort or standalone people list. Agent-person links open that modal for the exact object ID, including saved references outside paid/report cohorts. The tab retains one selected agent page and uses SQL counts and next/previous cursors. An exact saved person can legitimately have zero responsibility edges. A cursor invalidated by expiry or an unsafe change requires an explicit reload; neither the browser nor the API silently swaps to a newer inventory while continuing the old page.
- **Export lifecycle and representation:** poll `GET /api/data-exports/:id`; cancel with `DELETE` and CSRF. A ready job exposes a native browser download at `/api/data-exports/:id/download`, revalidated immediately before download. The browser never fetches the inventory artifact into a Blob. The shared durable engine enforces its 15-minute build deadline, 1-GiB artifact ceiling, storage/admission quotas and automatic expiry; failures never publish partial CSV success. Existing CSV columns remain, with `recordType`, `parentAgentId`, `sourceIdentity`, `sourceDomain`, `childKind`, `childOrdinal`, and `childData` describing normalized agent/source/child rows. Join children by parent and source identity; connector-operation child values identify their connector ordinal. This retains legal high-fanout definitions and assignments without an unbounded cell or browser collection. Formula safety applies to every CSV cell. Safe source refreshes do not replace the pinned export; expiry or unsafe authorization/invalidation stops it. Audit actions remain `export-agent-inventory`, `export-package-inventory`, and `export-power-platform-inventory`.
- **Power Platform source export and diagnostics:** `power_platform_agents` is an authorized, audited **agent-only** export, not a general resource explorer. Collection accepts only `microsoft.copilotstudio/agents` and `microsoft.powerplatform/environments`; environment rows support agent context and are not export targets. Sync history and **Inspect source job** open `/sync?powerPlatformJob=<id>` for that exact saved job. Inspection does not query Microsoft or substitute the newest attempt; source resume/cancel use that job, and a new refresh uses its original scope.
- **Interrupted Power Platform refresh history:** a transport failure or cancellation of the current history read leaves saved inventory available, but any retained refresh status is labelled **Last observed**, not **Latest**. Use **Sync > View diagnostics > Verify saved inventory** to reread saved inventory and history without starting provider work. Reads retired by navigation or account replacement cannot publish late status or errors.
- **Agent context limitations:** connector operations describe explicit saved configuration, not use or access. Missing, malformed, denied, capped or stale evidence is unknown/partial, not a confirmed empty list. Owner, creator, last modifier and operation configuration creator are distinct roles. Synced Resource Query and Graph packages do not establish invoked-flow relationships; Overview and CSV make this limitation explicit. Fixed Microsoft console landing links are handoffs, not verified deep links, relationship evidence or authority to mutate. Saved Users responsibility can include people outside paid/report cohorts without inventing licensing or usage evidence.
- **Fresh development schema:** this agent-centered revision initializes a fresh development database with the two-type constraints. Existing broad-catalog databases are not an in-place upgrade target; there is no old-data backfill, dual schema, retired-route redirect or compatibility reader. Use only an explicitly owned disposable database/project for fresh initialization; never reset a shared installation to apply this development change.
- **Package identity refresh lifecycle:** full agent sync collects catalog pages without detail fan-out. Separate explicit exact jobs check their persisted targets sequentially with a four-hour execution ceiling; automatic detail enrichment uses batches of at most 20 with a five-minute execution ceiling. Progress and failures are retained in Sync, and each job's publication is all-or-nothing. Completed collections survive transient publication-readiness retries in staged storage. Opening Agents may follow an already-running broad refresh; failed/cancelled attempts require a fresh Sync run. The operation survives tab navigation but never changes agent settings. A process restart requires real sign-in to reacquire delegated tokens. A freshly read alias package never extends expired native-control proof from another package.
- **On-demand provider writes:** no extra mode/configuration or prior qualification is required in local or Azure deployments. Sign-in, Admin role, provider permissions, same-origin/CSRF, exact targets, confirmation, immediate prestate checks, audit, one-shot dispatch and readback remain enforced. Package access lacks conditional concurrency protection and can overwrite a concurrent external change after the final pre-read. No write runs automatically. Owner reassignment has no implemented product workflow or documented owner readback.
- **Schema drift:** an unknown provider shape fails that operation and retains the previous snapshot. Local deployment's read-only preflight reports `database_schema_reset_required` for a non-current fingerprint before stopping the app. The deliberate agent-centered development schema replacement requires a fresh database or a separately authorized reset, not modified schema markers. Other unknown PostgreSQL schemas make runtime readiness `503`; keep them in maintenance and investigate.
- **Job age/failure:** inspect the source-specific job route from the workbench. Logs contain only structured request/job/provider IDs, status, durations, ages, attempts and counts.
- **Uncertain write:** leave the sent item `inconclusive`. With current Admin and provider-read authority, use its existing GET-only reconciliation route. Mark observed-applied, observed-not-applied or conflict; never resend automatically or invert a partial batch automatically.

## Resolve sign-in and permission problems

1. Confirm the username domain is configured for exactly one tenant.
2. Confirm **Assignment required?** is enabled and the user or group has
   `AgentControl.Viewer` or `AgentControl.Admin`.
3. Confirm the callback URL exactly matches the current public origin.
4. Confirm the required API permissions have tenant-wide admin consent.
5. Confirm the signed-in user has the Microsoft role and license required for
   the action.
6. Sign out and back in, then use **Permissions > Check status**.

| Event | Interpretation |
| --- | --- |
| `package_catalog_page` | Actual `pageSize`, cumulative `observedCount`, page number, continuation presence, and elapsed page read time including waits/retries. This is the evidence for page size, independent of UI progress labels. |
| `package_catalog_field_coverage` | Per-page counts for `elementDetails`, access collections, `longDescription`, `categories`, and `sensitivity` in the **raw list records**, before projection. `missingCount`, `nullCount`, `emptyCount`, `nonemptyCount`, and `invalidCount` are exclusive and sum to `count`. Empty is an empty array/string; nonempty is not a guarantee of useful identity metadata. Invalid counts describe the top-level field type, not nested schema validity; normal validation still runs and can reject the page. |
| `package_catalog_response_type` | Counts of code-owned `actualType` categories: `summary` or `detail` for the documented `@odata.type` names, otherwise `missing`, `null`, or `other`. No arbitrary provider type string is logged. Treat field-coverage evidence, not the type label alone, as authoritative. |
| `package_scan_progress` | A cumulative identity-stage sample every 100 completed checks. `count` includes 404s; `observedCount` counts returned packages; `totalRecords` is the number of targeted detail checks. |
| `package_scan_summary` | Final collection wall time and read/wait counters for the reached stage (`catalog` / `identity`), also on collection failure, cancellation, or deadline. Each stage's summary is emitted at most once; the first finish freezes its outcome, counters and timings, and late callbacks cannot emit more scan progress. Exact/detail `totalRecords` is the target count. Catalog `totalRecords` is omitted until collection succeeds, then equals the observed complete catalog, never a provider count hint. `outcome: collected` is emitted before publication readiness and remains collected if later authorization/publication fails; only `package_refresh_succeeded` confirms publication. |
| `package_provider_pacing_changed` | Adaptive request-start interval and the fixed `throttled` / `recovering` reason. Concurrent throttle responses share a rate penalty; a quieter period can raise throughput again. |
| `package_publication_readiness_retry` | Collection is complete, but authorization/readiness is not yet available. Includes safe error category, completed count, attempt and retry delay; the result is retained rather than re-collected. Only `package_refresh_succeeded` confirms publication. |
| `data_residual_limit_exceeded` | An application storage check rejected a parent `field: residual` or child `field: payload`. `bytes` is the measured size; `maximumLength` is the unchanged 262,144-byte limit. `stage: inventory_projection` and `generation_batch` measure UTF-8 JSON; `stage: database` measures PostgreSQL JSONB text, which can be larger after normalization. The event inherits request/job correlation and contains no record IDs, names, field contents or definitions. The original `data_residual_bytes` error and failed publication remain unchanged. |

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

Catalog and exact/detail collection are independent jobs. A broad catalog job does not fan out detail reads or emit identity-stage summaries; an exact/detail job does not list the catalog. These pipelines do not emit list-versus-detail comparison events or make extra reads for diagnostics. Do not skip exact detail reads based only on populated list fields or type labels.

Persisted job progress and Sync label exact/detail `observedCount` as **targets checked**, including authoritative 404 absences in exact refreshes. Catalog progress counts **packages observed**. Diagnostic identity summaries separately use `count` for completed checks and `observedCount` for packages returned. Completed checks or `outcome: collected` do not imply saved-data publication.

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

- `requestCount`: settled read attempts, including errors/retries; `retryCount`: attempts beyond the first; `throttleCount`: recognized throttle responses, including exhausted attempts. Capability probes outside this scan are not included.
- `requestDurationMs` and `maxRequestDurationMs`: total and maximum time inside a read attempt, including response consumption but excluding admission/backoff.
- `admissionWaitMs`: cumulative time queued for the shared read scheduler, including pacing and cooldowns caused by other jobs; `retryWaitMs`: actual elapsed retry backoff, including interrupted waits, rather than the requested delay.
- `readIntervalMs`: highest configured start interval observed before a read attempt for this stage. It can already be 250 ms because an earlier job throttled the shared client.
- `durationMs`: collection-stage wall-clock elapsed time, including token renewal, progress persistence and local processing, excluding subsequent publication readiness, publication and canonical follow-up. Concurrent workers' request/wait durations overlap: **do not add those totals to derive wall-clock time**. Progress samples exclude still-running request attempts.

An unchanged startup performs one selected inventory capture and one page read,
not a second read when automatic status first arrives. A publication racing
startup causes one scoped synchronization regardless of response order.
Subsequent progress, failure (including provider timeouts), or job completion
alone does not reload inventory or reports. Completion can request an eligible
publication check; persisted publication markers decide whether content changed.

Diagnostics retain counts/timings and fixed field labels only, with the existing job/request correlation. Graph error reasons use a finite set of canonical code-owned labels; unknown provider codes and arbitrary exception names are omitted. Provider request IDs shown in logs or Sync must have UUID/32-hex format. HTTP status, not a provider-supplied code, owns authorization/permission job classification. No package IDs/names, principal IDs, definitions, payloads, tokens, continuation URLs, or raw provider messages are logged. There are no per-package success logs or additional provider calls. Final summaries require the process to remain alive; a hard process termination can leave only page/progress events. Preserve the job-correlated output and compare it before choosing a throughput optimization.

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

Operational metadata is a finite field contract: counters are nonnegative safe
integers, durations are finite nonnegative milliseconds, flags are booleans,
and provider/source/stage/outcome/schema labels use code-owned allowlists.
Unknown fields, accessors, proxy objects and nonprimitive values are omitted
without traversing provider payloads. Request/job/run IDs are exact bounded
ASCII tokens; provider correlation IDs must be exact GUIDs or 32 hexadecimal
characters. No identifier is trimmed, truncated or recased. HTTP terminal
callbacks retain their initiating async context and settle once, including
response errors followed by a late finish or close. Transport errors are
observed without handling otherwise unhandled errors; only this logger's
listeners are removed at settlement. Sampling, clock, serialization and
console-sink failures do not replace business results or exceptions. An
unavailable HTTP clock produces no terminal sample, not a fabricated duration.
Capability operation/readiness/reporting diagnostics and identity-provider
retry evidence read only own data error fields; failed evidence storage cannot
turn a completed business write into a failure. Uninspectable fields provide
no additional retry authority and never become synthetic network failures.
HTTP error-code locals are best-effort annotations: immutable or accessor
locals do not replace the original problem response.
Invalid code-owned event names or levels remain programming errors.

The browser applies the same request-ID bounds to problem/header diagnostics,
falls back to a valid `X-Request-ID` when the problem ID is invalid, and omits
nonfinite or unsafe-integer `Retry-After` diagnostics.

Data-sync worker failures (`data_sync_worker_failed`, `data_sync_worker_status_failed`) retain the bounded `runId` shown in **Sync history > View details**, together with sanitized error classifications. Database-pool and session-store errors use the same timestamped error envelope without connection or exception details.

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

Explicit package resume starts a new collection attempt from the beginning, not
from an unpublished continuation. Its observed/page counts reset to zero and its
provider total is unknown until current progress supplies one. Prior complete
inventory remains readable until successful publication. If the retained job
expires during a start or cancellation status handoff, the API returns
`409 package_refresh_expired`, not an empty successful job response.

Package job submission, including selection-backed jobs, retains the initiating
account and capability authority through application-scope approval and the
database pre-COMMIT fence. Saved job
status, history, target pages, requested cancellation and aggregated Sync history reject account
revocation or replacement before releasing a response, without checking provider
availability. Internal `sync_cleanup` cancellation remains available after
revocation so sign-out can stop its owned children. A committed source remains
successful if capability evidence or canonical follow-up fails. Delegated
canonical follow-up is attempted independently of evidence completion failures,
honors the execution signal and current authority, and has a bounded local wait;
later inventory reconciliation can retry it without recollecting the source.

Package and Power Platform refresh startup preserve the first cancellation, sign-out, or shutdown reason even if a pending job lookup, authorization check, or token request later rejects. Execution deadlines preserve their exact first abort reason; later cancellation, shutdown or delayed settlement cannot relabel them, and a cancellation that wins first does not become a timeout in scan diagnostics. Nested generation heartbeats forward that same reason, including an explicit `null`. Shared execution signals clear their unreferenced timers and parent listeners immediately on abort or disposal; disposal is repeatable and does not itself cancel work. A zero duration is already expired (an already-cancelled parent still wins), invalid durations fail before acquiring resources, and large safe-integer durations are split into non-overflowing timer intervals. Intervals recheck elapsed monotonic time: early callbacks rearm, delayed callbacks cannot renew the budget, and wall-clock adjustments do not change the execution signal's duration. Package workers use the earlier of their execution ceiling and the persisted job deadline, including pending collection/publication authorization. Cleanup persistence failures still propagate to the caller and an in-flight shutdown drain. Provider readiness and token requests do not hold the account-session write lock needed for sign-out. Admission permission denials are recorded as failed jobs with permission guidance, not resumable sign-in waits. Power Platform rechecks session generation and provider admissions after awaited progress writes before allowing another page. If cancellation or the execution deadline interrupts application-scope authorization before publication, no subsequent capability check or publication is started.

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

Saved inventory is checked automatically; administrators do not approve it after sync. Agents retains a concise attention notice for actual source/verification failures and invalid, ambiguous or conflicting matching evidence; **Sync > Inventory health** explains these issues without requiring diagnostics to be opened. Routine detail freshness alone does not show an attention notice: Sync says **Sources checked**, not that every identity is fresh. Agent **Overview** omits the package-detail freshness notice; freshness diagnostics remain available in Sync. **View diagnostics** separates detail checks that are current, never collected, previously collected but expired, or awaiting a compatibility recheck. These are package-detail counts, not missing-agent counts or failed matches. A successful read without native linking metadata is still a completed check; repeated reads do not guarantee that Microsoft will supply a link.

The unified API and CSV use verification status `details_pending` when source accounting and link consistency pass but package detail checks are not all current; `checks.packageMetadata` remains false. `identityCollection.pendingDetails` breaks the existing `pendingPackages` total into `missing`, `stale`, and `invalidated`. Actual source failures or invalid/conflicting evidence still produce `needs_attention`. Detail expiry remains one hour and never grants fresh identity/control authority. Automatic details captured for an unchanged reserved catalog revision tolerate list/detail endpoint modification-timestamp differences; changed catalog revisions, package IDs, versions or positive identity evidence still invalidate the association.

Saved presentation, package-detail reads and CSV exports compare detail observations at the selected instant without truncating fractional timestamp evidence; canonical identity-expiry scheduling retains the earliest exact expiry. Source membership accounting covers the same unfiltered, unexpired canonical rows as the inventory query; expired rows cannot satisfy a missing target's accounting. Each native agent requires one logical native-bearing row, while several Graph packages may share a logical row. Malformed saved typed fields or contradictory row identities fail the read rather than reaching frontend rendering or control decisions.

Use **Verify saved inventory** to recheck the complete saved source set and reconciliation without provider calls. Opening diagnostics starts no sync or verification action. The unified API and CSV expose the check time, scope, source/unique/logical counts and identity checks. Missing optional `wids` alone is not a partial-completion condition and does not require an app-registration change or broader role. Verification time does not advance source freshness or prove access beyond the recorded authenticated query.

### Agent inventory views and portal count comparison

**Agents** opens in **Microsoft 365 catalog**: agents backed by saved Microsoft Graph package records, enriched with Power Platform information only after confirmed identity matching. **Additional Power Platform agents** shows native agents with no confirmed match in the saved package catalog; this does not prove they are unpublished or absent from Microsoft's portal. Missing or stale matching evidence can affect that classification. **Combined inventory** includes both groups, consolidating confirmed matches without deleting either source observation. Matching never relies on display names.

The catalog view displays the **distinct catalog-agent count**, without inline scope explanations or portal-count commentary. Scope descriptions are available on the buttons' hover text; source **package-record counts** remain in **Sync > Inventory health > View diagnostics**. Multiple package versions can represent one logical agent, and provider sync timing or collection scope can also explain differences from the Microsoft admin portal. Compare like-for-like counts and source collection times; do not add Power Platform counts to package counts. An unavailable source remains **Unknown**, not zero. Inventory health and verification receipts continue to describe the complete saved source set.

Inventory scope is independent of availability, organization, usage, and other table filters. Scope buttons show unfiltered counts; availability metrics and filter facets apply to the selected scope. Switching scopes clears table filters, paging, details, and selected mutation/export targets, but preserves sorting. **Clear filters** preserves the scope. Bookmarks use `/agents?inventory=power_platform_only` or `/agents?inventory=all`; `/agents` defaults to the catalog. Filtered CSV exports use the current scope; exact agent links and explicitly selected exports remain scope-independent. Reported usage metrics continue to cover all imported reports, not just the selected inventory view.

While saved agent results update, a refresh indicator beside **Export CSV** replaces the table's updating banner. Its reserved space keeps the layout stable, and existing rows remain visible with selection/export disabled until the read completes. Screen readers receive a status announcement; reduced-motion preferences disable the rotation.

Background saved-inventory reads do not disable block/unblock or access-management actions for already-selected packages or exact visible package rows. These actions use explicit native IDs and obtain current server previews before any confirmed write. Selection and revision-bound exports still wait for the new page; a session/access denial still clears protected state. Permission checks run once per signed-in session and thereafter only through **Check status**, not periodically or when returning to the tab. Normal automatic data synchronization remains separate and unchanged.

**Access and availability** is the single home on Agents for package-job status, processed counts, results, and recovery controls, including retained `/agents?controlJob=<id>` links. There is no standalone Jobs page; old `/jobs` bookmarks open Sync. Running jobs replace the selection-action buttons with job-specific controls. **Cancel unprocessed tasks** stops work that has not started; it does not undo completed changes, and a change already in progress can still finish. **Resume unprocessed tasks** retains explicit authorization/confirmation and never replays uncertain writes. **Check uncertain results** performs read-only reconciliation before a separately previewed retry. Commands show a pending state and cannot be double-submitted; request errors and final outcomes stay in the same panel. After polling stops or fails, **Refresh status** reads that exact task without repeating a write. Reload restores the browser's saved active task; if that pointer was cleared during sign-in, Agents restores the newest unfinished or uncertain task from the current principal's latest 50 retained tasks using saved-data reads only.

Block/unblock confirmations show package names, current and requested block states, and the effect on usage. Unblocking preserves existing availability and installation settings; it does not grant new access. Bulk confirmations show the full target count and explicitly identify when only the first 20 packages are listed. **Technical details** is collapsed by default and retains exact package IDs, raw states, provider/permission details, actor, rollback information, and the selection hash. The preview API notice remains visible. This presentation does not change server confirmation hashes, authorization, immediate state checks, or provider readback; cancelling never submits a write.

API consumers can send `inventoryScope=catalog`, `inventoryScope=power_platform_only`, or `inventoryScope=all` to `GET /api/agent-inventory` and filtered CSV exports. Omission preserves the API's combined behavior for existing consumers. Responses echo `inventoryScope` and expose `scopeSummary`, while `summary` and verification remain global. Scoping occurs after complete reconciliation so changing views cannot remove canonical memberships or create new identities.

A saved Agents response is rejected when its inventory, source, or contextual evidence has expired, even if the HTTP response is successful. **Verify saved inventory** can reload newer saved evidence, but does not renew an expired snapshot or collect provider data. If no unexpired snapshot is available, use the normal Sync controls to refresh the affected source.

Automatic-refresh scheduling continues on every workbench page, but its banner is shown only on **Sync**. The CSV section calculates **Reporting dates (UTC)** from the minimum and maximum activity dates across all retained complete reports, independently of history pagination or the selected set. No manual dates are required. Drafts and deleted sets are excluded, and the summary recalculates after imports and deletions. This date span does not prove complete daily coverage or permit summing overlapping snapshots.

Data sync separates **Last saved count** in Workspace data from current-attempt counts in the progress/detail panel. Workspace counts and **Last successful sync** come from persisted successful Data sync publications, not the latest limited/failed attempt or an older standalone inventory refresh. These timestamps are not a live-provider freshness guarantee. Running counts are actual observations, not provider target totals; Graph can reset its counter between list collection and identity checks, with the phase in its message. Users counts distinct **directory users checked** from products containing paid Copilot features plus exactly verified active report identities. This includes users whose Copilot is inactive/unverified; it is not a paid-license count, tenant headcount, basic Chat count or a sum across overlapping queries. The successful refresh message reports verified active M365 Copilot licensed users separately. The Users page no longer repeats the checked-count banner. Failed/partial attempt counts remain labelled as reported, not saved totals. No total-object percentage or ETA is inferred.

A Users sync completing around 4,000 in a 30,000-account tenant is not itself evidence of truncation: Graph applies the Copilot-capable product filter across the directory and returns bulk license/feature evidence. Every matching continuation page must reconcile with its filtered `@odata.count`. A bundle assignment, including E7 with Copilot disabled, is only a discovery candidate: licensed labels, the default roster and paid-adoption metrics require verified active paid features. The Users dropdown separates paid users, active report users with verified no active paid access, and the independent saved **Agent responsibility** cohort. Unknown licenses appear in neither licensing/report cohort but do not exclude a responsible person. Responsibility does not establish licensed access or usage and requires no tenant-wide directory scan. Additional exact, bounded report-identity reads occur during Users sync, never saved-page navigation, without an all-tenant scan or destructive reset. Run Users sync after deployment/new imports to verify report identities absent from existing snapshots. Directory paging retains the 100,000-observed-row and 16 MiB response bounds; the license catalog remains at 200 pages/1,000 rows. See [license scope and count diagnostics](copilot-license-usage.md#investigating-an-unexpectedly-small-count). Paid features **Not enabled** never means basic Copilot Chat is disabled.

**Sync history** combines retained sync runs and standalone or underlying Graph / Power Platform refreshes in one chronological table with a shared outcome filter. Run durations include waits/retries from their original start; refresh durations use the latest recorded attempt. Results retain their own units: sources completed versus records saved or reported. These rows are not additive full-sync totals. Open **View details** for exact messages, identifiers and recovery controls. **Sync > Manage reports** (`/sync?reports=manage`) holds the single paginated report-history table, Admin draft/selection/deletion actions, and legacy-browser cleanup; Viewers retain read-only history and snapshot inspection. **Sync > Import reports** (`/sync?reports=import`, optionally `&staging=ID`) owns upload review. Accepted-import **View snapshot** links open the exact read-only inspector (`/sync?reports=snapshot&snapshot=ID`), never change the current report, and do not reopen import approval; jobs without a retained snapshot open Manage reports. In contrast, old `/official-usage?view=history&snapshot=ID` bookmarks open Manage reports because explicit history takes precedence over snapshot/window selectors; only staging takes priority over history. Bookmark migration deletes no source data, and report APIs and retention are unchanged. See the [report workflow and bookmark contract](official-usage-import.md#one-home-for-each-workflow). New default syncs collect only automatic sources. A retained older run waiting for CSVs still needs its import completed or the waiting run cancelled before another sync can start.

Fresh initialization creates current DDL directly with the operator identity; verify the compiled fingerprint and readiness using the restricted runtime role before starting. Old-schema data is not converted. An incompatible database needs an explicit owned-target reset; ordinary current initialization and in-app clean resync do not change the schema.

To isolate an exact attempt, copy its server-generated ID from the structured logs:

```bash
docker logs --since 15m seha-app-1 2>&1 | grep -F '"requestId":"REQUEST_UUID"'
docker logs --since 15m seha-app-1 2>&1 | grep -F '"jobId":"JOB_UUID"'
```

Logs intentionally exclude tokens, cookies, authorization headers, native resource/tenant/environment IDs, names, continuation values, request/response bodies, raw exception messages/stacks and arbitrary provider header values. Do not enable raw payload logging to diagnose an identity error. Counts, types, lengths, stages and correlation are sufficient to distinguish malformed data, unsupported identity bounds, scope failures, pagination overlap, throttling, timeouts and publication failures. Existing authorization, pagination limits, snapshot publication rules and log retention remain unchanged.

## Retention

After the [operator helper setup](#operator-only-local-helpers), preview one bounded batch:

```powershell
docker compose logs app
docker compose logs postgres
```

Do not share logs until credentials, tokens, tenant data, and user data have been
removed.

## Back up a local installation

The exact case-sensitive confirmation is `<lowercase-project>/agentcontrol`, including for preview. Repeat explicitly until `pending=false` and all affected counts are zero, at least daily while the POC is active. The compatibility CLI range is 1–5,000, but each SQL change is capped at 250 rows and the entire committed slice at 1,000 rows/1 MiB/5 seconds. A persisted relation/tenant cursor prevents earlier busy tables starving later work. One PostgreSQL advisory lock prevents competing cleanup. A failure rolls back that slice; preview rolls back both data and cursor changes. Retention makes no provider calls. There is no browser cleanup endpoint.

| Data class | Default / expiry | Single cleanup owner |
| --- | --- | --- |
| Server sessions | Cookie/session 8 hours | operator `Retain` |
| Capability evidence | authorization 5 minutes | operator `Retain` |
| Package and Power Platform jobs | 7 days; snapshots 30 days | operator `Retain` |
| Coordinated sync runs and saved user/license/app-activity snapshots | 30 days; successful-source markers survive expiry so zero-row success is not mistaken for first use | operator `Retain` |
| Purview and Defender jobs/results | 30 days; qualification/retained scope bounds are schema-defined | operator `Retain` |
| Quarantine jobs | 7 days; observations 30 days; audit 90 days | operator `Retain` |
| Official upload staging | 30 minutes; one abandoned ingestion per sweep, child-first resumable cleanup; reservation reaches zero only after both staging representations are gone | report maintenance and operator `Retain` |
| Accepted official report content | Until explicit confirmed Admin deletion; shared observations survive while another retained set references them | operator `Retain` removes deleted/orphaned content, not aged live history; deleted accepted correction metadata remains while its original is undeleted, preventing superseded evidence from reviving |
| Administrative and minimal import audit | 90 days | operator `Retain` |
| Export artifacts/uploads | 256 KiB artifact chunks; 15-minute build, 30-minute artifact expiry; upload wire bytes never archived | bounded export/staging owners, then operator `Retain` |
| Managed production logs | 30-day initial target | Azure monitoring setting in the approved target |
| Local container logs | `json-file`, 10 MiB maximum per file, three files per `app` and `postgres` service | Docker Compose service configuration |
| Local logical backups | 7 days | PowerShell backup-retention helper after applied `Retain` |

Dependent rows, report selection and source projections are invalidated before parent removal. Administrative audit is ordinary append-only data, not cryptographic evidence against `agentcontrol_admin`.

## Backup and isolated restore

After the [operator helper setup](#operator-only-local-helpers), create a restricted native dump and current-schema checksum/fingerprint receipt:

```powershell
Invoke-LocalDeployment $context 'Backup' -BackupFile "$PWD/.local/agent-control-phase01/backups/operator-verified.dump"
```

Omit `-BackupFile` to create a timestamped dump/receipt pair in the protected project backup directory. Explicit destinations must have an existing restricted parent directory; files are never overwritten. Receipts use `format: "agent-control-backup-v1"`, `schemaFingerprint`, `fingerprintAlgorithm: "sha256-pg-row-json-pkey-utf8-v1"`, `sha256`, `tables`, `snapshotAt` and `createdAt`. They bind table content to the exported snapshot. Old numeric-version receipts and mismatched schema fingerprints are not restored or converted. Retention rejects unrecognized receipt formats without deleting those dumps. Backups contain sensitive retained data, provide no automatic cross-backup privacy suppression and must remain access-restricted.

Restore only to a new isolated database:

```powershell
Invoke-LocalDeployment $context 'Restore' -BackupFile "$PWD/.local/agent-control-phase01/backups/operator-verified.dump" -RestoreDatabase agentcontrol_restore_operator_review
```

Restore verifies the dump checksum, receipt table fingerprints and exact compiled current schema fingerprint, with no upgrade path. It invalidates sessions/provider qualifications and official staging/previews/confirmations, fences leases/owners and source-sync coordinators, and marks sent work inconclusive. It repeats bounded retention until a zero-change pass, then compares exact current cache ownership and authority bindings with the current database, including current official set/version deletion and selection and exact Defender retained-scope revocation. Mismatches are purged rather than exposed; missing source data requires explicit resync. It leaves `operational_state.mode=maintenance` and provider work disabled. The restored database is not wired to the retained app by this command.

After an operator reviews current deletions, role/scope changes, report selection, audit/job integrity and retained data scope, reopen the database:

```powershell
Invoke-LocalDeployment $context 'Reopen' -RestoreDatabase agentcontrol_restore_operator_review
```

Reopen repeats retention to zero and repeats the current-state comparison from one read-only current-database snapshot while holding the restored operational-state row in a transaction. It refuses unavailable or over-bound current review, remaining sessions, Purview/Defender execution ownership, provider qualifications or mutation authority, and keeps provider work disabled. Any official or provider cache whose exact current owner/deletion/access binding cannot be proved is purged. Any future switch of the production app to this database is a separately approved maintenance action followed by restart, core smoke and fresh provider requalification. Never use restored authority to replay an uncertain write. Azure point-in-time restore is Phase 12 work and must use the same reopening checks.

Startup verifies the current schema before loading operational state or running recovery. Provider admissions remain closed until the process loads exactly one valid operational-state row. Unknown modes, non-boolean provider flags, invalid timestamps, or incomplete restoration-review timestamps fail closed. A failed reload closes previously open admissions until a later valid load; diagnostic reads cannot reopen the cached gate, and older overlapping loads cannot replace newer completed state. Process maintenance and draining always override the loaded state. Normal mode with provider work disabled still permits saved-local-work recovery, reconciliation, and exports without contacting providers.

Measure local recovery with elapsed time around `Backup`, `Restore`, review and `Reopen`. Receipts use `format: "agent-control-backup-v1"`, the exact current `schemaFingerprint` and fingerprint algorithm `sha256-pg-row-json-pkey-utf8-v1`; old formats are rejected, not converted. The checked-in primary-key inventory is validated against the actual schema before reading data. Fingerprints stream in stable primary-key order from the same exported PostgreSQL snapshot used by `pg_dump`; dump checksums and subprocess output are streamed. RPO is the difference between `snapshotAt` and the failure/recovery point; `createdAt` is only receipt completion. RTO ends only after reviewed reopen and core smoke. These future observations are not HA, Azure throughput or Azure PITR guarantees.

### Record lifecycle, recovery and bounded-work diagnostics

| Event | Valid pinned reads / exports | Current work and physical collection |
| --- | --- | --- |
| Safe full replacement, accepted new report, exact detail update | Keep the captured immutable temporal/history view until its own expiry | Current head advances; canonical reconciliation finishes captured work and keeps one latest pending input. No per-detail whole-generation copy. |
| Failed attempt | Last successfully published root remains readable | Failed/stale owner's reservations contract to stored bytes; children are collected before the generation. |
| Principal clear, logout/revocation, privacy deletion, tenant removal | Affected scope/session epochs immediately deny new reads and downloads; no other principal/tenant purge | Old owners cannot publish or dispatch. Physical rows remain only while a valid root or control settlement needs them. |
| Official correction, confirmed deletion, expiry, including a non-active set | Tenant-history epoch/revision advances even if active-set revision does not; affected old selections fail | Shared facts survive while another legally retained set references them. There is no invented legal-hold facility. |
| Cancel, role loss, source invalidation, artifact expiry | Stop polling/streaming; never offer a partial artifact as ready | Fenced worker stops; child chunks/items and pins are collected within the slice budget. |
| Process death / restore | Expired ownership cannot be revived; restored sessions and provider qualifications are invalidated | Startup drains bounded recovery slices, leaves uncertain sent work inconclusive and unsent work awaiting authorization. Restore stays provider-disabled through reviewed reopen. |

Current/staging roots, independent worker-input pins, live selections, exports and legally retained history protect their dependencies relationally. Collection marks roots/generations deleting while locked and rejects new pins; closed intervals never reopen. Inventory control settlement precedes GC. An expired early selector or a still-pinned early root must not block later scopes: `data_lifecycle_progress` persists `records`, `inventory`, `inventory_metadata`, `operator`, `report_payloads` and `report_staging` cursors and cumulative bounded-work counters.

Operator convergence requires a complete quiet cursor traversal, not merely an
empty final slice or the remainder of a traversal resumed after process death.
The same 1,000-pass safety ceiling and per-transaction budgets remain in force.

An explicit quarantine resume first authorizes the requested tenant/principal/job,
then recovers only that exact job in one bounded transaction. It never sweeps
another principal's older job. Missing/foreign IDs do no recovery work; all job
GETs remain read-only. Startup and maintenance retain their separate one-job,
tenant-scoped sweep. Unfinished recovery remains durable for the next explicit
resume or maintenance slice; no resume request drains all tenants or jobs.

Operational inspection uses **scalar metadata only**, for example through the authorized operator:

```sql
SELECT worker,cursor,slices,rows_collected,bytes_collected,updated_at
FROM data_lifecycle_progress ORDER BY worker;
SELECT state,count(*) AS generations,sum(reserved_bytes) AS reserved_bytes
FROM data_generations GROUP BY state;
SELECT status,count(*) AS exports FROM data_exports GROUP BY status;
```

`data_lifecycle_metrics` is flushed every 30 seconds, and once after admitted HTTP/worker work settles during shutdown (including failed drains), with at most six fixed stage labels (`record_gc`, `inventory_gc`, `generation`, `selection`, `export`, `admission`). Standalone database and backup/recovery commands flush their process-local metrics before closing the operator pool; imported retention helpers leave flushing to their caller. Values are aggregate observation counts and numeric interval maxima (not sums or last-value gauges): rows, encoded bytes, duration in milliseconds, captured pin count, queue depth and observed generation age in milliseconds. Only nonnegative safe integer fields are retained, including explicit zeroes; unknown stages/fields are ignored. Counts saturate at the maximum safe integer and reset at each flush; they count valid-stage observation calls, not jobs or artifact-wide chunk totals. A single retention pass may observe both backlog and work counters. Shared lifecycle slices, including report staging and inventory metadata cleanup, also report `record_gc`; do not sum stage counts or maxima as independent work totals.

Transactional observations become visible only after confirmed COMMIT: its response must carry the `COMMIT` command tag, not PostgreSQL's `ROLLBACK` response for an aborted transaction. Rollback, cancellation before COMMIT, failed commits and operator retention dry-runs contribute nothing. A metric scope belongs to one transaction: it may run multiple awaited phases, cannot commit while a phase is unfinished, closes on commit/discard, and ignores detached observations after closing. Repeated commit cannot recount observations, and closed scopes cannot run new phases. Independently committed nested transactions survive an enclosing transaction's failure. Post-COMMIT diagnostic/unlock/release failures still fail the operation, but cannot roll back its durable effects or erase its committed metrics. Committed export chunks still contribute their cumulative row/byte high-water marks even if a later chunk, producer step or final publication fails; they do not prove a ready download. The in-memory admission queue observation is independent of SQL commits, even inside a transaction metric scope. The `generation` stage's age is elapsed work age sampled on a committed successful heartbeat, not proof that an absent heartbeat succeeded.

`record_gc.backlogRoots` is the exact scalar count of deleting, not-yet-collected generation roots at the start of a retention pass; its `oldestAgeMs` is the oldest such generation's creation age, not time since it became eligible. The aggregate returns one row and shares the five-second transaction deadline. It excludes protected/current roots and is not a count of every physical child or retained history set. Metrics are **not** an unbounded per-tenant series, global retained-byte totals or a replacement for the SQL progress counters. Request/job context is cleared; no tenant, principal, identity, query, payload or provider response labels are added. Console emission is best-effort: sink failures can lose samples but do not fail business work or the runtime sampler.

Investigate any committed GC slice exceeding 1,000 rows, 1,048,576 bytes or 5,000 ms; a collector with eligible unpinned work but no progress over two complete cursor traversals; queue depth above 32; or ownership surviving more than 60 seconds without a successful renewal. Capture progress, scalar counts, lease/deadline timestamps, bounded redacted logs, memory/OOM state and image IDs before cleanup. Stop affected admissions rather than replaying uncertain writes. Independent heartbeat acquisition has its own connection and continues through provider Retry-After/validation waits (20-second heartbeat/60-second lease).

Export setup, status preflight and cancellation retry at most three times for network/429/503, with bounded 2–10-second waits; the same UUID idempotency key is reused for setup. A failed admitted job is never invisibly recreated. Polls contain metadata only, stop on terminal state/unmount/logout, and abort controllers are owned by their selection context. CSV is a native download, never an artifact-sized Blob. HTTP keeps the final chunk until checksum, authority and audit completion succeed, so a late server failure cannot satisfy `Content-Length` and masquerade as a completed file. Audit outcomes include row/byte counts and SHA-256 (partial prefix checksum on failed streams); this proves server-side processing, not a client's disk write.

### Intentionally bounded collections

| Consumer | Retained bound / behavior |
| --- | --- |
| Provider append / SQL transfer | ≤250 records and ≤1 MiB encoded per batch; residual JSON ≤256 KiB; no accumulating all pages |
| Selected lists / detail / cursors | ≤100 rows/1 MiB per page; detail ≤512 KiB; cursor ≤4 KiB; exact identity lookup batches ≤100 |
| Inventory identity investigation | At most two candidates establish uniqueness; bounded independent child/detail projections, not all canonical members |
| Agent people | 100 exact IDs per repository/request batch, eight concurrent lookups, 100,000-reference traversal ceiling; display name 512 and UPN 320 characters; UI has three person fields |
| Official facts / imports | Fact/staged JSON ≤16 KiB; acceptance copies 50 rows per statement; cleanup 25 rows per child relation under shared byte/time budget; staging 2 GiB tenant / 1 GiB actor and bundle |
| Export / mutation work | Chunks ≤256 KiB; native route retains one final chunk plus current chunk (≤512 KiB); artifact ≤1 GiB/2 million rows. Existing explicitly chosen export IDs are capped at 5,000 and persisted in bounded batches; all-matching export never enumerates IDs in the browser. Ordinary mutation targets are server-staged with a 5,000-target ceiling. |
| Recovery | One job per transaction; package ≤64 items, quarantine ≤25. Package prefixes include every item/attempt/audit change **and every full parent-row revision-trigger write**, capped at 768 KiB or the shared 1 MiB ceiling minus two parent settlement writes, whichever is smaller; ≤1,000 row changes / 5 seconds. |
| Principal revocation | Scope UUIDs are keyset-read 250 at a time inside the existing atomic epoch transition; no full account-scope array or authority-model change |
| Saved UI reads | One visible selected page and bounded detail/facet queries; inactive query `gcTime=0`, no implicit focus/reconnect refetch or retry; logout/context owner clears cache |
| Polls | Export intervals 2–10 seconds; automatic refresh due check 60 seconds, backoff ceiling five minutes; foreground job follow budget five minutes |
| Context CSV | Only the bounded selected detail connector projection, not every connector/operation relationship |
| Purview / Defender | Purview ≤20 record pages/5,000 records/8,000,000 total bytes; each response ≤2,000,000 bytes. Defender ≤200 stored rows (201st detects partial) /2,000,000 response bytes. Both retain 30-second request budgets, at most three retry attempts, seven-day query windows and one-hour qualification windows; no generic provider-storage rewrite |
| Backup / review | Explicit table/key inventory; indexed ≤250-record fingerprint slices stream binary COPY frames containing ≤32-KiB text pieces; review batches ≤250/1 MiB; exact-current review ≤100,000 IDs and report-selection review ≤10,000 tenants |

### Disposable lifecycle qualification and cleanup

**Current production-first campaign scope:** phase06 capacity qualification was
curtailed by the user, not passed. Do not launch `all`, another capacity run,
detail sweep, or synthetic soak for this handoff. Use
`-Suite production-prerequisites` for pending schema/report/lineage and harness
correctness, or `-Suite production-counts` for count-ledger and snapshot/restore
repairs. Neither selector launches a capacity/browser workload. The diagnostic
`production-gate-cost` selector runs only the two measured slowest backend files
and captures bounded synthetic PostgreSQL duration logs; it is not qualification.
Explicit software qualification and cleanup remain mandatory for production
proof; normal local start is not that proof. Production compilation now occurs
once in the Docker build and is reused by qualification. Its four commands are
frontend lint, full frontend typecheck, backend tests (1,200 seconds), and frontend
tests; the other three commands retain 180 seconds each. The outer software
workload deadline is 35 minutes. Per-test deadlines, assertions, fixture sizes,
isolation and resource limits are unchanged. Earlier timeout results remain
failures. Actual full qualification and fresh-installation proof are still
required before production reset or deployment.
See `plans/large-tenant-data-platform/completions/07-production-convergence.md`.

The current schema adds a per-report-version membership count maintained transactionally
by INSERT/UPDATE/DELETE statement triggers. Runtime access is SELECT-only and
readiness rejects missing SELECT or write/execute privilege drift. Selected
history reads use that count; all facts already use the current typed schema,
without a `typed_version` predicate. Physical membership validation still
governs publication. Backup reconciles counts in
its exported snapshot before writing a dump. Restore reconciles before authority
review/retention and again afterwards. Restored count SELECT is granted before
retention readiness, while mutable grants still follow authority review.

Run from the repository root, without inherited provider/database credentials:

```powershell
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite lifecycle
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite lifecycle-acceptance
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite restore
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite restart
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite browser
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite all
```

`browser` builds unique checked-in Dockerfile operator/runtime/permission-browser targets, runs the synthetic-auth Vitest bootstrap with focused `largeTenantData.spec.ts`, then the unfiltered existing desktop/mobile matrix. It is never bare Playwright or a retained app. `restart` uses operator-only seed/expire and separate compiled runtime crash/recover containers; both assert `/api/ready=200`. Success requires dispatch marker **and exit 17 and persisted receipt-selected state**, then successful recovery/readback. Runtime has only its app DB password and synthetic auth settings, plus the exact read-only harness/receipt mounts under its matched UID/GID.

`restore` dumps only its owned `agentcontrol_test_*` child and restores to a distinct guarded `agentcontrol_restore_*` target via the existing operator (never `testDatabase` with a weakened prefix). It verifies snapshot consistency, facts/pointers, runtime grants, maintenance readiness 503 and reviewed readiness 200 with provider work still disabled.

All fixtures use fixed Node 1,536 MiB / V8 768 MiB / PostgreSQL 1,024 MiB budgets, owned disk PGDATA, no published ports and no production mounts/provider route. Installed dependency reuse first verifies all four manifests and protected base image IDs; no public registry fallback. Diagnostics retain exact exits, bounded logs, inspect/OOM/limits/mounts, receipts and image IDs under `artifacts/large-tenant-data-platform/<run>`. After connections close, drop tracked child/restore/control databases, verify absence, then remove only exact ownership-labelled containers/network/volume. A cleanup failure remains a qualification failure; never global-prune or remove a retained project. `all` is independent command evidence, **not** a replacement for the unchanged five-command deployment safety gate.

### Fixed-budget capacity evidence

`pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite capacity`
builds a uniquely tagged synthetic candidate using the protected installed
dependencies, then attempts three clean owned fixtures. It never uses retained
application configuration. `capacity-query` is the separate 10k/100k diagnostic
comparison, not a substitute for the full workload; `capacity-probe` isolates the
real transient-heap detector; `capacity-focused` runs its regression contracts.

The capacity model deliberately does **not** inherit lifecycle PostgreSQL tuning:
app/worker 1,536 MiB, 1.5 CPU, four connections and 768-MiB old space;
PostgreSQL17 1,024 MiB, 0.5 CPU, 32-MB shared buffers, 4-MB work memory,
64-MB maintenance work memory, no parallel gather and 15-second statements;
separate provider/controller 1,024 MiB/1 CPU. PGDATA, WAL and PostgreSQL temporary
files use the exact owned disk-backed volume, with at least64 GiB free before
loading and a48-GiB volume stop. No host/VM tuning or shared-resource cleanup
is authorized by a qualification failure.

Each process/isolate records actual Node/V8 versions, arguments and heap limit.
The250-ms samples are lower-bound observations, **not** a heap high-water proof.
Raw `--trace-gc-nvp` output preserves V8 pre/post object sizes and allocated
bytes separately. Node24's `start_object_size`/`end_object_size` are object-heap
sizes; `start_memory_size` is not a substitute. Targeted synchronous hooks cover
provider JSON, batch serialization, SQL results, import transformation and
export encoding; the harness also checkpoints serialized responses. Hooks are
inert outside an explicitly installed observer and do not monkeypatch global
JSON. Telemetry has finite buffers/files and reports drops as incomplete
coverage, including serialization failures and values that have no JSON
representation; those failures never write an invalid JSON line. The probe retains at least32 MiB, crosses baseline+16 MiB, releases
and collects in less than250 ms while the timer misses it. Forced GC is
probe-only.

Each telemetry instance owns one unreferenced250-ms timer from `start()` through
`stop()`, including initial/final samples. Repeated starts/stops are idempotent;
restarting a stopped instance or overlapping isolate samplers is rejected.
Request windows also sample both boundaries, even if no timer fires during a
short request. Observer setters return installation-specific cleanup functions;
replacing an observer does not transfer in-flight query/publication work to the
new observer. Query hooks cover promise, callback (including pool queries) and
`pg.Query` completion/error APIs, retain config-object SQL/parameters, and use
the submitting operation's async context rather than the pooled socket's.

Report sampled heap, pre-GC heap, stage-checkpoint heap, combined observed heap
and kernel-charged memory separately. Cgroup peak includes file cache. Required
headroom is80% for **both** app and PostgreSQL; observed heap must be at most
615 MiB **and** have successful detector/coverage evidence. Missing counters,
dropped records, an over-duration probe or unmeasured stages cannot pass.
Heap coverage also requires complete nonnegative safe-integer byte samples,
matching PID/isolate and terminal identity, and the actual workload Node/V8
versions, heap limit and arguments. Loader GC remains separate from identified
workload/lease-worker heap maxima; incomplete raw evidence remains inconclusive.
The result/command files preserve failed and inconclusive profiles; an ingest
or exact-ID oracle passing does not imply that latency, storage or heap gates
passed. Phase06's completion record is the support statement, not fixture size.
Database activity, lock waits, temporary-file counters and approximate live/dead
tuples are sampled through the same four-connection application pool. PostgreSQL
logs are streamed before cleanup; disk samples distinguish volume, WAL and
backup bytes. The row estimates in PostgreSQL statistics are not exact fixture
truth or physical-read counters. Physical write instrumentation labels actual
transactions and counts trigger/cascade changes; its exact membership-seek
EXPLAIN does not alone prove all internal read amplification. Tagged committed
transactions additionally capture PostgreSQL transaction-local sequential/index
tuple visits and heap fetches (not sampled global statistics or buffer bytes).
Rolled-back work is explicitly excluded. Per-operation WAL intervals are
precommit cluster deltas: concurrent/maintenance work can overlap, so these are
not claimed as attributable transaction WAL. The isolated fixed-component probe
also retains its complete before/after cluster-WAL delta.
Both isolated20-key probes begin after an actual `CHECKPOINT`, so one is not
measured immediately after a checkpoint while the other reuses already-dirty
pages. Earlier unmatched checkpoint-age measurements remain preserved failures.
This is not per-batch checkpointing or Node forced-GC normalization.
Write evidence combines repeated transaction counters by operation/relation/action
inside each250-counter flush, preserving exact sums without serializing a million
redundant rows. Read totals remain per tagged committed transaction; detailed
relation rows are retained for both fixed probes and bounded high-water samples.
Telemetry caps are unchanged and any earlier capped/dropped run remains
inconclusive for heap coverage.
Committed publication timings include acquisition and the complete final
transaction; rejected attempts are counted separately. The diagnostic emits
synchronous request-window markers into the raw GC stream, so per-request GC
peaks do not depend on guessing alignment between V8 and performance clocks.

The full fixture also hosts the real authenticated Express routes inside the
same capped worker. Twelve HTTP readers, slow downloads and a real disconnected
download execute in the separately capped internal controller. Its synthetic
session issuer renews fixture-only role claims using the real clock; no Entra
authority is contacted. This HTTP profile is separate from the simultaneous
12-reader/two-replacement/two-export/GC profile; do not combine their receipts
into an unmeasured concurrent HTTP claim. The controller counts rejected
requests rather than treating them as successful throughput.

The exercised engine uses cgroup v2. On a v1 host, equivalent raw evidence is
`memory.usage_in_bytes`, `memory.max_usage_in_bytes`, `memory.limit_in_bytes`,
`memory.failcnt`, `memory.oom_control`, `memory.stat`, `memory.memsw.*`,
`cpu.cfs_quota_us`/`cpu.cfs_period_us` and `cpu.stat` (throttled nanoseconds,
not v2 microseconds). A missing cumulative OOM counter must remain inconclusive;
`under_oom=0` is not a zero historical OOM count. The current runner fails
coverage closed where its v2 paths are unavailable; it does not qualify v1.

Canonical reconciliation's coalesced pending requests add only keys newer than
the last captured pending vector. Earlier pending sequences already retain
their changed keys until claimed; repeatedly re-copying the entire range since
the active worker would make sustained small updates quadratic. Safe updates
still permit that worker to publish its captured vector; invalidation fences
and current mutation authority are unchanged.
The churn producer still sends exactly5,000 twenty-key batches per sweep; its
consumer claims every20 batches (or the final batch) to exercise real coalesced
work rather than starting5,000 workers which finish before the next input.
This does not change runtime admission, batch limits or component sizes.
Queue snapshots sample the following batch to detect genuine active+pending
overlap; every final changed value is independently checked in bounded slices.

Inventory broad-page transactions disable JIT and discourage nested-loop joins:
the measured union-view estimate previously caused an N-by-N materialization
after `ANALYZE`. Their root source and scope also constrain the union explicitly,
and native roots never expand canonical membership branches. Point/detail reads
keep their ordinary indexed plans. Report typed-fact validation counts the
FK-protected immutable membership rows and checks the sparse invalid-fact index
added by the current schema; it no longer joins a million valid payloads merely to count
them. Null-typed facts still reject acceptance and preserve the old publication.
Directory-plan insertion also disables JIT
when its bounded indexed-parent validation discourages sequential scans. These
are measured planner repairs, not capacity claims or increased SQL deadlines.

The current schema adds a separate, tenant-FK-scoped inventory collection cursor and
indexes both canonical-source and compaction-source references. Collection scans
at most250 ordered keys, considers at most50 unreachable keys, and shares the
existing1,000-row/1-MiB/5-second transaction budget across250-row deletion
statements. A partially collected key remains ahead of the cursor; completed
scans wrap to revisit keys whose pins subsequently disappear. Advancing GC must
not update authorization-scope rows or introduce selected-read snapshot
conflicts. Runtime grants and the current explicit107-table backup inventory include
this operational cursor. Retention diagnostics use bounded scoped keysets:
zero is exact after exhaustion, while the first orphan is reported only as
`at_least_1`, never a fabricated count. Historical immutable generation byte
counters remain historical; admission quota excludes collected generations.

The controller RPC flushes its headers and bounded progress whitespace while
the real HTTP load executes. Its disconnect aborts every outstanding reader;
the 20-second HTTP request bounds and 15-minute export bound are unchanged.
The fixture's Graph catalog/detail records carry matching real revision markers:
without those markers automatic detail enrichment correctly refuses identity
links, so a fixture cannot claim its intended mixed-identity oracle was exercised.
The page-order profile streams all100k IDs through signed cursors, checks a
separate deterministic checksum, and explicitly visits first/middle/last/reverse
pages and three filters without extending the normal selection lease.

Activity CSV downloads retain a15-second header/read-idle network bound, while
staged database backpressure is governed by the unchanged30-minute source
deadline and independent lease heartbeat. A single15-second timer spanning
network plus every awaited database batch previously cancelled a healthy100k
stream. Both a15.2-second real consumer pause and a stalled network reader have
regression coverage; neither changes the source deadline or lease settings.

Presentation facts are sparse: absent sort values and false classified-view
predicates are not stored as redundant child rows. Known zero and empty strings,
all observed provider collections, identity evidence and facet values remain.
Readers reconstruct the complete nullable column envelope before byte-prefix
accounting; absent facts still sort/filter as SQL NULL. Ordinary opaque cursors
resolve their signed native identity directly; exceptionally wide identities
retain the bounded digest anchor. Both paths are tied to the same immutable
selection, query hash, principal and revision.

Backup fingerprints retain the current streaming byte algorithm and one repeatable-read
snapshot. Bounded binary COPY replaces a network round trip per four fragments.
Each statement seeks after the previous primary key and reads at most250 records;
offset249 is constant, never an offset growing with table cardinality. The
decoder retains only19 framing bytes and hashes at-most32-KiB chunks directly,
including fragmented UTF-8, without buffering complete rows or tables. It rejects
unexpected framing, oversized chunks and incomplete streams. The15-second
statement guard and restore's distinct-target/provider-disabled checks remain.
The capacity backup uses the operator credential only against its verified
synthetic database. Its two runtime slots, one operator snapshot connection,
and one `pg_dump` connection fit the original four-connection ceiling. The
operator snapshot client installs the same targeted SQL-result checkpoint
hooks as runtime transactions; no privileges are added to the application role.

Accepted report-staging cleanup seeks the existing `(parent,ordinal)` indexes
before its unchanged25-row slice. Sorting every million-row staging set by
physical `ctid` before `LIMIT` caused an actual5-second transaction termination.
The bounded byte accounting still operates only on selected candidates.
An already committed acceptance remains successful if subsequent cleanup is
unavailable: it emits `official_report_staging_cleanup_deferred`,retains the
durable idempotent receipt,and leaves its reservation for ordinary resumed
retention. This is not permission to ignore a backlog: any deferred event or
staging age above600seconds requires diagnosis and closed new-import admission
until quota convergence is demonstrated.
Checked-out PostgreSQL clients retain a bounded connection-error guard. A
transaction-timeout socket close rejects the work, preserves rollback evidence,
discards the unusable connection and releases admission; it must not become an
unhandled Node`error` event. A real100ms PostgreSQL transaction-timeout regression
checks subsequent permit reuse. Temporarily narrowing the backup runtime pool
to two connections also narrows foreground admission to one, preserving the
separate renewal slot instead of silently borrowing it.

Latency histograms separate successful requests from failures and legacy
unknown outcomes; rapid rejections cannot improve a successful-request
percentile or satisfy the1,000-successful-request gate. Controller cgroups are
reported separately, never added to the application's memory allowance.
Bounded first-seen SQL templates survive a missing final summary, and grouped
physical-write counters retain exact sums without one log event per trigger.
The separately capped controller reuses the immutable, architecture-checked
protected Chromium image and the candidate's installed dependencies; both
candidate stages build with networking disabled and no installs. Its real
browser opens the compiled UI against the actual100k-plus inventory, rejects
all nonfixture origins before requests leave Chromium, navigates forward/back,
checks bounded DOM/list/detail responses and idle no-autodrain behavior. The
dedicated full browser suite still supplies explicit cache-eviction and terminal
polling contracts; those receipts must not be relabelled as100k UI measurements.
Node's250ms samples no longer duplicate the large`memory.stat`/`cpu.stat`
blocks already preserved by each service's independent250ms raw cgroup capture.
Scalar charge,limits,events and swap remain in Node samples. The256MiB telemetry
ceiling is unchanged; any dropped event still makes heap coverage inconclusive.
`capacity-query` additionally reproduces the identical10k mixed-identity/
twenty-key probe before its cursor comparison. A failed pair query captures a
bounded,nonexecuting PostgreSQL plan immediately after rollback. Such a plan
is explicitly`analyzed:false`; it is diagnostic evidence,not substituted for
the successful-path`EXPLAIN (ANALYZE,BUFFERS,WAL,SETTINGS)` receipts.
The fresh cold-statistics pair plan chose whole match-index scans with estimated
one-row cardinality and actually timed out at15seconds. Pair reconciliation now
materializes only one record's facts before matching and retains parameterized
scope/kind/value seeks. This preserves the captured membership,ambiguity and
previous-component checks without requiring foreground`ANALYZE` or a larger
statement timeout.
Measured delta work also exposed whole-baseline reads despite only20 logical
changes. Isolated previous-component lookups and interval closure now retain
parameterized point seeks. The final closure updates only tuple IDs obtained
under the existing scope-publication lock; it neither sorts nor scans all
membership tuple IDs. Real read counters and a PostgreSQL Tid Scan regression
cover this distinction. Identical100k component probes run before replacement
churn. Indexed name seeks restore the broad-join planner mode before enrichment;
leaking nested-loop tuning into that larger relation caused a retained15-second
timeout and is not considered a successful optimization.
The current schema replaces only the per-row membership **insert** guard with
an equivalent set-based statement guard over its transition table. Every
distinct baseline/revision must still resolve to a validated,published head;
one invalid row rejects the whole statement and transaction. Existing
per-row update/delete,pin,immutable-content and foreign-key guards remain.
This attempts to reduce100k publication work without hiding it from the
transaction-duration metric or moving visibility ahead of validation.
Readiness checks both trigger modes and the noncallable runtime helper;
mixed valid/invalid insert tests prove rollback. It grants no new runtime
privilege and requires the current schema, not historical SQL replay.

The measured100k inventory page unnecessarily materialized all1.3million report
facts before discovering that its native IDs were unlinked. Inventory now
resolves reviewed/exact semantic links against agent headers first,then reads
only those linked agents' immutable report facts through the existing agent
index and captured version memberships. The shared official-agent aggregation
still preserves observed relationship counts and known-zero versus unknown.
No fuzzy/name-only links or alternative report authority are introduced.

Actual summary plans also scanned8.9million facts for absent Teams/availability
predicates. The current schema adds two sparse source-reference indexes for
those exact predicates. Unfiltered aggregate counts and verification totals
have a per-database-pool,at-most32-entry/16KiB-per-entry read-through cache keyed by the
opaque selection. The database remains authoritative: every request first
validates principal,session,epochs,pins,query and association revision; expired
entries are not used. Filtered aggregates—including mutable people/search
filters—are not cached. Job status,current-head/source freshness and returned
records are recomputed,not cached. Eviction/restart only causes recomputation;
the cache contains no full dataset and cannot authorize a read or mutation.
Its weakly held pool lifetime survives request-scoped native package readers;
constructing a new reader does not recompute the same immutable aggregate on
every page. Authentication and application-scope capability checks still run on
every request before this cache can be read.
Selected users/report counts and summary/analytics envelopes have the same
32-entry/16KiB bounds. Their expiry is the captured selection's expiry,not a
sliding60-second idle timer: the rows,source vector,query and evaluated-at
time are immutable. Otherwise a minute of unrelated cold queries or plan
capture discards the exact aggregates and turns warmed bounded pages back
into whole-selection scans. Every selected read still validates its live
authorization,epochs,pins and expiry before and after using these values;
an invalidated selection cannot use the cache. No selection lifetime or
cache-entry/byte budget is increased.
Generation sync-mutex and writer-fence lookups materialize the one exact
generation ID before applying scope/tenant/state/lease predicates. This
prevents small or stale planner estimates from using a tenant admission index
to visit unrelated generations on every detail transaction. The sync mutex,
scope/head/generation lock order and every owner/version/epoch/cancellation/
deadline check remain; the writer's exact generation row remains locked.
Stored component catalog/detail dates likewise use correlated exact-ID
lookups. Their LEFT semantics preserve missing lineage as null,while preventing
a metadata-wide hash join for every small component batch when another query
has disabled nested-loop planning. The normal100-record/1MiB work envelope
and immutable source/fact reconstruction remain unchanged.
The separately capped capacity browser uses the internal HTTP origin
`http://test-db:8081`,which Chromium does not normally consider a secure
context. Unlike the authorized localhost deployment,that DNS name otherwise
has no native`crypto.randomUUID`,preventing the UI from issuing selections.
Only the isolated harness grants that exact origin secure-context treatment
with Chromium's launch option;its request allow-list still blocks every other
origin. No application crypto polyfill,authentication bypass,global browser
setting or production exception is installed. A real authenticated Chromium
bootstrap verifies`isSecureContext`,native UUID availability and a generated
version4 UUID before data loading;the separate100k UI navigation/detail test
still runs in full and is not replaced by this platform probe.
Native`catalog` and`power_platform_only` scopes are recognized as no-op filters
only for their matching native source. A canonical`catalog` filter is not a
no-op and does not receive that optimization. The current schema also adds disjoint
short/long name indexes: short names use an exact indexed64-character key;
long names retain their complete key and original C/ICU collation. The bounded
merged candidates alone receive presentation/report enrichment. Reverse and
opaque-ID cursor contracts are unchanged. The original per-user plan ceiling
remains1,000; the required10,000-user wide profile contains500 plans per user.

The first full79-schema run still timed out while computing the uncached
199,998-record canonical summary. The current schema adds a scoped partial
index for its five categorical fact kinds. Unfiltered summaries aggregate
those facts set-wise,without evaluating per-record scalar lookups or unused
report presentation fields. The aggregate preserves absent values,multiple
package mutation targets and duplicate-singleton rejection. Filtered summaries
retain their existing query path; native/canonical parity tests compare the
new aggregate against that independent path. Index keys do not include
unbounded fact values or payloads. These are measured-root repairs,not a
capacity-support claim.

PostgreSQL17's `pg_stat_get_xact_*` scan getters expose pending backend
counters that can still contain earlier committed transactions. Capacity read
instrumentation therefore subtracts a same-backend snapshot taken immediately
after `BEGIN` from the snapshot before `COMMIT`; reset,missing or truncated
counters are inconclusive,not zero. Both snapshots' overhead is measured.
The parser requires `transaction-difference-v2` on both fixed probes.
Earlier unsubtracted read totals remain in raw evidence but cannot establish
read amplification. Physical write triggers and cluster WAL intervals are
separate measurements and are unaffected by that correction.
Replacement cycles admit both real collector leases and create both export
jobs before releasing their first provider requests into12-reader/GC
contention. This avoids accidentally testing only requests rejected before
admission. Acquisition timeouts,queue limits,lease clocks,source deadlines
and all eventual work/rejection checks remain unchanged.
Capacity inventory jobs now reserve the same1GiB as the shipped inventory
runtime; directory/activity jobs retain their existing8GiB generation maximum.
Earlier capacity attempts used the8GiB maximum for every source and are labelled
accordingly. No production quota,resource or reservation setting was widened.
The mixed-identity baseline and uniform sparse churn are distinct full-size
profiles. A conflicting package correctly refuses a subsequent non-authoritative
detail update; it must not be silently treated as a successful changed-value
sweep. The sparse profile freshly collects100,000 packages and100,000 PP
resources into a separate principal before measuring both5,000×20 sweeps.
Its200,000 singleton canonical components have an independent expected count.
No broad replacement or compaction occurs during those sweeps. A separate
fresh100-source merge/split adversary uses the actual authoritative exact
collector for identity changes,not a weakened detail guard. Both sweep digests
and bounded mismatches are retained before final value assertions.

Identity-expiry scheduling starts with the scoped expiry range index,then
checks captured membership and source links by exact keys. The range horizon
is the statement's actual wall clock,not transaction-start `now()`; the
volatile expiry predicate remains a recheck. Newly expiring records are
eligible on the next scheduler statement. A real-clock regression begins
a transaction before expiry and verifies expiry afterward in that same
transaction. This does not change mutation-authority checks.

Broad inventory publication no longer writes a duplicate per-identity
change log. Reconciliation detects a changed baseline and seeds every member
of its captured root; within-baseline deltas still journal their exact keys.
Publication retains its reported changed count,atomic head transaction and
fences. JIT is disabled only for the inventory publication transaction.
The remaining measured broad-membership INSERT cost is moved out of the head
transaction by the current schema. Validated broad generations prepare their
existing membership representation in at most250-key transactions behind a
noncurrent root,then seal its count. Readers still see only the prior published
root until the final atomic switch. Every preparation slice retains lease,
version,epoch and source-pin fences; active staging and sealed rows cannot be
collected or changed. Failed/cancelled preparation leaves the old head intact
and remains eligible for bounded cleanup. Within-baseline deltas retain their
existing pointwise publication path. Compaction reference scratch rows are
collected after publication rather than deleted N-at-once inside its head swap.

Operator retention convergence verifies the complete schema once on its
owned connection while holding the shared schema advisory lock. The
ordinary bounded transactions,cursors,quotas and complete quiet traversal
remain mandatory; initialization's exclusive lock cannot overlap them.
A public single-pass retention request still verifies its schema.
Membership retention keeps its original scope lock and pin/inherited-root
checks,but selects current closed intervals and unpinned retired roots through
separate indexes. At most997 selected tuple IDs are deleted; an OR across
both reachability cases no longer forces scanning/sorting every current
member. The1,000-row/1MiB/five-second slice ceiling is unchanged.
The current schema adds an inclusive cursor rewind when references are released or
staging keys become collectable behind the current cursor. Statement transition
tables coalesce the earliest generation/identity per source scope; progress rows
are locked in scope order. This is a scheduling hint only: every deletion still
checks the actual references, generation state, pins and ordinary scope fences.
Both the generic lifecycle slice and membership cleanup reserve cursor-update
work before deleting and count the trigger's actual row/byte writes afterward.
Inventory collection uses nonblocking sync and scope fences: a busy reader or
writer is skipped for the next fair traversal rather than consuming the
five-second transaction budget while waiting for its fence. Mutation and
authorization invariants remain unchanged.
Selected repeatable-read scopes use shared authorization locks,including
nested final assertions and read-selection capture. Epoch updates remain
blocked until the readers commit; ordinary writer assertions retain exclusive
locks. The exact pooled-client read context is cleared on every exit.
Read-only actor epoch lookups also share their fence; generation admission
and revocation retain exclusive actor locks. A request must still validate
the captured actor/scope epochs inside its selected read.
Membership slices admit at most997 interval rows, leaving room for the cursor
and existing metadata writes. The whole1,000-row/1MiB/five-second ceiling remains
unchanged, including those previously hidden writes. `capacity-core` runs the
actual schema/cursor/termination/instrumentation regressions before the broader
`capacity-focused` qualification.

The observed deep-child fixture remains a separate unsupported candidate
envelope,not a normalized-quota pass: the frozen provider parser permits at
most50 element groups and100 elements per group. A single10,000-element
group is rejected before the normalized10,000-total-fact quota; retained
metadata also consumes that latter quota. Neither limit is raised to make
the100-agents×10,000-observed-children requirement appear supported.

The current schema introduced scoped retained-generation charges; the current schema
isolates them in the runtime-read-only `data_generation_charges` relation.
Ordinary quota changes and no-op scope reuse must not create new authorization
epoch row versions: doing so caused repeatable-read selections to fail during
otherwise safe detail churn. Existing scopes are locked without rewriting them.
Admission reads the positive scoped charges and the live
generation lease index rather than scanning every retained detail generation.
Only the fenced generation trigger changes this counter; collected generations
charge zero, active writers charge their reservation, and other retained
generations charge their actual bytes. The old counter column is removed, not
retained as a second reader/writer. Restore/retention verification compares
the counter with the authoritative generation sum. Retention locks scopes
before charge-changing generations, skips writer-held scopes, and includes
the trigger's charge-counter update and serialized bytes in its unchanged shared
1,000-row/1MiB/five-second budget.

The current schema checks child INSERTs once per affected generation using
statement transition tables on `directory_service_plan_rows` and
`inventory_facts`. Parent lookups remain indexed point reads; all original
lease/state/epoch/schema checks,inventory worker pins,composite FKs and field
constraints still reject the entire statement. UPDATE/DELETE retain their
original per-row immutability/reachability fences. Readiness checks both trigger
modes and closed helper ACLs;restore reapplies those ACLs before validation.
This targets measured repeated child-row guard CPU,not a larger batch/resource
budget. Final-source capacity evidence remains in the phase06 completion.
The churn harness enforces its existing60-second canonical publication
deadline after every batch;expiry records a failed incomplete attempt,never
a reduced-cardinality success. Idle canonical workers are claimed promptly;
the first staged publication barrier waits only for the next real source batch
to create pending work,not for an artificial20-batch accumulation.

The capacity app must use the application's single configured pool,including
its process-scoped capability/sync/job services. The isolated harness binds
that unused pool once to its populated child DB/runtime role before any
connection;using a second injected pool leaves those services on the empty
control DB and invalidates full-app/aggregate connection-budget coverage.
Bootstrap capability,sync-state,and refresh-history GETs must return200 before
large loading. Named app/lease/operator/backup connections are included in
server-side diagnostics;the four-connection ceiling is not enlarged.

Metadata GC first selects one completed, inactive worker in its own scope,
then seeks that worker's frontier/edge index. Change-journal and reconciliation
request slices use their indexed revision/sequence order rather than sorting
all eligible tuples by physical address for every50-row slice. Active workers
and their pending vectors remain protected. Backup child failures report the
unchanged120-second timeout, elapsed time and killed flag without emitting
database contents; a timed-out restore remains a failed restore.

Directory/activity matching aggregates alias cardinalities before joining.
It preserves duplicate-UPN, object-ID/UPN and multi-row ambiguity without
forming a duplicate-key cross product. The immutable matched-count cache holds
at most32 scalar generation pairs per pool; availability, latest-attempt and
freshness metadata are still read on every capture. Inventory person labels
use exact directory identity lookups and do not calculate whole-tenant
activity matches merely to retrieve a display name.

Selected Users pages reuse only bounded immutable count/summary/analytics
results after the ordinary selection, principal, epoch and report fences.
The pool-shared cache permits32 entries of at most16KiB. For direct directory
filters and ordering, subsequent pages preselect at most101 directory keys,
then fetch their exact report evidence; whole-directory ambiguity and global
unresolved evidence remain unchanged. The current schema indexes the actual
PostgreSQL normalized report-name expression rather than assuming JavaScript
and PostgreSQL Unicode ordering are interchangeable. Other filters retain
their complete relational semantics. Source exports from mixed canonical
roots apply their exact source-kind predicate before the indexed name seek,
not after taking an arbitrary unfiltered page.
Every export read transaction independently disables JIT, including child-only
reads and later pages that reuse their captured context. Indexed member/child
lookups restore nested-loop planning after the broad page's set-based plan.
Transaction-local settings from an earlier read are not assumed to survive
COMMIT. The unchanged5,000-agent/10,000-source export test records bounded
per-query costs and retains its original15-second assertion.
The at-most101 selected inventory rows and their projected facts are
materialized once inside PostgreSQL; exact canonical-source members are fetched
by parameterized lateral seeks. Broad relations remain set-based and are not
materialized as a request-wide JavaScript collection. This prevents a planner
statistics change from repeatedly expanding the same bounded projection into
whole-source joins. The integration receipt includes the actual bounded
projection's`EXPLAIN(ANALYZE,BUFFERS,WAL,SETTINGS)`after the original measured
export deadline assertion.

The real HTTP parser's explicit`source=all`default is a neutral filter, just
like`inventoryScope=all`; it retains bounded page preselection and immutable
summary reuse after the ordinary authorization/selection fences. Literal
facet values such as publisher/type`all`remain real filters. Both native and
canonical regression pages exercise the explicit defaults, and the10k/100k
diagnostic records those same query inputs instead of omitting`source`.
The current schema supplies the missing partial tenant admission index for
active or pending reconciliation. The exact20-job tenant queue limit,
epoch/expiry checks and coalescing semantics are unchanged. Both independently
opened validation transactions disable sequential-scan preference and JIT
before their exact root/worker-pin checks; planner settings from an earlier
transaction are not assumed to carry over. Actual physical sequential reads
remain part of the strict10% amplification gate, even for small counts.
Exact selected inventory reads also disable JIT locally and use the captured
domain/scope with parameterized record seeks. The actual100k heartbeat fixture
had exposed roughly600ms per20-key read from the old unbounded union plan,
starving the unchanged five-second acquisition bound before its retry wait.
The600-second real wait must be rerun; no shorter wait substitutes for it.

Selected official-user, official-agent and relationship name pages can seek
at most101 captured primary fact keys after their exact immutable counts
prove that no bridge-only/duplicate primary group would be omitted. Otherwise
they retain the complete relation. User enrichment still checks all directory
aliases and all report aliases for the candidate identities; it cannot turn
ambiguous identity evidence into a match. The current schema's128-character normalized
name-prefix indexes bound index entries for accepted wide UTF-8 names.
The full normalized name and full identity remain cursor/order comparisons:
the prefix is an index aid, not truncation or a replacement sort key. Exact
set/version membership remains mandatory at every seek.
Large official-agent cold pages compute page, summary and analytics in separate
statements of the same selected repeatable-read transaction. This targets the
measured combined15-second statement timeout without changing that deadline,
the complete metrics or the bounded immutable envelope cache. Capacity traces
capture bounded cold and warm actual plans before releasing their source pins.
The lease-death subprocesses also expose their actual four-connection pool and
write terminal memory telemetry before re-raising the same real`SIGTERM`.
They do not abort, publish or clean up their lease: real expiry/takeover remains
mandatory. Heap qualification includes both workers' SQL checkpoints, samples,
raw GC, identity and dropped-record/terminal receipts. Missing worker counters
or a missing terminal record makes the full heap bound inconclusive; parent
samples or a loader GC cannot fill that gap.

The capacity HTTP controller records one cold selection separately before
its1,008 concurrent warm requests. All12 readers share that authorized pinned
selection but still traverse the real request and selected-read fences.
Cold failure fails the profile; it is neither retried away nor counted as a
successful warm request. Earlier runs without this warmup remain separate
evidence. The in-process report oracle checks the actual `directory` DTO for
Copilot users; it does not assume an obsolete outer `identity` object.
Each replacement cycle likewise records one cold page for its five selected
inventory/report snapshots before starting the unchanged concurrent work.
A cold failure is retained and fails that cycle, but does not omit its full
replacement/reader/export/GC attempt.

Isolated software checks may clone a sealed test-schema template instead of
initializing current DDL for every test file. Its name and ownership marker
are bound to the unique `agentcontrol_test_*` fixture and compiled schema
fingerprint. Initialization creates the current schema and grants
once, verifies the result, closes connections and disables template
connections. Every clone keeps its own database, runs bootstrap and runtime
schema verification, and receives no rows written by another test.
Fresh-initialization tests still start empty. Mismatched template ownership,
seal or marker fails closed without modifying that database. Templates live
only in the owned disposable fixture volume; no production template, deadline
increase, parallel backend files, omitted assertions or reduced fixture is
involved.
The disk-backed`compose.large-tenant-test.yaml`override also restores
PostgreSQL's1GiB`max_wal_size`checkpoint target while keeping32MiB
`shared_buffers`,32MiB`min_wal_size`,all memory/CPU limits and every deadline
unchanged. The ordinary small-fixture`compose.yaml`64MiB WAL target and
production settings are unchanged. This is retained WAL disk headroom,not
application or PostgreSQL RAM. Repeated0–1-second WAL checkpoints were
observed during the unfiltered5,000-source timeout; log/checkpoint evidence
must demonstrate the change's effect before claiming a software-gate repair.
Capacity's separate model already uses PostgreSQL's default1GiB WAL target;
this override does not change its qualified resource model or48GiB disk stop.
`-Suite capacity-software`repeats exactly the five independent`all`software
commands after a fixture-only repair without repeating already-executed
auxiliary/full-capacity workloads. It does not replace`-Suite all`,the
unchanged original`software-gate`,or any required browser/restore/capacity
attempt,and keeps the independent runner's existing600-second command bound.
Initialization timings identify full schema-template creation, verified clones
and deliberately empty initialization fixtures separately in the normal software
logs. The physical capacity observer retains v2 same-transaction subtraction
but combines each counter/WAL/operation endpoint into one bounded SQL request.
Its real PostgreSQL calibration compares the coalesced snapshot with the
independent row-wise snapshot; every tagged committed transaction remains
observed, and measured observer overhead is still reported.
The first worker in each full detail sweep has a measured publication barrier
at its second authorization callback: real captured work has been staged,
the next actual20-key provider batch is published/enqueued, and active plus
pending state is read before releasing publication. No SQL transaction or
connection is held at that barrier; ordinary leases, heartbeats and deadlines
remain unchanged. The wait for the staged worker is bounded at30seconds.
This is an explicit concurrency scenario,not a fake clock or a manufactured
queue row. Each sweep still contains exactly5,000×20 keys; the barrier adds,
omits or duplicates no source batch.

## Maintenance and current-schema initialization

### Bounded package-job results

Package mutation job status/history now return scalar counts and a monotonic
`resultRevision`; they do not embed result arrays or duplicate `job.result`.
`GET /api/agents/bulk-jobs/:id/items?revision=...&limit=50` reads one bounded
outcome page (maximum 100). Follow only its authenticated next/previous cursors.
Progress invalidates an older result cursor with `selection_invalidated`; refresh
status and restart the result pages instead of silently combining revisions.
Counts of inconclusive, reconciliation-required, retry-eligible and cancelled
items cover the complete job, not just the visible page. No status/history GET
performs recovery writes. The server recovers expired leases in non-overlapping
30-second background passes, rechecks process/marker and persisted maintenance
before each tenant's package and quarantine recovery slice, and drains an active
pass before database shutdown. Closure or an unavailable operational-state read
prevents the next slice; a later open pass resumes ordinary expired-lease recovery.
Explicit resume/reconciliation still requires current
authorization and the existing mutation-admission gates. Large reconciliation
work reads bounded ordinal batches and reports exact attempted/failed counts;
error examples are capped at 20.

“Select all matching published versions” retains a server selection, not a
downloaded target list. Preview stages native IDs and prestates in bounded SQL
batches, with at most 5,000 block targets or 100 access targets. A confirmation
shows at most 20 targets; its digest covers all staged targets in C/UTF-8 order
without normalizing opaque IDs. Previews expire after ten minutes, with admission
limits of five outstanding previews per actor and forty per tenant.
Submission rechecks current membership and control authority. Historical read
pins never authorize writes: changed source heads, expired evidence, revocation,
clear or pending control publication require a fresh preview.

The current schema also freezes source-generation (including its control revision),
opaque source identity, canonical identity and authority deadline on each staged
job item. Preview/selection cleanup does not
remove that durable evidence. Immediately before the one-shot sent marker, the
worker takes the publication mutex and current source-scope locks and rechecks
live membership, source revision, canonical identity and both frozen/current
authority expiry. A changed/expired target
fails before dispatch with `confirmation_mismatch` and an audited item outcome;
it is not refreshed or silently rebound. Between staged targets, the existing
inventory runtime settles prior verified readbacks; that may publish a new
canonical projection but cannot change another target's frozen source binding or
extend its deadline. Approved direct canary cycles retain
their separate approval and per-dispatch authorization contract.

Quarantine status/history GETs are read-only too.
Quarantine authorization waits honor worker cancellation and finite deadlines,
including authorization within target locks and GET-only reconciliation.
Verified readback commits recheck the exact current private inventory target
under the publication mutex, alongside persisted cancellation, job deadlines
and canary approval, including observations attached to inconclusive outcomes.
Evidence-free terminal cleanup remains permitted after these fences close.
Superseded or expired authority cannot dispatch or publish
provider state, and sent work remains non-replayable. Retained uncertain receipts
can still be reconciled by GET after the original execution deadline.

The same server startup and
non-overlapping maintenance-aware recovery loop recovers interrupted quarantine
jobs by configured tenant, with at most 1,000 running and 1,000 queued jobs per
startup transaction (each job has at most 25 targets). Startup drains full batches
before accepting new HTTP work; periodic recovery drains before closing the
database. Status polling never recovers another tenant's work.

### Current inventory storage

The current record-backed inventory contract is documented in
[`record-data-foundation.md`](record-data-foundation.md).
Collectors, selected reads, off-request reconciliation and exports use this
authority directly; no dormant predecessor schema or activation handoff remains.

Use the synthetic, disk-backed, fixed-memory `inventory-foundation` selector:

```powershell
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite inventory-foundation
```

The source page receipts distinguish unknown expected totals from observed zero.
Current PP collectors support a thirty-minute deadline and 100,000-source ceiling.
Current
source heads may be ahead of a captured canonical result: `catching_up`,
`reconciling` and stale/partial metadata must remain visible, and none authorizes
a provider control. Clear/revocation/control fences invalidate immediately.
GC/compaction run only in bounded, pin-safe slices; do not delete source
generations merely because a newer head exists.

Independent fixture checks are not deployment proof. No reset, deployment,
canary or retained-resource cleanup was executed for this schema change.

### Existing installation maintenance

Stop admissions and both retained containers cleanly:

```powershell
pwsh ./deploy-local.ps1 stop -Project agent-control-phase01
```

Apply the current worktree and start with the same volume, network, secrets and saved port:

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control-phase01
```

Public `start` maps to internal `Deploy`: it captures source, builds the operator, performs read-only current-schema preflight and builds the runtime before maintenance. Regression checks run only with `-ForceChecks` or the separate `check` command. When changes are required it drains the app, initializes/verifies the current schema and grants as needed, starts the app and verifies readiness. It is not an existing-image-only shortcut. Preflight/build/check failures do not drain the app or reset data. An initialization failure retains maintenance and its repair marker; fix the failure and rerun without repeating reset. An incompatible database requires explicit `-DbReset`, not a forward migration or a modified receipt.

Run lifecycle checks sequentially, never concurrently:

```powershell
pwsh ./scripts/restart-runtime.tests.ps1 -Project agent-control-phase01
pwsh ./scripts/persistence.tests.ps1 -Project agent-control-phase01
```

## Local secret or volume recovery

Local secrets are restricted files under `.local/agent-control-phase01/secrets`; the PostgreSQL volume is `agent-control-phase01_data`. If an existing-volume DB/session secret is missing/corrupt, stop. Restore the original state directory from approved secure storage; do not regenerate a password or reset the volume. Then rerun `start` and verify health/readiness. A missing client secret is handled by the secure configuration wizard, not by replacing database/session secrets.

For a fresh application database in the same project, use:

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control-phase01 -DbReset
```

This explicitly deletes all saved application data, including reports, audit, jobs and sessions, without an additional confirmation prompt or a pre-reset backup. It preserves project settings/secrets, port/public URL, PostgreSQL roles and volume, other databases, and existing backup files. Reset-target/credential preflight precedes runtime build and optional checks; app drain precedes reset and current-schema initialization. A failure after deletion does not restore the discarded database, and reset/initialization failures leave maintenance active. Only the operator identity on the `postgres` maintenance database may reset the exact confirmed, operator-owned application target; runtime access is rejected. Omit the switch on subsequent ordinary starts.

The separate **whole-project destruction** helper additionally deletes configuration and secrets. It requires a verified backup outside the project state directory, the [operator helper setup](#operator-only-local-helpers), and the exact case-sensitive `<project>/<project>_data` confirmation:

```powershell
Invoke-LocalDeployment $context 'Reset' -ConfirmReset 'agent-control-phase01/agent-control-phase01_data'
```

Reset destroys that project's containers, volume and local state, including secrets and backups. It is not a credential recovery mechanism or a public deployment command.

## Credential expiry and separately approved replacement

Follow the 4-name/3-runtime-consumer contract in `docs/deployment-setup.md`: the complete tenant registry, session secret and restricted database password have runtime references; the administrator database password remains operator-only. Before expiry, obtain separate administrator approval and a maintenance window. Add new secret versions directly in the prepared vault, preview references/role assignments, stop admissions and drain/reconcile jobs, back up, update native versioned references, use the administrator password only for short-lived bootstrap/initialization input, remove that input, restart and verify least privilege. A session-secret replacement invalidates all sessions. A database-password replacement must coordinate the fixed `agentcontrol_admin` and `agentcontrol_app` PostgreSQL roles with their prepared vault versions; no managed-identity/password fallback exists. The Azure deployment wizard never writes or silently rotates a vault value.

## Validation

Run the full software gate without a configured tenant or running application:

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
