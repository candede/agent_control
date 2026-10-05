# Legacy-code cleanup plan

Status: implemented on 2026-10-04; final qualification completed on 2026-10-05.
The execution sequence below records the completed cleanup, followed by final
validation and explicit verification limits. Authorized tests used an isolated
PostgreSQL fixture, including initialization, reset and restore. No retained
`seha` environment or application deployment was accessed or reset.

## Goal

Remove obsolete application implementations, unused functions and exports,
disconnected UI, abandoned fixtures, unnecessary dependencies and tests of
retired behavior. Tests should exercise the implementation the application
actually uses, rather than keep a second implementation alive.

This is a deletion and consolidation project, not a new framework, registry,
compatibility layer or wholesale rewrite.

## Scan scope and evidence

The initial discovery inventory recorded **854 existing non-ignored files**:
588 tracked files and 266 untracked files. The untracked files include current
implementation work and must not be mistaken for disposable files.

That discovery snapshot is historical, not the final campaign denominator.
The frozen tracked-file manifest contains **581 entries** and remains fixed.
The final rescan includes **793 current non-ignored files**, including current
untracked implementation work; newly added regressions do not expand the frozen
tracked denominator.

| Area | Files |
| --- | ---: |
| Backend | 480 |
| Frontend | 262 |
| Operational scripts | 19 |
| Infrastructure | 8 |
| Documentation | 13 |
| Existing plans and completion records | 59 |
| Root files and configuration | 13 |

The scan covered:

- 713 TypeScript/JavaScript modules, including source, tests, browser fixtures
  and tooling. Module resolution was checked against both the backend's explicit
  `.js` imports and the frontend's extensionless bundler imports.
- 1,604 exported symbols, application entry-point reachability, local unused
  declarations and class-method references.
- All 15 stylesheets: 2,194 class-selector occurrences.
- All 17 PowerShell files: 145 function definitions and 2,676 command references.
- All three Python files, all 13 JSON/JSONC files, dependency declarations,
  command entry points and Markdown links.
- Focused manual tracing of the deletion candidates and their tests, routes,
  schema responsibilities and operational callers.

Generated audit manifests and detailed candidate reports are retained in the
session artifacts, not added as permanent application tooling. This is a
whole-codebase static scan plus targeted contract review, not a claim that every
line has already completed implementation-level review.

The initial static results included:

- Six application-source modules not reachable from either application entry
  point. One is a useful test helper that should move, not be discarded.
- One completely unreferenced script fixture.
- 17 zero-reference named exports, after excluding six automatically discovered
  framework configuration exports.
- 25 application exports whose only references are in other test files, with
  no internal reference. This includes legitimate test-reset hooks, so it is
  not a blanket deletion list.
- 11 unused declarations in backend tests/scripts.
- 83 stylesheet class/file candidates requiring dynamic-class verification.
- Two broken links in the active frontend README and 20 historical-plan links
  to superseded paths.

The 13 apparent unreferenced class methods reduce to two methods on the obsolete
inventory/report wrapper plus test doubles. Fake overrides are not dead code.
The 25 unresolved module-resolution edges are CSS imports, not broken imports.
No PowerShell function was found to have zero command references.

## Executed plan

### 1. Delete disconnected modules and retarget their useful tests

| Change | Pre-cleanup evidence | Test treatment |
| --- | --- | --- |
| Deleted `CumulativeAgentActivity.tsx` and its exclusive suite/styles | Only tests imported it; no production render path | Moved six live dashboard tests into [AgentInventoryOverview.test.tsx](../frontend/src/components/AgentInventoryOverview.test.tsx), added authoritative-count coverage and removed the obsolete mixed-suite case |
| Deleted `ReportedUserDetail.tsx` | A five-line wrapper imported only by a test | Test the current `UserDetailModal` report variant directly |
| Deleted `inventoryReportUsage.ts` | Only integration tests imported the wrapper | Tests now use the current report/usage services and selection contracts |
| Deleted `officialReportMaintenance.ts` | Tests called a parallel collector rather than the actual operator | Retargeted permission, pinning and bounded-work assertions to `retainUntilConverged` |
| Deleted `agentContext.ts` | Neither exported constant had a consumer | No replacement runtime code |
| Deleted `inventoryReportFixture.ts` | No module, command or document used it | Removed its three unused fixture helpers |
| Moved [officialReportFingerprint.ts](../backend/scripts/officialReportFingerprint.ts) into script support | Used by browser and restart fixtures, not the application | Preserved fingerprint assertions and updated both imports |

Do not replace deleted wrappers with differently named wrappers.

### 2. Remove orphan functions, singleton instances and types

The zero-reference named-export cleanup is:

| File | Remove |
| --- | --- |
| `backend/src/db/packageEnrichmentSchema.ts` (removed) | Removed module, including the unused `verifyPackageEnrichmentSchema` verifier of the retired cache design and its verifier-only imports |
| [agentPeople.ts](../backend/src/services/agentPeople.ts) | Unused `agentPeople` singleton |
| [savedAgentPeople.ts](../backend/src/services/savedAgentPeople.ts) | Unused `savedAgentPeople` singleton |
| [agentUsageIdentity.ts](../backend/src/services/agentUsageIdentity.ts) | Unused `usageChanged` error factory |
| [inventoryRecords.ts](../backend/src/types/inventoryRecords.ts) | Unused `InventoryProviderRecord` alias |
| [officialReportApi.ts](../backend/src/types/officialReportApi.ts) | Unused `OfficialReportAcceptance` and `OfficialReportLists` aliases |
| [unifiedAgents.ts](../backend/src/types/unifiedAgents.ts) | Unused `UnifiedAgentQuickView` alias |
| [client.ts](../frontend/src/api/client.ts) | Unused `getPackageCollection` wrapper |
| [UnifiedAgentTable.tsx](../frontend/src/components/UnifiedAgentTable.tsx) | Unused `AgentAuthoringTools` component |
| [usageInsights.ts](../frontend/src/usageInsights.ts) | Unused `usagePageLabel` and `reportedUserActivityUrl`, plus their orphaned imports |

The remaining zero-reference names are contained in the whole-file deletions
in step 1.

The following test-only leftovers were also retired:

- Old batching/query conveniences: `consumeBatches`, `combinedUserFactsSql`.
- Old route adapters: `parseBulkActionIds`, `inventoryPackageDetail`.
- Old inventory/revision helpers: `combineAgentInventoryRevision`,
  `packageInventoryIdentity`, `matchesAgentFilters`,
  `summarizeAgentAvailability`, and the test-only `agentIdentityResolution`
  singleton.
- Unused client conveniences: `cancelPackageRefreshJob`,
  `getInventorySourceAwareDetail`, `getInventoryQuarantineSelection`,
  `retryDataSyncRun`, `blockAllAgents`, `unblockAllAgents`.
- Superseded presentation helpers: `verificationLabel`,
  `capabilityStatusLabel`, `capabilityNextStep`, the import-presentation
  `errorMessage`, `inventoryCoverageValue`, `restoreTableSortFocus`.
- Removed the test-only `candidateReportEndpoints` production export; the
  current route-policy suite owns the exhaustive expected route list.

For each, delete only tests exclusive to the retired implementation. Transfer
still-relevant assertions to the live batching, SQL selection, route, UI or
component path. In particular, old in-memory filter tests are not evidence that
the current database query implements those filters.

The implementation preserved the explicit SQL filter/count/paging/export
cases, added focused SQL intersections and removed the redundant Cartesian
comparison against the retired in-memory filter. Browser fixtures now use
explicit selected-response counts and the current presentation classifiers,
not a replacement general-purpose filter or rollup implementation. Historical
migration-only fixtures are retired under the current reset-only decision.

Also remove the 11 unused declarations in the capacity scripts, restart fixture,
application tests and selection tests. Internal-only exports can lose `export`
where there is no public or tool contract; their live implementation must not
be deleted merely because it is local.

### 3. Remove orphan API paths, styles and dependencies

After step 1, trace and retire paths whose only clients were removed:

- `GET /api/official-usage/overview/:agentId/creator-types`: its only frontend
  consumer is the disconnected retained-agent component.
- `GET /api/agents/:id/collections/:kind`: its only frontend wrapper is the
  unreferenced package-collection function.

Check script/browser consumers and documented API ownership before deleting
each route. Remove its policy registration, exclusive service/query branches
and obsolete route assertions together. Do not delete shared collection,
selection, authorization or report-query functions used by other routes.
An unused client wrapper does not by itself prove that its backend route is dead.

Prune styles for the removed UI and the verified old layouts, including the
retained-agent locator, old report workbench/explorer, old report-user tables,
old pagination and unused insight controls. Split mixed selector rules instead
of deleting styling shared with current components. The 83 candidates are not
an automatic purge list: generated `status-*`, `state-*` and library-owned
classes require explicit treatment.

Dependency changes:

- Remove the unused production `recharts` dependency: no source or tool imports
  it.
- Remove the unused direct root `playwright-core` declaration after checking
  the browser commands. Browser tooling uses the declared Playwright test
  package; necessary transitive browser dependencies remain managed by it.
- Move backend `@types/multer` to development dependencies.
- Update the lockfile with the existing package manager and approved feed.
  Do not remove type packages merely because their names do not appear in
  imports, or remove `concurrently`, which is used by the root development script.

These changes removed 37 installed packages. npm's
`omit-lockfile-registry-resolved` setting also removed stale registry URL
bindings without changing any remaining locked version or integrity hash.
Subsequent registry resolution uses the approved project/Docker feed.

### 4. Retire explicitly supported old deployment workflows

The SQLite importer was actively wired into Azure deployment. It was retired
across all of these surfaces rather than merely deleting its script:

- The importer, its SQLite backup helper and its dedicated tests.
- The Azure `legacy_import` mode, backup parameters, action step and tests.
- The old Static Web App retirement action and its legacy target configuration.
- Corresponding examples, operational instructions and obsolete assertions.

Unsupported configuration, removed CLI parameters/modes and receipts containing
retired steps now fail explicitly. Old installation parameters are not silently
ignored. No legacy deletion/import action was executed.

Trace obsolete database fields/tables associated with those workflows separately
from code deletion. Removing a script is not authorization to delete stored
audit history.

### 5. Use the current-schema, explicit-reset development contract

**Superseding user decision: do not preserve old schema or data compatibility.**
[schema.ts](../backend/src/db/schema.ts) exports the current DDL,
`schemaFingerprint` (SHA-256 of that DDL) and `verifySchema`. The singleton
`app_schema` marker records only the current fingerprint; there is no migration
array, checksum history, numeric schema baseline or schema-handoff framework.
All 51 historical schema modules were removed.

[database.ts](../backend/scripts/database.ts) preflight accepts only `fresh`
(empty) or `current` (exact fingerprint). `initialize` replaces `migrate`;
nonempty old schemas fail with `database_schema_reset_required`. Explicit local
`start -DbReset` discards the exact owned application database and initializes
the current schema without a pre-reset backup. Ownership, credential validation,
drain, maintenance and failure reporting remain required. Existing saved dumps,
retained project settings, credentials, volumes and unrelated databases remain
untouched.

Azure uses `fresh` or `existing`, with no `upgrade` alias or expected numeric
baseline. Backup/restore supports only the current schema and never upgrades an
old dump. Historical schema-handoff helpers and compatibility-only tests are
retired rather than retained as active dependencies.

Tenant configuration uses only `TENANTS_JSON` or `TENANTS_JSON_FILE`, without a
standalone credential fallback or saved-settings conversion. A valid registry
preserves current credentials and ignores stale standalone runtime inputs;
unsupported standalone-only configuration fails explicitly. Azure requires
four prepared vault secrets and exactly three runtime secret references.

The initial implementation was code-only. Subsequent explicitly authorized
qualification exercised the current schema against an isolated PostgreSQL
17.11 fixture, including initialization, reset, concurrency, permissions and
backup/restore. Historical completion records are not substitutes for this
current-schema evidence. No retained application database was accessed or reset.

### 6. Update documentation and packaging

- Repair the two active [frontend README](../frontend/README.md) links to deleted
  Copilot usage fixtures and document the current fixture entry points.
- Update architecture and operations documentation for the supported schema and
  installation policy, retired API paths and removed legacy-import workflow.
- Remove current build/test dependencies on historical plan text where they
  exist; point current contract assertions at current documentation.
- Treat completion records as historical evidence, not executable requirements.
  Identify superseded links without rewriting history as though old deployments
  used the new code.
- Ensure deleted services and fixtures no longer enter application build output.

The current documentation and fixture command lists were updated. The vault
documentation test now checks the current setup contract directly; local source
snapshots, Docker test inputs and capacity build inputs no longer depend on a
historical plan README. Historical completion records were not rewritten.
The operator image contract now includes `azure-database.ts`, `azure-pitr.ts`
and `release-inspect.mjs`; static regressions verify their source files exist
and are explicitly copied within the operator stage. The Key Vault access
module's minimum and maximum runtime-secret cardinality are both three, with
a matching static assertion. These checks are not image-build or ARM
compilation evidence.

All 51 stale compiled historical-schema modules were removed. The final
production output contains 169 current emitted modules, with zero unresolved
imports or stale outputs.

### 7. Verify the cleanup and rescan

The final rescan covers 652 current TypeScript/JavaScript modules across 793
current non-ignored files. It reports:

- No unreachable application-source modules.
- No unused local declarations or broken imports.
- Six legitimate framework-discovered default exports and eleven test-double
  methods remain classified separately rather than incorrectly deleted.
- All 23 unresolved relative resolution edges are stylesheets, not broken
  source imports.

The frozen tracked denominator remains 581 entries. The 793-file current scan
also covers untracked implementation work and newly added tests. This is
whole-codebase static coverage plus focused contract review, not a claim of
793 separate implementation-level reviews.

The first real aggregate exposed stale fixture, vault/canonical-route and
index-plan expectations, plus a genuine timezone defect. SQL `DATE` decoding
now preserves UTC calendar dates under UTC+4, covered by the new
[pool.test.ts](../backend/src/db/pool.test.ts) regression. The directly coupled
expectations and bounded indexed-plan assertions were repaired, and affected
integration tests have explicit 30-second budgets. Targeted repair runs were
followed by the complete successful aggregate below; intermediate failures are
not presented as final qualification or added to its test count.

| Check | Observed result |
| --- | --- |
| Backend aggregate with isolated PostgreSQL 17.11 | All 4,806 tests passed in 194 files, 856.20 seconds, with explicit `TZ=Asia/Dubai` |
| Current database integration | Explicit initialization, reset, concurrency, permissions and backup/restore checks passed |
| Frontend component/unit aggregate | All 2,386 tests passed in 82 files |
| Backend configured typecheck and production rebuild | Passed |
| Frontend configured typecheck and build | Passed |
| Core operator/fixture strict compilation | Ten core modules and their strict dependency closure passed |
| Frontend lint | Zero errors; two pre-existing hook-dependency warnings |
| Mocked PowerShell aggregate | 1,934 assertions passed: 199 local-runtime, 1,388 local-orchestration, 82 fresh-installation and 265 Azure |
| PowerShell/Python/infra syntax | All 17 PowerShell AST checks, three Python AST parses and three infra JSON parses passed |
| Qualification entry points | All 84 suites and 195 selectors resolve; this does not claim execution of every infrastructure/browser/capacity workflow |
| Compiled production inventory | 169 emitted modules; zero unresolved imports and zero stale outputs |
| Whitespace/diff hygiene | Final `git diff --check` passed |
| Optional widened capacity/script strict typing | Ten pre-existing errors remain unchanged; this supplemental sweep did not pass |

The final backend log is retained as the session artifact
`files/fresh-schema-backend-final.log`; its summary records 194 passed files,
4,806 passed tests and 856.20 seconds. Useful final logs and audit evidence are
retained outside the application source. One-time derivation inputs were
removed. Fixture disposal is completed and verified: the exact task-owned
container stopped with exit code 0, successful Docker listings confirmed both
the container and its anonymous data volume were absent, and the attached
`fresh-schema-postgres` shell exited with code 0. No shared or other Docker
resources were touched. This isolated fixture cleanup is not an application
reset or deployment.

**Verification limits:** no actual `seha` or application deployment/reset,
authenticated synchronization, ARM compilation, image build, browser execution
or full capacity campaign was performed. Existing `seha` remained untouched.
The authorized isolated PostgreSQL qualification is real database evidence,
not Azure, provider, browser, capacity or production-deployment proof.
The ten pre-existing optional strict-typing errors remain a disclosed
limitation; the entire backend test/script tree is not claimed to be
strict-type-clean.

## Completion criteria

All confirmed dead application code and exclusive obsolete tests are gone;
useful assertions target current implementations; the chosen database policy is
explicit; active consumers, packaging contracts and documentation agree; the
configured builds and final backend/frontend/mocked operational aggregates
pass. Optional typing debt and unexecuted deployment/browser/capacity
qualification remain explicit rather than being reported as successful checks.

Do not weaken validation, remove current safety checks, or discard still-used
provider-format handling merely because a name contains "legacy", "snapshot",
"fallback" or "test".
