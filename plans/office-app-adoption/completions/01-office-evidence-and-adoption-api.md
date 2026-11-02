# Phase 01 — Office evidence and adoption API

## Phase Result

**Complete for phase 01: implemented and verified.** Phase 02 can consume the concrete contracts below. This is not a deployment, real-provider/browser qualification, or campaign-completion claim. Phase 03 owns the authorized local `seha` reset/deployment and production-continuation proof.

Worker: `gpt-6.1-sol`, `xhigh`; one worker, no nested agents. Repository: `/Users/candede/repos/agent365/agent_control`. The skill, worker contract, AGENTS, README, assigned prompt and campaign state were read before editing. Initial tracked worktree was clean; the parent's untracked completion directory was preserved. No commit, push, branch, application-database mutation or campaign-state edit occurred.

## Implemented

- One seven-app catalog/classifier: Word, Excel, PowerPoint, Outlook, OneNote, Loop, Teams. Chat, Edge, overall last activity, agent activity and global prompt/ROI/productivity metrics do not participate.
- One immutable retained evidence owner: `office_observations` headers and `office_person_facts`, inside existing generations, tenant scopes, leases, reservations, accounting and lifecycle slices. Historical facts do not join current directory/licenses, imported reports, inventory or original source generations.
- Automatic local capture after either ordinary source publication; startup and existing 30-second recovery finish directory-first/app-first and interrupted work. Successful/no-op vectors are acknowledged in the existing app source attempt. Two idle ticks do not recopy people or call Graph.
- Source-vector fencing/reachability protection during bounded staging and an atomic recheck at publication. Clear cancels pre-clear staging. Same-date semantic corrections replace the canonical capture and invalidate direct and timeline-range dependents.
- Viewer-capable authenticated HTTP selected reads, complete aggregation/ranking before pagination, actor/session-bound signed cursors, numbered five-group pages/renewal anchors, paginated people/facets/departments/history and explicit payload limits.
- Frozen eligibility, exact directory identity/display/group context, seven dates, original observation timestamps, provenance and unknown reasons. Retained unseen directory/app rows never become current participants. Unknown evidence is a subset of no-recent evidence.
- `users` publication revision includes Office heads/status, without changing the three publication keys or automatic provider-source IDs. Derived errors are visible/retried and cannot downgrade healthy source publication.
- Twelve UTC calendar months with cutoff equality through the whole UTC day, including the non-leap-February-to-leap-February boundary. Expiry/clear invalidate child selections before bounded fact/header deletion and release charges. Recovery/restore review cannot resurrect cleared or superseded captures from restored old source heads.
- One `office-app-adoption` selector in the existing isolated SQL owner, with new database/API/publication/recovery/lifecycle/concurrency contracts. No new runner, provider permission, scheduler or runtime approval/enable prerequisite.

## Deleted

Replaced the duplicated seven-app labels in existing user details with the shared catalog; its existing Chat detail remains separately labeled. No supported agent API, MCP behavior or agent-report retention was deleted. Proposed redundant SQL object-length and in-memory champion helpers were removed rather than retaining competing validators/ranking implementations. No migration chain, compatibility route, ID alias or historical schema was introduced.

## Design and falsifiable hypothesis

Hypothesis: existing generation leases/source-attempt bookkeeping can provide immutable retained captures and automatic catch-up without another job/store. Cheap disproof: replay equivalent facts using different source generations/timestamps, then execute two idle recoveries. A changed canonical capture, full recopy or Graph call would reject the design. Final SQL proof preserves the original capture/provenance and performs no recopy/Graph call.

Canonical tenant scope is `office_app_adoption`, selector `<provider-date>:D28:v2`; its existing generation head is the sole canonical capture. Header insertion enforces that selector/window. Semantic SHA-256 streams identity-ordered facts and report coverage; generation IDs, group hashes and collection/evaluation/evidence timestamps are excluded. Unchanged replay preserves original capture; changed same-date evidence publishes a new immutable generation, with no aliases.

The vector is SHA-256 of ordered directory/app `(scope ID, epoch, generation ID, head revision)` facts. Existing sync mutex/scope/head/generation locks fence it before staging, on renewal and at publication. Live derived staging leases protect source reachability; published history has no source FK/read dependency. Batches are at most 250 rows/1 MiB, within existing 100,000-source-row/8-GiB generation bounds.

Only the existing verified-paid classifier qualifies people (`enabled`, `warning`, `partially_enabled`); inactive/no-paid/unknown licensing is retained separately in coverage. Recent is refresh minus 27 days through refresh inclusive. Current admission requires valid non-future refresh, current `D28`/`v2` source semantics and existing freshness/expiry checks. Source aging changes current availability, not frozen historical metrics.

The five existing-attempt additions are Office vector/status/error/timestamp/revision. A tightly bounded guard permits only those metadata fields to change after successful app-source publication, with every source-owned field unchanged and revision incremented. Checkpoints publish atomically. Committed capture/no-op acknowledgement is rechecked after a lost commit response before recording a false failure.

## Exact phase 02 API contract

Authoritative types: `backend/src/types/officeAppAdoption.ts`. Typed transport: `frontend/src/api/officeAppAdoption.ts`.

All routes are authenticated Viewer-capable GETs under `/api/office-app-adoption`:

| Suffix | Payload |
| --- | --- |
| `/context` | `OfficeContext` |
| `/summary`, `/comparison` | `OfficeSummary` |
| `/history` | `OfficePage<OfficeHistoryPoint>` |
| `/groups`, `/departments` | `OfficePage<OfficeGroup>` |
| `/facets?kind=company\|department` | `OfficePage<OfficeFacet>` |
| `/groups/:groupId/people` | `OfficePage<OfficePerson>` |

Query: `officeSnapshot?`, `officeBaseline?` (UUIDs), `company?: string|null`, `department?: string|null`, `search?` (decoded maximum 256 characters), `app?` (seven catalog IDs only). No agent `snapshot`/`baseline` parameters. Nullable facets encode as `~null`; literal strings encode as `~string:<value>`, including literal `~null`. Encoded organization scalars allow the eight-character prefix in addition to the decoded limit.

Paging: `selectionId?`, `cursor?` (maximum 4096), `limit?`, `pageNumber?`, `anchor?` (64-character group ID). Cursor/anchor require the same selected read. Cursor, page number and anchor are mutually exclusive. Groups are exactly five/page; other pages default 50, allow 1..100. Group anchors resolve numbered renewal pages; other endpoints reject anchors. Departments order by participation descending. Group IDs use the existing SQL NFKC/lower organization normalization, not frontend-generated IDs. Responses over 1 MiB fail explicitly with 413; no silent truncation.

Capture one context and pass **the identical query plus its selection ID** to every panel/page. Selections pin metadata-only `office_history`, the selected `office_observation`, and optional earlier baseline. Signed cursors bind actor/session epoch, selection/revision, query, endpoint/group/facet and page size. Correction, clear, retention, revocation and expiry reject invalid selections instead of mixing pages. A historical snapshot excludes later provider dates and observations collected after its selected-read evaluation.

`OfficeContext`: nullable selected observation/baseline, current status, selected-read metadata and original query. Status is `available|preparing|waiting_sources|unavailable|failed`, with nullable safe error/message. Selected-read publication keys remain exactly `graph_packages`, `power_platform`, `users`.

Observation: ID, refresh date, `D28`, `v2`, window start, original capture/expiry/content hash, original directory/app generation IDs and observation timestamps, coverage. Coverage contains directory population, inactive/no-paid/unknown licenses, reported/retained rows, overlapping reason counts and `complete|partial`. Reasons: `missing_row`, `ambiguous_identity`, `retained_row`, `retained_directory`, `wrong_window`, `no_app_dates`, `invalid_app_date`, `future_app_date`. Unknown licenses/retained rows/reasons disclose partial coverage. Reason counts can overlap; the **unknown-evidence people metric counts only no-recent people with reasons**.

Metrics: saved licensed people, distinct reported active users, active user-app pairs, distinct apps used, no-recent people, unknown-evidence people, and all seven overlapping per-app counts. Summary exposes unfiltered organization metrics, matching metrics/group counts, filtered people, nullable organization `suggestedChampions` and `filteredSuggestedChampions`, optional baseline metrics and context. Organization cards/history metrics ignore company/app filters; groups/departments/people/facets/suggestions apply them. Missing observation gives null metrics/champion counts, not a fabricated dated zero.

Group: stable ID, nullable company/department, full paid denominator/seven-app metrics, participation, filtered people and up to three positive-breadth champions. App filters narrow displayed people/suggestions and matching groups, but never shrink the full group's denominator or seven totals. Champion ranking uses breadth, qualifying recency, normalized display label, exact identity over the whole matching set. Summary suggestion counts are not sums of one group page.

Person: exact identity/UPN/display label, frozen nullable company/department/group ID, entitlement/service state, original directory/app observation times, app report refresh, seven nullable dates, qualifying recent apps/latest date and unknown reasons. Distinguish these facts from any newer current profile/license/agent details.

Errors use existing wrappers: malformed/unsupported input and invalid paging/cursors are explicit 400; invalidated/expired/unavailable selection is 409; role/auth denial is existing 403/401; payload bound is 413. No provider-read consent is required to read shared saved Office facts.

## Changed paths / cross-root impact

- `backend/scripts/{backup.test.ts,backup.ts,backupInventory.ts,database.ts,largeTenantFixture.test.ts,largeTenantFixture.ts,officeAppAdoptionFixtures.ts}`.
- `backend/src/{app.ts,server.ts,server.test.ts}`.
- `backend/src/db/{currentSchema.ts,dataGenerations.ts,dataRetention.ts,inventoryAutomaticRevisions.ts,schema.ts,schema.test.ts,userSourceStages.ts,userSources.ts,officeAppAdoption.ts,officeAppAdoption.test.ts,officeAppAdoption.unit.test.ts,officeAppAdoptionSchema.ts}`.
- `backend/src/routes/{policy.test.ts,officeAppAdoption.ts,officeAppAdoption.test.ts,officeAppAdoption.unit.test.ts}`.
- `backend/src/services/{dataMetrics.ts,dataSelections.ts,dataSync.ts,telemetry.ts,officeAppAdoption.ts,officeAppAdoption.unit.test.ts,officeAppAdoptionReads.ts}`.
- `backend/src/types/officeAppAdoption.ts`.
- `frontend/src/api/{officeAppAdoption.ts,officeAppAdoption.test.ts}` and `frontend/src/components/UserDetailModal.tsx`.
- `scripts/large-tenant-tests.ps1`.
- `docs/{data-architecture.md,copilot-license-usage.md,operations.md}`.

**MCP no-change:** inspected existing agent adoption operations in `mcp/src/agent_control_mcp/tools.py`; they still call agent-report adoption endpoints and preserve their meaning. No Office tool is requested or required.

**UI boundary:** typed transport/shared catalog and directly affected detail-label consumer are updated; Dashboard/Users domain navigation, charts and frozen-fact presentation belong to phase 02, not implemented here. Existing publication consumption remains three-key.

**Deployment/fixture boundary:** existing SQL owner/selector, schema/grants, accounting/retention, backup keys and restore consumer are updated. Compose/deployment/reset owners and approved npm registry are unchanged. Phase 03 owns scale/current-installation/restore fixture extensions and deployment. The Office restore check here is a focused database contract test of the current review consumer, not a replacement restore runner.

## Validation and identities

Environment: macOS workspace; Docker `desktop-linux`, verified Unix socket `unix:///Users/candede/.docker/run/docker.sock`; local isolated `test-db`/`test-postgres` projects only. Test authentication and synthetic people remain inside disposable fixtures, never the application database. No dependencies installed; owner verifies all four manifests against the explicit installed baseline and builds offline.

- Baseline tag: `agent-control-office-adoption-baseline-4b34cc5b:local`.
- Baseline immutable ID: `sha256:3f334d1f5324d9655f94cf4c0f0617d71e8a1c37c1b138f8bebe44783fbd50be`, arm64.
- Current schema SHA-256: `05d36a05ce28de5573541ad107788edaab862688d70ae86ff7de83a9f101a0fc`; fresh schema/runtime verification passed. Current declarations: 106 tables, 3 views, 80 functions, 108 triggers, 2 collations; current source/grant/root/FK/accounting/backup checks passed.
- Base commit (not created by worker): `a0e6585283dfbfe2b1117bb24e27e32ae013a3ec`.
- Final SQL image: `agent-control-ltdp-72ae6448d49e461e939e7ce9083d6a7d-operator:local`, ID `sha256:0c1c02e92a5ba1a65f22bc30229534687cb22a8c353e9e450678676e7afa7408`, arm64, Node `v24.20.0`.
- Final changed-source digest: `c90ff1a492190e8b883a5b3fb6391c6d7fbbb10fb6c311c17faf39035da79a1c`. All 41 changed application/test/tooling/doc files were SHA-256 compared against that exact image and matched. Algorithm/individual hashes: `artifacts/office-phase01-source-receipt.json`.
- Synthetic source scope is tenant-owned `directory`/`app_activity`, selector `complete`; captures expose and freeze their original generation IDs/times. No live tenant/source identity or provider-data proof is claimed.

Commands/results:

1. **Passed:** `npm test --workspace backend -- src/services/officeAppAdoption.unit.test.ts src/db/officeAppAdoption.unit.test.ts src/routes/officeAppAdoption.unit.test.ts src/services/adoptionGroups.unit.test.ts src/services/adoptionHistory.unit.test.ts src/services/adoptionDepartments.unit.test.ts src/db/userSources.unit.test.ts src/db/schema.test.ts src/db/automaticRevisions.unit.test.ts src/routes/policy.test.ts src/server.test.ts src/services/userSourceGraphFields.test.ts src/services/copilotServicePlans.test.ts` — **618 tests / 13 files**, final log `artifacts/office-phase01-focused.log`.
2. **Passed:** `npm run typecheck --workspace backend`; `npm run typecheck --workspace frontend`; `git diff --check`.
3. **Passed:** `npm test --workspace frontend -- src/api/officeAppAdoption.test.ts src/api/reportData.test.ts src/components/UserDetailModal.test.tsx` — **90 tests / 3 files**, `artifacts/office-phase01-frontend.log`.
4. **Passed:** `npm exec --offline --workspace frontend -- eslint src/api/officeAppAdoption.ts src/api/officeAppAdoption.test.ts src/components/UserDetailModal.tsx`.
5. **Passed:** `pwsh ./scripts/large-tenant-tests.ps1 -Suite office-app-adoption -BaselineImage 'agent-control-office-adoption-baseline-4b34cc5b:local' -BaselineImageId 'sha256:3f334d1f5324d9655f94cf4c0f0617d71e8a1c37c1b138f8bebe44783fbd50be'` — final **529 tests / 12 files**, no skips, backend typecheck exit 0; exact owner exit 0. New Office files were discovered: database 25, HTTP 3, classifier 26, schema/matching 2, route-input 11 cases. Evidence: `artifacts/large-tenant-data-platform/72ae6448d49e461e939e7ce9083d6a7d/{result.json,*.log}` and `artifacts/office-phase01-sql-08.log`.

SQL proof includes no imported agent set/inventory; both automatic source orders; replay and two idle ticks/no Graph; simultaneous genuinely pending corrections; ambiguous/duplicate/concealed aliases; warning/partial/inactive/no-paid/unknown licenses and normalized/missing groups; all-record champion ranking/ties/zero breadth; all group/facet/people pages and app-filter/full-denominator separation; cancellation/expired stage/head change/staging clear; recovery-only users revision; healthy source success after derived failure; lost commit acknowledgement; frozen historical context/source retirement; real expiry and dependent-first bounded deletion/byte release; clear/restore nonresurrection; Viewer HTTP saved reads, invalid query/paging, tenant/actor/session expiry/revocation; current schema/grants/backup keys. Existing focused parser/classifier tests cover malformed/future/blank dates and refresh fields.

### Failed attempts — repaired, not relabeled as passed

Each used the same exact SQL owner/baseline arguments; directories are under `artifacts/large-tenant-data-platform/`.

| Attempt/project suffix | Test result | Backend typecheck | Overall |
| --- | --- | --- | --- |
| `0b4ddc8d81c046149cc16c5c86594666` | 26 failed, 483 passed, 7 skipped / 516 | passed | failed |
| `9f2a307141f941b5ba9e34f14795a1b4` | 16 failed, 501 passed / 517 | passed | failed |
| `f959102efeee4219b5a53b14d5cc7a7c` | 15 failed, 499 passed / 514 | passed | failed |
| `497d12ff1e0b47879951aa57bcfa6588` | 3 failed, 520 passed / 523 | passed | failed |
| `86ce4a06d417496180c7a62ac88b4b55` | 1 failed, 523 passed / 524 | failed | failed |
| `c475bf8bc7154944aa1363f510f7d7ab` | 2 failed, 525 passed / 527 | passed | failed |
| `9ce064d59c504281b5bf06c7f79dd564` | 529 passed / 529 | failed | failed |
| `72ae6448d49e461e939e7ce9083d6a7d` | 529 passed / 529 | passed | passed |

Repaired exact source-attempt schema registry/counts, the published-source metadata guard, redundant helper privilege requirement (removed helper), SQL DISTINCT/C ordering, fixture mocks/assertions, proper source-plan consistency, real expiry testing without weakening immutable intent, timeline reachability during bounded GC, and the typed status boundary. A frontend test's inappropriate backend runtime import initially failed erasable-only frontend typecheck; it was replaced by the pure encoding contract, with backend decoding separately tested.

The pre-existing backup assertion expected `selection_invalidated` for an unavailable superseded agent report. The production service is byte-identical to the baseline (`largeTenantUsersReports.ts` SHA-256 `51ad7bf7a7c9f6d8ef01db1cba8e3f4a4a14400128e181e8911ce8c2658d329e`) and already returns `usage_report_unavailable`. The fixture now strictly asserts that unchanged code **and 404 status**, rather than changing agent behavior or weakening the rejection.

## Autonomous Decisions / Decision Needed

Used the direct two-table evidence flow, existing source attempts/recovery and current schema only. Preserved current provider/agent contracts. Kept historical metrics stable while exposing current source freshness separately. Used backend SQL for full-set suggestions and counts, not frontend page sums. No material architecture/scope/authorization decision remains for the parent.

## Environment actions / cleanup

Only campaign-owned disposable project databases (`agentcontrol_test_*` and existing isolated restore fixtures), containers/internal networks/volumes and offline fixture images were created. Each SQL owner removed its exact workload/Postgres containers and volume; no broad pruning or unrelated directory deletion was used. After identity capture, all eight exact fixture operator image tags were removed without force. Receipt `artifacts/office-phase01-cleanup-receipt.json` verifies zero remaining owned containers/volumes/networks, unchanged baseline ID, `desktop-linux`, running `seha-app-1`/`seha-postgres-1` and preserved `seha_data`. Baseline and unrelated images/resources are retained. Protected `seha`, `agentcontrol`, loopback `http://localhost:3002` and configured `https://mgzftq2n-3002.euw.devtunnels.ms` were not changed.

## Residuals / Next Preconditions

No known phase-01 implementation failure remains. The following are **not_run / phase-owned elsewhere**, not passed checks or runtime acceptance gates:

| Scope | Existing containment and signal | Numeric trigger / owner / fix-forward |
| --- | --- | --- |
| Phase 02 Office UI/browser journeys | Existing authenticated selected reads, explicit invalidation/null/status/payload bounds; backend and existing detail/transport tests pass. | Phase 02 owner must repair **any (>=1)** incorrect/mixed/agent-dependent Office browser result when implementing the planned browser cases. |
| Phase 03 capacity, nonempty Office backup/restore/current-installation fixtures and aggregate/browser checks | Existing isolated fixture safeguards, current schema/accounting/grants/backup keys, maintenance restore review, source epochs and tested local recovery/clear contracts. | Phase 03 owner must attempt all planned owners; **>=1** leaked/restored superseded identity, wrong count, schema/byte-accounting discrepancy or unmet bound triggers repair and exact affected-owner rerun. |
| Phase 03 authorized local reset/deploy, ordinary sign-in automatic first-run sources/Office and real-provider/browser proof | Existing auth/provider permissions/roles, automatic source synchronization and Office catch-up; no Office CSV/inventory/admin-session/enable prerequisite. Unavailable derived evidence is explicit and agent/unaffected flows remain supported. | Parent/phase 03: reverify context/project/service/volume/database/origin/candidate before mutation. **>=1** failed ordinary first-run journey or Office error remaining after **two 30-second recovery ticks** with admissible saved sources triggers inspection of `office_derivation_failed`/checkpoint/head fences and a scoped fix-forward. After successful reset omit `DbReset`; inspect uncertain reset outcomes instead of replaying. |

Phase 02 should use the authoritative types/transport, one selected query across panels, complete suggestion counts and frozen person facts; preserve the separate agent defaults/URLs. Phase 03 must not treat these isolated SQL results as live-provider/deployed proof. The parent remains owner of campaign state and eventual deployment/production-hardening classification.

## Phase 03 coupled qualification addendum

The original proof above remains historical. Phase 03's complete 100,000-row
journey exposed repeated whole-source alias aggregation and whole-group/coverage
rescans. The current owner now uses bounded indexed source matches, direct
group-indexed people pages, and the existing header's complete coverage finalized
once under the fenced staging lease. Published coverage/provenance/facts remain
immutable; `database.ts` grants only `UPDATE(coverage)` for this staging
finalization. Group IDs generated by SQL are included in generation charges.
No second aggregate owner, provider, scheduler, schema migration or runtime gate
was added.

Current schema fingerprint:
`8e807119ce6155f320b0c91a6a151770827743a605ed04d0a10393938800458a`.
The unchanged 600-second scale command initially timed out; subsequent complete
pagination passed but a fixture's per-small-group selection capture hit existing
admission. Reusing one selected context repaired the fixture without raising
budgets. Scale 03 passed **86 tests / 2 files**, every **100,000** identity, and
backend typecheck in the existing owner, root
`artifacts/large-tenant-data-platform/96bfae2be7c44fa2937b6ae164d787e4`.
The test command took 444,934ms. Peak heap/RSS were 89,114,776/206,479,360 bytes;
maximum SQL result batch 250, parameters 165,936 bytes, response 68,360 bytes.
Actual EXPLAIN used `office_person_group`.

Measured Office charges were 65,109,025 bytes; physical person relation
115,965,952 bytes plus 81,920 header bytes. The representative 366-point
extrapolation was 23,829,903,150 charged / 42,473,521,152 physical bytes, below
unchanged 8 GiB generation and 64 GiB tenant budgets. A 367-day inclusive leap
calendar upper count extrapolates to 42,589,569,024 physical bytes. This is
representative synthetic capacity, not universal maximum-width data or live
provider qualification.

The current-schema restore owner also passed **7 tests / 2 files** and
typecheck, root `artifacts/large-tenant-data-platform/ee3f7b4be4be4d5abf5156fff42f7cb4`,
with nonempty frozen history after original source collection, revoked old
authority, source-clear/correction fences and accounting. A first fixture attempt
correctly rejected old restored session epochs; fresh read identities now use
the actual renewed epoch without changing revocation. All referenced scale/restore
projects above and failed predecessors were cleaned by their exact owners.
Final current SQL/aggregate/browser/compiled-first-run and parent deployment
evidence belong to the phase 03 handoff, not this historical phase status.

### Current phase 03 schema/qualification addendum

The current source is fingerprint
`3d4e39268129fe79f85b4d58e20091f921b2cc7ffc34c0828abd98a3b86c4b84`.
The existing Office evidence guard validates INSERT generations set-wise once
per bounded statement using transition rows, with whole-statement rollback for
a mixed staging/published batch. Header/UPDATE/DELETE immutability, leases,
epochs, narrow coverage-only staging grant, semantic no-op provenance and
accounting remain enforced. The current schema has the same 106 tables/80
functions and 109 triggers; no aggregate owner/store, migration or runtime gate.

Current Office/coupled SQL passed **945 / 20 files** plus typecheck at
`artifacts/large-tenant-data-platform/430c543eeb084af491d11049ed4885da`.
Current report-source-scale passed **87 / 2 files** plus typecheck at
`artifacts/large-tenant-data-platform/ed7274cb99f14aa59cc001e246e1b169`;
100,000 identities/pages, capture 112,142.52ms, people reads 163,848.50ms,
peak heap/RSS 86,593,784/205,307,904 bytes. Persisted/charged sizes and
366/367-point extrapolations equal the prior representative receipt above.
The statement guard is not claimed to accelerate end-to-end capture; unchanged
120s case/600s command deadlines remain falsifying assertions. Earlier receipts are
historical. Final software/browser/compiled deployment and actual provider/live
proof remain owned by phase 03 and its parent continuation.

### Phase 03 current indexed-read qualification

The owning reader now pages group metadata before indexed full-group metrics
and champions; participation sorting still measures every matching full rate.
Existing authenticated people cursors retain first measured counts plus the
canonical SQL label/exact identity, seek the same index forward/backward and
validate the ordinary identity/query/group/selection/frozen-root fences.
Numbered pages still count and use their exact offset. Current directory
admission requires nonempty UPN; absent display names use that fallback.
No new schema/index/endpoint/store/compatibility owner was needed.

Current SQL **947 / 20 files** plus typecheck passed at
`artifacts/large-tenant-data-platform/a2f24122b7ef4ed4a81cc2649cb4289e`.
Current scale **89 / 2 files** plus typecheck passed at
`artifacts/large-tenant-data-platform/95802f940e124d74a8c1ab762b0b2608`:
100,000 identities, capture **113,786.83ms**, 99,000-person ordinary paging
**6,936.55ms**, actual existing-index ROW seek, heap/RSS
**87,612,576/208,109,568 bytes**. Charges/storage/366–367-point footprint and
current `3d4e3926…4b84` fingerprint are unchanged. The former draft's “180s
people” description was inaccurate: current partitions each have 120s and the
whole command 600s, unchanged. Prior receipts remain historical; exact final
aggregate/compiled/browser and parent live proof are recorded in phase 03.

### Phase 03 current retained restore and automatic-first-run proof

The final reader/schema implementation remains fingerprint
`3d4e39268129fe79f85b4d58e20091f921b2cc7ffc34c0828abd98a3b86c4b84`.
Current nonempty isolated restore/reopen passed **7 / 2files** plus backend
typecheck at `artifacts/large-tenant-data-platform/92d4bb0413fd468286a0b4cd8eec4eb2`,
including retained Office facts after original source retirement, provenance,
counts/isolation, rejected old authority, clear/correction fences and accounting.

Compiled `fresh-installation-current` passed at
`artifacts/large-tenant-data-platform/57a86518881541c3a186a1ddc22b20dd`.
Both ordinary **DataSyncService.automaticRefresh** source admission orders
published Office before inventory or agent imports, each with3synthetic provider
calls and3paid/2active people. Recovery-only Users revision and compiled restart
each proved two idle ticks with zero provider recopy. The exact safeguarded
`ac-ltdp-install-f02204b30547` resources/state/images were cleaned; seha was
untouched. Public Office HTTP/types/provider/reconciliation/accounting owners
remain unchanged; final software/browser and actual parent deployment/provider
observation are recorded in phase03, not inferred from fixture readiness.

### Phase 03 final current-source qualification addendum

The final1,021-input candidate manifest is
`fdc06bd67161b219c5e356e2a10ecc995709f6f16552611c5b11ca0ca7aaf118`;
the current3d4e…4b84 schema and Office runtime qualified by SQL947/20 and
scale89/2 are unchanged by later fixture-only lifecycle/browser repairs.
Final nonempty restore05 passed7/2 plus typecheck at
`artifacts/large-tenant-data-platform/1c62a0ae93a747f9bec0b30cbd2ad44e`.
Final compiled automatic-first-run/reset/restart/reopen/recovery fresh06 passed
at `artifacts/large-tenant-data-platform/9e7cc9bb2c174ee8afe5515b18fdcab6`;
all1,021common source hashes match exactly. Its exact synthetic resources and
images were cleaned; no seha mutation occurred.

Final mandatory CheckOnly06 passed4/4, backend9,373/292files and
frontend5,564/128files, at
`artifacts/software-checks/106a354a52824916afe6ecc69c1b45ac`.
Original phase01 evidence remains historical to these later changes. Exact
final combined browser/cleanup and parent-owned deployment/provider/ten-minute
observation receipts are owned by phase03; fixture/software results are not
live-provider proof and do not complete the deployment_pending phase.

Final Browser04 now passed focusedOffice32/32 and all32Office-owned cases in
the full841passed/17intentional-skipped aggregate, zero unexpected/flaky.
Packaged restart/native9responses/1active user/2writes passed unchanged.
Phase03 records root `daa929cb5ca04d98b71996f2a6d7d459` and exact final cleanup:
43owned projects, zero remaining resources/tags, protected seha/baselines/
unrelated Redis preserved. Only parent deployment/provider/live observation is
pending; phase01's original evidence remains historical.
