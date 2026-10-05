# 04 — Inventory cutover: incomplete implementation receipt

**Status: incomplete, not accepted. Do not advance to 05 on this receipt.**

This worker implemented and verified the package-job metadata/result-page slice,
but did **not** complete the requested atomic inventory cutover. The staged
inventory writers, reconciliation and queries remain dormant; the required real
inventory HTTP regression still fails. This is not `complete_with_risk`, a
production-readiness claim, an authorization blocker, or a safety-guard refusal.
The parent owns campaign state and acceptance; its ledger was not edited.

## Binding source and preservation

- Prompt: `04-inventory-cutover.md`, SHA-256
  `5e039ddabfd586e5206e0b6999dd8b7bfaa5271f57d04809ee96119e9f0efbb9`.
- Read the README, worker contract, AGENTS.md, .npmrc, predecessor completion
  records and the parent acceptance/repair addenda. No nested agents, commits,
  branches, pushes, dependency installations, production actions or external
  provider mutations were performed.
- `artifacts/phase04-source-receipt.json` identifies the 27 changed source/test/
  documentation files and the unchanged protected build/deployment inputs.
  Existing dirty work was preserved.
- Actual SQL checksums for **all migrations 1–51** were compared with the
  protected final-03 image and matched. Migration 51 remains
  `32d1333b0e15ac2f4b70cddd1c0ccb4262d9d153f3cb3da64e9610f4f04ed322`.
  Evidence: `phase04-migrations.json`, `phase04-predecessor-migrations.json`.
- Forward migration **52**, `jobPagesSchema.ts`, adds only job outcome revision
  infrastructure. Its SQL checksum is
  `ea90f5e2239ed0d23e6c3e634e2ba9745a7e22c431ea6ad2a36470cb21cf591e`.
  It does **not** perform the still-required inventory storage cutover.
- Both phase-03 source receipts remain intact. The three specified protected
  baseline/browser/final-03 image identities were independently checked.

## Falsifiable starting proof

Added the required `backend/src/routes/largeTenantInventory.test.ts`. It publishes
101 synthetic package records through the real staged foundation, reconciles a
canonical generation, starts the real application with an authenticated synthetic
session, and asks `/api/agent-inventory?limit=50`.

The test rejects both source-wide `readUnifiedSource` methods and
`UnifiedAgentRegistry.withSnapshot`. It requires an exact counted 50-row selected
page with a continuation cursor and response below 1 MiB. The initial session
fixture error was repaired; the subsequent real route returns **500:
GET-side reconciliation forbidden**. The guard is intentionally not weakened,
skipped, or rewritten to expect failure. It remains an unresolved phase-04 defect.

Evidence: `phase04-route-before.log`, `phase04-route-reproduced.log`, and the
final inventory-selector attempt below.

## Implemented package-job slice

### SQL, lifecycle and API

- `JobRepository.get` is one metadata/scalar-count query, not a 5,000-item
  materialization. `list` is one SQL query rather than one `get` per job, with
  SQL-encoded byte budgeting. Neither returns `results` or duplicate `result`.
  Stored confirmation target examples are omitted from status/history.
- Exact job-wide totals include completed, succeeded, failed, skipped,
  inconclusive, cancelled, queued, reconciliation-required and retry-eligible
  counts. Existing resume constraints, token mode, deadline/attempt budgets and
  cancellation checks remain authoritative.
- Migration 52 uses statement-level transition-table triggers to increment
  `result_revision` once per affected job per item-write statement, rather than
  once per outcome row.
- `GET /api/agents/bulk-jobs/:id/items` serves maximum-100 keyset pages. Cursors
  bind tenant, principal, authorization/session identity, job ID and outcome
  revision. Reads use the existing repeatable-read connection path and a shared
  principal-epoch fence. Revision changes reject incompatible continuations.
- Item SQL accounts for actual JSON-encoded bytes, supports byte-short pages
  with continuation, and rejects an individually oversized first item.
- Existing submit writes now batch job items, source identifiers and requested
  audit events at at most 250 records and 1 MiB. **This does not eliminate the
  upstream full target/prestate arrays or implement server-filtered selection.**
- Reconciliation reads bounded ordinal/byte batches rather than 5,000 outcomes.
  Attempted/failed totals are exact; returned error examples stop at 20. Existing
  provider authorization, target locking, canary qualification, audit,
  readback/publication and no-automatic-retry safeguards are preserved.
- Status/history GETs no longer invoke recovery. The server performs
  non-overlapping 30-second recovery passes, respects maintenance, and drains an
  active pass before closing the pool. Startup and explicit resume retain
  recovery semantics.

### Frontend and producer/consumer trace

- `api/client.ts` owns the metadata-only job type and paged item transport.
- `BulkActions` uses server-wide totals/eligibility; `BulkJobItems` holds one
  independently requested outcome page, exposes previous/next controls, aborts
  abandoned reads, hides data across owner changes and visibly restarts when
  the outcome revision changes.
- App history/polling no longer reads embedded outcome arrays. Status polling
  aborts on superseding requests/account scope changes. Terminal presentation
  reads only one result page, never drains a job. When outcomes exceed that
  page, App invalidates exact caches and clears selection instead of treating
  the visible page as the complete result set.
- Updated backend repository/service/HTTP/policy tests, App/BulkActions fixtures,
  and browser job fixtures. The legacy migration-44 test now seeds its old
  schema directly instead of calling the current repository against a schema
  lacking migration 52.
- The required `frontend/src/components/LargeTenantInventory.test.tsx` currently
  covers **only job outcome paging**, including 5,000 server totals,
  byte-short continuation, owner abort and visible revision invalidation.
  It is not the complete inventory UX test requested by this phase.
- Browser diagnosis found the network-isolated fixture reports
  `navigator.onLine=false`. The affected scheduler case now explicitly models
  an online browser, like the existing automatic-refresh fixtures, without
  opening network access or weakening permission-count assertions.

## Validation: actual outcomes, not inferred passes

All executions used the checked-in owned source-copy fixture, approved installed
dependencies, Node 1,536 MiB/V8 768 MiB and PostgreSQL 1,024 MiB constraints.
No deadline or resource ceiling was raised.

| Evidence | Actual result |
|---|---|
| `phase04-jobs-repair.log`, run `ae7617224a4c41faa9657eb62850e979` | **264 backend / 291 frontend passed**, backend typecheck and frontend build passed |
| `phase04-job-browser-online.log`, run `9770afce531c418b986338f3c5c5df83` | Real synthetic-auth browser bootstrap: **20/20 desktop/mobile Playwright checks**, wrapper passed |
| `phase04-final-recovery-retention.log`, run `7bf845c6efa64975b8bc82595dcb6a9c` | **156 passed** plus typecheck, including final recovery/maintenance tests, backup/restore and grants |
| `phase04-job-http-final.log`, run `e8bd55172e2847198c7807942cc286c1` | **207 passed** plus typecheck, including real job-item HTTP response and cross-principal isolation |
| `phase04-foundation-attempt.log`, run `62b28d670aa74013992a6fb099cbcb5e` | **109 passed** plus typecheck |
| `phase04-inventory-attempt.log`, run `f2405bcc42604badb4fd07a0365d7704` | Exact required inventory selector: **556 backend passed / 1 failed**, **342 frontend passed**; unresolved failure is the real GET cutover regression |
| `phase04-all-attempt.log`, run `cbca9ec5ace9475a8e5fd2923404103a` | Independent aggregate **4/5**: backend **4,316 passed / 4 failed**; frontend **2,354 passed**; typecheck, lint and build passed |
| `phase04-software-gate-attempt.log`, operator run `2b773c6ce59f43979d7228e59d312976`, check project `bddb3251b43945ecb059643334a2377c` | Original gate **FAILED 0/5**, backend `spawnSync npm ETIMEDOUT` at unchanged **180s**, OOMKilled=false; remaining four steps **not_run** |

The independent aggregate backend took **380.954s**. Three aggregate failures
were subsequently repaired and passed in the focused job slice: a stale embedded
result assertion, a wide-row fixture trying to mutate immutable target text, and
current job code called against the old migration fixture. The fourth—the
inventory GET cutover—is **not repaired**.

**Source overlays are explicit:** the aggregate precedes those repairs and the
periodic recovery implementation; the final focused job proof precedes the
database-maintenance recovery check and extra HTTP assertions, covered by the
final retention/HTTP runs. No final all-command aggregate is claimed for the
combined overlay. The passing browser proof concerns the job slice, not activated
staged inventory. Initial failed browser and job attempts are retained.

The real 5,000-outcome test proves bounded metadata/history, all 50 result pages,
first/middle/last/previous traversal, byte-short pages, cursor tampering,
cross-tenant/principal/session/authorization rejection and progress invalidation.
It does not establish the requested >5,000-source/high-fanout inventory route
qualification or the later 100k/1m capacity envelope.

## Root impact and deletion audit

- **backend/**: job SQL, forward schema/verifier, item route and policy, off-GET
  recovery, service batching and related HTTP/lifecycle/migration tests changed.
  Existing source/canonical inventory runtime authority is unchanged.
- **frontend/**: job wire, App polling, paged outcome UI, unit and real browser
  consumers changed. Inventory list/detail/filter/facet/export contracts have
  **not** been cut over.
- **scripts/** and **backend/scripts/**: exact required `inventory` selector and
  focused `inventory-route`/`inventory-jobs` selectors registered and exercised.
  Existing fixture isolation/cleanup and software-gate constraints remain.
- **docs/**: operations documents the active metadata/page/recovery contract and
  still truthfully labels inventory foundation dormant. Security-model and
  mutation-canary documentation were checked for the removed result wire;
  no authorization or canary contract changes were required for this slice.
- **Root build/deployment**: Dockerfile, compose files, local deployment script,
  manifests/lockfile, .npmrc and AGENTS.md are hash-checked unchanged against
  predecessor evidence. No build/deployment path, admission bypass, new package
  or public registry use was introduced.
- **Deleted files: none.** Removed runtime contracts are embedded job result
  arrays, duplicate `job.result`, and GET-side job recovery. The mandated
  inventory full readers, old exports and storage objects **remain**, so the
  required inventory deletion audit cannot pass.
- Exact-label independent cleanup and protected-image checks are recorded in
  `artifacts/phase04-cleanup-receipt.json`. Owned containers, networks and volumes
  are absent. Qualification images/evidence were retained.

## Remaining phase-04 ownership; no 05 handoff

The following are still phase **04**, not deferrable lifecycle work for 05:

1. Activate `StreamedInventory` through current refresh/dataSync jobs, commit
   source/head/run/job outcomes together, then enqueue and poll/recover coalesced
   canonical reconciliation off GET; activate bounded inventory GC.
2. Replace package, PP, unified, responsibility, usage-candidate and operation
   reference reads with selected SQL keysets; implement exact detail and truly
   counted paged children plus targeted enrichment.
3. Wire current membership/control revisions through mutation previews,
   qualifications/readback, quarantine, people/identity, investigations,
   workbench and usage association mutations. Implement bounded server-filtered
   target/prestate staging with the existing confirmation digest and 5,000 cap.
4. Atomically replace inventory frontend/API/cache/filter/facet/detail/selection
   contracts; add paged refresh-target API/consumers. Preserve all existing UX.
5. Register three inventory durable-export producers, remove all old inventory
   CSV routes/helpers/consumers, and perform fresh-data-guarded forward storage
   deletion with working clear/retention/restore/backup/startup/grants.
6. Complete both required large-inventory test files, >5,000-source/high-fanout
   and concurrency/control/export proofs, final browser/shared/aggregate checks,
   source/deletion receipts and the parent acceptance review.

No credible external blocker was discovered. This receipt reports unfinished
implementation rather than disguising it as an infrastructure or authorization
failure. **05 cannot rely on row-backed inventory or paged inventory browsers.**

### Release containment and exact repair signals

The existing production installation was not touched. Do not deploy this
unfinished phase or claim support beyond prior qualified bounds. Parent/04 must
close the above work when the required real inventory regression records **zero**
source-wide reads/GET reconciliations and all required cutover checks pass.

Phase **07** retains the original software-gate cost repair and production
continuation: any command exceeding **180s**, nonzero result, cleanup failure or
fewer than **5/5** successful original-gate steps keeps maintenance/reset/
deployment closed. The current signal is measured 380.954s independent backend
cost plus the actual 180s ETIMEDOUT. Fix forward by completing predecessor
deletion and practical test/runtime cost repair, then rerun the unchanged gate;
do not raise memory/deadlines, skip assertions, substitute independent results,
repeat an application reset, or bypass Start/Deploy.

---

# Continuation — complete inventory cutover, 2026-09-30

**Phase Result: `complete_with_risk`; parent acceptance remains pending.**

This continuation supersedes the historical **implementation** findings above:
inventory is no longer dormant, the controlling real GET regression passes,
the consumers and exports are cut over, and the required predecessor removal
is complete. It does not erase or relabel any previous failed/partial run.
The original **13,921-byte** receipt prefix remains byte-for-byte intact,
SHA-256 `494be6e629cda659a28350379169cf65dd278cf21882bd24717698074389a7b8`.

The residual is measured **whole-suite execution cost**, not missing inventory
implementation or an external authorization blocker. The final independent
aggregate is **4/5**, and the actual unchanged original gate is **0/5**. Both
are non-passing; their exact results and mandatory 07 repair obligations appear
below. This is not production qualification or phase acceptance. The parent
ledger was not edited. No nested agents, commits, branches, pushes, dependency
installs, public package-feed access, external provider mutations or production
actions were used.

## Source/head/job activation and canonical recovery

1. Actual Graph package and Power Platform refresh services, data-sync paths,
   selected refresh jobs and provider callbacks now use `StreamedInventory`,
   `DataGenerations` and the row-backed repositories. There is one inventory
   writer, not a shadow write or whole-list adapter.
2. Source records, exact-head state, completed run/job state and the published
   source head commit together. Incomplete, failed, cancelled or fenced work
   cannot publish a successful replacement. Prior good inventory remains
   readable with truthful refresh/coverage state.
3. Only after source commit does `InventoryRuntime` request canonical work.
   Recovery/polling, coalesced pending work and bounded GC run off GET.
   A safely captured active vector can finish while a newer vector is pending;
   clear, revocation, expiry and unsafe control changes fence immediately.
   Corrected dropped wake-ups so an overlapping notification is not lost.
4. Live control recovery is settled before GC can retire its required
   membership. Canonical work, exact-head/tombstone state and historical pins
   remain protected through recovery, compaction and bounded cleanup.
5. Source data-sync mutexes precede generation/scope/head locks; multiscope
   locking is sorted. Fenced batch writes and the independent 20-second
   heartbeat/60-second lease remain active through provider waits. Maintenance
   and shutdown stop admission and drain active work.
6. The existing observer/startup barrier, session-derived identities, active
   user/report storage, history and durable exports remain intact. Delegated
   directory/people evidence remains independent of inventory source token mode.

Canonical matching preserves opaque Graph IDs verbatim, including
case-distinct GUID-shaped IDs; only the appropriate PP identifiers normalize.
Merge/split survivors, ambiguity, exact deletion precedence and catalogue
absence watermarks retain their foundation semantics. Coverage, pending
details, reconciliation, unavailable and catching-up states are presented
instead of manufacturing a current/complete inventory.

## Selected SQL, current authority and route-to-consumer closure

| Contract | Active production path and consumers |
|---|---|
| Canonical/native/package lists | `InventoryQueries`, `NativeInventory` and `LiveInventory`; `/api/agent-inventory`, `/api/agents`; App and manual-page inventory tables |
| Wide selection capture | POST `/api/agent-inventory/selections` and `/api/agents/selections`; bounded metadata transport followed by reads using the immutable selection ID |
| Counts and facets | `/api/agent-inventory/summary` and `/facets`; server global/scope/filtered counts, asynchronous searched facet pages, normalized value/label and tagged-null semantics |
| Exact details | `/api/agent-inventory/:recordId/detail` and `/api/agents/:id/detail`; selection plus exact ID, never a large-list lookup or browser page walk |
| High-fanout evidence | Canonical `/members`, `/sections`, `/children`, package `/collections/:kind`, PP exact `/related`; independently counted/paged members, connectors, definitions and evidence |
| Responsibility/ownership | `/api/agent-responsibility`, targeted SQL people/identity/usage joins; ownership views and user-owned-agent detail use selected pages |
| Mutation selection | `/api/agents/mutation-selection` and `/mutation-preview`; bounded server-filtered target/prestate staging and incremental existing confirmation digest |
| Selected refresh | `/api/agents/refresh-selection`, refresh metadata and `/api/agents/refresh-jobs/:id/targets`; App refresh progress and `InventoryRefreshTargets` consume one revision-bound page |
| Bulk jobs | Metadata/scalar-count status/history plus `/api/agents/bulk-jobs/:id/items`; App, `BulkActions` and `BulkJobItems` never receive embedded outcomes or duplicate `job.result` |
| Identity, investigations and workbench | Current live-source predicates and existing control authority through people resolution, quarantine, qualifications/readback, investigation context, operation references and routing |
| Usage associations | Selected SQL candidate search and exact current authorization for attach/remove; historical readability is not mutation permission |
| Inventory downloads | Existing durable export dispatcher/chunks with `graph_packages`, `power_platform_agents`, `unified_agents`; native authenticated browser download |

All meaningful view/relevance conjunctions, native/catalog/all scopes, source
and logical counts, verification, token modes, visibility and freshness remain
server-owned. Environment names, cached people, memberships, identities and
usage are targeted at the selected page or exact bounded relation. There is
no tenant-sized Node enrichment map, JS inventory filter/sort/count pipeline,
JSON-to-SQL collection roundtrip or GET reconciliation.

Selected responses use one explicit repeatable-read client and evaluated time
for rows, counts, facets and context. Serialization conflict remains
**503 / Retry-After 5**, without replay or legacy fallback. First-read
selection/pin metadata persistence follows the README contract; GET cannot
advance source, canonical, control or job authority.

Current live membership/control revision is checked independently of read
pins, including final authorization and dispatch boundaries. Existing roles,
capabilities, CSRF, admission, audit, idempotency, provider canaries,
reauthorization and reconciliation restrictions remain in force. A failed
control-settlement check dispatches **zero** provider mutations and releases
its lease. The existing **5,000-target** bulk ceiling is explicit; a 5,001-target
bulk selection is rejected rather than silently truncated.

Server-filtered selection stages target/prestate batches in storage, not a
5,000-object upstream array. Job inserts/reconciliation and refresh-target
status stay bounded. Safe read pins survive publication, but cannot be used
to confirm a write against superseded control authority.

## Frontend and export completeness

- Shared types, serializers, cache ownership, query keys, App and tables now
  use selected server pages, sorting/filtering/facets and exact server totals.
  The active view retains at most current/previous/next pages. Abandoned
  requests abort; principal, tenant, role and invalidation changes clear or
  hide protected data instead of leaking a previous capture.
- Column selection, per-column sorting, details/modals and return focus,
  bulk/reference actions, ownership, usage, investigation/workbench context,
  refresh progress/cancel/resume and stale/error/empty/loading states remain.
  A replacement detail is owned by selection ID, not merely its numeric
  revision. Previously visible content can retain measured space while its
  actions are locked; it is not reused as current authority.
- High-fanout details fetch only an independently selected member/section
  page. The UI regression includes **6,000 members / 9,000 detail rows** as
  server totals without downloading unseen pages.
- The final real browser run found a shared filter panel overflowing left at
  768px after the all-matching action changed the toolbar anchor. Fixed
  horizontal viewport clamping, recomputation and fixed-layout reset while
  preserving above/below positioning, focused controls and table geometry.
  The original geometry assertions were not weakened.
- Inventory exports preserve the CSV schema, source/child rows, formula
  protection, audit and selection/operation-reference authorization. Browser
  code does not fetch the artifact into a Blob or expand all matching IDs.
  Source rows are lazy, byte-checked batches; member/child windows are
  independently bounded and persisted through the existing chunk framework.
- A real 5,000-agent / 10,000-source export contains **50,000 CSV rows,
  32,002,324 bytes and 123 chunks**. It passed the unchanged 15-second build
  assertion at **11,275ms** in exact inventory and **10,439ms** in the final
  aggregate's completed integration file.

Bounds remain **250 SQL records and 1 MiB**, **1 MiB list responses**,
**512 KiB details/logical rows**, **256 KiB residual payloads**,
**100 exact read IDs**, **4 KiB authenticated cursors**, and at most
**100 export rows / 1 MiB per batch**. Actual encoded values, including
primary members, determine page budgets. Wide values are neither truncated
nor hash-sorted; a byte-short page can correctly have a continuation cursor.
The previously disproven 600,056-byte child remains rejected by the unchanged
residual constraint.

## Forward schema and predecessor deletion

Migrations **1–51 remain frozen**, and the previously tested **52** is preserved.
This cutover adds forward migrations **53–73** for active authority, selection/
refresh/job staging, source observations, identity/expiry, ordering/projection
and fresh-data retirement. Final source-image extraction verified **all 73**
SQL checksums against the preceding immutable capture, with no later SQL drift.

- 51: `32d1333b0e15ac2f4b70cddd1c0ccb4262d9d153f3cb3da64e9610f4f04ed322`
- 52: `ea90f5e2239ed0d23e6c3e634e2ba9745a7e22c431ea6ad2a36470cb21cf591e`
- 73: `494bc0e813654a1003d4086fefa055fcabb56cda0c9f2bc1b08ff83baccd6d5a`

The fresh-application-data guards reject legacy inventory content rather than
convert or backfill it. Retired PP snapshots/resources, unified registry/source
tables, package detail cache, obsolete publication triggers and functions are
removed. The surviving package snapshot/resource tables are the **existing
exact control-only authority**, constrained to delegated exact one-target
block/access observations; they are not an inventory compatibility reader.
Their surviving code is extracted into `packageControls.ts` and related exact
authority helpers, not duplicated in a second control store.

Actual source deletions relative to the immutable final-03 image:

1. `backend/src/db/packageInventory.ts`
2. `backend/src/db/powerPlatformInventory.ts`
3. `backend/src/db/unifiedAgentRegistry.ts`
4. `backend/src/db/unifiedInventoryRevision.ts`
5. `backend/src/services/agentResponsibility.ts`
6. `backend/src/services/unifiedAgentExport.test.ts`
7. `backend/src/services/unifiedAgentExport.ts`
8. `backend/src/services/unifiedAgents.ts`
9. `frontend/src/components/EnvironmentFilter.test.tsx`
10. `frontend/src/components/EnvironmentFilter.tsx`

The old inventory GET/POST CSV routes and client/helper contracts are deleted.
Final source searches find **zero** retired reader/registry/`forExport` symbols
and **zero** retired inventory CSV runtime routes. Negative route assertions
and a historical audit-row fixture intentionally retain old URL text.
Unrelated audit/Purview/Defender CSV contracts are not inventory fallbacks.
Earlier 02B deletions are not attributed to this worker.

Clear, retention, backup/restore, startup schema verification, least-privilege
grants and compiled restart/export recovery work against the new schema now.
Strict named-field verification rejects missing evidence instead of accepting
an empty object vacuously. Historical migration fixtures use only the owned
operator to seed/inspect retired schemas; current runtime grants are not
restored to make a test pass.

## Autonomous decisions and practical repairs

- Reused the existing generation, selected-read, durable export and exact
  control contracts; no architecture fork, alias or compatibility bridge.
- Added forward **73**'s partial environment-only native-ID lookup index after
  measuring repeated missing-environment scans. Native selected reads improved
  from approximately **3.6–4.9s to 0.48–0.61s**, without planner overrides,
  less data or changed assertions.
- Kept the shared source relation compact, aggregated known responsibility
  roles once, and projected primary members once inside the selected SQL
  window with actual byte budgeting. Rejected and removed slower inlining
  experiments. No temporary SQL monkeypatch remains in runtime/tests.
- Coalesced lazy export source rows into bounded batches and used direct
  validated canonical/native joins. The measured export formerly exceeded
  **15s**; the exact and final aggregate measurements above now pass unchanged.
- Repaired stale schema, identity, quarantine and workbench fixtures against
  the actual active contracts, adding fail-closed tests rather than restoring
  retired privileges or weakening assertions. App interaction tests wait for
  legitimately unlocked actions instead of clicking retained-but-locked rows.
- Fixed independent-runner timeout isolation: each npm command has an owned
  process group; a **600s** timeout kills that exact group, failing closed if
  its identity/cleanup cannot be established. The former late-backend-output
  contamination is absent from the final run. The original software-check
  implementation and its **180s** limit are unchanged.
- Supplemental backend shards expose full-file results but do not substitute
  for `all` or the real original gate. Neither deadlines nor memory, data
  volumes, required assertions or file parallelism were relaxed.

## Final validation and source overlays

All commands used `scripts/large-tenant-tests.ps1`, approved installed
dependencies and isolated synthetic fixtures. Node remains **1,536 MiB /
768 MiB old space**, PostgreSQL **1,024 MiB**, disk-backed owned PGDATA/WAL/temp,
no published ports or external provider traffic, and backend
`fileParallelism:false`. No concurrent qualification workloads were used for
the final measurements.

`artifacts/phase04-continuation-validation-final.json` indexes **293**
continuation attempt logs, retaining their checksums, command receipts and
historical results. Do not sum overlapping focused suites as a unique total.

| Final or directly relevant command/evidence suffix | Actual result |
|---|---|
| `-Suite inventory`; `inventory-twenty-one.log` | **556 backend / 354 frontend passed**; real first GET, 5,001 streamed sources, 5,000 staged/refresh targets, high fanout, controls and durable download |
| `-Suite inventory-foundation`; `inventory-foundation-twenty-one.log` | **513/513 passed**, backend typecheck passed |
| `-Suite cutover-retention-contract`; `cutover-retention-contract-twenty-one.log` | **158/158 passed**, typecheck passed; grants, clear, retention, backup/restore, recovery and timeout ownership |
| `-Suite cutover-compiled-restart`; `cutover-compiled-restart-twenty-one.log` | Build and deliberate crash/recreation/export recovery passed |
| `-Suite foundation`; `foundation-final-ten.log` | **175/175 passed**, typecheck passed, including all current named schema checks |
| `-Suite inventory-usage-authority`; `inventory-usage-authority-fourteen.log` | **146 passed**, typecheck/frontend build passed; repaired historical schema fixture |
| `-Suite inventory-controller-contract`; `inventory-controller-contract-fifteen.log` | **49 passed**, typecheck passed; current identity/final-authorization and quarantine settlement |
| `-Suite report-source-scale`; `report-source-scale-fifteen.log` | **34 passed**, typecheck passed; isolated 30,001-user case **28,523ms** |
| `-Suite inventory-facets`; `filter-placement-twenty-two.log` | **137 backend / 476 frontend passed**, backend types/frontend build/lint passed; final viewport regression included |
| Four-file focused real browser; `filter-browser-twenty-two.log` | **70/70 passed** |
| Full 21-file real browser; `browser-final-twenty-two.log` | **325 passed / 0 failed / 9 existing skips**, wrapper passed |
| `-Suite all`; `all-final-twenty-two.log` | **4/5**: backend **600,112ms ETIMEDOUT**; frontend **2,382 passed**; backend typecheck, frontend lint and production build passed |
| Actual `-Suite software-gate`; `software-gate-final-twenty-two.log` | **0/5**, backend ETIMEDOUT at unchanged **180s**; remaining four steps **not_run**, not passes |
| Final static/editor checks | Changed filter files report no errors; `git diff --check` passed. Lint retains two existing App hook warnings; build retains its large-chunk warning, neither suppressed |

The browser selection was:
`agentContext, agentResponsibility, agentActivity, agentExperience,
unifiedAgents, automaticRefresh, bulkActions, reportSets, layout, permissions,
agentFilters, agentPeople, userDetails, inlineAgentManage, dialogFocus,
packageConfirmation, jobs, dataSync, agentCatalog, layoutGeometry,
permissionLayout` (`.spec.ts` for each).

The aggregate backend has **32 completed files / 1,813 known passing tests**,
with no reported assertion failures before timeout. It has **no complete
backend result** and must not be represented as 1,813/1,813 or a full-suite
pass. There are **zero backend file-result lines after frontend execution
begins**, unlike the contaminated historical attempt.

The previously workload-sensitive 30,001-user/three-plan case passed in this
final aggregate at **27,080ms**, and its complete **34-test** file passed.
Its historical **84,869ms / 60,000ms-limit** failure remains recorded; a
specific cause was not established and is not claimed. The two historical
backend shards (**1,813 passed / 1 failed**, and **2,682 passed / 36 failed**)
remain failed historical runs. Repaired controller/schema failures have the
focused proofs above; no clean final shard result is invented.

The earlier three browser geometry failures (**322 passed / 3 failed /
9 skips**) are superseded only by the final **325/0/9** result. Similarly,
the earlier contaminated **3/5** aggregate is not relabeled.

**Immutable source comparison:** all **700** current root source files match
the final browser, aggregate and original-gate images. The exact inventory,
foundation, retention and compiled-restart images match every backend source;
their only later overlay is **three frontend viewport files plus
`docs/record-data-foundation.md`**. That overlay is covered by the 476-test
focused frontend run, real browser runs and final 2,382-test full frontend.
The pre-overlay exact frontend count remains 354, not an invented 355 rerun.
Image equality does not convert a timeout into a pass.

## All-root impact, manifests and environment cleanup

`artifacts/phase04-continuation-source-final.json` records **199 changed /
71 added / 10 deleted** files against the immutable final-03 source image.
Its per-file hashes, image overlays and grouped paths are the exhaustive
manifest; existing predecessor work is preserved.

- **backend/** — **203 affected paths**: active source/runtime/reconciliation,
  SQL/native/current authority, forward schema and verifiers, stages/jobs,
  selected routes/shared types, presentation/export services, lifecycle/
  operator scripts and real DB/HTTP/unit/browser fixtures. Principal new
  boundaries include `inventoryRuntime`, `inventoryAuthority`,
  `inventoryMutationStages`, `inventoryIdentityQueries`, `nativeInventory`,
  `liveInventory`, `packageControls`, `packageRefreshJobs`,
  `powerPlatformRefreshJobs`, `inventoryData`, `inventoryMutations`,
  `inventoryPresentation` and `inventoryExports`.
- **frontend/** — **73 affected paths**: client/shared wire, App orchestration,
  page/cache/selection ownership, manual tables, facets, details/children,
  responsibility/usage/investigations/workbench, jobs/refresh targets, native
  exports and matching unit/real browser contracts.
- **scripts/** — **1 affected path**, `large-tenant-tests.ps1`: required and
  supplemental selectors, preserving the original gate. Fixture execution/
  timeout ownership changes are under `backend/scripts/`.
- **docs/** — **3 affected paths**, `operations.md`,
  `record-data-foundation.md`, `security-model.md`: active boundaries,
  operator continuity, current authority, bounds and truthful validation.
  `mutation-canaries.md` needs no edit: existing provider qualification,
  approved-control and canary semantics are preserved.
- **Root deployment/build/configuration** — unchanged after impact review:
  Dockerfile, `.dockerignore`, both compose inputs, local deployment helper,
  dependency manifests/lockfile, `.npmrc` and AGENTS.md retain protected hashes.
  No new dependency, feed, port, callback, secret, deployment bypass or runtime
  grant relaxation is required.

Evidence:

- `phase04-continuation-source-final.json`
- `phase04-continuation-deletion-final.json`
- `phase04-continuation-migrations-final-source.json`
- `phase04-continuation-validation-final.json`
- `phase04-continuation-cleanup-final.json`
- `phase04-continuation-native-index-evidence.json`
- `phase04-continuation-export-performance-repairs.json`

The **14 protected inputs, nine prompts and six historical receipts** match
their recorded hashes. The three specified baseline/browser/final-03 images
retain their exact identities. Final read-only image proof used seven
separately named, network-none, no-mount, fixed-memory containers; all were
auto-removed and independently checked absent.

The cleanup audit verifies **292 referenced synthetic project identities**:
**291 have captured exact owned disk-backed PGDATA evidence**; the remaining
identity is the software-gate source-build wrapper, whose separate check
project has its own mount evidence. Across **26,154 captured container state
samples**, none reports `OOMKilled=true`. All referenced project containers,
networks and volumes, and owned gate scratch directories, are absent.
Qualification images and diagnostic/source evidence are intentionally retained.
No global prune or name-based process kill was used. Protected production and
recovery resources were not operated on.

## Residual handling and exact next-phase preconditions

**No unresolved architecture decision or external access blocker remains.**
The concrete non-passing current checks are execution-cost checks:

| Residual | Measured signal and threshold | Containment, owner and exact trigger |
|---|---|---|
| Independent full backend cannot finish its fixed budget | **600,112ms > 600,000ms**, 32 completed files, no full backend result | **07** owns further real cost repair; preserve isolation, memory, assertions and data volumes. Repeat unchanged `all` after cost changes and retain partial/failing evidence |
| Original Test/Deploy gate refuses software | **0/5**, backend **180s ETIMEDOUT**, four steps not run; no OOM | **07** must achieve the actual unchanged **5/5** and clean owned resources before maintenance, app stop, authorized initial reset or deployment. No internal Start/container bypass, deadline increase, aggregate substitution or repeated reset as a fix |
| Larger capacity/live-provider envelope is not established here | 100k/1m/churn and real provider/live production checks **not_run in 04** | **06** supplies fixed-budget capacity evidence; **07** owns deployed observation/canaries and fix-forward. Preserve unsafe-admission/publication/mutation fences; do not extrapolate the synthetic cutover proof into capacity or live-provider success |

Largest completed files in the final backend attempt are
`unifiedAgentsIntegration.test.ts` **108,863ms**,
`routes/largeTenantInventory.test.ts` **95,971ms**,
`powerPlatformInventory.test.ts` **94,886ms** and
`largeTenantUsersReports.test.ts` **59,761ms**. The validation artifact records
all completed-file timings for 07's cost investigation. Practical query/export
and process-isolation repairs have already been implemented; these numbers are
not a proven attribution of the remaining aggregate cost.

Keep the **60s** 30,001-user and **15s** inventory-export assertions unchanged.
Any recurrence, response/row/byte-budget breach, unsafe-authority acceptance,
missing cleanup proof or nonzero original-gate step is a concrete 06/07
fix-forward trigger. Capture the corresponding bounded timing, state, query
and audit evidence; close affected unsafe admission/publication/mutation paths,
not the overall Always-Deploy campaign.

Subject to the parent's acceptance, **05 can now rely on active row-backed
user/report/inventory paths, bounded browser pages and independently counted
details/jobs/refresh targets, durable native downloads, current-only write
authority and no predecessor inventory runtime**. Clear, grants, backup/
restore and startup/restart already work; 05 owns deeper lifecycle/resource
proof, not a postponed consumer cutover. Preserve all 1–73 checksums and this
source/deletion evidence. 06 owns capacity; 07 must continue through the real
unchanged gate and verified seha deployment/observation. Phase04 performed no
production reset or deployment and makes no production-ready claim.

## Parent acceptance review - not yet accepted

The parent's independent `-Suite inventory` passed **556 backend / 355 frontend**
tests against the final source, including the final viewport overlay. Backend
duration was **305.99s**; the measured 50,000-row export built in **11,179ms**.
Evidence: `artifacts/phase04-parent-inventory-acceptance.log`. The parent verified
all 700 source hashes, 10 deletions, 14 protected inputs, nine prompts, six
historical receipts, all 73 executable migration checksums and frozen 1-52
identity. The 292 continuation projects and the independent parent fixture
have no remaining exact-owned containers, networks or volumes.

The bounded control review nevertheless identified three correctness gaps:

1. Final bulk-job dispatch marks an item sent without validating the frozen
   staged target against current inventory membership/revision/expiry. The
   reviewer exercised the real runner/markSent code in-memory; a real staged
   database regression is required for repair acceptance.
2. Mutation-selection and staged-target authority gates omit the final live
   view's `authority_expires_at` predicate. Source generation validity alone
   does not establish still-current identity-detail evidence.
3. Quarantine job-status GET invokes global interrupted-job recovery before
   resolving the requested job's scoped identity, violating the read-only
   product-authority boundary.

Parent source inspection confirms the missing checks/call. The inventory UI
review subsequently found two additional failures:

4. The frontend includes already-stale optional identity/detail evidence in
   active expiry calculation, rejecting an otherwise valid catalog selection.
   Retained stale evidence must be presented without becoming current
   authority or invalidating a still-readable catalog.
5. App's Admin-only group-selection guard hides Viewer selections of ordinary
   multi-version agents from checkbox state and selected export. Read/export
   group selection must work independently of Admin-only mutation actions.

**Phase 04 is not accepted and phase 05 must not start** until these findings
are repaired and independently verified. This overrides the continuation's
proposed `complete_with_risk` acceptance, while preserving its successful tests
and separate aggregate/original-gate cost debt. Fresh bounded repair worker
`4c1a2900-92e9-49ab-8de0-81c14cb39d55` owns all five findings and their real
regressions; no full cutover rewrite or later-phase implementation is assigned.

## Acceptance repair — five findings implemented and verified

This bounded repair addresses **only the five parent findings**. Phase04 still
requires the parent's acceptance; this worker has not started 05, changed the
campaign ledger, or performed production operations.

### Finding dispositions

| Finding | Correction and concrete proof |
|---|---|
| **1 — durable final package authority: fixed** | Staged jobs now retain immutable source-generation, opaque source identity, canonical identity and authority deadline. `markSent` validates that binding against current live membership under the publication fence before setting the one-shot sent marker. Real `InventoryMutationStages` → `JobRepository` → `runBulkJob` → `GraphPackagesClient` regressions replace/withdraw/invalidate sources or revoke the principal during the second immediate provider read: **zero provider mutations**, unsent failed items, and started/failed audit events. Optional expiry is separately covered. Unchanged single and multi-target jobs still perform their qualified writes. |
| **2 — optional identity expiry: fixed** | `assertCurrentMutationTargets` and `inCurrentSelection` now use shared `currentInventorySourcesSql`, including its clock-expiry predicate. A real streamed catalog/detail/reconciliation fixture first proves details current, captures a pin and submits a job, then expires only optional detail authority. Before background reconciliation, the staged-target check, current-selection mutation gate, preview, submission and final dispatch reject; retained catalog reads still work, and a fresh read capture presents stale optional evidence. |
| **3 — quarantine GET authority writes: fixed** | Status GET no longer calls recovery. Real authenticated HTTP GETs for owned, foreign-tenant and nonexistent jobs, plus job list/audit reads, issue **zero job/item/attempt writes** despite expired running leases. Recovery runs by configured tenant through the existing startup and non-overlapping 30-second maintenance-aware loop, with the existing shutdown drain. Running and startup-queued batches each cap at 1,000 jobs; startup drains full batches before admitting new HTTP jobs. Real scoped recovery and queued-progress tests, plus startup/non-overlap/shutdown tests, pass. |
| **4 — stale optional UI evidence: fixed** | Already-stale `identityDetails.current=false` deadlines are not active query-expiry dependencies. Current identity/package/access details and valid selection deadlines still expire normally. Real App/query-wrapper and desktop/mobile browser fixtures retain the readable catalog and show stale-detail diagnostics instead of clearing/reloading it. Future-expiry regressions remain strict. |
| **5 — Viewer group export selection: fixed** | Canonical group selection is read/export state for Viewers as well as Admins. Admin-only mutation count requests, previews and controls remain separate. Select/deselect and mixed group/single export send two bounded canonical IDs without enumerating members/children or requesting mutation authority. Real desktop/mobile native downloads pass; existing ownership, role-loss/reset and selection-cap behavior remains covered. |

The baseline `phase04-acceptance-repair-before.log` reproduced unsafe staged
provider writes after invalidation, **10 quarantine authority UPDATEs** from
GET-side recovery, the Viewer checkbox failure, and rejection of stale optional
evidence by the query wrapper. Intermediate `after-1` through `after-4` logs are
retained honestly: they also contain corrected syntax, schema-mock, fixture
provenance and assertion-shape mistakes, not additional claimed product defects.
The final optional-detail fixture uses the real stream/projector with matching
catalog revision markers and proves it was genuinely fresh before expiry.

### Durable authority contract and producer trace

Forward **migration74** requires empty package target tables; it does not
convert prior application data. Migrations **1–73 remain byte-for-byte identical
as executable SQL**. The new job binding is:

`source_generation_id`, `source_identity`, `agent_id`, `authority_expires_at`.

Staged targets always populate the complete tuple; submission copies it to
immutable durable job items. The tuple has an all-null/all-present constraint
and an immutable UPDATE trigger. It has no generation foreign key and does not
extend a browser selection's retention. A real test deletes the preview and its
selection/pins before executing an otherwise unchanged staged job successfully.
Fresh installation, repeated migration verification, immutable binding rejection,
and refusal of populated target migration are tested.

The frozen revision is the **individual source-record generation**, not the
whole canonical projection generation. Canonical identity and the original
authority deadline are also frozen. Prior verified readbacks settle through the
existing inventory runtime before the next staged target, without rebinding a
remaining target or extending its deadline. This preserves normal multi-target
execution while still rejecting source/control revision or identity changes.

The final transaction takes the tenant/principal **data-sync publication mutex
before source-scope and job locks**, retains lease/cancellation/deadline checks,
and only then admits `sent_at`. Existing provider reauthorization, both prestate
reads, provider readback, capability/role/CSRF controls and per-target audit/error
handling remain in place.

Ordinary bulk and exact/single package producers use `InventoryMutationStages`.
The only production direct `JobRepository.submit` package producer is the
approved `submitCanaryJob` path. Direct canaries retain their separate approved
cycle and per-dispatch reauthorization contract; their unbound tuple is not a
fallback for staged inventory jobs. Canary authorization/restoration tests pass.

### Validation and directly coupled repairs

Commands below use
`pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1`.
Log names are under `artifacts/phase04-acceptance-repair-`.

| Selector / evidence suffix | Actual result |
|---|---|
| `-Suite inventory-acceptance-repair` / `focused-final.log` | **325 backend, 302 frontend passed**; backend typecheck, frontend lint and build passed. Backend 28,815ms; frontend 100,955ms. |
| `-Suite cutover-browser-contract -BrowserFiles inventoryAcceptance.spec.ts` / `browser-final.log` | **4 real browser tests passed** across desktop/mobile, 7.8s; packaged fixture/build passed. The preceding browser log retains a corrected export-fixture deadline/native-link interaction failure. |
| `-Suite inventory-staging` / `staging-final.log` | **28 backend, 277 App tests passed**; typecheck/build passed. The unchanged 5,001-source / 51-page / 5,000-target / 50-item-page fixture completed in **91,385ms** with zero provider mutations. App counts are also in its structured JSON report. |
| `-Suite inventory` / `inventory-final.log` | **556 backend, 359 frontend passed**. Backend 274,026ms; frontend 13,468ms. The same unchanged 5,000-target assertion completed in **86,300ms**. |
| `-Suite all` / `all-final.log` | **4/5 independent commands passed**. Backend terminated at **600,108ms**, `SIGTERM`, `spawnSync npm ETIMEDOUT`; no complete backend success is claimed. **2,388 frontend tests**, backend typecheck, frontend lint and root build passed. |
| `-Suite inventory-acceptance-recovery` / `schema-recovery-final.log` | Final late schema/startup overlay: **63 backend tests passed**, 12,962ms; final backend typecheck passed, 2,782ms. Includes all database migration/retention tests, quarantine repository/query-spy tests and startup/maintenance/shutdown tests. Earlier `recovery-final.log` separately records 41 passing lifecycle tests. |

The first required inventory attempt exposed a **repair-induced** 120-second
timeout in the unchanged 5,000-target test: the initial implementation queried
live authority once per target. This was repaired at the cause by fetching
authority **once per existing bounded 100-target page**, retaining exact
membership/revision/identity/deadline comparisons. `staging-final` and the full
`inventory-final` then passed. No deadline, RAM, file parallelism, assertion or
cardinality was relaxed.

The independent aggregate also exposed one old migration-test expectation:
nonempty schema7 jobs had been expected to migrate into the latest runtime.
Migration74 intentionally forbids that conversion. The test now retains all
existing job/item/qualification/audit assertions through frozen migration73,
requires runtime schema verification and migration74 to reject that nonempty
database, and proves migration history and target data remain unchanged.
The complete **22-test database suite** passes within the final 63-test result.
The aggregate was not rerun to conceal its failure/timeout.

Startup batching was also completed rather than leaving more than 1,000 queued
orphans stranded: recovery reports queued progress and startup drains full
batches before listening. The final 63-test run qualifies this late overlay.
The source receipt explicitly records the **eight-file post-aggregate overlay**
(two production recovery files, their tests, migration test, selector plumbing
and related operations documentation); it does not claim the aggregate image
contained those later edits.

Editor diagnostics and `git diff --check` are clean. Frontend lint retains only
the two pre-existing App effect-dependency warnings; no new lint error remains.

### All-root impact, integrity and cleanup

Compared with this worker's immutable `before.json`:

- **Backend:** 19 modified files and two additions. Durable authority, migration74,
  current mutation selection, existing recovery lifecycle, and directly related
  database/service/route/schema tests and fixture selectors.
- **Frontend:** four modified files and one added browser spec. Optional expiry,
  Viewer read/export selection, and their real App/query/browser regressions.
- **Scripts:** only the qualification selector allowlist changed.
- **Docs:** operations, security model and record-data foundation updated.
- **Root configuration/dependencies:** unchanged. No installation, branch,
  commit, push, production reset/deploy or live-provider operation.
- **Plan/completion:** this append only; the parent-owned campaign ledger and
  all nine ordered prompts remain unchanged.

Evidence:

- `phase04-acceptance-repair-source-overlay.json`: complete **727-file** current
  hash map, source delta and preserved inputs. The runtime manifest is **703
  files** (the continuation's 700 plus three additions); the continuation's ten
  deletions remain absent.
- `phase04-acceptance-repair-image-source.json`: exact final qualified
  image/source equality, aggregate-image hashes and the subsequently qualified
  overlay. `image-source-focused.json` preserves the earlier image proof.
- `phase04-acceptance-repair-migrations-final.json`: all **73 frozen executable
  checksums unchanged**, with migration74 checksum
  `ab8d8d101426a17d1589f5a399a7ff5d57c7baea5b03c6918885024f4dc1d9ce`.
- `phase04-acceptance-repair-validation.json`: genuine command receipts,
  successful counts and preserved failing/timeout evidence.
- `phase04-acceptance-repair-cleanup.json`: **14 exact-owned fixture projects**
  have zero remaining containers, networks or volumes. Disk PGDATA ownership
  and captured `OOMKilled=false` are verified. Read-only, network-none source
  proof containers are absent. Qualification images/logs remain intentionally
  retained; the three protected baseline/browser/final03 image IDs are unchanged.
- `phase04-acceptance-repair-resource-limits.json`: actual Node **1,536MiB** and
  PostgreSQL **1,024MiB** limits, unchanged inherited swap totals, **768MiB**
  workload-child old-space setting and no host-port publication.

All **14 protected inputs, nine prompts and six historical receipts** match
their prior hashes. The continuation's **39,687-byte** completion prefix and
the parent's documented acceptance-review append are preserved; this worker
captured and preserved that complete **42,212-byte** prefix before appending.
No retained recovery or seha3002 resource was changed.

### Residual cost, containment and next-phase authority

The five correctness findings are implemented and verified. The remaining
aggregate cost obligation is still **07-owned**:

- Independent backend: **600,108ms timeout against 600,000ms**, 34 completed
  files, no complete backend result. The surfaced old migration expectation is
  separately corrected and green; the remaining overall timeout is not hidden.
- Original deployment gate remains the historical **0/5**: backend **180s
  ETIMEDOUT**, four commands not run. The independent 4/5 result is **not** a
  substitute for the actual unchanged original gate.
- **Before maintenance, app stop, reset or deployment**, 07 must achieve the
  actual unchanged **5/5**, verify cleanup, and only then perform the already
  authorized fresh-application-database reset through the checked-in deploy
  workflow. No phase04 reset/deployment authorization is inferred.

Any unsafe-authority acceptance, missing cleanup proof, original-gate failure,
or recurrence of the unchanged **120s 5,000-target**, **15s inventory export** or
**60s 30,001-user** limits is a concrete fix-forward trigger. Preserve the
affected admission/publication/mutation fence and capture bounded evidence;
do not raise limits or terminate the overall Always-Deploy campaign. The 06
100k/1m/churn qualification and 07 production observation are not claimed here.
The parent alone may accept phase04 and authorize the next ordered step.

## Final parent acceptance

**Accepted: `complete_with_risk`.** All five acceptance findings are repaired
and independently verified. The earlier not-accepted state remains historical;
phase05 may now begin. This is not production qualification or deployment.

Parent inspection confirmed the durable per-target binding and publication
fence at final dispatch, separate approved-canary authority, shared expiry
checks, read-only quarantine polling with bounded lifecycle recovery, and
frontend stale-detail/Viewer selection fixes. Real staged/provider and
HTTP/App regressions cover the previously unsafe or broken paths.

- `artifacts/phase04-parent-repair-verification.log`: **327 backend /
  302 frontend passed**, plus backend typecheck, frontend lint and build.
- `artifacts/phase04-parent-recovery-verification.log`: **63 passed** plus
  typecheck, covering the final migration/recovery overlay. This overlaps
  the preceding suite; counts are not summed.
- **703 runtime / 727 manifest hashes**, **28 changed / three added** repair
  files, ten preserved deletions, protected inputs/prompts/receipts and
  completion prefixes verified. All **74 executable migration checksums**
  verified, with **1-73 unchanged** and migration74 frozen at
  `ab8d8d101426a17d1589f5a399a7ff5d57c7baea5b03c6918885024f4dc1d9ce`.
- **14 repair projects and two parent fixtures** independently verified
  clean; protected images unchanged; read-only proof containers removed;
  `git diff --check` passed. No production action or commit.

The independent aggregate remains **4/5 / 600,108ms backend timeout**, with
the late overlay qualified separately, not retroactively. The actual original
gate remains historical **0/5 / 180s timeout**. Phase07 must repair real cost
and achieve unchanged **5/5 plus cleanup before maintenance/reset/deployment**.
No threshold, fixture-size, assertion or memory increase is authorized to
erase that debt. Phase05 owns deeper lifecycle/restore/resource closure;
phase06 owns full-envelope qualification; phase07 owns verified seha deployment.
