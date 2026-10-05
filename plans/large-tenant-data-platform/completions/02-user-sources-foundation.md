# 02 — Dormant user-source foundation completion

## Scope and result

Position **2/9**, historical prompt `02-users-and-reports-cutover.md`.
Status: **complete** within the dormant phase scope. Focused verification and
all five independent aggregate software commands passed. The existing frontend
bundle warning and later production/capacity evidence remain explicit below.
This is a dormant backend, not an activated users/report cutover.
Parent acceptance and campaign-ledger advancement remain parent-owned.

Implemented bounded directory/SKU discovery, exact-identity verification,
streamed D30 app activity, SQL evidence and publication, licensing/activity
queries, selected pages/counts/summaries/facets/plan children, and targeted
people/cache composition. The implementation has executable domain goldens,
runtime-role PostgreSQL tests and 1,000/10,000-user measurement receipts.

**No predecessor was deleted.** No live route/writer/handler/producer/default
instance was registered, no frontend or existing live wire contract was changed
by this worker, and no old application data was converted or copied into the new
tables. Existing runtime remains the sole authority through 02A. Official report
ingestion/history/facts/combined SQL/agent usage/export producers remain 02A's
work, followed by 02B's single activation and deletion boundary.

## Implemented contracts

### Provider, stage, evidence and publication

- `UserSourceProvider.refresh` and `refreshSources` directly execute the new
  implementation. The latter settles at most two independently successful
  sources, validates their shared identity/session/token mode, and reads SQL
  status/count metadata. One failed source does not erase the other good source.
- `UserSourceStages.execute` wraps the accepted `DataGenerations.execute`,
  requiring principal scope, `directory`/`app_activity`, selector `complete`,
  schema version 1, fixture/data-sync job identity, captured session epoch and
  a deadline no longer than 30 minutes. The independent 20-second heartbeat,
  60-second lease, abort signal, reservation, job, principal and scope fences
  remain owned by 01, not a second competing lease implementation.
- Nonfixture publication requires
  `completeJob(client, {source,generationId,jobId,runId,rows,bytes})`.
  Head publication, successful source-attempt metadata and actual source-job
  completion occur in the same writer transaction. Tests insert real synthetic
  data-sync job/run rows; a throwing completion callback rolls back the new head
  and completion count. Shared Users jobs must not finish while their other
  source is still collecting.
- Authorization is a mandatory caller callback before collection and before
  publication. There is no permissive token/auth default. Directory retains
  `User.Read.All`/`LicenseAssignment.Read.All`; app activity retains
  `Reports.Read.All`, with the corresponding provider-role/capability decisions
  bound by 02B. Error/status metadata preserves permission-required,
  waiting-authorization, cancellation and failed-attempt distinctions.
- Catalog observations are bounded to 1,000 SKUs/200 pages. Directory pages are
  at most 100 rows/16 MiB; catalog JSON at most 2,000,000 bytes. Discovery uses
  at most 20 SKU predicates and 1,000 pages; exact verification at most 20
  identities, an 8,192-character URL and 6,000 pages. Shared evidence limits
  remain 10,000 pages/5,000,000 wire rows and 100,000 unique source users.
- Validated Graph paths/origins and continuation filters cannot change between
  requests. Repeated continuation tokens and query members live in SQL, not
  growing process Sets. Identical overlapping directory/SKU observations
  coalesce where allowed; conflicting facts, inconsistent totals, incomplete
  queries and duplicate pages fail without replacing a preceding good head.
  CSV duplicate identities intentionally remain separate ambiguity evidence.
- `identities(lease, values)` accepts at most 250 normalized inputs at a time,
  with SQL deduplication and a 100,000-identity ceiling.
  `verificationBatch` processes at most 250 pending identities and returns at
  most 20 unknown ones; known identities and negative verification are persisted.
  Synthetic report-like inputs exercise this boundary without an old report
  getter. Evidence parameter bytes are charged to the generation reservation,
  including repeated member inputs conservatively.
- Requests time out after 15 seconds, with at most three attempts for
  429/500/502/503/504 and explicit Retry-After support through 600 seconds.
  No DB client/transaction spans network/backoff/CSV waits. Four pool slots and
  reserved renewal capacity remain unchanged.
- `streamAppActivity` uses installed `csv-parse`, strict incremental UTF-8,
  16-KiB slices and backpressure. Limits are 64 MiB wire bytes, 100,000 data
  rows, 64 KiB per record, 1,024 characters per supported field/header and 320
  per UPN. Named v1 headers and D30 are validated; reordered/added columns are
  accepted, malformed dates/UTF-8 and overflow rejected. Signed downloads use
  the existing two permitted origins/paths without forwarding Graph credentials.
  Empty reports, blank dates and ambiguous identities remain unknown, not zero.
- Directory facts and service-plan children are typed relational records, at
  most 1,000 plans per user. Evidence digests include child facts. Original
  submillisecond assignment timestamps survive in bounded scalar residuals.
  Batches enforce both 250 rows and 1,048,576 encoded parameter bytes; residual
  JSONB remains at most 262,144 bytes. No full-domain arrays are reconstructed.

### SQL reads, semantics and people

- `UserSourcesRepository.capture` uses additive
  `DataSelections.captureWith`. Scalar source metadata, dependency roots,
  context and evaluated-at instant are captured on one REPEATABLE READ client.
  Existing `capture` delegates without weakening pre-snapshot admission locks,
  auth, quotas or invalidation. Public selected reads all use the same
  `DataSelections.read` callback for rows/counts/summaries/facets/dependencies.
- `user_sources` is a validated principal/token-mode mutable-dependency root,
  accompanied by zero to two generation roots. No permissive validator stub
  exists. Immutable `user_source_read_contexts` retain only two scalar source
  metadata records. Normal replacement preserves pinned rows and metadata;
  people changes invalidate their root epoch. Expiry is bounded by source,
  cache and upcoming freshness transitions without rejecting already-stale data.
- Public dormant reads: `page`, `exact`, `plans`, `facets`, `people`,
  `projectPeople`, `refreshStatus`; writes: `savePeople`.
  Composition: `userSourceFactsSql`, `userSourceSqlParameters`,
  `metadataInRead`, `countsInRead`, `summaryInRead`, `contextInRead`, `read`,
  and `userSourcePeopleInRead`. Low-level helpers require the already-validated
  selected callback client; they are not plain read-committed entry points.
- Filters: search, exact nullable company/department, entitlement
  (`paid_active`, `paid_inactive`, `no_paid`, `unknown`), service state and
  activity (`active`, `inactive`, `unknown`). Sorts: name, UPN, company,
  department, service and activity, ascending/descending. Invalid keys/values
  fail; search/name normalization is NFKC/lowercase. C-collated keysets use
  immutable ID ties and nulls last independent of direction. Reverse pages
  retain display order.
- Page size defaults to 50, maximum 100; no offset/all switch. Plan children
  are separately paged. Company/department facet pages omit their own selected
  facet filter while retaining other row filters and facet search; null is an
  exact separate option. Page totals mean the authorized unfiltered checked
  cohort, not tenant headcount; filtered counts/summaries honor row filters.
  Checked source count is separately named. Response bytes are bounded to 1 MiB.
- Licensing preserves active paid provisioning, assigned inactive paid features,
  verified no-paid entitlement and unknown evidence. `no_paid` does not assert
  free/basic Copilot Chat access. Failed latest directory attempts retain
  preceding rows as partial but make current licensed/adoption scalars unknown.
  App matching requires one report identity to one directory person, including
  object-ID/UPN alias collisions. D30 is inclusive refresh-minus-29 through
  refresh; blank/missing/stale activity is unknown. No official-report metric
  fields, fabricated zeros or placeholder report values were introduced.
- Exact object-ID input is normalized and rejects more than 100 inputs before
  querying, including duplicates before deduplication. SQL starts from requested
  IDs and scoped tenant/principal/token-mode joins; it does not enumerate other
  directory users.
- Person identity precedence compares source observation, cache check and last
  conclusive check. Later lookup failure overlays its status/error/expiry but
  cannot revive identity data superseded by a newer 404. Resolved/not-found/
  failed TTLs remain seven days/one day/15 minutes.
- Dormant `savePeople` requires a transactional caller fence, preserves existing
  cache semantics and invalidates all matching token-mode source roots.
  `projectPeople` checks tenant before lookup, accepts at most 100 caller rows,
  batches at most 300 referenced identities into exact reads of at most 100,
  and discards stale preexisting overlays. 02B must activate cache save/clear
  invalidation together with new readers.
- Existing cursor/error outcomes remain: invalid cursor 400, invalidated
  selection 409, serialization conflict 503 `data_read_conflict` with
  `Retry-After: 5`, without silent replay. Writer/renewal isolation is unchanged.

## Schema, grants and source integrity

Appended migration **48** only. New tables:
`user_source_attempts`, `user_source_queries`, `user_source_query_members`,
`user_source_skus`, `user_source_identity_inputs`, `user_source_read_contexts`.
Five guard-trigger instances protect stage/evidence writes. New indexes:
`user_source_attempt_scope`, `user_source_identity_pending`,
`directory_user_entitlement`, `directory_user_upn_order`,
`user_source_generation_attempt`. The root constraint adds `user_sources`;
no legacy source table is dropped.

The final verifier checks exact column types/nullability, table/FK/trigger/index
and root-constraint presence, enabled guards and least-privilege runtime grants.
Immutable evidence/context tables do not receive UPDATE; runtime receives no
TRUNCATE. Fresh initialization applies all migrations and verifies as the real
runtime role. Tests reject unauthorized mutations and detect intentional schema
type drift inside a rolled-back operator transaction.

Migrations 1–47 retain the frozen combined SHA-256
`38127337787c35454a0d972fb132ff60f2326b1f9b474a5e992bb6bd087a9438`.
Migration 47's SQL digest remains
`58599c9c110adacae6f2dd5b199cb7594932c4b6d55ab1a4ee1c98e3fe970957`.
Unchanged implementation hashes:

- `dataGenerationSchema.ts`:
  `e30324f1794da8f53460fe3e0841af9303b59ea0189bcc5fedd65c1fb0329b2a`.
- `dataGenerations.ts`:
  `a0ac23e0eb893b4d5d11bcbbaa024ef72b11c48c953fc15c13c5c53e2b755273`.

## Decisions and changed-file ownership

Autonomous decisions followed existing contracts: keep independent sources
independent; use SQL for query/member/exact-work evidence; retain ordinal CSV
rows to preserve ambiguity; add a validated mutable source root and immutable
scalar selection context; reuse existing pure Graph parsers rather than change
live semantics; expose composable source SQL without inventing report metrics.
Timestamp residuals preserve original assignment precision. Conservative evidence
charging prevents unmetered SQL work. No architecture alternative or live
compatibility path was introduced.

Phase-02-owned additions:

- `backend/src/db/{userSourceSchema,userSourceStages,userSources}.ts`
- `backend/src/services/{userSourceProvider,userSourceRecords,largeTenantUserSources.test}.ts`
- `backend/src/types/userSources.ts`

Phase-02 edits to existing/current-campaign files:

- `backend/src/db/{schema,schema.test}.ts`
- `backend/src/services/dataSelections.ts`
- `backend/src/services/copilotUsageGraph.ts` — exports of existing pure helpers
  only; no changed parser body or live caller.
- `backend/scripts/{database,largeTenantFixture,largeTenantFixture.test}.ts`
- `scripts/large-tenant-tests.ps1`
- `docs/{record-data-foundation,copilot-license-usage}.md`
- This exact completion record.

Cross-root checks: backend producers/consumers were traced through live source,
people, report and route code; no new dormant module is imported from live
routes/server/orchestration. Scripts expose the exact required focused suite and
conditional schema grants; existing deployment gate is unchanged. Documentation
records source composition and activation/deletion consumers. Root manifests,
lockfile, Dockerfile, Compose/deployment configuration, `.npmrc` and `AGENTS.md`
were not edited. All nine prompt hashes match the parent ledger; neither ledger
nor prompts were edited.

Frontend production files and existing wire types are unchanged. Parent
independently fixed the previously carried observer **test** race in
`frontend/src/App.session.test.tsx`; this worker made no frontend edit. Its
SHA-256 is
`0428f6716a14dd5207afdc48f3e203b0df5ecbcef361ee0a9be31fe6bd3cc1c9`,
included in the aggregate candidate. Parent's final 01 addendum records the
deterministic reproduction, four focused passes and 2,345-test frontend pass.
Those receipts close that specific residual, not the earlier failed aggregates.

## Verification receipts

Every execution below used the actual owned fixture wrapper with synthetic
settings, no ports/external providers and existing dependencies:
`pwsh -NoProfile -NonInteractive -File ./scripts/large-tenant-tests.ps1`.

| Command / receipt | Result |
| --- | --- |
| `-Suite user-sources-foundation`, immediate first coherent slice | **393 tests passed**, backend typecheck passed. `artifacts/phase02-first-proof.log`; run `d61b6d79b9e643e88f7ed73d03f7a7d0`. The first falsifying assertions were licensing truth and exact lookup SQL reading only requested identities. |
| `-Suite user-sources-foundation`, final | **427 tests passed**, backend typecheck passed. `artifacts/phase02-focused-qualified.log`; run `9d4e105116474c08a517f623b28ed2c8`. Six exact plan suites, including 36 new dormant-domain cases. |
| `-Suite foundation`, final | **96 tests passed**, backend typecheck passed. `artifacts/phase02-foundation-final.log`; run `5ec398e291cd492dbc75340b6c349fb8`. Preserves earlier generation, selected-read, export, schema and runner contracts. |
| `pwsh -NoProfile -NonInteractive -File ./scripts/local-deployment.tests.ps1` | **1,291 orchestration assertions passed**. `artifacts/phase02-orchestration.log`. Mocked ownership/failure safeguards, not a production deployment. |
| `-Suite all` | **All five commands passed**, exit 0; `result.json` has no failures. Run `25c33e01d51d4ce08bfbd724acdcb51c`, `artifacts/phase02-all.log`. Exact results below. |
| Editor diagnostics, `git diff --check`, prompt hashes, candidate comparison | **Passed**. All nine prompts match the parent ledger; all 18 recorded source/docs/parent-test hashes match the immutable aggregate candidate and current implementation. |

Aggregate commands ran independently against that one candidate:

| Command | Actual status |
| --- | --- |
| `npm run test --workspace backend` | Exit 0; **4,343 tests**, 164 files passed. |
| `npm run test --workspace frontend` | Exit 0; **2,345 tests**, 77 files passed, including the parent's observer-test repair. |
| `npm run typecheck --workspace backend` | Exit 0. |
| `npm run lint --workspace frontend` | Exit 0. |
| `npm run build` | Exit 0; backend/frontend production builds passed. Existing **829.63-kB** frontend JavaScript chunk exceeds the **500-kB** warning threshold; warning retained, not suppressed. |

This is a genuine combined **5/5 software aggregate** for the current candidate,
not the earlier pre-repair candidate's result and not a claim that the actual
07 deployment gate or production deployment ran.

The focused suite is exactly:

```sh
npm run test --workspace backend -- src/services/largeTenantUserSources.test.ts src/db/dataSync.test.ts src/services/copilotUsageGraph.test.ts src/services/copilotUsage.test.ts src/services/copilotServicePlans.test.ts src/services/savedAgentPeople.test.ts
npm run typecheck --workspace backend
```

Goldens cover independent success/permission failure, retained good heads,
conflicting duplicates and counts, SKU/exact-input batches, Unicode/null/tied
keyset replacement, self-filter facets and exact summaries, principal/tenant
isolation, source partial/stale/empty/expiry, original timestamp precision,
cache/conclusive/404 precedence, caller pages, the 1,000-plan ceiling, malformed
and exact-limit CSV/UTF-8, streaming backpressure/cancellation, real job completion
atomicity, stage/reservation/evidence denial and schema grants.

The long-wait test uses controlled interval advancement with **real PostgreSQL
renewals awaited at each step**: 600-second Retry-After plus 60-second idle
prepublication validation produces exactly 33 successful renewals. This is not
a claim of a 660-second wall-clock process/restart test. Cancellation is tested
during provider wait, validation and principal revocation, with no head advance.

### Retained failed attempts and repairs

Failed receipts are not deleted or relabeled as passes:

- `phase02-ingestion-proof.log`: multi-table PL/pgSQL guard referenced fields
  absent on another table, plus TypeScript unused-import/CSV overload errors.
  Table-specific nested guards and correct parser-options typing repaired these.
- `phase02-query-proof.log`: tests passed, typecheck found an unused import;
  removed it. `phase02-query-qualified.log`: misplaced `refreshSources` insertion
  caused syntax failure; moved it outside the refresh callback.
- `phase02-expanded-proof.log`: fake intervals outran asynchronous SQL renewal
  completion (13 observed versus 33 expected). The test now advances one
  20-second tick and awaits its real renewal, preserving the exact assertion.
- `phase02-foundation-regression.log`: schema mocks lacked the new seventh
  verifier result. `phase02-foundation-qualified.log`: the new SELECT formatting
  violated the existing read-only verifier assertion. Updated exact mock counts,
  added missing/invalid schema and seventh-query failure cases, and retained the
  existing SELECT assertion. Final foundation/backend passes cover the repair.

### Measured SQL and batch bounds

Actual runtime-role `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` receipts from the
final focused run are retained in the log and `artifacts/phase02-measurements.json`.
These are exact-ID observations, not a full-capacity or every-filter SLA claim.

| Users staged | Exact rows returned | Maximum encoded parameters | Tracked batch residents | Charged staged bytes | Exact-read execution |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 1 | 142,105 bytes | 2 | 1,055,292 bytes | 0.024 ms |
| 10,000 | 1 | 142,105 bytes | 2 | 10,552,920 bytes | 0.017 ms |

Both plans use `directory_user_rows_pkey` for the generation/exact-identity
predicate, with one actual directory row, respectively three/four shared hit
blocks and no temporary reads/writes. The row/parameter evidence is bounded as
domain size grows; tracked batch residents are instrumentation, not heap-peak
proof. Fixed-budget capacity/working-set qualification remains 06.

## Authorized environment and evidence

The wrapper verifies baseline manifests, then copies the candidate source into a
new immutable image; no dependency installation occurred. Aggregate image:
`agent-control-ltdp-25c33e01d51d4ce08bfbd724acdcb51c-operator:local`,
ID `sha256:9ed90a7270874917c5e65d86d22f6cd73f651593e2cbab5db6cb5ae8ff242711`.
All 18 source/docs/parent-test hashes match both that image and the current
implementation (`artifacts/phase02-source-manifest.json`,
`artifacts/phase02-candidate-verification.json`).
The protected baseline remains
`sha256:78f3cb9fa91e7a64960699899d8fe2eb56bdd77c8ee56490f1f5255855b3c235`.

Node/PostgreSQL limits stayed 1,536/1,024 MiB, with disk-backed owned PGDATA/WAL/
temporary storage and no external-provider credentials or port publication.
Diagnostics were captured before teardown under
`artifacts/large-tenant-data-platform/<run-id>/`.
Final focused observed cgroup memory peaks were 811,884,544 bytes workload and
528,166,912 bytes PostgreSQL; foundation peaks 418,975,744 and 166,875,136 bytes.
The aggregate recorded 224 state captures per container: observed memory peaks
were 1,156,784,128 bytes workload and 544,813,056 bytes PostgreSQL.
Observed `oom_kill` counters were zero and Docker `OOMKilled` false. Workload
exit was 0; PostgreSQL was healthy/running when captured, then removed.
These are observed cgroup peaks, not invented V8 heap peaks.

All **15** completed fixture projects, including the final aggregate, were
checked by exact Compose project labels: **zero remaining containers, networks
or volumes** (`artifacts/phase02-cleanup-verification.json`).
Aggregate diagnostics are retained in `artifacts/phase02-aggregate-diagnostics.json`;
focused diagnostics in `artifacts/phase02-focused-diagnostics.json`. Candidate
images and sanitized evidence are retained. No broad kill/prune, retained duplicate
recreation/deletion, production configuration/secret inspection, production
reset/deployment, commit/push/branch or nested agent occurred.

## Exact 02A and 02B handoff

02A can directly instantiate the dormant provider/stages/repository using the
existing pool and selection secret, without registering them. It must:

1. Stage bounded positive-activity report identities through `identities`, then
   use `verificationBatch`/`verified` via the provider. Do not adapt an old
   full-report getter or copy application data.
2. Compose **actual** typed report facts with `userSourceFactsSql` and scalar
   metadata on the same supplied selected client/evaluated-at instant. Its
   history-aware context must retain the validated source/mutable roots as well
   as its tenant-history root. No null/zero report placeholders.
3. Preserve licensing/ambiguity/partial/provenance/count bases from these goldens
   while adding all report thresholds, historical cohorts, targeted agent usage
   and export algorithms. Use 01's `context.read` for every export source batch.
4. Freeze complete response/query/export contracts and executable combined
   goldens before 02B. Rerun this exact `user-sources-foundation` suite in addition
   to 02A's prescribed suites; append future migrations, never rewrite 1–48.

02B's activation/deletion inventory (also in `docs/record-data-foundation.md`):

- `services/copilotUsage.ts`: users/refreshUsers, old source collectors and
  report composition; `services/dataSync.ts` Users orchestration;
  `routes/{copilotUsage,dataSync}.ts`; existing copilot/data-sync wire types.
- `services/savedAgentPeople.ts`: full-directory directoryPeople/read/project;
  `services/agentPeople.ts`: full-directory exclusion and cache writes;
  `services/unifiedAgents.ts` and `routes/unifiedAgents.ts`: read/project/detail
  enrichment. Until 04, inventory uses bounded caller pages/exact-ID batches,
  not a whole-directory Map. Replace all cache save/clear hooks with root
  invalidation atomically before new reads become authoritative.
- `routes/officialUsage.ts`: licensing-cohort reads and CSV directory-hash
  checks. 02A first supplies combined SQL/export algorithms; 02B removes old
  whole getters and CSV routes/functions/Blob consumers.
- `db/dataSync.ts`: old publishDirectory/publishAppActivity/getUserSources/
  getDirectorySource and snapshot codecs; `copilot_usage_snapshots` and
  `copilot_usage_source_state`. Historical migrations remain immutable;
  fresh-data guarded removal belongs to 02B.
- `backend/scripts/{database,backup}.ts`: cleanup/grants/restore filters;
  data-sync persistence tests and synthetic browser/restart fixtures must move
  with the authority transition, not wait for 05 cleanup.
- Frontend `api/client.ts`, `App.tsx`, `usageInsights.ts`, `CopilotUsersView`,
  `CopilotServiceDetails`, `UserDetailModal`, plus 02A/02B's enumerated report,
  history/import/export consumers. Existing full-collection UI behavior is
  deliberately unchanged until that atomic producer/consumer cutover.

## Remaining campaign obligations and production continuation

No phase-02 implementation is deferred to an environmental residual. External/
later-phase validation remains explicitly not run here:

| Evidence / limit | Containment, signal, numeric trigger, owner and continuation |
| --- | --- |
| Real Microsoft tenant/network/permission canary | No external credentials/provider contact and no live activation in 02. 02B binds existing admission/auth/permission guards; 07 uses the authorized deployment's real canary. Any mismatched expected count, changed continuation/filter, unauthorized request or incomplete source (threshold **1**) must fail the attempt and retain the prior good head; owner 07 with 02B integration repair, fix forward without fabricated metrics. |
| Wall-clock long idle, process death/restart, browser and restore integration | Controlled real-SQL heartbeat/cancel tests are passing, but not a wall-clock crash/restore proof. Owners 02B/05/06, final 07. Keep staged generations unreadable and expired ownership fenced; **1** stale publication, unauthorized read or job/head mismatch triggers immediate affected-publication containment and root repair/retest. |
| 100k/full-capacity memory and every-filter plan proof | 1k/10k exact-ID evidence is not a 100k capacity pass. Owner 06, final 07: fixed Node/PG **1,536/1,024 MiB**, batch **250 rows/1 MiB**, residual **256 KiB**, page/exact **100**, two batch residents. **1** OOM/limit breach/unbounded scan-result materialization triggers bounded algorithm/index repair, never a memory bump or weaker semantic assertion. |
| Existing frontend bundle warning | Build passes with **829.63 kB** JavaScript against the existing **500-kB** warning threshold (gzip 235.50 kB). No frontend runtime change or threshold suppression in 02. Owners 05/06, final 07, preserve browser/network performance observation; crossing the existing warning or regressing measured browser performance triggers targeted bundle/query-consumer repair rather than disabling diagnostics. |
| Production reset/deployment and official gate | Not run and not authorized in 02. Only 07 may reverify `seha` localhost:3002 and perform the authorized initial DB-only reset, preserving all configuration/sign-in/secrets/backups/port/public URL. Require the real gate **5/5**, then observe and fix forward. **1** gate refusal remains an explicit open continuation; no bypass, fake success or deployment of half-activated unsafe publication. |

The campaign must continue through 02A/02B/03/04/05/06/07 and converge on the
authorized production outcome. This worker neither invokes that deployment nor
uses deferred real-endpoint/capacity evidence as permission to leave source
implementation incomplete or stop the campaign.

## Parent acceptance

Parent inspected schema, provider/stage, SQL selection/query/people, additive
contracts and cross-root dormancy, verified all 18 candidate source/documentation
hashes, and independently reran `-Suite user-sources-foundation`: **427 passed**
plus backend typecheck. Evidence: `artifacts/phase02-parent-focused.log`, owned
run `c75a48c8daa248919e26b609075db1d0`. Editor diagnostics and diff hygiene passed.

Accepted **complete**. The same-candidate 5/5 aggregate includes the parent's
observer test repair; prior failed attempts remain historical failures. Phase 02A
may proceed with the frozen contracts above. No production action occurred;
readiness on port 3002 remained HTTP 200.
