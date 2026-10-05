# 02 — Dormant user-source ingestion, licensing SQL and people foundation

## Mission and prerequisites

Implement the **dormant user-source backend**: bounded Graph directory/activity ingestion, directory/service-plan licensing SQL and targeted people lookup. Read [README](README.md), `completions/01-record-foundation.md`, [02A](02A-official-reports-foundation.md), [02B](02B-users-and-reports-cutover.md), parent state and scoped dirty status. GPT-6 Astra, `xhigh`. The historical prompt filename is retained intentionally; its completion record is `completions/02-user-sources-foundation.md`.

No activation, default runtime imports/registrations, competing writer, live wire change, frontend change or predecessor deletion belongs here. Shared types are additive and dormant. Existing runtime remains sole authority through 02A. 02A owns official-report imports/history, combined user/report projections, targeted agent usage and export producers; 02B owns the single activation/API/UI/export/deletion boundary.

Hypothesis: directory/activity/service-plan semantics and exact people lookup can be produced from scoped typed SQL with one-page/batch working memory. First prove licensing-state goldens and a query-spy assertion that an ID lookup reads no unrelated directory people.

## Tooling contract

- Company-protected machine: **NEVER contact default/public npm or PyPI registries**, including probes, fallbacks, subprocesses or containers. npm registry access must use `https://packagefeedproxy.microsoft.io/npm/` via approved config or explicit `NPM_CONFIG_REGISTRY`; preserve the already-approved Dockerfile environment and parent-maintained project config.
- Python installs only with `python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple <package>`; no public extra index, including inherited settings.
- Use existing dependencies. Install only after a manifest change or genuine missing-tool/package failure; no implicit `npx` downloads. Verify effective config locally and retain/reinject the approved registry after environment scrubbing. If the feed is unavailable, report it without public fallback. Follow README's binding tooling contract.

## Read first

- `backend/src/db/{dataSync,dataSyncSchema,agentPeople}.ts`
- `backend/src/services/{copilotUsage,copilotUsageGraph,copilotUsageIdentity,copilotServicePlans,savedAgentPeople,dataSync}.ts`
- `backend/src/routes/{copilotUsage,dataSync}.ts`, shared `copilotUsage`/`dataSync` types and source/identity/service-plan tests
- `frontend/src/{api/client.ts,App.tsx,usageInsights.ts}`, `components/{CopilotUsersView,CopilotServiceDetails,UserDetailModal}.tsx` for eventual consumer contracts, not edits
- Report-dependent call sites in `copilotUsage` and `agentUsage` only to specify the bounded composition boundary consumed by 02A
- `docs/copilot-license-usage.md`, source status/refresh and directly related schema documentation

## Required implementation

1. **Dormant provider pipeline.** Implement bounded Graph directory discovery, subscribed-SKU matching, exact-identity verification and D30 app-activity CSV producers, not registered by live orchestration. Preserve 20-SKU/identity query batches, URL/origin/filter validation, timeouts, Retry-After, permissions, progress and count reconciliation. Store visited-token hashes and dedup/exact-identity work in SQL. Identical cross-query duplicates count once; conflicts/inconsistent totals fail. Provide bounded staged identity inputs/20-ID verification operations for 02A's report composition; test these with synthetic inputs now, not an old full-report getter. Use 01's independent heartbeat during waits/validation.
2. **Dormant directory/activity domain.** Implement metadata/stage/validate/publish/targeted-ID/page operations and SQL refresh counts, with original independently successful source/partial-attempt semantics and durable fences. New schema/grants must leave the existing runtime functional; do not drop old objects or change live `publishDirectory`, `publishAppActivity`, `getUserSources` or `getDirectorySource` contracts yet. Tests directly instantiate the new implementation with synthetic rows; never populate it from old application data.
3. **Directory licensing SQL.** Implement scoped directory/activity/service-plan queries, typed filters/sorts, counts/summaries/facets, service-plan child pages and source freshness/partial/unknown semantics. Preserve paid/free/unlicensed/unavailable distinctions, plan provisioning states, normalization and exact count bases. Return bounded SQL records and scalar metadata; do not fill not-yet-implemented official report values with invented zero/null defaults. 02A composes actual report facts into final joined cohorts and endpoint handlers.
4. **Targeted people.** Implement normalized object-ID reads (max 100), metadata and scoped person-cache joins preserving newest observed/checked/last-conclusive precedence, lookup-failed overlay, tenant checks and TTLs. Bounded caller-page projection must not materialize unrelated directory users. Record every caller for 02B activation, including inventory callers that must batch exact-ID reads until 04.
5. **Domain contracts and golden proof.** Freeze typed user-source query/staging/identity input contracts needed by 02A, with exact limits, sort/null/cursor/count/error behavior and SQL/index evidence. Add candidate shared types only without modifying existing live exported shapes or frontend imports. Test direct dormant factories; no route/default writer registration. Prove partial independent source publication, licensing truth and identity/cache precedence before report composition.
6. **Handoff and documentation.** Record exact entry points, caller/deletion inventory and schema/grant/fresh-init proof for 02A composition and 02B activation. Update directly related architecture/license docs with the dormant boundary. Existing runtime/frontend/fixtures still work unchanged. Do not implement official multipart import, report sets/history, report-dependent agent usage or export producers here.

## Scope guard and atomicity

This phase owns user-source ingestion, directory licensing SQL and targeted people only. 02A owns official-report/combined-query/export algorithms and combined goldens; 02B owns every users/report producer/frontend consumer activation and predecessor deletion. Inventory activation remains 04. The old runtime remains the only live authority through both foundations; no old-format adapter, temporary wire shape or dual write.

## Validation

Add `backend/src/services/largeTenantUserSources.test.ts`, testing dormant implementations directly. The `user-sources-foundation` fixture suite runs:

```sh
npm run test --workspace backend -- src/services/largeTenantUserSources.test.ts src/db/dataSync.test.ts src/services/copilotUsageGraph.test.ts src/services/copilotUsage.test.ts src/services/copilotServicePlans.test.ts src/services/savedAgentPeople.test.ts
npm run typecheck --workspace backend
```

Invoke `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite user-sources-foundation`; also attempt README aggregate software commands, including unchanged live runtime/frontend behavior.

Prove directory/service-plan licensing and activity-state goldens, Unicode/tied/null keys, exact counts without duplicate/omitted pages during replacement, principal/tenant isolation, D30 CSV/UTF-8 boundaries and exact caps, provider partial/failed attempts, cancel/revoke races, one user at the service-plan child ceiling, targeted people returning no unrelated rows, cache precedence and paged facets. Test long idle/Retry-After renewal and validation cancellation. Measure query rows/parameter bytes at 1,000 and 10,000 users; 02A owns combined report goldens and 06 owns full capacity proof.

## Production continuation

No production reset/deployment here. Apply README's Always-Deploy contract: root-fix and rerun failures, classify residuals truthfully with containment/signal/threshold/07 owner/trigger, continue safe work. Do not weaken the deployment gate or leave unsafe report publication enabled to force progress.

## Completion record and done conditions

Write exactly `completions/02-user-sources-foundation.md`. Include dormant user-source/people entry points and typed composition contracts for 02A, licensing/source goldens and index/EXPLAIN evidence, cross-root caller/deletion inventory for 02B, unchanged live-runtime/shared-type proof, focused/aggregate outcomes, cleanup and residuals.

02A receives implemented/tested user-source and people primitives for official-report composition. No live contract changed, no predecessor was deleted and no frontend was cut over. 03 requires both 02A's combined foundation and 02B's atomic activation completion.
