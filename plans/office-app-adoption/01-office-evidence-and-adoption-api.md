# 01 - Office evidence and adoption API

## Mission

Implement the complete backend path from existing saved directory/app evidence to retained Office observations and bounded, authorized adoption reads. The observable outcome is an API dataset that the dashboard and grouped Users view can use consistently without an imported agent report.

## Prerequisites and read first

Read and obey [the roadmap README](README.md), including its shared evidence, metric, navigation, visual, and always-deploy local-runtime contracts, plus the current installed implementation worker contract.

Read the directly controlling surfaces:

- [Copilot types](../../backend/src/types/copilotUsage.ts), [user-source types](../../backend/src/types/userSources.ts), [Graph field parsing](../../backend/src/services/userSourceGraphFields.ts), and [streaming provider](../../backend/src/services/userSourceProvider.ts).
- [Source stages](../../backend/src/db/userSourceStages.ts), [source reads](../../backend/src/db/userSources.ts), [source sync](../../backend/src/services/copilotUsage.ts), [generation publication](../../backend/src/db/dataGenerations.ts), and [selection machinery](../../backend/src/services/dataSelections.ts).
- [Sync/recovery service](../../backend/src/services/dataSync.ts), [startup/periodic recovery](../../backend/src/server.ts), [publication revision owner](../../backend/src/db/inventoryAutomaticRevisions.ts), [publication types](../../backend/src/types/dataSelection.ts), and [automatic-refresh consumer](../../frontend/src/useAutomaticRefresh.ts).
- [Existing adoption groups](../../backend/src/services/adoptionGroups.ts), [departments](../../backend/src/services/adoptionDepartments.ts), [history](../../backend/src/services/adoptionHistory.ts), and [read routes](../../backend/src/routes/officialReportData.ts).
- [Current DDL](../../backend/src/db/currentSchema.ts), [schema verification](../../backend/src/db/schema.ts), [bounds/accounting](../../backend/src/db/dataBounds.ts), [retention](../../backend/src/db/dataRetention.ts), [lifecycle slices](../../backend/src/db/lifecycleSlice.ts), [backup table keys](../../backend/scripts/backupInventory.ts), and their directly relevant tests/clear/restore consumers.
- [Disposable fixture owner](../../scripts/large-tenant-tests.ps1), [SQL selector registry](../../backend/scripts/largeTenantFixture.ts), [software checks](../../backend/scripts/softwareChecks.ts), and [Compose fixtures](../../compose.yaml).
- [Data architecture](../../docs/data-architecture.md), [licenses and usage](../../docs/copilot-license-usage.md), [operations](../../docs/operations.md), and [MCP adoption operations](../../mcp/src/agent_control_mcp/tools.py).

There is no prior phase record. Inspect worktree status before editing and preserve unrelated changes.

## Scope and non-goals

Own schema, compact historical evidence, automatic local reconciliation/publication, read contracts, policy/type consumers, lifecycle/backup reachability, focused fixtures/tests, and related backend documentation. Do not implement the dashboard UI, add provider permissions, collect overall prompts, migrate old schemas, expand MCP functionality, or deploy/reset the shared local app in this phase.

## Concrete work

1. Introduce one backend-owned seven-app catalog/classifier and proper Office observation/person/group/summary/history types. Reuse exact matching, paid eligibility, count/date bounds, and source metadata rather than duplicate them. Preserve agent contracts.
2. Add the smallest current-schema representation for observation headers and self-contained person facts. Wire tenant ownership, keys/indexes, immutability/correction constraints, runtime grants, schema verification, selection root types/validators/checks, lifecycle/accounting, backup table keys, and clear/restore consumers together. Reads must depend on retained Office facts, not short-lived source generations. Do not introduce parallel aggregate storage or a migration chain.
3. Implement coherent capture from saved source heads. Freeze paid classification and company/department context alongside app dates and original evidence timestamps. Require a valid non-future report refresh date and the expected period/version. Only unambiguously matched rows from that refresh date qualify; retained unseen rows remain dated evidence/unknown coverage, never new-window participation.
4. Protect the source vector during bounded staging and recheck its heads/epochs at atomic publication. One canonical observation exists per provider date/period/version. Hash ordered semantic facts/coverage without volatile IDs or collection/evaluation times; unchanged six-hour replays are no-ops. Changed same-date content replaces the canonical point completely and invalidates old reads. A concurrent clear must reject pre-clear staging.
5. Wire reconciliation after either source commits and through existing startup/periodic recovery. If directory is not ready when app evidence arrives, the later directory publication must finish the flow. A crash after source commit but before derived publication must recover without a page visit, manual enable action, new provider job, or another Graph scan. Acknowledge successful/no-op source vectors in existing work/status bookkeeping so idle recovery does not repeatedly copy unchanged facts; changed vectors and failed pending work remain automatically eligible.
6. Surface derived preparation/failure status explicitly without rolling back, falsely failing, or preventing healthy directory/app publication. Retry missing local results through existing automatic work. Include Office publication/status changes in the existing `users` revision, even when only recovery changed Office data; preserve the three-key publication and automatic source-ID contracts. Use actionable safe telemetry, not another scheduler or a source-success gate.
7. Implement `/api/office-app-adoption` read routes for history/context, organization summary, departments, groups, facets, and per-group people. Use current Viewer-capable authentication/read wrappers, actor-bound selections, signed cursors, and explicit validation errors. Keep route/query types and all shared consumers aligned.
8. Calculate group identity/search/facets using existing organization normalization. Apply scope/filters before full-matching-set aggregation/ranking, then paginate. Preserve the README's unfiltered organization cards and full-group licensed denominator/app totals during app drill-down, distinguishing filtered people/champion counts. Preserve five-group numbered pages and anchors; page large groups' people with existing limits/payload bounds. Unknown values cannot qualify as measured inactivity.
9. Pin one Office observation throughout a selected read, including coverage, summary, departments, people, champions, and app filters. Reconcile correction, retention, source clear, revoked authorization, and expired selections without mixed pages or cross-tenant leakage.
10. Integrate the twelve-calendar-month UTC retention cutoff and explicit user-data/privacy clear. Invalidate affected child reads before bounded deletion and release accounted bytes. Ordinary source retirement or a later observation must not erase/change a pinned historical observation; clear/correction/retention must invalidate its actual dependents.
11. Inspect MCP and global API policy/type consumers. Existing MCP adoption operations remain agent-specific and unchanged in meaning; document why no new MCP tool is needed. Update a directly implicated shared consumer if required, not an unrelated transport.
12. Update backend-owned sections of [data architecture](../../docs/data-architecture.md) and [licenses and usage](../../docs/copilot-license-usage.md): sources, metric definitions, snapshot semantics, coverage, authority, and retention. Leave final deployment instructions to phase 03.
13. Register one focused `office-app-adoption` SQL selection in the existing fixture owner/selector registry containing the new database/API/publication/lifecycle contract tests. Preserve its isolated-environment and image-identity safeguards; do not create another runner. Phase 03 owns the separate scale/current-installation/restore fixture extensions.

Define exact subroute/payload shapes once in the backend types and document them in the completion record for phase 02. Avoid casts that erase domain distinctions and catch-to-empty fallbacks.

## Focused verification

Use the existing backend Vitest runner, combining new focused files and directly affected existing files in one invocation. The commands below are repository-root commands; if new test filenames differ, use their actual exact paths and record discovery/results.

```bash
npm test --workspace backend -- src/services/officeAppAdoption.unit.test.ts src/db/officeAppAdoption.unit.test.ts src/routes/officeAppAdoption.unit.test.ts src/services/adoptionGroups.unit.test.ts src/services/adoptionHistory.unit.test.ts src/services/adoptionDepartments.unit.test.ts src/db/userSources.unit.test.ts
npm run typecheck --workspace backend
git diff --check
```

Run the implemented SQL selection using the README's verified baseline variables:

```powershell
pwsh ./scripts/large-tenant-tests.ps1 -Suite office-app-adoption -BaselineImage $baselineImage -BaselineImageId $baselineImageId
```

Its new schema, publication, lifecycle, API, and concurrency tests run only in the owner's disposable `test-db`/`test-postgres` fixture environment, never against `seha` or unrelated databases. Prove the selector actually discovers the new tests; passing an unchanged legacy selector is not Office proof.

Required cases:

- Office evidence works with no imported agent set and no inventory; Chat/overall dates never qualify a person.
- Window boundaries, blanks, older/future/malformed app and refresh dates, freshness transitions, header-only reports, partial coverage, retained unseen rows whose old date falls inside the new window, and stale-source recovery.
- Exact/ambiguous/concealed identities, duplicate aliases, paid/warning/partially-enabled/inactive/unknown licenses, and organization normalization/missing fields.
- One person in multiple apps is one active person and several user-app pairs; app totals overlap correctly. No sums across observations.
- Champion ties and zero breadth, all-record ranking before paging, multi-page facets/groups/people, count precision, and explicit payload-limit behavior.
- Both source publication orders, unchanged semantic content with new source IDs/timestamps, duplicate notifications, simultaneous corrections, cancellation, interrupted staging/commit, automatic catch-up, and same-date replacement.
- Recovery-only Office publication changes the existing `users` revision and not provider-source success; derivation failure cannot make healthy source publication fail.
- After a successful/no-op vector, two idle recovery ticks perform no full person recopy or Graph calls. Changed input and a pending derivation failure still recover automatically.
- Historical reads never recompute facts from newer licenses/departments, aging, later observations, or retired source generations. Explicit same-date corrections supersede the whole immutable capture and invalidate old reads instead of mutating its facts.
- Retention cutoff equality/leap/month-end cases, clear during staging, privacy deletion, byte release, selection expiry/renewal/invalidation, tenant isolation, session revocation, and Viewer saved reads without source permission.
- Current-schema fresh initialization, root/tenant/grant constraints, and complete backup table-key coverage. No old-schema migration is expected.

Prove automatic capture using ordinary publication/startup behavior, not only direct calls to the new helper.

## Production continuation

Obey the README's always-deploy local-runtime policy. This phase does not reset/deploy `seha`; phase 03 owns that action. Record every non-passing check honestly with scope, containment, signal, numeric threshold, owner, and exact fix-forward trigger. Healthy source collection and existing agent reads must remain unaffected by unavailable derived Office evidence.

## Completion record and done conditions

Write exactly `completions/01-office-evidence-and-adoption-api.md` using the README/worker completion contract. Include the actual schema fingerprint, semantic replay/correction rules, API/query/null/coverage shapes, automatic trigger/retry and `users` revision owner, selection/retention/clear/backup owners, focused SQL selector and baseline identity, proof of source independence, MCP impact result, commands/results, and any residuals.

Done means the backend path is implemented, owned focused checks have been attempted and repaired as required, the observation/API contract is concrete, and no runtime-owned requirement is left as a recommendation. Phase 02 may rely on exact typed payloads, automatic history publication, selected-read behavior, and documented failure states; it may not assume integration tests passed when unavailable.
