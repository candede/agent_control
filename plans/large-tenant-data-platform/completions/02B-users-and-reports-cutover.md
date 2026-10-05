# 02B — Users and official reports atomic cutover

**Implementation status: complete_with_risk.** The users/report code cutover,
frontend, durable exports, deletion and directly implicated operator/browser
contracts are implemented and verified. **Production qualification remains
`blocked_safety_check`: the unchanged original software gate is 0/5 because its
backend command exceeds 180 seconds.** This is not an approved passing gate.
No production deployment, maintenance, reset, migration or provider mutation
was performed. The parent owns campaign acceptance and the ledger.

Completed against the phase-02B prompt, position 4/9, on 2026-09-29. Repository:
`/Users/candede/repos/agent365/agent_control`; implicated roots are `backend/`,
`frontend/`, `scripts/`, `docs/` and root build/deployment configuration.

## Hypothesis and contract-first evidence

Hypothesis: the record-backed user sources and retained report authority can
replace every live producer/consumer together without a compatibility path or
loss of report/licensing semantics. The first executable falsifier was the
real route-to-client boundary in `backend/src/routes/dataPages.test.ts`.
`artifacts/phase02b-contract-first.log` records its initial failure;
`phase02b-contract-fixed.log` and the later exact selectors record repairs.
The required frontend boundary suite is
`frontend/src/components/LargeTenantUsersReports.test.tsx`.

The bounded caller/deletion inventory included live writers, middleware,
shared types, API serializers, hooks/query keys, App orchestration, every
listed user/report/detail/import/history component, inventory enrichment,
exports, lifecycle SQL, browser fixtures and compiled restart consumers.
`artifacts/phase02b-retired-test-scenarios.json` records predecessor scenario
ownership; the final source/deletion manifest contains 290 entries, including
preserved predecessor foundations and 28 deleted tracked files.

## Activated authority and cross-root implementation

### Backend producers, readers and authentication

- `services/copilotUsage.ts`, actual data-sync orchestration,
  `services/userSourceProvider.ts`, `db/userSourceStages.ts` and
  `db/userSources.ts` now own directory and app-activity collection/publication.
  Sources have independent attempts, observation times, availability and retry
  decisions. App-only collection does not pretend retained directory rows are
  newly observed. The shared Users source stays running while another source
  is still collecting.
- Session/scope/cancellation fences, independent 20-second heartbeats,
  60-second leases, transactional `completeJob` and derived input validation
  remain active. No SQL connection is retained through provider network/backoff
  work. Four connections reserve one for renewal and three for foreground work.
- Positive Users **or** relationship-report identities are fed through bounded
  exact-ID verification, without reading a complete report into JavaScript.
  Pure provider/schema/record-ID helpers were extracted before old containers
  were deleted.
- `db/agentPeople.ts` and `services/savedAgentPeople.ts` use exact IDs and the
  existing status-specific TTL/observation/conclusive-result semantics.
  Conclusive not-found, lookup failure with prior evidence, ambiguity and
  invalidation are distinct. Every cache write/clear/revision path participates
  in its dependency context; reads accept no more than 100 IDs.
- `services/largeTenantUsersReports.ts`, `db/officialReportHistory.ts`,
  `db/officialReportImports.ts`, `services/officialAgentUsage.ts` and
  `services/inventoryReportUsage.ts` are live. Reports reuse the existing
  artifact/version/complete-set/fact tables with typed columns: no second
  report truth or shadow publication was introduced.
- Existing inventory repositories remain inventory authority until 04.
  Their report/people consumers now use targeted summaries, exact stored
  source references and current evidence fingerprints/CAS. There is no
  whole-directory/report adapter or `list(limit:5000)` enrichment bridge.
- `app.ts` registers `createOfficialReportDataRouter` with real session,
  authorization and policy middleware. `server.ts` starts/drains the durable
  report runtime. Reports remain tenant-visible; directory/inventory evidence
  remains principal/token-mode scoped.

### HTTP and frozen wire contracts

The normative contracts remain `types/officialReportData.ts`,
`types/officialReportApi.ts` and `docs/official-reports-foundation.md`.
Live paths below are under `/api`:

| Surface | Live contract |
|---|---|
| Selected lists and facets | `GET /copilot-usage/users`, `/official-usage/aggregate`, `/official-usage/users`, `/official-usage/agent-users`, `/official-usage/history`, `/official-usage/overview`, with their `/facets` paths |
| Exact directory detail | `GET /copilot-usage/users/:objectId`, separately paged `/service-plans` and `/agents`; static `/users/unresolved-identities` precedes the parameter route |
| Exact report detail | `GET /official-usage/agents/:agentId`, `/users/:username`, and separate agent/user relationship and user-plan pages |
| Historical children | `GET /official-usage/history/:setId/observations` and `/official-usage/overview/:agentId/creator-types` |
| Streamed imports | `POST /official-usage/staging`; `GET`, `DELETE`, diagnostics and acceptance for `/staging/:id`; bundle preview/acceptance at `/bundles/:id/preview` and `/accept` |
| Set mutation | `POST /official-usage/sets/:id/preview`, then `/official-usage/confirmations/:id` with the exact reviewed confirmation |
| Existing inventory usage | Exact `/agent-inventory/:recordId/usage`, paged candidates/associations, and reviewed association mutations |
| Durable exports | `POST /data-exports`, `GET`/`DELETE /data-exports/:id`, native `GET /data-exports/:id/download` |

Selections bind immutable query intent, scope, authorization, roots and cursor
ordering. Related metadata, rows, counts, facets and analytics execute through
one validated repeatable-read client/callback/captured time. Serialization
conflict remains `503 data_read_conflict`, `Retry-After: 5`, without replay or
weaker fallback. Limits remain SQL 250 rows/1 MiB, residual JSON 256 KiB,
API 1 MiB, exact detail 512 KiB, default page 50/max 100, cursor 4 KiB,
exact IDs 100 and dependency roots 16.

Imports retain immutable query intent when fields precede **or follow** the
file; bounded previews/diagnostics, abort/disconnect/revocation, receipt
idempotency, explicit acceptance and select/delete confirmation are active.
The acceptance wire receipt is exactly `{setId,activeRevision,complete}`:
no `reusedExistingSet` field or old-field fallback.

One temporal history root addresses 32+ sets. Ordinary acceptance advances
membership revision while preserving existing pinned membership.
Non-active correction/deletion/expiry advances invalidation epoch and
invalidates history, overview and exports even when the active head is
unchanged. HTTP regressions exercise acceptance between pages, non-active
correction/deletion, unchanged active revision and invalidated exports.

### Frontend and durable exports

- `api/reportData.ts`, `api/client.ts`, `useReportPage.ts`, related query keys,
  `App.tsx`, and all inventoried user/report/import/history/detail components
  consume the frozen bounded envelopes. Query retention is bounded to the
  current/adjacent-page budget, never a tenant-wide page drain.
- Search, company/department facets, server sorting, response/agents-used/
  activity sorts, cohort cards, thresholds, provenance, historical selection,
  licensed/service-plan presentation, unknown/stale states, roles,
  accessibility and navigation survive. Counts are server counts.
- Exact parent details and separately paged plans, relationships, unresolved
  identities, creator types and observations replace embedded collections.
  Stale requests abort; `selection_invalidated` is visible and requires an
  explicit restart. A byte-short page can still have `nextCursor`; cursor
  presence, not `rows.length === limit`, controls continuation.
- Saved-report management remains the original history-only surface, without
  adding a new cross-import locator. The standalone bounded overview component
  and API retain coverage. Route-isolation browser assertions inspect the
  actual history request and ensure no inherited set/search/cursor/offset.
  Choosing the current report or placeholder cancels an unused review.
  Historical dates are readable UTC dates in semantic `<time datetime>`.
- The parent's App startup-observer ordering regression was preserved, not
  reverted. Final App/full frontend tests pass.
- `ReportExportDispatcher`, `OfficialReportExports` and
  `ReportExportButton` provide real persisted queue discovery, build, status,
  cancellation, expiry, restart ownership and native streamed download for
  `copilot_users`, `official_agents` and `official_users`. Browsers poll
  metadata only; they do not buffer these CSVs as Blob/string/ArrayBuffer.
- Export batches use `context.read` fences, 256-KiB chunks, a 15-minute build
  deadline, 30-minute expiry, 1-GiB/2-million-row ceilings and at most 5,000
  explicit IDs persisted in 250-row/1-MiB batches. Formula safety and exact
  audit classifications remain. Official-user CSV is a **relationship-row**
  export, including an unknown relationship row where necessary; repeated
  user metrics are not additive.

## Deletion, schema and directly affected operations

Deleted replaced runtime containers include:

- `db/officialUsage.ts`, `db/agentUsage.ts`;
- old `routes/copilotUsage.ts`, `routes/officialUsage.ts`,
  `routes/agentUsage.ts`;
- old full-report parser/views/history/overview services, the full-source
  `copilotUsageIdentity.ts`, old `copilotUsageGraph.ts`, and old agent-usage
  service/validation containers;
- obsolete `types/officialUsage.ts` and `types/agentUsage.ts`;
- browser legacy-format migration/acknowledgement storage and whole-source
  fixtures that supported only the removed formats.

Pure records/schema declarations now live in `officialReportRecords.ts`,
source-qualified targets in `agentUsageTarget.ts`, scalar identity
normalization in `copilotIdentityKey.ts`, and pure CSV encoding in
`csvEncoding.ts`. These are not compatibility aliases.

Forward migration **50** is fresh-data guarded. It drops only the obsolete
`copilot_usage_source_state` and `copilot_usage_snapshots` tables and the unused
`official_usage_row_facts_observed` index. It adds the immutable acceptance
revision, durable export actor and generation-collection lifecycle metadata,
and replaces directly affected clear/invalidation guards. It does not convert
or backfill old application payloads. Migrations **1–49 are unchanged**;
schema tests retain their historical checksums, including migration 49's
SQL checksum `a322adb86d30fd5758a99947214102eab740a707790c64d36cc434c5a9f232e3`.
Unrelated immutable history and audit infrastructure is retained.

Clear, retention, grants, startup verification, backup/restore SQL,
`database.ts`, `backup.ts`, browser bootstrap and restart fixtures were
updated now, not deferred as broken commands to 05. Compiled restart proof
retains the tooling/application-role split and three real crash modes
(`crash-quarantine`, `crash-canary`, `crash-bulk`) before recovery; it also
discovers persisted queued exports after process replacement. This is not a
claim that phase 05's entire scale/lifecycle campaign has run.

Final four-root deletion searches found no runtime imports of removed
containers and no live `publishDirectory`, `publishAppActivity`,
`getUserSources`, `getDirectorySource`, `getAppActivitySource`, `getPublished`,
`readSources` or `memoryStorage` callers. Remaining method-name matches are
explicit removal assertions. Old user/report `.csv` and admin routes have
404 tests. Unrelated inventory/audit CSV buffering remains its existing
authority and was not silently recast as a report export.

Changed-root inventory is frozen in
`artifacts/phase02b-source-manifest.json`. Detailed semantic successor mapping
is in `docs/official-reports-foundation.md`, including retired route suites,
streaming parser boundaries, native 100,000-identity unions, licensing goldens,
exact people evidence, selected-read isolation and old-format rejection.
All exact prompt selectors remain executable; no selector was silently
skipped. User/import/operations/foundation documentation and directly affected
build/deploy fixture references were updated. Dependency manifests and
approved-feed configuration were preserved; no package installation occurred.

## Root-cause repairs and autonomous decisions

1. **Publication deadlock, not a retry.** The full aggregate exposed a real
   run/source-row lock cycle: a generation fence held the run while waiting
   for a child source; source-status publication held the child while updating
   the run. Run-backed fences/renewals/publication now take the existing
   per-principal data-sync mutex before generation locks and before derived
   input validation, matching status and people-cache publication ordering.
   A deterministic real-database regression proves a blocked fence has not
   acquired the scope lock needed by the status transaction. Session, lease,
   source-job and completion checks were not weakened.
2. **Actual query-plan repairs.** Captured fresh-data plans merged on report
   kind and filtered payload hashes afterwards. Multi-batch projections now
   discourage nested/merge plans and disable transaction-local JIT, restoring
   settings at transaction end. The initial 10,000-row cutoff still left a
   1,000-user nested loop discarding 2,001,000 combinations; policy now applies
   above one 250-row batch. Both measurement sizes assert against these plans.
   Final combined reads measured **75–98 ms for 1,000 users** instead of
   **4,702 ms**, and **772–938 ms for 10,000 users**.
3. **Small tenants beside large facts.** Actual analysed-statistics plans
   scanned 150,003 facts three times for a three-row tenant. Explicit tenant
   predicates on both count relations preserve all integrity checks while
   exposing index selectivity. Capture+page fell from approximately
   **295–375 ms to 13–48 ms**. Both cold 100,000-identity union tests remain;
   a new tooling-ANALYZE regression also bounds actual small-tenant fact probes
   to 250 visited rows. Runtime receives no ANALYZE privilege.
4. **Write-path index/planning.** The removed timestamp-leading index caused
   exact fact FK probes to scan a tenant prefix: measured **2.286 ms to 0.01 ms**
   after removing that unused index; 10,000-row report acceptance improved
   from about 14–15 seconds to 2.83 seconds. Transaction-local custom/discounted
   sequential planning for directory plan-child writes reduced the
   30,001-user/90,003-plan collection from about 44 to 21 seconds. No memory,
   statement/test deadline or qualification threshold was raised.
5. **Browser scope and quotas.** Real-server CSV workflows explicitly accept
   reviewed bundles and select only when needed, retaining duplicate and
   delete/reimport identity checks. Desktop/mobile use two existing synthetic
   actors instead of exhausting one actor's unchanged 100-live-selection cap.
   History-only management and real route-isolation assertions replaced stale
   locator expectations; no missing control was hidden by a compatibility DTO.

## Verification receipts

All container execution used unique owned
`scripts/large-tenant-tests.ps1` fixtures, installed dependencies, no host ports,
no external providers or production secret mounts, fixed Node **1536 MiB /
768-MiB old space**, PostgreSQL **1024 MiB**, and owned disk-backed PGDATA/WAL/
temporary work. Commands below use
`pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite ...`.

| Final or directly relevant command | Observed result / evidence |
|---|---|
| `user-sources-foundation` | **280 tests / 7 files**, backend types pass; `phase02b-user-foundation-final.log` |
| `official-reports-foundation` | **314 tests / 9 files**, types pass, 108.21 s; `phase02b-official-foundation-converged.log` |
| `users-reports-cutover` | Exact required selectors: **337 backend / 9 files + 527 frontend / 8 files**; `phase02b-cutover-converged.log` |
| `cutover-automatic-contract` | **331 tests / 13 files**, types pass, including deterministic publication lock order and real automatic refresh; `phase02b-publication-lock-order.log` |
| `cutover-native-views` | **51 tests / 2 files**, types pass, unchanged native deadlines and analysed-statistics regression; `phase02b-native-small-tenant-repair.log` |
| `cutover-ui-contract` | **973 tests / 23 files**, frontend lint pass; `phase02b-selector-cancel-ui.log` |
| `cutover-retention-contract` | **153 tests**, types pass; `phase02b-retention-converged.log` |
| `cutover-compiled-restart` | Backend build and actual compiled-process recovery pass; `phase02b-compiled-converged.log` |
| `cutover-browser-contract` — eight primary/implicated specs | **144/144 pass** through synthetic-auth Chromium/axe, desktop/mobile; `phase02b-browser-converged.log` |
| Same browser selector — all six remaining changed specs | **151 pass**; nine pre-existing mobile duplicates of desktop-run viewport/density matrices remain excluded as before. No skips added. `phase02b-browser-adjacent-verified.log` |
| `cutover-types` after the final browser-only repair | Backend types and frontend build pass; `phase02b-types-browser-final.log` |
| Mocked PowerShell orchestration | **1,319 assertions pass**; `phase02b-orchestration-verified.log` |
| Final editor diagnostics / `git diff --check` | No diagnostics/errors or whitespace errors |

Primary browser files: `agentContext`, `agentPeople`, `copilotUsers`,
`csvUsageReports`, `cumulativeUsage`, `officialUsage`, `reportSets`, `userDetails`.
Remaining changed files: `agentCatalog`, `agentExperience`,
`agentResponsibility`, `automaticRefresh`, `layout`, `permissions`
(all `.spec.ts`). The earlier adjacent run's two stale history-locator failures
were repaired and the complete six-spec command rerun successfully.

### Independent five-command aggregate: **5/5**

`-Suite all`, `artifacts/phase02b-aggregate-converged.log`:

| Command | Exit | Evidence |
|---|---:|---|
| `npm run test --workspace backend` | 0 | **4,268 tests / 165 files**; command 304.955 s, Vitest 304.68 s |
| `npm run test --workspace frontend` | 0 | **2,340 tests / 78 files**; command 97.866 s |
| `npm run typecheck --workspace backend` | 0 | 2.408 s |
| `npm run lint --workspace frontend` | 0 | 12.196 s |
| `npm run build` | 0 | 10.765 s |

This independent runner is **not** the original deployment gate. The existing
large-bundle warning remains enabled; it was not suppressed. The final
browser-only test repair was subsequently checked by all affected browser
specs, backend types and frontend build.

### Original software gate: **0/5, not qualified**

Both actual `-Suite software-gate` attempts are recorded in
`phase02b-original-gate-actual.log` and
`phase02b-original-gate-converged.log`. Both invoke the original
`Invoke-LocalSoftwareChecks`; backend exits via
`spawnSync npm ETIMEDOUT` at the unchanged **180-second** limit. The other four
gate commands are **not run by the fail-fast guard**, not reported passed.
`OOMKilled=False`; this is real workload/cost qualification debt.

Earlier true failures remain in the evidence: the full aggregate's publication
deadlock, native-view timeouts, stale UI locator assertions and shared browser
actor admission. They were repaired and rerun, not suppressed. Backend
aggregate duration improved from the failing **360.82 s** attempt to a passing
**304.68 s**, but still exceeds the original guard by **124.68 s**. Largest
observed backend files include combined native users/reports (58.377 s),
native views (30.562 s), and the existing registry/inventory integration files
(24.175 s and 23.599 s).

The earlier 08:59 aggregate's **four skipped backend cases** were all
`src/appRedirect.test.ts`: suite setup failed because its construction-only
database stub lacked `options.max`, and teardown then waited for a nonexistent
server. They were not intentional skips or passing tests. The stub now declares
the real four-connection contract and teardown closes only a created server.
All original redirect/privacy/no-database-access assertions remain unchanged.
All **four execute and pass** in the final aggregate (27 ms) and the focused
publication suite (30 ms). The final backend aggregate reports **4,268/4,268
passed, zero skipped**; the earlier counts are superseded, not relabelled green.
This is separate from the nine pre-existing browser viewport exclusions above.

## Environment, preservation and cleanup

`artifacts/phase02b-cleanup-final.json` checks **310 recorded fixture project
identifiers**, **466 physical mount records** and **448 attested/explicit known
volume names**: **zero remaining owned containers, networks or volumes**.
This is an audit of recorded identifiers, not a claim that all were created.
The explicitly stopped `87c06558cffb4bb08039ea546d82e8ee` worker and its
`97d34822...5ecedb0` anonymous volume are absent. Every normal wrapper captured
live/final memory and verified exact labels/mounts before teardown; no shared
project kill/prune or protected image deletion was used.

Final aggregate measured PostgreSQL peak **761.13 MiB** and Node/workload peak
**968.70 MiB**, with **zero OOM / OOM-kill events**. Diagnostics are in
`artifacts/large-tenant-data-platform/783238608d9c42ffad858483ccab3acd/`.
Owned operator images and evidence are deliberately retained for parent
reproduction, not running fixture resources:

- Aggregate operator:
  `agent-control-ltdp-783238608d9c42ffad858483ccab3acd-operator:local`,
  `sha256:b7736d96e8c268f89922243f0942ce7c77dddaf51fe83663a9fdc2d00746bde6`.
- Final browser/type operator:
  `agent-control-ltdp-92651605abae4926a203968c4b47dd20-operator:local`,
  `sha256:b485d7f7ed90efda565bcdb4971e252d0fab23041e2bab554f165a65ec419efe`.
- Protected operator unchanged:
  `sha256:78f3cb9fa91e7a64960699899d8fe2eb56bdd77c8ee56490f1f5255855b3c235`.
- Protected browser unchanged:
  `sha256:b4eda044a9e58194703b1aa3e3209d3a7ea9cc219f9df14d36d418db873bb60b`.

`phase02b-preservation-final.json` verifies all nine parent-owned prompt hashes
and exact migration-49 source identity. The campaign ledger and predecessor
completion records were not edited. Prior work was preserved; no commit,
push, branch, nested agent, package installation or production action occurred.
No production credentials/configuration/domain/URL/port/callback/proxy/backups
were changed.

## Residual obligation and phase-03 preconditions

**Open: `blocked_safety_check` — original software qualification cost.**

- **Signal/threshold:** actual backend `ETIMEDOUT` at 180 s; independent full
  backend command 304.955 s. Passing test assertions under the independent
  runner does not qualify deployment.
- **Containment:** no production maintenance/reset/start/publication was
  performed; original guards remain intact. No memory/deadline increase,
  test suppression, internal Start call or direct-start bypass was introduced.
- **Owner:** parent integration owner / phase **07**.
- **Trigger:** further measured root-cost repair followed by an actual
  unchanged original **5/5** gate before any approved production maintenance
  or reset. Keep this status open until that real receipt exists.
- **Production continuation:** phase 07 still owns physical identity checks,
  preservation of seha/localhost:3002 configuration, the specifically
  authorized `pwsh ./deploy-local.ps1 start -Project seha -DbReset`, and
  observe/fix-forward. This record does not replace that required production
  execution with a test-only ending or waive its guard.

Phase 03 receives **live record-backed users/reports code, complete current
user/report UI and durable exports**, not dormant scaffolding. Old-format
readers are gone and directly affected browser/operator/restart consumers are
verified. Inventory itself remains its existing authority until 04; its
already-targeted report/people consumers and source-fingerprint/CAS contracts
must be preserved.

03 must preserve frozen envelopes, tenant-history temporal membership and
invalidation, principal/token-mode evidence scope, mutable dependency fences,
bounded exact IDs/pages/batches, repeatable-read callback ownership, the
data-sync-mutex-before-generation/input-lock order, independent renewal and
transactional completion. Migrations 1–49 remain immutable and migration 50
remains forward/fresh-data guarded. Phase 05 owns the additional complete
lifecycle/scale campaign, 06 capacity qualification, and 07 the still-open
original-gate cost repair and authorized production convergence.

## Bounded UI acceptance repair — 2026-09-29

**Worker result: the three parent-assigned UI defects are repaired and
verified; parent acceptance is still pending.** This addendum preserves every
historical result above. It does not change the campaign ledger, phase prompt,
original deployment-gate status, production authority or later-phase scope.

### Reproduction and precise repairs

The falsifiable hypothesis was that the three failures originated in frontend
dismissal/date state and facet encoding, not the already-correct backend
acceptance or filter contracts. Render regressions were added before runtime
edits. The existing owned `cutover-ui-contract` wrapper reproduced **eight
failures / 976 passes** in 23 files, with lint passing:
`artifacts/phase02b-ui-repair-reproduced.log`.

1. **Verified non-active imports:** four real-modal cases cover duplicate and
   correction acceptance, each dismissed by **Cancel import** and the native
   dialog cancel event generated by Escape. Previously every dialog remained
   open because dismissal entered the active-set finish check. A conclusively
   verified non-active saved import now calls the dismissal callback directly,
   without selection preview/confirmation, discard, repeat acceptance or
   navigation. Tests retain all three accepted stage receipts and the
   unchanged active-set/revision evidence. Active-success acknowledgment still
   revalidates; **OK**, explicit adoption, one-use revision confirmation,
   pending-upload cleanup and in-flight/ambiguous acceptance guards remain.
   The existing ambiguous-response test now additionally proves dismissal
   cannot bypass recovery.
2. **Optional period metadata:** both date controls derive provenance only
   from a complete pair. Clearing both removes start/end/provenance from the
   actual `stageReport` multipart body. Two render-to-real-serializer cases
   exercise both clearing orders while retaining independent source-as-of
   metadata. Three additional cases prove incomplete/reversed dates still
   reject before uploading. No backend all-or-none validation was relaxed.
3. **Nullable facets:** one shared encoding helper now supplies both API
   organization serialization and rendered option values/keys: `~null` for
   SQL null and `~string:` plus the full literal string otherwise. The
   untagged empty option alone means no filter. Render regressions for company
   and department select null, `"null"`, `"~null"`, `""`, `"~string:"` and
   `"~string:null"` independently, asserting raw change values, serialized
   filters and absence of duplicate-key diagnostics. Creator-type UI options
   use the tags too; their existing raw HTTP query meaning is unchanged.

The first repaired run passed all eight reproduced cases but exposed one
coupled test locator still using `~Sales` (**983 passed / one failed**);
`artifacts/phase02b-ui-repair-fixed.log` preserves that actual failure.
The selector and all directly coupled old facet-value selectors were updated,
not skipped or weakened. The final focused and aggregate runs pass.

### Exact changed files and producer/consumer impact

- Frontend runtime: `frontend/src/components/OfficialUsageImportPanel.tsx`,
  `frontend/src/components/ReportFacet.tsx`, `frontend/src/api/reportData.ts`.
- Render/unit tests: `frontend/src/components/OfficialUsageImportPanel.test.tsx`,
  `LargeTenantUsersReports.test.tsx`, `CopilotUsersView.test.tsx`,
  `OfficialUsageViews.test.tsx`, `ReportedUserActivity.test.tsx` in the same
  components directory. **Eleven new cases**; existing assertions retained,
  with stronger ambiguous-acceptance protection.
- Existing browser consumers:
  `frontend/browser/copilotUsers.spec.ts`,
  `frontend/browser/officialUsage.spec.ts`; only directly affected option
  selection values changed.
- Directly related documentation: `docs/official-reports-foundation.md`,
  `docs/official-usage-import.md`, plus this appended completion record.

The importer-to-modal callback/route boundary was checked and rendered with
the real modal. `companionMetadata` already restores complete metadata triples
and needed no change. `UserActivityFilters`, user/report views, query captures
and `ReportExportButton` preserve raw nullable filters and selection-pinned
export authority. The existing selected-data test fixture already decodes the
correct HTTP null/string tags. No second serializer/API alias was added.

Backend impact check: `officialReportMultipart` already enforces zero or
three period fields; `officialReportData.requestQuery` already distinguishes
`~null` from `~string:` literals. Shared report/import/facet types, acceptance
receipts, exact facet SQL and selected export contracts remain unchanged.
No backend runtime/schema/type edit was required. The full backend suite and
backend typecheck pass. Scripts/root configuration required no change:
existing wrappers, synthetic browser bootstrap, fixed budgets, approved feeds
and original guards were used unchanged.

### Verified command receipts

All commands used
`pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite ...`.
Editor test discovery returned no tests; executable evidence comes from the
actual owned wrappers, not that unavailable discovery path.

| Suite | Observed final result | Evidence |
| --- | --- | --- |
| `cutover-ui-contract` | **984/984 tests, 23 files**, frontend lint pass | `artifacts/phase02b-ui-repair-verified.log` |
| `cutover-types` | Backend typecheck and frontend production build pass | `artifacts/phase02b-ui-repair-types.log` |
| `cutover-browser-contract -BrowserFiles copilotUsers.spec.ts,officialUsage.spec.ts` | **112/112 desktop/mobile browser cases**, synthetic-auth Vitest/Chromium/axe bootstrap pass | `artifacts/phase02b-ui-repair-browser.log` |
| `all` | Independent **5/5** commands: **4,268 backend / 165 files; 2,351 frontend / 78 files**, backend typecheck, frontend lint, production build pass; zero skipped cases | `artifacts/phase02b-ui-repair-aggregate.log` |

Aggregate command durations were **289.927 s backend**, **92.076 s frontend**,
**2.369 s types**, **12.006 s lint**, **11.567 s build**. The existing large
bundle warning remains visible. This independent runner is not an original
deployment-gate pass. Final editor diagnostics and `git diff --check` pass.

### Exact source identity and cleanup

New scoped evidence:
`artifacts/phase02b-ui-repair-before.json` and
`artifacts/phase02b-ui-repair-source-receipt.json`.
The latter's SHA-256 is
`fdec43d75bdea21869df094c52c36f8cd8d0a9c08b76c0cdeda21083f13c91b1`.
It records before/after hashes for the **12 changed source/test/documentation
files**, command/log receipts, protected identities and exact cleanup checks.
This completion addendum was appended after qualification and is not claimed
to be embedded in the tested images.

Both retained qualified images were directly read back with network disabled;
all 12 scoped source hashes match the worktree:

- Aggregate:
  `agent-control-ltdp-b8cc55e305d34aa5b27ff4d67114208d-operator:local`,
  `sha256:dd879b36a0c63e637980940d49e8c103c958ecf164e8e40b3292520902286a47`.
- Browser:
  `agent-control-ltdp-81c53b36580449e3a784f81adf1d069c-operator:local`,
  `sha256:5523c0cf79cd4a75bc6fd1147ccc42b296f1551ed75b41352ec6f7ad67cbb94e`.

Runtime file SHA-256 values:

| File | SHA-256 |
| --- | --- |
| `OfficialUsageImportPanel.tsx` | `4a6ae615176125359db9c36cd53b5e6f92ce120366417c728ae405cc62751008` |
| `ReportFacet.tsx` | `7eae7ea7500014b698eaaac67b46ccf1f0de8e8639bd9078f5453f3934a0c60c` |
| `api/reportData.ts` | `7cfaefb363e799431d235b85e6ae1387774144e035c592fbfd683b2720689eac` |

The original **290-entry** `artifacts/phase02b-source-manifest.json` was not
overwritten; its SHA-256 remains
`41e16279efde45bd7195f5f516ce4c92634ab1eaca65d8f4b620db7acfb493d7`.
Comparison against it found only these 12 scoped changes, with no other
changed/deleted-path drift. All parent prompt/README hashes and feed/policy
files remain unchanged; the ledger was not edited.

All six owned runs captured diagnostics before exact-label/mount teardown.
Independent checks covered **six exact project labels, 23 recorded mounts
and 11 recorded/named volumes**: **zero remaining owned containers, networks
or volumes; zero OOM/OOM-kill events**. The protected operator and browser
image IDs remain exactly those recorded above. Source-proof containers used
unique owned names, no network/ports and automatic exact-container/anonymous
volume removal. Fixed Node **1536 MiB / 768-MiB old space** and PostgreSQL
**1024 MiB**, owned disk-backed PGDATA and installed dependencies were retained.
No package installation, nested delegation, commit, branch, push, production
action, provider call or secret/configuration change occurred.

### Unchanged original-gate obligation

**`blocked_safety_check` remains open: original gate 0/5, backend
`spawnSync npm ETIMEDOUT` at 180 seconds, no OOM.** This bounded repair did not
rerun or alter that gate and did not attempt its root-cost repair. The current
independent backend command still exceeds the original deadline.

- **Containment:** no production maintenance/reset/start/publication; original
  guards remain intact. No deadline/RAM increase, assertion relaxation,
  suppression, internal Start call or direct-start bypass.
- **Owner:** parent integration owner / phase **07**.
- **Trigger:** further measured root-cost repair followed by an actual
  unchanged original **5/5** gate before any approved production maintenance
  or reset. Keep this status open until that real receipt exists.
- **Continuation:** phase 07 still owns physical identity/configuration checks,
  the authorized seha/localhost:3002 deployment/reset and observation/fix-forward.
  Always-Deploy remains mandatory eventual work, not a test-only ending.

The next action is parent review/acceptance of this bounded repair. This worker
has not accepted 02B, advanced the campaign or implemented any later phase.

## Parent acceptance and quota-contract correction

Parent accepts phase **02B complete_with_risk**, with the original-gate
deadline debt above preserved. All three frontend review findings are closed:
the parent inspected their runtime changes and eleven added regression cases,
then independently ran `cutover-ui-contract`: **984 tests and frontend lint
passed**. Evidence is `artifacts/phase02b-parent-ui-repair.log`, owned run
`686c6674a3ce48539a26e2a7b8acdecb`. Backend/schema/operations and deletion review
and the earlier parent **337 backend / 527 frontend** cutover validation also
remain valid historical evidence.

The parent verified the preserved **290-entry** source/deletion manifest,
including **28 absent deleted paths**, the **12 scoped UI repair hashes** and
all **nine immutable prompt hashes**. The final README-contract comparison
then found one prerequisite mismatch outside the three UI findings: official
staging allowed **4 GiB per tenant**, but the binding workload contract requires
**2 GiB**. The parent restored the existing constant to 2 GiB and corrected
the normative report documentation; actor/bundle limits remain 1 GiB.

The new DB regression uses two independent actors' persisted 1-GiB reservation
counters, not multi-gigabyte fixture payloads. It submits another actual
streamed upload at the 2-GiB boundary and requires explicit HTTP-413
`staging_limit_exceeded`, unchanged published report and reservation total,
no remaining active failed ingestion, and normal staging in another tenant.
Before the constant correction it reproduced the defect: **1 failed / 314
passed**, because the upload incorrectly succeeded. After correction,
`cutover-native-authority` passed **315 tests plus backend typecheck**.
Evidence:

- `artifacts/phase02b-parent-tenant-quota-before.log`,
  run `a7f2fbafa3b8424faccd7bba7bf39257`.
- `artifacts/phase02b-parent-tenant-quota-after.log`,
  run `d03d200e525d44b5816ebab9947aa6bd`.

`artifacts/phase02b-parent-acceptance-receipt.json` records the final three-file
hash overlay over the original manifest and UI receipt. The UI worker's
**5/5 independent aggregate (4,268 backend / 2,351 frontend)** and **112
affected browser checks** precede this narrow parent quota correction; the
parent did not claim another full aggregate or browser run for that change.
Subsequent phase aggregates and the unchanged original deployment gate must
run against their actual final candidates.

Parent independently verified exact-label cleanup of the six UI repair runs
and three new parent runs: zero owned containers, networks or volumes remain.
Editor diagnostics and `git diff --check` pass. Production readiness remained
HTTP 200 on port 3002; no production/configuration/provider mutation, dependency
installation, commit, push or branch creation occurred.

**Handoff:** migrations 1-50 and active user/report contracts are frozen for
03. Phase 03 now owns only its dormant inventory foundation, followed by 04
activation. The original **0/5**, **180-second** gate refusal remains a phase
07 cost-repair and qualification obligation, with pre-maintenance containment;
the independent aggregate is not a substitute gate pass.
