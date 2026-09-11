# Phase 10 Completion — Unified Admin Workbench

## Status

```yaml
phase_file: 10-unified-admin-workbench.md
phase_status: complete
outcome: completed_with_disabled_capabilities
validated_at_utc: 2026-09-10T10:53:25Z
execution_target: retained local agent-control-phase01 Compose project at http://localhost:3001
```

Plan: [10-unified-admin-workbench.md](../10-unified-admin-workbench.md). The canonical callback remains `http://localhost:3001/api/auth/callback`. No commit, push, branch, live provider call, permission grant, Azure action, credential rotation, volume reset or retained-data recreation occurred.

## Delivered contracts

### Workbench, roles and routing

- The combined Express/React application owns routable Agents, Power Platform, Users, Official usage, Audit, Security, Permissions and Jobs views. Agents remains the first view for a principal with Reader or Operator.
- The four application roles remain additive and non-hierarchical. Broad Graph package and Power Platform inventory are Reader-only. An Operator-only Agents view performs one explicit exact-native-ID lookup or exact refresh and never calls the broad `/api/agents` route; its Power Platform view uses the separately scoped quarantine target projection. Administrator and SecurityReader do not inherit these reads.
- Agents URLs now preserve search, status, publisher, availability, host, platform, age, sort, page, exact selected IDs, detail ID and detail tab. Power Platform URLs preserve search, type, environment, sort, page, exact snapshot, up to 25 quarantine selections, exact detail identity and detail tab. `popstate`, direct loads and role/account changes use these same parsers.
- Requests use caller-owned abort signals/generations. Late inventory, detail and job responses cannot repopulate a changed principal or role view. Package selection persists across pages up to the backend’s 5,000-target package limit; the independent quarantine limit remains 25 and exact selected targets are resolved before confirmation.
- Inline selection URLs have a 4,096-byte budget. Larger package selections retain all IDs in principal-scoped session storage with explicit session-only sharing guidance; missing, corrupt or mismatched storage never applies a partial selection. This is navigation state, not browser report authority. Audit, Security and Official usage filters and selected jobs also survive browser history.
- API 401 and `403 missing_internal_role` invalidate private state and revalidate `/api/me`. Ordinary provider 403 responses do not sign out the user. Missing action metadata and missing individual actions disable the actual buttons, not just explanatory text.

### Authoritative inventory and source-aware details

- `GET /api/agents` now performs bounded server search/filter/sort/paging against one current principal-owned snapshot. It returns authoritative unfiltered and filtered totals plus authorized publisher, availability, host and platform facets. Ordering has a native-ID tie-breaker and the UI uses 50-row pages rather than a 5,000-row fetch or local approximation.
- A 73-package repository fixture proves filters, facets, totals and a second result page beyond the first boundary. Package export uses the same query contract.
- `GET /api/inventory/resources/:nativeId/related` authorizes the source before any related query or count. It returns the exact Power Platform IDs and observation, package/report unresolved states, exact Purview CDS-bot/environment matches, exact Defender Entra-agent matches and exact native control targets.
- Names, owners, application IDs, timestamps and same-value/different-kind identifiers are never joins. Package-to-Power-Platform and official-report association remain explicitly unmatched because retained contracts document no exact equivalence. Unauthorized, unmatched, unavailable and authorized-empty states remain distinct.
- Package and Power Platform detail dialogs provide source-aware identity, package, Power Platform, reports, audit/security and controls tabs. Exact identifiers, job/snapshot/correlation IDs, observations, disagreement and connector truncation are shown without raw content. Tabs implement roving Arrow/Home/End behavior, modal focus trapping, Escape, retry for safe reads and trigger-focus return.

### Typed actions and jobs

- `/api/workbench/metadata` is consumed by `WorkbenchActionProvider` and shared action gates, not merely used for navigation. Metadata covers package broad/exact refresh, exact inspection, block/unblock/access, package recovery, Power Platform refresh/recovery/export, quarantine recovery, official import/export, Purview and Defender search/recovery/export.
- A policy-alignment regression resolves every metadata method/route against the registered backend policy and checks roles, CSRF and route capability declarations. Backend policy remains authoritative; the registry does not make authorization decisions.
- `/api/workbench/jobs` aggregates only role/source-authorized retained jobs and returns at most 100 minimized summaries: source, safe target, status, cardinality, partial state, update/expiry, recovery flags, request ID and exact source link. It does not return item results, staged previews, query filters or confirmation bodies.
- Jobs uses one abortable non-overlapping request. It polls only submitted/discovered `queued`, `running` or `reconciling_create` work, never `waiting_authorization`, and stops after five minutes. Principal/role changes abort, clear and generation-fence state.
- Recovery is explicit: valid unsent work may resume or cancel; uncertain writes expose GET-only reconciliation. No write is replayed or automatically inverted. Package, inventory, Purview and Defender foreground polling is also sequential and finite.
- Source-discriminated job links resolve the exact package refresh/control, inventory, quarantine, Purview, Defender or import-staging job. Opening a link never falls back to the latest job, starts a provider request or resumes a write. Same-tick action guards and generation fences prevent duplicate dispatch and stale-principal updates.

### Exports, audit and lifecycle

- Package, Power Platform, official aggregate/user, local administrative audit, Purview and Defender CSV exports use one bounded publication service. It neutralizes `=`, `+`, `-`, `@`, tab, carriage return and Unicode-minus formula prefixes; validates filenames/schema; applies row, byte and 15-second deadlines; publishes in 64 KiB chunks; honors backpressure and disconnect; and removes listeners.
- Package and Power Platform exports require an exact current snapshot and reject incomplete/truncated selections. Power Platform rows explicitly stamp `sourceSystem`; inventory exports include snapshot ID, observation and expiry. Purview/Defender rows retain only their allowlisted projections. Official exports retain the three-file active revision/set/version authority and Phase 08’s delegated/application scope split.
- The bounded-buffer decision is intentional: package, Power Platform, official and Purview outputs cannot exceed 8 MB, Defender cannot exceed 2 MB, local administrative audit cannot exceed 1 MB, and budget/schema errors are detected before successful headers. No temporary export file or bearer URL exists.
- Every export repeatedly re-reads the stored session, expiry, principal and required role, then revalidates the source snapshot/job/revision before querying and between publication chunks. Supersession, deletion, expiry, scope revocation or role/session invalidation fails closed. Cached authorized exports do not require current live-provider availability.
- Export success audit is metadata-only and is durable before the final response chunk; a final transport failure appends a failed projection. Failure audit has only a safe code. Source, snapshot/job, resulting count and bytes are retained; rows and formula-bearing content are not.
- `POST /api/audit/events/export.csv` requires SecurityReader and CSRF, accepts 1-100 exact event IDs, and applies tenant/actor and 90-day source validity before returning rows. The frontend downloads this server projection with abort cleanup. Browser row-to-CSV serializers were removed; `agentExport.ts` now only delivers and releases a server Blob.
- Phase 10 added migration 23 for package/Power Platform export audit actions, migration 24 for official aggregate/user export audit actions and migration 25 for local administrative audit export actions. Once applied, none was edited; migrations 1–22 remain unchanged. A nonempty schema-22 fixture upgrades through 23, 24 and 25, preserves prior audit rows and stored checksums, and tolerates a repeated invocation. The retained database independently passes `verifySchema` for all 25 stored checksums using `agentcontrol_app`. Any subsequent schema work starts at migration 26.

### Existing retained sources and packaging

- Official usage still has exactly the Microsoft three-file import authority, lineage, periods, active/superseded/incomplete/stale states and unresolved report-only rows. User rows remain SecurityReader-only and Administrator staging remains actor-owned.
- Audit remains exactly local administrative audit plus separately labelled/tallied Purview Audit Search. Security remains fixed-template Defender scope/readiness/partial evidence with an external portal link; arbitrary KQL, raw content and recurring collectors remain absent.
- The production artifact is still one Express process serving built React assets plus PostgreSQL. API/auth/health precedence, deep-link fallback, API and missing-asset 404s, traversal rejection, CSP/cache behavior and server-owned identity remain in the packaged smoke contract.
- Provider capability evidence is disabled/unconfigured on the retained local target, as observed. Saved authorized data remains usable offline; this is not recorded as live provider qualification.

## Changed files

### Backend

- Inventory and lifecycle: `backend/src/db/packageInventory.ts`, `powerPlatformInventory.ts`, `purviewAudit.ts`, `defenderHunting.ts`, `sessions.ts`.
- API and policy: `backend/src/routes/agents.ts`, `inventory.ts`, `workbench.ts`, `officialUsage.ts`, `audit.ts`, `purviewAudit.ts`, `defenderHunting.ts`, `policy.test.ts`.
- Shared contracts: `backend/src/services/csvExport.ts`, `workbenchMetadata.ts`, `purviewAudit.ts`, `defenderHunting.ts`; `backend/src/types/workbench.ts`, `audit.ts`.
- Schema: `backend/src/db/schema.ts` (Phase 10 migrations 23-25).
- Administrative export: `backend/src/services/auditLog.ts`, `backend/src/routes/audit.ts` and the typed `audit.export` action.
- Evidence: `backend/src/services/csvExport.test.ts`, `workbenchMetadata.test.ts`, `backend/src/db/packageInventory.test.ts`, `defenderHunting.test.ts`, `backend/scripts/database.test.ts`, `backend/src/app.test.ts`, `backend/src/routes/officialUsageCsv.test.ts` and directly implicated source tests.
- Package proof: `backend/scripts/package-smoke.ts`, `backend/scripts/zip-runtime-smoke.mjs`.

### Frontend and browser

- Workbench state/client: `frontend/src/App.tsx`, `api/client.ts`, `workbenchRouting.ts`, `workbenchActionContext.tsx`, `packageSelectionSession.ts`, `agentExport.ts`.
- Integrated views/controls: `AgentTable.tsx`, `BulkActions.tsx`, `AccessAssignmentModal.tsx`, `AgentDetailModal.tsx`, `InventoryExplorer.tsx`, `CopilotStudioQuarantineControls.tsx`, `JobsView.tsx`, `PurviewAuditView.tsx`, `DefenderHuntingView.tsx`.
- Additional integrations: `AuditLogView.tsx`, `OfficialUsageImportPanel.tsx`, `CopilotStudioQuarantineTargetPicker.tsx`.
- Regressions: `api/client.test.ts`, `workbenchRouting.test.ts`, `InventoryExplorer.test.tsx`, `JobsView.test.tsx`, `PackageManagement.test.tsx`, `PurviewAuditView.test.tsx`, `App.session.test.tsx`, `packageSelectionSession.test.ts`, `workbenchActionContext.test.tsx`, `AuditLogView.test.tsx`, `agentExport.test.ts`, related Defender/import/quarantine tests and `frontend/browser/permissions.spec.ts`.
- The existing `frontend/src/components/UserAccessView.tsx` changes and deletions of `reportImports.test.ts`, `reportImports.ts`, `reportingModels.ts` and `usageModels.ts` remain preserved.

### Completion evidence

- `README.md`, `frontend/README.md` and this record document the integrated workbench and exact final verification. Backend, frontend and the shared root package/scripts were checked as one application boundary; no second runtime or cloud implementation was introduced.

## Autonomous decisions

- Retained exact identifier contracts were treated as the complete join authority; missing equivalence is shown as unmatched rather than inferred or manually linkable.
- Small-capacity bounded buffers were chosen over streaming a potentially invalid export because the hard 8 MB/2 MB/1 MB limits allow complete budget validation before headers. Publication remains chunked and backpressure-aware.
- Operator-only package work uses exact ID lookup/refresh and never broad enumeration. Reader+Operator principals may use Reader inventory with separately gated Operator controls.
- Successful export audit is inserted immediately before the final chunk so an immediate follow-up read is consistent; any final disconnect appends the failed status and becomes the audit projection.

## Validation evidence

| Check / exact command | Environment / revision | Status | Observed result and safe evidence |
| --- | --- | --- | --- |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./deploy-local.ps1 -Action Deploy -Project agent-control-phase01` | Docker operator, isolated `agentcontrol_test_*` database, final schema-25 worktree | passed | Backend 50 files / 505 tests; frontend 24 files / 175 tests; backend typecheck, frontend ESLint and both production builds passed. Repeated by final persistence deployment at 10:51 UTC with the same counts. |
| Focused Docker reruns for `csvExport.test.ts`, `workbenchMetadata.test.ts`, `packageInventory.test.ts`, `app.test.ts`, routing, client, Inventory Explorer, Package Management and Jobs | Docker operator / isolated PostgreSQL where required | passed after repair | Initial aggregate exposed SQL syntax/count expectations, immediate audit ordering, route-policy coverage, stale polling tests, React lint and browser fixture drift. Each was repaired; final focused and aggregate reruns passed. |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./scripts/permission-browser.tests.ps1 -Project agent-control-phase01` | Built SPA + real Express routes + isolated PostgreSQL + blocked outbound providers | passed after repair | 46/46 Playwright cases in 54.3 seconds plus the Vitest harness at 10:49 UTC. Covered capability states, four roles, exact/no-broad Operator lookup, source tabs, keyboard/focus trap/return, source-specific job links/history, partial/stale/error/empty/disagreement, all 25 frozen quarantine targets, official import, separate Purview/Defender, axe, reduced motion and reflow. Synthetic desktop/mobile route screenshots were visually inspected. |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./deploy-local.ps1 -Action Deploy -Project agent-control-phase01` | Retained `agent-control-phase01` | passed | Current worktree tested/built, app recreated without volume reset, `app` and `postgres` both healthy at `http://localhost:3001`. |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./scripts/persistence.tests.ps1 -Project agent-control-phase01 -Port 3001` | Final schema-25 retained volume plus isolated restore databases | passed | Persistent fingerprints, original credentials/origin, two-service health, repeatable-read backup and isolated native restore passed. Exact proof dump/receipt pairs and fixture databases were removed. |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./scripts/restart-runtime.tests.ps1 -Project agent-control-phase01` | Final runtime image + isolated fixture databases | passed on sequential rerun | An overlapping persistence stop caused `ENOTFOUND postgres` in the first attempt; both harnesses cleaned their databases. Rerun after persistence completed passed. Zero completed/uncertain/canary/quarantine replays, no automatic provider calls, GET-only quarantine reconciliation, preserved official lineage and explicit-only fixture scans were observed. Do not overlap these lifecycle scripts. |
| `docker build --platform linux/amd64 --target export --output type=local,dest=artifacts .` | Docker Desktop Linux/amd64 | passed | Rebuilt `artifacts/agent-control-linux-x64.zip` from the same production release tree; platform/architecture guard passed. |
| `docker run --rm --network agent-control-phase01_default --mount "type=bind,source=$PWD/artifacts,target=/evidence,readonly" agent-control-phase01-operator:local backend/scripts/package-smoke.ts http://app:3001 /evidence/agent-control-linux-x64.zip` | Final retained runtime and ZIP | passed | All eight deep links, API/auth/health precedence, API/asset 404s, traversal, CSP/no-store, immutable asset caching, exact callback, spoofed identity rejection, production dependency closure and ZIP exclusions; actual HTML/JS equality against the running image passed. |
| `docker build --platform linux/amd64 --target package -t agent-control-phase10-package:local .` followed by the exact ZIP command below | Final Linux/amd64 package stage | passed | Extracted ZIP executed with Linux x64 Node 24.20.0, passed runtime smoke and mounted-secret exclusion, shut down cleanly and removed scratch. Validation-only package image tag subsequently removed. |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./scripts/local-deployment.tests.ps1` | Existing PowerShell orchestration harness | passed | All 22 assertions, including culture-safe retention helper. |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./deploy-local.ps1 -Action Backup -Project agent-control-phase01 -BackupFile .local/agent-control-phase01/backups/phase10-verified-schema25-20260910T110000Z.dump` | Retained schema 25 | passed | New non-overwriting protected dump and receipt verified; file label is explicit, actual creation was 10:53 UTC. |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./deploy-local.ps1 -Action Retain -Project agent-control-phase01` | Retained database/backups | passed | Scoped retention succeeded; all four named dump/receipt pairs below remain. No provider calls. |
| Restricted-role schema query below, Docker topology inspection, editor diagnostics and `git diff --check` | Final retained Compose project | passed | All 25 migration checksums verified as `agentcontrol_app`; only `agentcontrol` and `postgres` non-template databases; exactly healthy persistent `app` and `postgres`; no owned fixture containers remain; no diagnostics or whitespace errors. Unrelated Docker resources were left alone. |
| Live provider qualification/canary | No approved live target or credentials in Phase 10 | unavailable by design | No provider request, mutation canary, grant or Azure action was attempted. Fixture evidence is labelled test-only and production cannot enable fixture mode. |

### Exact final package and schema commands

Run from the repository root after the package build above. All application/database tooling remains in Docker, using the existing Dockerfile and approved `https://packagefeedproxy.microsoft.io/npm/` registry. Host PowerShell only orchestrates the checked-in scripts.

```bash
docker run --rm --platform linux/amd64 --network agent-control-phase01_default \
  --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets/postgres-app,target=/run/secrets/postgres-app,readonly" \
  --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets/session,target=/run/secrets/session,readonly" \
  -e PGHOST=postgres -e PGUSER=agentcontrol_app -e PGDATABASE=agentcontrol \
  -e PGPASSWORD_FILE=/run/secrets/postgres-app -e SESSION_SECRET_FILE=/run/secrets/session \
  --entrypoint node agent-control-phase10-package:local backend/scripts/zip-runtime-smoke.mjs

docker exec agent-control-phase01-app-1 node --input-type=module -e \
  'import { pool } from "./backend/dist/db/pool.js"; import { verifySchema } from "./backend/dist/db/schema.js"; try { await verifySchema(pool); console.log(JSON.stringify({ schema: (await pool.query("SELECT count(*)::int AS applied, max(version) AS latest FROM schema_migrations")).rows[0], role: (await pool.query("SELECT current_user")).rows[0], databases: (await pool.query("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname")).rows, validatedAt: new Date().toISOString() })); } finally { await pool.end(); }'
```

The final ZIP is `artifacts/agent-control-linux-x64.zip`. Built assets are `index-DlFqKnIa.js` (888.62 kB, gzip 250.77 kB) and `index-m8ztlf2Y.css` (69.28 kB). The inherited Vite >500 kB advisory remains visible, not suppressed. Runtime proof includes the extracted process, not merely ZIP inspection or build success. Canonical origin/callback and server-owned session cookies are unchanged; no SWA proxy, trusted identity headers, alternate origin or separate frontend process is required.

### Final cleanup and retained evidence

- `artifacts/phase03/permission-browser-results.json`, `workbench-routes-desktop.png`, `workbench-routes-mobile.png` and the source/confirmation screenshots remain as synthetic browser evidence. The two route screenshots were inspected for restrained styling, readable source/disabled states and mobile reflow.
- Final database inventory is exactly `agentcontrol`, `postgres` (excluding templates). All owned test/restore databases, restart fixture containers and proof backup pairs were removed by the checked-in harnesses. The exact `agent-control-phase10-package:local` validation tag was removed after successful ZIP execution. Retained app/operator/browser artifacts, final ZIP, original network/volume/secrets and unrelated containers were preserved.
- After retention, `.local/agent-control-phase01/backups/` contains these four verified pairs: `phase09-verified-20260909T220129Z.dump` (231073 bytes), `20260910T060940442Z.dump` (230942 bytes), `phase10-verified-20260910T095823Z.dump` (231570 bytes, schema 24), and `phase10-verified-schema25-20260910T110000Z.dump` (231271 bytes, schema 25). Each has its `.dump.json` receipt; dump/receipt permissions remain `0600`. The prior two sizes and modification times remained unchanged. This proves present backups, not missing historical history.
- No secrets, row contents or transcripts were added to this record. No commits, pushes, branches, campaign ledger or per-file hashes were created. The existing user worktree remains dirty and preserved.

## Open issues

Inherited [P09-BACKUP-HISTORY](09-copilot-studio-quarantine.md#open-issues) remains unresolved: the two currently required verified dumps are present and current-state backup/restore passed, but older historical backup preservation cannot be claimed without independently protected copies.

The inherited [P01 identity/bundle-size](01-domain-persistence-foundations.md#open-issues), [P04 live inventory](04-power-platform-inventory.md#open-issues), [P05 package safety/live qualification](05-package-management.md#open-issues), [P07 Purview contract/live eligibility](07-graph-audit-search.md#open-issues), [P08 provider/retained-scope and offline-RBAC](08-defender-agent365-hunting.md#open-issues), and [P09 live quarantine](09-copilot-studio-quarantine.md#open-issues) residuals are not closed by fixtures. No live call, canary approval or qualification was supplied.

## Parent review, repairs and discriminating proof

Initial successful test totals did not prove all Phase 10 requirements. Parent review kept the phase open when Agents still used browser filtering, action metadata was not consumed, source detail was explanatory only, and exports lacked the claimed lifecycle bounds. Those implementation gaps were repaired rather than classified as disabled providers.

The next parent pass added tests that reproduced five remaining failures: a source-detail Defender query omitted retained-scope authorization before counts, stalled backpressure and authorization reads exceeded their deadline, final audit allowed invalidation before the last write, and an empty export bypassed header/deadline budgets. The shared publisher now cancels read/backpressure/finish waits, removes listeners, checks after final audit, and delays CSV headers until publication is authorized. The Defender related query uses the same retained visibility predicate as normal reads, joins current version-3 jobs/snapshots, and returns no rows or counts after authority loss or revocation. An initial SQL test run exposed an incorrect snapshot-column assumption in this repair; the corrected join passed.

Actual Express/PostgreSQL race tests also prove session deletion, role loss, snapshot expiry/deletion, application scope revocation and deletion of an audit filter's source during final audit prevent row publication and leave a failed, row-free audit projection. Audit-reference package filters require SecurityReader independently of Reader, filter on the authorized audit principal before counts, and revalidate both roles and selected audit source for download. Official export audit now retains its bounded set/window fields. The unused prior CSV writer was removed and its backpressure tests exercise the shared publisher.

The six focused backend files passed 89 tests at 09:55:53 UTC; the additional audit-source race passed within the then-39-test HTTP suite at 09:57:16 UTC. Backend typecheck passed. The forward-only migration suite passed 20 tests after correcting the new test fixture's required block-state field. The extended packaged smoke passed against the retained app and ZIP, checking all eight canonical routes, no-store/CSP, exact callback, spoofed identity rejection and byte-for-byte served HTML/JavaScript parity.

Final frontend repairs made job deep links executable rather than decorative, removed fail-open metadata branches, fenced concurrent actions and private state on authorization loss, and bounded oversized selection URLs without losing any selected ID. Component tests cover restoration and fail-closed missing storage; real browser tests cover exact source job identity and history without provider sends.

A final direct-cutover inspection found local administrative audit still serialized browser rows. That path now uses the authenticated exact-ID server export, with tests proving independent SecurityReader authority, source deletion during final audit, row-free audit metadata, correct requested IDs and Blob cleanup. The HTTP suite now contains 40 tests. The unused full-package browser CSV serializer was also removed. Migration 25 extends only the permitted audit action constraint, and the nonempty migration fixture now runs through 25.

Repair history is not hidden: mounting the whole frontend directory masked installed workspace dependencies (corrected to mount only source, without a dependency install); a misplaced new client function and a test actor missing required roles failed the first focused validation and were corrected. The first expanded browser run passed 44/46 cases because `getByLabel("Action")` ambiguously matched the select and Audit-actions container; the exact combobox-role locator passed all 46 on rerun. The final lifecycle overlap failure and successful sequential rerun are recorded in the table. Final aggregates, executable package/runtime parity and cleanup all passed on the current schema-25 artifact.

## Next session

- Implement only [11-security-operations.md](../11-security-operations.md) in a fresh session; do not reinterpret disabled local providers as live qualification.
- Start from the retained `agent-control-phase01` project, immutable schema migrations 1-25, healthy two-service topology and the current uncommitted worktree. Any new migration starts at 26. Preserve all four named dump/receipt pairs, original volume/network/secrets, canonical origin/callback and all Phase 02–10 source/role/identity contracts.
- Re-read this completion, Phase 09’s completion and `docs/mutation-canaries.md`. Continue `P09-BACKUP-HISTORY` as an inherited residual rather than claiming older history was proven.
- Retain four independent roles, authorization before source joins/counts/exports, official three-file authority, Defender provider-proof versus retained-scope/revocation/projection-v3/offline-RBAC boundaries and all 25 exact native quarantine targets. No live identity configuration, provider call, write or qualification approval is supplied by this completion. `authConfigured` remains false.
- Reuse the exact Docker aggregate, built browser, ZIP/runtime, sequential restart/persistence and retention commands above. Do not reset retained data or broaden provider behavior to make a check pass.
- Copyable next-session scope: **Implement only `plans/admin-poc-production/11-security-operations.md`, starting from the verified Phase 10 completion and preserving the retained environment and dirty worktree. Stop before Phase 12.**
- Phase 11 was not started in this session. Local handoff: **http://localhost:3001**.
