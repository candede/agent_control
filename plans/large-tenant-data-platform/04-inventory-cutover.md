# 04 — Inventory and agent experience atomic cutover

## Mission and prerequisites

Activate the staged inventory and canonical read model from 03; replace every package/PP/unified API and frontend consumer that depends on the removed whole-set contracts. Read [README](README.md), completions for 01, 02, 02A, **02B** and 03, parent state and dirty status. GPT-6 Astra, `xhigh`. No production action.

Hypothesis: one agent-inventory page, its exact counts, and one detail can be served without loading/reconciling the tenant inventory in Node, and without changing canonical identity or mutation safety. Start with a route query-spy test that rejects source-wide reads and GET-side writes.

## Tooling contract

- Company-protected machine: **NEVER contact default/public npm or PyPI registries**, including probes, fallbacks, subprocesses or containers. npm registry access must use `https://packagefeedproxy.microsoft.io/npm/` via approved config or explicit `NPM_CONFIG_REGISTRY`; preserve the already-approved Dockerfile environment and parent-maintained project config.
- Python installs only with `python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple <package>`; no public extra index, including inherited settings.
- Use existing dependencies. Install only after a manifest change or genuine missing-tool/package failure; no implicit `npx` downloads. Verify effective config locally and retain/reinject the approved registry after environment scrubbing. If the feed is unavailable, report it without public fallback. Follow README's binding tooling contract.

## Read first

- Dormant code and identity/projection decisions recorded in 03
- `backend/src/db/{packageInventory,powerPlatformInventory,unifiedAgentRegistry,unifiedInventoryRevision,agentUsage,agentIdentity,agentPeople,jobs}.ts`
- `backend/src/services/{packageInventory,powerPlatformInventory,unifiedAgents,agentUsage,agentResponsibility,agentInvestigations,agentIdentityResolution,agentPeople,savedAgentPeople,unifiedAgentExport,agentContextExport,bulkJobs,dataSync}.ts`
- `backend/src/routes/{agents,inventory,unifiedAgents,agentUsage,copilotStudioQuarantine,workbench}.ts`, `types/agentPresentation.ts`, all route policy declarations
- `frontend/src/{App,agentInventoryQueries,agentColumns,agentDetails,agentExport,packageSelectionSession,bulkRefSearch,unifiedAgentIdentity,useAgentPeople,workbenchRouting,workbenchActionContext}.tsx` or `.ts` as present
- `frontend/src/api/client.ts`, `components/{UnifiedAgentTable,UnifiedAgentDetailModal,AgentInventoryFilters,AgentInventoryOverview,AgentUsagePanel,AgentInvestigationsPanel,AgentAccessManagement,UserAgentResponsibility,PrincipalPicker,BulkActions,WorkbenchDialog,PowerPlatformSourceJob,SavedInventoryVerification}.tsx`
- `frontend/browser/`, `docs/{operations,security-model,mutation-canaries}.md`

## Required implementation

1. **Activate single writers.** Switch refresh orchestration/scheduler/provider callbacks to staged Graph/PP pipelines and new generation heads. Publish run/source/job outcome and head atomically; failed/partial jobs keep prior success with truthful status. Queue canonical reconciliation only after complete source publication. Cutover drops obsolete empty payload/storage objects under the fresh-DB guard and deletes former runtime publication/getter code. No full-list adapters, dual writes or fallback to old snapshot tables.
2. **Activate changed-key canonical publication.** Move reconciliation out of `UnifiedAgentsService.list`, `UnifiedAgentRegistry.withSnapshot` GET transactions and responsibility/export calls. Activate 03's temporal membership and one-active/one-coalesced-pending scheduler. Safe newer details must not repeatedly cancel active work or clone full manifests; a still-valid captured vector may finish and publish with `catching_up`/stale status before the latest pending request. Expose captured coverage, `reconciling`, `unavailable`, ambiguity/conflict and details-pending accurately throughout APIs/UI. Clear/revoke/unsafe-control changes still fence immediately. Recheck current live mutation authority independently of stale readability.
3. **SQL list/query projection.** Package `list`, PP lists/related resources, unified inventory, responsibility, usage candidates and operation-reference queries use typed SQL predicates/aggregates/keyset pages. Remove whole-set JS filter/sort/summarize and JSON-to-SQL roundtrip. Preserve all catalog/native/all scopes; environment/type scope; source counts/logical counts; verification checks; global/scope/filtered summaries; pending details and usage/people freshness. Exact detail queries accept ID and selection; never implement them with `list(limit:10000)` or scan client pages.
4. **Targeted enrichment.** Read only page/exact target package memberships, environment names, owner/created/modified people, cached identities, usage totals and associations. Bound each relation independently; no list item embeds 10,000 packages, connectors, report users or operations. New exact detail and child-page endpoints preserve every field/column/insight available in the old full detail. Large evidence/connector/membership sets use explicitly counted paged sections; totals are not the visible child-page count.
5. **Control, bulk and investigations safety.** Trace `savedPackageScope`, token mode, package mutation previews/qualifications/readback, bulk job exact selection, quarantine selection, agent identity/people resolve, Purview/Defender investigation context, workbench routing and agent usage attach/remove. Resolve exact IDs against current authorized live membership/control revision. Historical read pins cannot authorize writes. Bulk operations keep existing 5,000-target ceiling and fail clearly above it; server-side filtered selection stages bounded target/prestate batches and computes the existing confirmation digest without a full target/prestate array or giant `job_items` insert. Keep role/capability/CSRF/admission/audit gates and provider canary qualification; do not perform external mutations to prove read scaling.
6. **Atomic API/frontend cutover.** Implement README endpoints/cursors and remove offset/all-list fields from changed contracts. Update shared types, API serializers, query/cache keys, App orchestration and components together. Server owns filtering/sorting/facets/counts; React Table presents the page using manual/server mode. Async facet searches are paged. Selection tracks bounded exact IDs and selection revision; all-matching export passes filters/selection, not downloaded IDs. Cache at most current/previous/next page per active view; clear on tenant/principal/role change and invalidation. No hidden `Promise.all` over all pages or detail targets.
7. **UI completeness.** Preserve column picker, per-column sorting, source and verification panels, details/modals and close/return-focus behavior, refresh progress/resume/cancel, bulk actions and operation reference search, ownership views, usage association UX, control restrictions, investigation/navigation context, loading/error/empty/stale states. Responsibility view and user-owned-agent detail must be paged SQL consumers too. Replace `JobRepository.get`'s 5,000-item read/filter and `list`'s per-job fan-out with SQL scalar counts and metadata. Add the README's paged job-item/refresh-target APIs and atomically change `BulkActions`, App polling and job presentation to server totals plus one result page; do not send results twice inside `job.result`. Preserve exact inconclusive/reconciliation-required/resumable/cancelled counts and action eligibility. Job progress increments the result revision; incompatible result cursors restart visibly. Abort abandoned requests and poll status-only bounded payloads; role loss clears protected cached data.
8. **Exports.** Register `graph_packages`, `power_platform_agents`, `unified_agents` bounded export producers. Delete old GET/POST `/agents/export.csv`, `/inventory/export.csv`, `/agent-inventory/export.csv` routes/helpers and update every client/test/download surface atomically. Preserve exact source-qualified/canonical selection and operation-reference authorization, all CSV columns, formula neutralization and audit receipts. Child facts are streamed according to the established CSV meaning, not omitted.
9. **Deletion audit.** Remove `readUnifiedSource` full materializers, GET reconciliation, tenant-sized `packageById`/people/environment maps, JS filtered set counts, `forExport` array return and giant collection binds. Search all implicated roots for removed methods/types/fields/routes and update fixtures, docs and tests, including clear/retention/restore/startup/grant SQL referencing removed tables. Those operator paths must remain functional now; 05 owns their deeper lifecycle/resource proofs. Retain only small pure presentation helpers and tiny test oracles that do not read old storage.

## Scope guard and atomicity

This is the inventory producer/consumer cutover, not a backend-only paging patch. Repair prerequisite defects from 03 rather than creating temporary compatibility paths. Do not redesign provider permissions, canonical business matching, report metrics or unrelated screens. If any changed contract still has an old consumer, finish it here before moving to 05.

## Validation

Add `backend/src/routes/largeTenantInventory.test.ts`, `frontend/src/components/LargeTenantInventory.test.tsx`; wire `inventory` suite:

```sh
npm run test --workspace backend -- src/routes/largeTenantInventory.test.ts src/db/packageInventory.test.ts src/db/packageInventoryUnifiedSource.test.ts src/db/powerPlatformInventorySorting.test.ts src/db/unifiedAgentsIntegration.test.ts src/services/unifiedAgents.test.ts src/services/unifiedAgentsSnapshot.test.ts src/services/agentUsage.test.ts src/services/agentInvestigations.test.ts src/services/agentPeople.test.ts src/routes/unifiedAgents.test.ts src/routes/agents.test.ts src/routes/agentUsage.test.ts src/routes/packageCanaryAuthorization.test.ts src/services/unifiedAgentExport.test.ts
npm run test --workspace frontend -- src/components/LargeTenantInventory.test.tsx src/components/UnifiedAgentTable.test.tsx src/components/UnifiedAgentDetailModal.test.tsx src/components/AgentInventoryFilters.test.tsx src/components/UserAgentResponsibility.test.tsx src/components/AgentUsagePanel.test.tsx src/components/AgentInvestigationsPanel.test.tsx src/agentInventoryQueries.test.ts src/agentExport.test.ts src/api/inventoryExport.test.ts src/packageSelectionSession.test.ts
```

Invoke `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite inventory`; attempt README aggregate software commands.

Prove no inventory GET writes; maximum returned rows/bytes and constant targeted enrichment; all filters/sorts/count scopes vs fixture truth; first/middle/last/previous pages with ties/null/Unicode; live refresh with pinned pagination; incomplete reconciliation; canonical merge/split/order stability; cross-principal/report joins; broad/exact/application/delegated coverage; stale control mutation rejection; high-cardinality details; 5,000-outcome bulk job status/history staying metadata-only; export selected/all and concurrent invalidation. Exercise >5,000 sources and a high-fanout single entity, not only 50-row happy paths.

## Production continuation

Use README's Always-Deploy contract: repair/rerun, never fabricate passing evidence, document each residual's bounded containment/signal/threshold/07 owner/trigger. Keep unsafe mutation stages closed. No production actions or deployment-safety bypass.

## Completion record and done conditions

Write exactly `completions/04-inventory-cutover.md` with source/canonical activation sequence, deleted APIs/readers, precise filter/count/identity semantics, route-to-consumer coverage, SQL/query bounds and tests, shared-root changes and residuals.

05 can rely on all user/report/inventory production paths being row-backed and browser-page-bounded, with working export jobs and no old-format runtime authority. Lifecycle closure is not permission to leave a known full-list consumer for later.
