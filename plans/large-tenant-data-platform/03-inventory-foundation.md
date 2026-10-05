# 03 — Inventory ingestion and reconciliation foundation

## Mission and prerequisites

Build dormant bounded Graph/Power Platform ingestion, effective observation projection and canonical reconciliation, without switching the existing inventory runtime yet. Read [README](README.md), completions for **01, 02, 02A and 02B** from its manifest (including `completions/02B-users-and-reports-cutover.md`), parent campaign state and dirty status. GPT-6 Astra, `xhigh`. This phase and 04 are a single release boundary; no production exposure occurs between them.

Hypothesis: source records and identity relationships can be validated and reconciled with SQL working sets and bounded iteration while preserving deterministic canonical merge/split survivors. Start with existing identity fixture parity and a three-page staged-source test.

## Tooling contract

- Company-protected machine: **NEVER contact default/public npm or PyPI registries**, including probes, fallbacks, subprocesses or containers. npm registry access must use `https://packagefeedproxy.microsoft.io/npm/` via approved config or explicit `NPM_CONFIG_REGISTRY`; preserve the already-approved Dockerfile environment and parent-maintained project config.
- Python installs only with `python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple <package>`; no public extra index, including inherited settings.
- Use existing dependencies. Install only after a manifest change or genuine missing-tool/package failure; no implicit `npx` downloads. Verify effective config locally and retain/reinject the approved registry after environment scrubbing. If the feed is unavailable, report it without public fallback. Follow README's binding tooling contract.

## Read first

- `backend/src/services/{graphPackages,packageInventory,packageObservation,packageControlProjection,packageDetailProjection,packageMutationState,packageRefreshPolicy,packageAgentIdentity,packageAgentMetadata,inventoryIdentity,inventoryRoleScope}.ts`
- `backend/src/services/{powerPlatformInventory,powerPlatformResourceQuery,providerJson,unifiedAgents,agentResponsibility}.ts`
- `backend/src/db/{packageInventory,powerPlatformInventory,unifiedAgentRegistry,unifiedAgentRegistrySchema,unifiedInventoryRevision,agentIdentity,agentUsage,agentPeople}.ts`
- `backend/src/types/{copilotPackage,powerPlatformInventory,unifiedAgents,agentPresentation}.ts`
- Existing publication/admission/filters/sorting/unified-source/registry/source-identity tests
- `frontend/src/agentColumns.ts`, `agentInventoryQueries.ts`, `components/UnifiedAgentDetailModal.tsx` for projection consumers

## Required implementation

1. **Dormant inventory schema.** Add README's per-generation package, PP and canonical record/membership tables and typed multivalue facts. Model source selectors, environment/type scopes, token mode, broad/exact reads, catalog observations, detail enrichment, control readback and identity evidence separately. A fresh catalog must not falsely refresh control/detail evidence. Reuse existing mutation/qualification tables; no second authority for provider controls.
2. **Provider pipeline.** Refactor enumeration internals into backpressure-aware page/record producers consumed by dormant staged writers. No accumulating `packages[]`, `resources[]`, source-wide Map, or entire-collection JSON bind. Keep existing provider origin/next-link filters, response byte limits, throttling/pacing/adaptive diagnostics, retry ceilings, cancellation and authorization refresh semantics. Graph package detail enrichment is a separate paced bounded queue, not an awaited detail fan-out over 100,000 catalog items. Wire the new supported source bounds/page counts and PP 30-minute enumeration budget coherently into tests/types/schema, not just one constant.
3. **Source completeness and liveness.** Persist per-page observed/raw/unique/expected counts, continuation hash and safe progress. Validate totals, repeated/cyclic links, duplicate conflicts, scope and omissions. Incomplete scans cannot remove membership. Exact reads affect only exact targets; broad replacement only its authorized selector. Cancelled/expired/fenced-out work cannot publish; newer safe input is not itself a cancellation. Use 01's independent heartbeat through network/accepted 600-second Retry-After/validation waits. Test >5,000 inputs and late stale-owner writes.
4. **Changed-key effective projection in SQL.** Preserve observation precedence, catalog/detail/control freshness, exact missing targets, read-started-at ordering, readback and identity invalidation. Implement README's baseline generation plus delta revision and temporal per-key membership references (`valid_from_revision`, once-closed `valid_to_revision`) to immutable content. A 20-record detail publication appends/closes only changed keys/affected relations, not a new N-row manifest. Fence interval closure and output-head advance atomically; an aborted stage must not close visible intervals. Index membership-as-of plus existing display/publisher/modified/filter/operation-reference keys. Maintain affected metadata/count deltas without rescanning or rewriting all N records per update. Broad complete replacement may stage a new baseline and atomically swap its root; explicit compaction must be bounded, measured and pin-safe. GC follows temporal reachability, not copied manifests.
5. **Progress-safe canonical reconciliation off GET.** Reuse durable jobs with one active reconciliation and one coalesced latest pending request per scope. Pin the active captured input vector; accumulate later changed-key ranges in SQL for the pending latest vector. Normal safe input updates do not cancel active work. The active job may publish its complete captured result against its expected canonical output head with truthful `catching_up`/stale status, then immediately schedule the coalesced latest request. Clear/revocation/expiry/correction/unsafe-control fences still abort affected work. Stage affected identity components, candidate edges and memberships using indexed SQL frontiers; reuse matching rules and deterministic merge/split survivors, preserving ambiguity/conflict. No tenant-sized JS structures or full rebuild merely because another 20-record batch arrived.
6. **Non-quadratic identity and write proof.** Index exact matching keys; do not compare every package with every native resource. Bound pathological components/facts with explicit failure. Incremental reconciliation writes changed keys/affected components and temporal references only; full rebuild is reserved for real broad replacement or explicit compaction. Test collision/dense/split/merge/order cases and inherited unchanged membership through multiple revisions. Pins protect both read selections and active worker input; stale-readable results cannot grant current mutation authority.
7. **Read model without activation.** Implement SQL list/summary/facet, exact ID/source-reference, children, people/usage/responsibility joins and current control validation. Use 02's directory/people SQL and 02A's report/combined queries, activated by 02B. Resolve captured temporal roots without enumerating all record IDs; preserve global/scope/filtered counts and freshness. Goldens cover every `agentPresentation` filter/sort/unknown rule and exact/detail revision churn.
8. **Consistency and tests.** Add grants/final schema verification/fresh-init parity for new tables. Production registration stays absent; tests call dormant new implementations directly. No fallback getters or runtime feature toggles. Update relevant architecture/operations docs with activation owner 04 and source-to-canonical asynchronous freshness behavior.

## Scope guard and atomicity

Do not activate any new inventory producer without its 04 consumer removal/cutover. Existing inventory runtime remains sole authority while this dormant implementation is developed. This is not permission to add a full-array wrapper around the new producer; old callers retain their existing implementation until 04, and both predecessor implementations are deleted at that cutover. Do not alter provider mutations, external configuration or auth scopes.

## Validation

Add `backend/src/db/inventoryGenerations.test.ts`, `backend/src/services/inventoryReconciliation.test.ts`, and `backend/src/services/streamedInventory.test.ts`. Extend suite dispatch `inventory-foundation`:

```sh
npm run test --workspace backend -- src/db/inventoryGenerations.test.ts src/services/inventoryReconciliation.test.ts src/services/streamedInventory.test.ts src/db/packageInventoryPublication.test.ts src/db/packageInventoryAdmission.test.ts src/db/packageInventoryFilters.test.ts src/db/powerPlatformInventory.test.ts src/db/unifiedAgentRegistry.test.ts src/services/packageAgentIdentity.test.ts src/services/packageMutationState.test.ts src/services/packageControlProjection.test.ts src/services/powerPlatformResourceQuery.test.ts src/services/graphPackagePacing.test.ts src/services/graphPackageReadBudget.test.ts
npm run typecheck --workspace backend
```

Invoke `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite inventory-foundation`; attempt README aggregate software commands.

Test 100,001-source-limit explicit failure, 10,000-page loop/ceiling with lightweight fixtures, provider partial page/count mismatch, byte-bound batches with large details, cancelled writer after session clear, retry after process interruption, duplicate-source keys, broad/exact race, control readback vs stale catalog, deterministic merge/split survivors, candidate join cardinality and counts under >5,000 sources. Instrument rows/bytes per DB response and parameter bind; inspect SQL plans under newly populated statistics as well as analyzed tables. Small fixtures prove logic; 06 owns full-envelope resource measurement.

In `inventoryGenerations.test.ts` and `inventoryReconciliation.test.ts`, compare identical 20-key changes over 100- and 1,000-key baselines: unchanged membership/content must not be rewritten, and captured older revisions must remain exact. Assert once-only interval closure, aborted-stage nonvisibility, pin-safe compaction/GC, one active plus one coalesced pending job, progress under continuous safe updates, and eventual newest-vector publication. Distinguish safe pending updates from immediate clear/revoke/unsafe-control cancellation; recheck current mutation authority after stale-readable publication. Record touched rows and SQL plans, not only bounded Node arrays. 06 owns the two full 100k detail-churn sweeps and fixed-budget progress thresholds.

## Production continuation

No production actions. Follow README's Always-Deploy contract, report real statuses and carry residuals with affected scope, closed admission/publication containment, numeric signal/threshold, 07 owner and exact repair trigger. A capacity unknown does not justify guessing identities or weakening control gates.

## Completion record and done conditions

Write exactly `completions/03-inventory-foundation.md` with dormant-registration proof, temporal membership/once-closed validity protocol, changed-key write counts, coalesced scheduler/progress and invalidation evidence, projection/identity rules, SQL ownership, source limits/deadlines, parameter/row bounds, index/plan evidence, exact focused/aggregate results, cross-root impact and residuals.

04 receives tested dormant staged collectors, SQL effective projections, canonical reconciliation and read contracts. It can activate them without an architectural decision or new schema design; any essential unresolved matching rule must be resolved with repository evidence in this phase.
