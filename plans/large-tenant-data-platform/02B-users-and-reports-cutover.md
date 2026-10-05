# 02B - Users and official reports atomic cutover

## Mission and prerequisites

Activate the completed dormant users/report backend and atomically change every API, UI, export and directly implicated operator/fixture consumer, deleting replaced runtime/storage paths. Read [README](README.md), [02](02-users-and-reports-cutover.md), [02A](02A-official-reports-foundation.md), `completions/01-record-foundation.md`, `completions/02-user-sources-foundation.md`, `completions/02A-official-reports-foundation.md`, parent state and scoped dirty status. **GPT-6 Astra, `xhigh`**; one repository with backend/frontend/scripts/docs.

Entry requires 02A's frozen bounded response/query/export contracts, complete executable combined user/report semantic fixtures and recorded verification attempts/results. Missing contract/fixture implementation is a prerequisite defect to repair; reproducible semantic failures must be fixed before opening affected behavior. Environmental evidence gaps remain truthful residuals under README's containment policy, not a new blanket deployment veto. Never stub joins, invent wire contracts here or expose unsafe publication. Shared types were additive/dormant and existing runtime remained sole authority through 02A.

Hypothesis: the golden-proven SQL backend can become the sole authority without a compatibility window or loss of any licensing/report/history/UI feature. Begin with a route-to-client contract test and a full import/caller inventory. If the foundation lacks a required backend algorithm, repair that prerequisite rather than inventing an adapter.

## Tooling contract

- Company-protected machine: **NEVER contact default/public npm or PyPI registries**, including probes, fallbacks, subprocesses or containers. npm registry access must use `https://packagefeedproxy.microsoft.io/npm/` via approved config or explicit `NPM_CONFIG_REGISTRY`; preserve the approved Dockerfile environment and parent-maintained project config.
- Python installs only with `python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple <package>`; no public extra index, including inherited settings.
- Use existing dependencies. Install only after a manifest change or genuine missing-tool/package failure; no implicit `npx` downloads. Preserve the approved feed through sanitized environments; no public fallback. Follow README's binding tooling contract.

## Read first

- 02's user-source/people entry points and 02A's report/history/combined-projection/export entry points, frozen contracts, combined golden tests and activation/deletion inventory
- `backend/src/db/{dataSync,dataSyncSchema,officialUsage,officialUsageHistorySchema,agentUsage,agentPeople}.ts`
- `backend/src/services/{copilotUsage,copilotUsageGraph,copilotUsageIdentity,copilotServicePlans,savedAgentPeople,officialUsageParser,officialUsageViews,officialUsageHistory,officialUsageOverview,agentUsage,dataSync}.ts`
- `backend/src/routes/{copilotUsage,officialUsage,agentUsage,dataSync}.ts`, shared types and CSV/import HTTP tests
- `frontend/src/{App.tsx,api/client.ts,usageInsights.ts,useOfficialUsageOverview.ts}`
- `frontend/src/components/{CopilotUsersView,CopilotServiceDetails,ReportedUserActivity,ReportedUserAgents,ReportedUserDetail,UserDetailModal,OfficialUsageSnapshot,OfficialUsageImportModal,OfficialUsageImportPanel,OfficialUsageManageReports,OfficialUsageHistoryPanel,OfficialUsageReportSelector,CumulativeAgentActivity,CsvUsageReportsSection,UsageReportContext}.tsx`
- `backend/scripts/{browser-fixture.browser.ts,fixtureSupport.ts,restart-fixture.ts,restart-runtime.mjs,database.ts,backup.ts}`, current browser specs and directly affected operator SQL
- `docs/copilot-license-usage.md`, `docs/official-usage-import.md`, `docs/operations.md`

## Required implementation

1. **Activate one writer/read authority.** Wire 02's staged directory/activity and targeted people implementation plus 02A's streaming import, report/history/combined SQL and export implementation into live orchestration, using independent lease heartbeats. Replace full `publishDirectory`, `publishAppActivity`, `getUserSources`, `getDirectorySource`, `getPublished` and `readSources` assumptions at every caller. Preserve source partial-attempt/freshness semantics, progress, session/cancellation fences, permissions and audit. No shadow work, feature switch, dual reads/writes or fallback.
2. **Close all report/people consumers.** Activate exact-ID person/cache lookup and SQL agent-usage summaries/candidates/attach-remove validation. Inventory callers still awaiting 04 must issue bounded exact-ID/report-summary queries, not retain a full-directory cache or full-report adapter. Official package enrichment uses exact stored source references, not `list(limit:5000)`. Preserve tenant report versus principal evidence scope.
3. **Atomic HTTP and shared wire contracts.** Register every README user/report list/detail/child/facet/history/overview endpoint with selection/cursor envelopes; static paths precede `:objectId`. Activate bounded previews/diagnostics and revision-confirmed accept/select/delete. History, overview and report export selections carry the tenant-history root/revision/invalidation epoch, not only active-set revision. Remove superseded response fields/routes outright; no aliases or old response readers.
4. **All frontend consumers together.** Update shared types, client serializers, hooks, React Query keys, App orchestration and every user/report/import/history/detail component. Preserve licensed cohort dashboard, company/department search, response/agents-used/activity sorts, thresholds, source notices, historical selection, provenance and unknown/stale/count meanings. Load one user/agent plus separately paged plans/relationships/unresolved identities; never embed whole child collections. Server counts remain exact, not page length. Abort stale requests, visibly restart invalidated selections and cap cache at current/previous/next pages; no hidden drain-all effect.
5. **Activate exports.** Register `copilot_users`, `official_agents`, `official_users` and shared export endpoints only with safe producers. Preserve selected filters/history root, CSV field and relationship meaning, classifications and audit receipts. Delete old official CSV routes/functions/client Blob buffering. Poll metadata only; use native streamed download, with cancellation/expiry/invalidation reflected accurately.
6. **Delete predecessor and repair adjacent contracts.** Delete obsolete directory/activity JSON snapshot writers, encoders/decoders, whole-report getters/binds and old parser/memory-storage paths. Drop now-obsolete empty tables/columns through fresh-data guarded forward DDL, not conversion. Update clear/retention/restore/startup/grants and synthetic browser/restart fixtures immediately; 05 is not permission to leave those commands broken. Delete old browser migration/acknowledgement UI only where it solely supports the removed old-format application data. Keep unrelated immutable historical migration/audit infrastructure; document why reset does not require deleting it.
7. **Docs and deletion audit.** Update user/import/operations docs and all changed API examples. Search all four roots for removed methods/types/fields/routes and ensure no runtime caller or consumer survives. Preserve inventory authority until 04; do not refactor unrelated provider permissions or screens.

## Scope guard and atomicity

This is one producer/frontend-consumer cutover. 02 owns user-source/people algorithms and licensing SQL; 02A owns official reports/history, combined projections, targeted agent usage, export producers and combined golden proof. This phase activates their frozen contracts, all UI/export/operator consumers and deletion. No API-only or frontend-only intermediate release. No application-data migration, compatibility window or new external provider mutation.

## Validation

Add `backend/src/routes/dataPages.test.ts` and `frontend/src/components/LargeTenantUsersReports.test.tsx`. Wire `users-reports-cutover` to these exact focused commands in the owned fixture:

```sh
npm run test --workspace backend -- src/routes/dataPages.test.ts src/routes/officialUsageCsv.test.ts src/routes/officialUsageImports.test.ts src/services/largeTenantUserSources.test.ts src/services/largeTenantUsersReports.test.ts src/db/officialUsageHistorySelection.test.ts src/services/copilotUsage.test.ts src/services/savedAgentPeople.test.ts src/services/agentUsage.test.ts
npm run test --workspace frontend -- src/components/LargeTenantUsersReports.test.tsx src/components/CopilotUsersView.test.tsx src/components/CopilotServiceDetails.test.tsx src/components/OfficialUsageViews.test.tsx src/components/OfficialUsageImportModal.test.tsx src/components/OfficialUsageHistoryPanel.test.tsx src/components/ReportedUserAgents.test.tsx src/api/client.test.ts
```

Invoke `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite users-reports-cutover`; rerun `-Suite user-sources-foundation` and `-Suite official-reports-foundation`, and attempt README aggregate software commands. Update obsolete test filenames if the replaced CSV suite is renamed; record exact replacements and keep route-removal/404 coverage.

Prove request/response/filter/facet/cursor contracts and UI fidelity against 02/02A's frozen combined goldens, import disconnect/cancel/revocation, cross-scope rejection, exact count semantics, high-cardinality details and bounded request/cache/polling bytes. Through HTTP test 32 historical sets, acceptance between pages and non-active correction/delete invalidating history/overview/export even with unchanged active revision. Verify old routes/readers are gone and user/report export byte counts/audits remain correct. Maintain existing synthetic-auth Vitest browser and compiled-runtime restart entry points; 05 owns complete orchestration and scale/lifecycle proof.

## Production continuation

No production reset or deployment here. Apply README's Always-Deploy contract: root-fix failures, keep statuses truthful and record residual containment/signal/threshold/07 owner/fix-forward trigger. Continue safe work without weakening publication/auth/deployment safeguards or exposing unsafe writes.

## Completion record and done conditions

Write exactly `completions/02B-users-and-reports-cutover.md`. Record activated entry points, deleted predecessor APIs/storage/functions, exact live endpoint contracts, history invalidation and export behavior, complete backend/frontend/scripts/docs caller audit, operator/fixture repair, focused/aggregate outcomes, cleanup and residuals.

03 receives live record-backed users/reports, complete user/report UI/exports and bounded report/directory queries, with no old-format readers or broken directly affected operator/fixture surface. Neither 02 nor 02A's dormant foundation record can satisfy this precondition without 02B completion.
