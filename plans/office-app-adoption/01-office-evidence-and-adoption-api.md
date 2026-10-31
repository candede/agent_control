# 01 - Office evidence and adoption API

## Mission

Implement the complete backend path from existing saved directory/app evidence to retained Office observations and bounded, authorized adoption reads. The observable outcome is an API dataset that the dashboard and grouped Users view can use consistently without an imported agent report.

## Prerequisites and read first

Read and obey [the roadmap README](README.md), including its shared evidence, metric, navigation, visual, and always-deploy local-runtime contracts, plus the current installed implementation worker contract.

Read the directly controlling surfaces:

- [Copilot types](../../backend/src/types/copilotUsage.ts), [user-source types](../../backend/src/types/userSources.ts), [Graph field parsing](../../backend/src/services/userSourceGraphFields.ts), and [streaming provider](../../backend/src/services/userSourceProvider.ts).
- [Source stages](../../backend/src/db/userSourceStages.ts), [source reads](../../backend/src/db/userSources.ts), [source sync](../../backend/src/services/copilotUsage.ts), [generation publication](../../backend/src/db/dataGenerations.ts), and [selection machinery](../../backend/src/services/dataSelections.ts).
- [Existing adoption groups](../../backend/src/services/adoptionGroups.ts), [departments](../../backend/src/services/adoptionDepartments.ts), [history](../../backend/src/services/adoptionHistory.ts), and [read routes](../../backend/src/routes/officialReportData.ts).
- [Current DDL](../../backend/src/db/currentSchema.ts), [schema verification](../../backend/src/db/schema.ts), [retention](../../backend/src/db/dataRetention.ts), [lifecycle slices](../../backend/src/db/lifecycleSlice.ts), and their directly relevant tests/clear/publication consumers.
- [Data architecture](../../docs/data-architecture.md), [licenses and usage](../../docs/copilot-license-usage.md), [operations](../../docs/operations.md), and [MCP adoption operations](../../mcp/src/agent_control_mcp/tools.py).

There is no prior phase record. Inspect worktree status before editing and preserve unrelated changes.

## Scope and non-goals

Own schema, compact historical evidence, automatic local reconciliation, read contracts, policy/type consumers, lifecycle, focused tests, and related backend documentation. Do not implement the dashboard UI, add provider permissions, collect overall prompts, migrate old schemas, expand MCP functionality, or deploy/reset the shared local app in this phase.

## Concrete work

1. Introduce one backend-owned seven-app catalog/classifier and proper Office observation/person/group/summary/history types. Reuse exact matching, paid eligibility, count/date bounds, and source metadata rather than duplicate them. Preserve agent contracts.
2. Add the smallest current-schema representation for observation headers and self-contained person facts. Include keys/indexes, constraints, immutability/correction behavior, runtime grants, schema verification, selection/lifecycle reachability, and byte/capacity accounting. Do not introduce parallel aggregate storage or a migration chain.
3. Implement coherent capture from saved source heads. Freeze paid classification and company/department context alongside app dates and original evidence timestamps. Retained unseen rows must keep their own dates/unknown coverage; they cannot be promoted into current telemetry.
4. Stage and publish bounded data atomically with existing authority/cancellation/transaction patterns. One canonical observation exists per provider date/period/version. Identical retries are no-ops; changed same-date content replaces the canonical point completely and invalidates its old reads.
5. Wire automatic reconciliation after either source publication and ordinary startup/recovery. If directory is not ready when app evidence arrives, the later directory publication must finish the flow. A crash after source commit but before derived publication must recover without a manual page visit, additional enable action, or another Graph scan.
6. Surface derived preparation/failure status explicitly. Do not roll back, falsely fail, or prevent an otherwise successful directory/app source publication because Office derivation failed. Schedule/reconcile the missing local result through existing automatic work, with bounded retries and actionable safe telemetry.
7. Implement `/api/office-app-adoption` read routes for history/context, organization summary, departments, groups, facets, and per-group people. Use current Viewer-capable authentication/read wrappers, actor-bound selections, signed cursors, and explicit validation errors. Keep route/query types and all shared consumers aligned.
8. Calculate group identity/search/facets using existing organization normalization. Calculate exact metrics/rankings across all selected facts before filters/paging. Preserve five-group numbered pages and anchors; page large groups' people with existing limits/payload bounds. Unknown values cannot qualify as measured inactivity.
9. Pin one Office observation throughout a selected read, including coverage, summary, departments, people, champions, and app filters. Reconcile correction, retention, source clear, revoked authorization, and expired selections without mixed pages or cross-tenant leakage.
10. Make snapshots independent of short-lived original generations, while integrating twelve-calendar-month retention and explicit user-data/privacy clear. Invalidate child reads before bounded deletion and restore capacity accounting.
11. Inspect MCP and global API policy/type consumers. Existing MCP adoption operations remain agent-specific and unchanged in meaning; document why no new MCP tool is needed. Update a directly implicated shared consumer if required, not an unrelated transport.
12. Update backend-owned sections of [data architecture](../../docs/data-architecture.md) and [licenses and usage](../../docs/copilot-license-usage.md): sources, metric definitions, snapshot semantics, coverage, authority, and retention. Leave final deployment instructions to phase 03.

Define exact subroute/payload shapes once in the backend types and document them in the completion record for phase 02. Avoid casts that erase domain distinctions and catch-to-empty fallbacks.

## Focused verification

Use the existing backend Vitest runner, combining the new focused selectors and directly affected existing selectors in one invocation. The commands below are repository-root commands; replace new selector names with the actual files created and record the exact command.

```bash
npm test --workspace backend -- src/services/*office*adoption*.unit.test.ts src/db/*office*adoption*.unit.test.ts src/routes/*office*adoption*.unit.test.ts src/services/adoptionGroups.unit.test.ts src/services/adoptionHistory.unit.test.ts src/services/adoptionDepartments.unit.test.ts src/db/userSources.unit.test.ts
npm run typecheck --workspace backend
git diff --check
```

Do not claim new globs matched tests without checking discovery. Run the new schema, publication, lifecycle, API, and concurrency integration tests in the repository's disposable `test-db`/`test-postgres` fixture environment, never against `seha` or unrelated databases. Read [isolated software checks](../../backend/scripts/softwareChecks.ts) and [Compose fixtures](../../compose.yaml) before selecting targeted database commands.

Required cases:

- Office evidence works with no imported agent set and no inventory; Chat/overall dates never qualify a person.
- Window boundaries, blanks, older/future/malformed dates, freshness transitions, empty reports lacking a refresh date, partial coverage, retained unseen rows, and stale-source recovery.
- Exact/ambiguous/concealed identities, duplicate aliases, paid/warning/partially-enabled/inactive/unknown licenses, and organization normalization/missing fields.
- One person in multiple apps is one active person and several user-app pairs; app totals overlap correctly. No sums across observations.
- Champion ties and zero breadth, all-record ranking before paging, multi-page facets/groups/people, count precision, and explicit payload-limit behavior.
- Both source publication orders, duplicate notifications, simultaneous source corrections, cancellation, interrupted staging/commit, automatic catch-up, and same-date replacement.
- Historical facts do not change with later license/department updates or source-generation cleanup.
- Retention/clear/privacy deletion, capacity release, selection expiry/renewal/invalidation, tenant isolation, session revocation, and Viewer saved reads without source permission.
- Current-schema fresh initialization and runtime grants. No old-schema migration is expected.

Prove automatic capture using ordinary publication/startup behavior, not only direct calls to the new helper.

## Production continuation

Obey the README's always-deploy local-runtime policy. This phase does not reset/deploy `seha`; phase 03 owns that action. Record every non-passing check honestly with scope, containment, signal, numeric threshold, owner, and exact fix-forward trigger. Healthy source collection and existing agent reads must remain unaffected by unavailable derived Office evidence.

## Completion record and done conditions

Write exactly `completions/01-office-evidence-and-adoption-api.md` using the README/worker completion contract. Include the actual schema fingerprint, observation identity/correction rules, API/query/null/coverage shapes, automatic trigger/retry owner, retention/clear owners, proof of source independence, MCP impact result, commands/results, and any residuals.

Done means the backend path is implemented, owned focused checks have been attempted and repaired as required, the observation/API contract is concrete, and no runtime-owned requirement is left as a recommendation. Phase 02 may rely on exact typed payloads, automatic history publication, selected-read behavior, and documented failure states; it may not assume integration tests passed when unavailable.
