# 02A - Dormant official reports and combined projections foundation

## Mission and prerequisites

Build the dormant official-report ingestion/query/history backend, compose it with 02's user-source SQL, and finish targeted agent-usage queries and user/report export producers. Read [README](README.md), [02](02-users-and-reports-cutover.md), [02B](02B-users-and-reports-cutover.md), `completions/01-record-foundation.md`, `completions/02-user-sources-foundation.md`, parent state and dirty status. **GPT-6 Astra, `xhigh`**.

Existing runtime remains the sole authority. Shared types are additive and dormant; no live handler/writer registration, frontend contract change, predecessor deletion or new source of report truth. Before handing off to 02B, freeze the complete bounded response/query/export contracts and prove combined user/report semantics with deterministic fixtures.

Hypothesis: streamed imports and typed report facts can preserve report-set history and exact licensing/usage joins without reconstructing reports or enumerating whole directories. First prove a combined cohort query and a history selection over more than 16 sets.

## Tooling contract

- Company-protected machine: **NEVER contact default/public npm or PyPI registries**, including probes, fallbacks, subprocesses or containers. npm access must use `https://packagefeedproxy.microsoft.io/npm/` through approved config or `NPM_CONFIG_REGISTRY`; preserve Dockerfile and project feed configuration.
- Python installs only with `python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple <package>`; no public extra index or inherited fallback.
- Use existing dependencies; install only after a manifest change or genuine missing-tool/package failure. No implicit `npx` download. Preserve approved feed settings after environment scrubbing and report unavailable feeds without fallback.

## Read first

- 02's dormant directory/activity/licensing/people SQL and exact-identity staging inputs, contracts and golden fixtures
- `backend/src/db/{officialUsage,officialUsageHistorySchema,agentUsage,agentPeople}.ts`
- `backend/src/services/{officialUsageParser,officialUsageViews,officialUsageHistory,officialUsageOverview,copilotUsage,copilotUsageIdentity,agentUsage,csvExport}.ts`
- `backend/src/routes/{officialUsage,copilotUsage,agentUsage}.ts`, CSV/import tests and shared types
- `frontend/src/{api/client.ts,usageInsights.ts,useOfficialUsageOverview.ts}` and user/report/history/detail/import components, to enumerate every eventual consumer without changing it
- `backend/scripts/{browser-fixture.browser.ts,restart-fixture.ts,restart-runtime.mjs,backup.ts}`, `docs/{official-usage-import,copilot-license-usage}.md`

## Required implementation

1. **Dormant streaming import.** Implement multipart/file-to-staging backpressure and incremental file/content hashes with installed `csv-parse` streaming support. Preserve one-file/field restrictions, required CSRF/admin middleware, disconnect cleanup and UTF-8/header/control-character/schema/date/number validation. Enforce field/file/row/actor/tenant/bundle limits while consuming; scalar previews include at most 20 examples/warnings and diagnostics are paged. Build handler/storage factories without replacing live multer/parser registration. Use independent lease renewal through network/validation waits.
2. **Typed report facts and publication.** Add typed indexed report fact columns/relations and bounded insert/validation/acceptance operations while leaving existing runtime functional. Existing artifacts, immutable versions, complete three-kind sets and facts remain sole authority. Preserve deduplication, corrections, supersession, selected historical sets, confirmation revisions, retention/audit and documented individual-stage rules without partial active sets. No giant JSON bind, full-report getter, payload reconstruction on GET or old-data conversion.
3. **Bounded history authority.** Implement `official_usage_history_state` and `official_usage_history_memberships` from README as revision/epoch plus temporal readable-set references, not copied reports. Acceptance advances history revision atomically. Correction/delete/retraction/expiry/visibility/provenance changes to any retained set, including non-active sets, also advance invalidation epoch. One captured history root addresses all readable sets relationally; ordinary acceptance preserves pinned membership, invalidating changes deny dependent history/overview/export even if active-set revision stays unchanged. Preserve retained/superseded visibility and pin-safe bounded cleanup.
4. **Combined user/report SQL.** Compose 02's user-source/licensing queries with exact typed report facts and source metadata. Implement every user/report filter/sort/threshold/window, cohort, count/summary/facet, child page, unresolved identity, provenance and freshness/unknown rule. Preserve verified active-without-paid anti/semi joins, null versus zero and missing versus unknown semantics, tenant report visibility and principal-scoped directory/package evidence. Feed bounded report-identity SQL batches into 02's exact-identity staging/verification operations; do not require an old full-report adapter. No users x agents matrix or whole filtered array.
5. **Targeted agent-usage queries.** Implement summary/candidate pages, attach/remove validation and revision metadata for all report-dependent agent consumers. Official package enrichment uses exact stored package/source references, never `list(limit:5000)` or full-source materialization. Record callers awaiting 02B activation; inventory authority itself remains unchanged until 04.
6. **Dormant handlers and export producers.** Complete candidate handler functions and additive candidate response/query types for every README user/report endpoint. Implement `copilot_users`, `official_agents`, `official_users` iterators against 01's export engine, preserving pinned filters/history, CSV columns/relationship meaning, formula defenses and audit classifications. Test through dormant factories; no public route/producer registration or old CSV deletion.
7. **Freeze the 02B handoff.** Specify exact allowed filters/sorts, cursor/selection/dependency fields, null/error/count semantics, response/child/facet byte/row limits and export schemas in tested candidate types/contracts. Combined golden fixtures must cover user/report joins, historical selections, partial/freshness states, targeted agent usage and exported values; prove no full-domain reads. Record exact entry points, SQL/index evidence and all backend/frontend/scripts/docs activation/deletion consumers. Shared types remain additive/dormant through this phase; existing exported live types and runtime calls stay unchanged.

## Scope guard and atomicity

User-source ingestion, directory licensing SQL and targeted people were implemented in 02; repair prerequisite defects there, without broadening this phase into their reimplementation. This phase owns official reports/history, combined projections, targeted agent usage and export producers. 02B alone activates every users/report API/UI/export contract and deletes old runtime/storage. No compatibility adapters, dual writes, shadow publication or source-data migration.

## Validation

Add `backend/src/services/largeTenantUsersReports.test.ts` and `backend/src/db/officialUsageHistorySelection.test.ts` for dormant combined implementations. Wire `official-reports-foundation` to:

```sh
npm run test --workspace backend -- src/services/largeTenantUsersReports.test.ts src/db/officialUsageHistorySelection.test.ts src/db/officialUsage.test.ts src/db/officialUsageImports.test.ts src/db/officialUsageHistory.test.ts src/services/officialUsageParser.test.ts src/services/officialUsageViews.test.ts src/services/copilotUsage.test.ts src/services/agentUsage.test.ts
npm run typecheck --workspace backend
```

Invoke `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite official-reports-foundation`; rerun `-Suite user-sources-foundation` and attempt README aggregate software commands, including unchanged live frontend/runtime behavior.

Prove combined goldens for every licensing/activity/report state, tied/null/Unicode sorting, exact counts across pinned pages, tenant/principal isolation, malformed CSV/UTF-8 boundaries and exact limits, disconnected upload/cancel/revoke, incomplete bundles, one user with 10,000 observed facts, targeted enrichment, facets and export bytes/counts/audits. Use **32 retained sets**, acceptance between history/overview/export pages, and non-active correction/delete with unchanged active revision: acceptance preserves selected membership; correction/delete yields `selection_invalidated` and prevents old export publication. Measure query rows/parameter/response bytes at 1,000 and 10,000 users, not as a substitute for 06.

## Production continuation

No production actions. Apply README's Always-Deploy contract with truthful results, root repairs and residual scope/containment/signal/threshold/07 owner/fix-forward trigger. Missing frozen contracts or combined fixture implementation must be repaired before 02B; environmental evidence gaps retain truthful status/containment rather than creating a new blanket deployment veto. Reproducible semantic failures do not authorize unsafe exposure or weaker deployment gates.

## Completion record and done conditions

Write exactly `completions/02A-official-reports-foundation.md`. Include report/history schema and fences, combined SQL/index/EXPLAIN evidence, frozen bounded response/query/export contracts, combined fixture truth/results, exact dormant entry points and cross-root activation/deletion inventory, unchanged live-runtime proof, focused/aggregate outcomes, cleanup and residuals.

02B receives complete dormant user/report backend, frozen bounded contracts, executable combined semantic fixtures and actual verification results, not unresolved join semantics or missing handlers. No consumer has changed wire contract, no new writer has been activated and no predecessor has been removed.
