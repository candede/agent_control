# 01 — Record foundation completion

## Status and boundary

**Completed and verified, 2026-09-28.** Phase 01 of nine is implemented. No
production deployment/reset, provider request, compatibility reader, conversion,
dual write, route registration or scheduler activation occurred. Existing domain
storage remains the live authority. The parent-owned campaign ledger, `.npmrc`
and `AGENTS.md` were not edited. No commits, branches, pushes or nested agents.

The initial falsifiable hypothesis was that two bounded appends remain invisible
until one scoped, lease-fenced head transaction publishes, while cancellation
preserves the preceding head. The initial backpressure test and subsequent
runtime-role PostgreSQL tests established those boundaries.

## Implemented schema and contracts

Migration **47** is appended. Historical migrations 1–46 are unchanged; their
combined version/checksum digest remains
`762510d30af8cececc01a9bdbd93a1c747d832008e6016a0a0abb6a323bd2814`.
Initialization, repeat migration, applied-checksum tampering, read-only schema
verification and runtime grants are tested.

| Tables | Persisted responsibility |
| --- | --- |
| `data_principal_epochs`, `data_scope_epochs` | Account/session revocation and tenant/principal/token/source/selector fences; actual nullable tenant principal with `UNIQUE NULLS NOT DISTINCT`. |
| `data_generations`, `data_generation_heads` | Immutable attempt intent, owner/version, job/run, quotas, lease/deadline/expiry, expected output revision, counts, incremental content digest and atomic head CAS. |
| `data_generation_batches`, `data_generation_pages` | Ordered replay digests, measured parameter bytes, bounded page/token digests and wire counts. |
| `directory_user_rows`, `directory_service_plan_rows`, `app_activity_rows` | Typed identities, display/normalized keys, licensing/service facts and dates, schema version/content hash, bounded residuals and relational plans. |
| `data_read_selections`, `data_generation_pins` | Authorization/query identity, evaluation/expiry, root count, revision and at most 16 typed dependency roots. |
| `data_exports`, `data_export_items`, `data_export_chunks` | Audited artifact jobs, immutable all/explicit intent, selected identities, leases, counts and ordered checksummed chunks. |

The verifier checks 14 tables, 14 foreign keys, 13 enabled custom guards,
null-distinct scope identity, 12 named indexes and least-privilege properties.
Indexes cover writer/admission/expiry, directory order/UPN/company/department,
plan user lookup, activity identity, selection admission, pin reachability and
export admission. Scope-composite foreign keys reject cross-scope payloads.
Runtime cannot update record/chunk/item content or truncate payload tables.
State/content/intent/head triggers protect mutation and publication. Runtime
grants are applied through the existing operator, not application startup DDL.

### Bounds and generation lifecycle

- Append: **250 records AND 1,048,576 encoded parameter bytes**, including UTF-8
  text Bind values and four-byte parameter length prefixes. Residual JSONB:
  **262,144 bytes in PostgreSQL's textual representation**. A producer and its
  normalized consumer batch are the only tracked batch arrays; pull is serial.
- Generation reservation: 8 GiB; logical tenant reservation: 64 GiB; source
  parent records: 100,000; future derived/canonical envelope: 200,000. The latter
  does not raise source ceilings or implement inventory domain records early.
  Plans remain relational and SQL-validated, at most 1,000 per user.
- Admission: four active ingestion streams globally, two per tenant, one per
  selector. Existing domain jobs remain responsible for queued work; no second
  generic scheduler or copied job authority was introduced.
- Page evidence: maximum 10,000 pages/5,000,000 wire rows, persistent token hashes,
  and complete expected-count reconciliation. Same batch replay is a no-op;
  changed replay or duplicate identity poisons the unpublished generation.
- Validation persists phase/key cursor/counts in slices of at most 250 parent
  keys, yields/releases its transaction between slices, and can resume. Plan
  cardinality checks read at most 1,001 child keys per parent. The generation
  digest is an incremental fixed-size chain, not a whole-generation aggregation.
- Lifecycle: staging → validating → published → retired → deleting, or
  failed/cancelled unpublished terminals. Prior good heads survive failed work.

### Publication, heartbeat and pool protocol

The common lock order is principal epoch when needed, sorted scope epochs,
output head, generation lease, then existing source job/run. Revocation, clear,
takeover and abort use the same scope/head fencing. An expired owner cannot
renew, append or publish. Source job/run state and expiry are checked in SQL.

`DataGenerations.execute` owns an independent **20-second** heartbeat for a
**60-second** lease and passes an abort signal to work. SQL checks owner/version,
scope/session epochs, cancellation, deadline and expiry; the signal is additional
protection, never publication authority. Renewal loss aborts and durably cancels.
Publication pauses/joins renewal before its terminal transaction, retains
cancellation through COMMIT, then stops the timer/listener. Cancellation after a
committed publication does not manufacture failure.

Non-fixture publication requires `completeJob` in the same transaction. Derived
publication additionally requires a domain `validateInputs` callback, acquiring
captured input scope locks in order. A newer safe input head alone does not
invalidate a still-readable captured vector.

The shared `BoundedPool` preserves the existing maximum of four connections,
five-second acquisition and 15-second statement timeout. All ordinary callers,
including existing direct `pool.connect`/`pool.query` consumers, use three
foreground slots; renewal can use the fourth. Queue length is 32. Admission
errors expose 429/503 and `Retry-After: 5`, not an unbounded wait. Promise and
callback `pg` acquisition are retained. No second unbounded application pool.

### Selections and exports

Canonical allowlisted query values and their hash are persisted. HMAC cursors
bind authorization/session/principal/tenant, endpoint, selection/revision,
query, direction and null/key/identity boundary; maximum encoded size is 4 KiB.
Directory SQL order and keyset predicates use the same explicit `C` collation.
Pages default to 50, maximum 100; exact reads accept at most 100 IDs. The entire
page envelope counts against 1 MiB. Scalar bigint counts are checked before
conversion. No all-record getter, offset API or implicit cursor draining exists.

Selections expire within ten minutes or the earlier freshness/source boundary;
explicit invalidation wins. Admission is 100 per principal/1,000 per tenant and
returns retryable HTTP 429. Normal head replacement preserves readable pinned
retired inputs. Typed roots are generation, tenant-history scope/revision and
inventory baseline/delta revision, not an enumeration of every historical set.
Future non-generation roots refuse use without the domain relational validator.

Exports persist kind, filename, query and all/explicit intent. Explicit IDs are
limited to 5,000 and read/inserted in bounded batches. Sources receive immutable
query/selection context and an async selected-ID iterator. Construction consumes
at most 250 rows/1 MiB per source batch and writes chunks ≤256 KiB under
backpressure; it never requires a whole-artifact array/string or writable app
filesystem. Existing `csvValue` formula protection is reused.

Limits are 2,000,000 rows/1 GiB, two active exports per tenant/four globally, ten
queued per tenant, 15-minute construction and 30-minute artifact lifetime or
earlier source expiry. Persisted chunks/counts/SHA-256 are read back before
fenced ready publication. Polling returns metadata only. Downloads verify scope,
expiry and checksum during iteration, support disconnect/cancel, and require
transactional started/succeeded/failed audit events. Expiry work is bounded.
Exports can retain valid roots beyond read-page TTL, never beyond their own or
source lifetime. Domain producers/routes remain intentionally unregistered.

## Semantic seeds and cross-root impact

Synthetic builders/goldens preserve enabled/warning/partial paid states versus
inactive/unknown, app freshness, unknown versus genuine zero, complete three-kind
official sets/periods, unresolved identities, report-versus-union count bases,
filtered/unfiltered counts and non-additive active-user meaning. Existing view
implementations are exercised only by tests, not wrapped into a new runtime
reader. Phase 02A still owns the full combined SQL semantic proof.

Searches across `backend/src` and `frontend/src` for `dataGenerations`,
`dataSelections`, `dataExports`, `dataConnections` and `BoundedPool` found no new
domain-module import in live routes/server/collectors or frontend. Only the
shared pool instantiation is active infrastructure; its existing consumers and
error middleware were traced and validated by the full backend/frontend suites.
No wire payload, public route, frontend shared type or API client changed, so
frontend edits would violate the dormant boundary. Existing domain readers are
not deleted until their owning atomic cutover.

### Changed files by root

- **Backend schema/admission:** `src/db/boundedPool.ts`, `dataBounds.ts`,
  `dataConnections.ts`, `dataGenerationSchema.ts`, `dataGenerations.ts`,
  `dataGenerations.test.ts`, `pool.ts`, `schema.ts`, `schema.test.ts`;
  `src/errors.ts`, `src/errors.test.ts`.
- **Backend read/export:** `src/services/dataSelections.ts`,
  `dataSelections.test.ts`, `dataExports.ts`, `dataExports.test.ts`.
- **Backend operator/fixtures:** `scripts/database.ts`,
  `dataSyncPersistence.test.ts`, `softwareChecks.ts`, `largeTenantFixtures.ts`,
  `largeTenantFixture.ts`, `largeTenantFixture.test.ts`,
  `exportReadonlyFixture.ts`.
- **Root/scripts:** `compose.large-tenant-test.yaml`,
  `scripts/fixture-diagnostics.ps1`, `scripts/large-tenant-tests.ps1`,
  `scripts/local-deployment.ps1`, `scripts/local-deployment.tests.ps1`.
- **Docs:** `docs/record-data-foundation.md`, `docs/operations.md`, this record.
- **Unchanged:** frontend, root manifests/lockfile/Dockerfile/ordinary Compose
  fixture, production configuration and parent campaign records.

## Definitive validation

All paths below are relative to the repository. Software commands ran only in
synthetic owned fixtures. No dependency install or registry probe was required.
Effective npm config and sanitized children use the approved Microsoft proxy;
the runner verifies baseline identity and dependency hashes rather than
following public URLs in the existing lockfile.

| Command | Observed result and evidence |
| --- | --- |
| `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite foundation` | **Passed:** 8 files/84 tests and backend typecheck. `artifacts/phase01-foundation-qualified.log`; run `79b4eaa38b8d4e5da7a7fc9374515d63`. |
| `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite all` | **Passed:** backend 163 files/4,295 tests; frontend 77 files/2,345 tests; backend typecheck; frontend lint; production build. All five commands attempted independently. `artifacts/phase01-all-qualified.log`; run `2cbe493129844e5eaa33e83b6c78997d`. |
| `pwsh -NoProfile -File ./scripts/local-deployment.tests.ps1` | **Passed:** 1,291 assertions, including redaction, combined failures, ownership, retained-state protection and capture/removal ordering. `artifacts/phase01-deployment-final.log`. |
| `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite export-readonly` | **Passed:** actual `/app` write refused with EROFS; built/downloaded 1,250 rows/10,709 bytes; two durable successful audit outcomes. `artifacts/phase01-export-readonly-complete.log`; run `947d677509c74663bdc91d50810274ac`. |
| `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite gate-failure` | **Expected refusal verified:** the original helper remained failed on exit 17; only the smoke wrapper returned zero. No capture/cleanup error is accepted. `artifacts/phase01-gate-failure-receipt-verified.log`; wrapper `10b64cd1a39c4b88aad1ad8c49f60f2d`, original check `eef7a01045704af09b887b610bea99fa`. |
| `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite software-gate` | **Passed 5/5** through the original helper. `artifacts/phase01-software-gate-complete.log`; check `36a50a858a014412a0e13bde0190ce73`. Superseded as exact-image evidence by the next row. |
| Exact candidate original gate, command below | **Passed 5/5:** 4,295 backend and 2,345 frontend tests, typecheck, lint, build and owned DB cleanup. `artifacts/phase01-original-gate-qualified.log`; check `ae03b49e233543b7a729e3d03671a39e`. |
| `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite capacity` | **Expected not-implemented refusal**, not capacity qualification. `artifacts/phase01-future-suite-refusal.log`; no fixture started. |
| `git diff --check`; editor diagnostics; effective `npm config get registry` | Passed/no errors; approved registry confirmed. |

Exact final candidate gate invocation:

```powershell
pwsh -NoProfile -Command '. ./scripts/local-deployment.ps1; Invoke-LocalSoftwareChecks @{Root=(Get-Location).Path;Operator="agent-control-ltdp-2cbe493129844e5eaa33e83b6c78997d-operator:local"}'
```

The final candidate is
`sha256:ec91f7b946c96a607c2978f0e7bf815cc8f69b101ecfc6132e327eab8a36af5c`.
Its 27 changed executable/config files match current source byte-for-byte before
and after the exact gate. The ordinary gate retains its pre-existing read-only
source bind mounts; no source edits occurred during this final run. The campaign
aggregate independently tests immutable image source with inherited source
mounts removed. Earlier image/source comparison identified two superseded
selection files, so that earlier image was not claimed as the final artifact.
See `artifacts/phase01-artifact-source-verification.json` and
`artifacts/phase01-final-evidence.json`.

Focused tests include 0/1/250/251 rows, UTF-8 growth, exact byte boundaries/+1,
replay poisoning, cross-scope FKs, deferred COMMIT failure, revocation/cancellation
races, expired-owner takeover, CAS failure, prior-head retention, bounded
resumable validation, authentication/cursor reuse, ties/nulls, expiry,
source invalidation, explicit-ID paging, corrupt artifacts and disconnect.
Controlled time observes 30 renewals across an append-idle 600 seconds and three
more during the validation interval; real four-connection contention is tested.
This is not a claim of a real 600-second provider/process qualification.

Measured receipt, from runtime-role SQL rather than estimates:

```json
{"contract":"generation_batch_bounds","maximumParameterBytes":1048576,"maximumBatchResidents":2,"residualBytes":262144}
```

### Repaired attempts, not hidden successes

Earlier failures remain in `artifacts/phase01-*.log`: short/full container-ID
mismatch; a trigger referencing a field absent from batch/page rows; transient
source edits entering an early live-mounted aggregate; missing upgrade-fixture
grants after migration; export timestamp skew from separate clock evaluations;
PowerShell case-insensitive variable collisions; and `tsx` CLI cache creation
under a read-only app filesystem. Repairs respectively use full IDs, table-aware
guards, immutable campaign source, the real operator grant lifecycle, one
statement timestamp, distinct variables, and `node --import tsx`.

The final response-envelope regression initially miscomputed its synthetic
UTF-8 filler (`phase01-foundation-complete.log`); corrected bytes then passed.
Outer failure receipts initially serialized a null PowerShell optional-property
expression despite real refusal; flattened exception messages now persist and
the real failure smoke was rerun. Full aggregate and exact original gate passes
above supersede these repaired attempts, not erase them.

## Existing-gate diagnostics and environment receipt

`Invoke-LocalSoftwareChecks` still invokes the real unchanged `test-all.ts`
before maintenance, app shutdown or application migration. Workloads have an
exact project-owned identity and wait for a start marker. Capture begins before
release, continues during execution, and records final available test/PG state
before explicit test removal and PostgreSQL teardown. No `--rm` loses the test
container first. Startup, OOM, nonzero exit, missing counters, capture and cleanup
failures are covered; nested primary/capture/cleanup failures remain failures.
Only safe state/cgroup fields and redacted bounded logs are persisted, not
`Config.Env` or secret-file contents. Missing counters are unavailable, never zero.

Final original-gate evidence:
`artifacts/software-checks/ae03b49e233543b7a729e3d03671a39e/`.
There are 185 captures, from `2026-09-28T12:56:44.1207150Z` through final
`2026-09-28T13:01:19.6349150Z`. Workload `4b4621b15b28…` exited 0,
OOMKilled=false, observed cgroup memory peak **1,187,856,384 bytes**;
PostgreSQL `d5f9f9f4361a…` was still running at final capture, OOMKilled=false,
peak **549,031,936 bytes**. Both observed `oom_kill=0`. Stopped-workload counters
are marked unavailable at final capture; preceding live peaks are retained.

Expected-failure evidence:
`artifacts/software-checks/eef7a01045704af09b887b610bea99fa/`.
Workload `dfc11e4fb016…` exited 17, OOMKilled=false, peak 72,228,864 bytes;
PostgreSQL `c65411652893…` remained running for final capture, peak 80,023,552
bytes; observed `oom_kill=0` for both. The outer receipt contains exactly the
expected failure, not an empty/null success receipt.

The campaign override removes only inherited test PGDATA tmpfs and verifies an
exact project-owned disk-backed volume; data/WAL/temp remain in that storage.
The ordinary 256-MiB tmpfs fixture and Node/PG **1,536/1,024-MiB** budgets are
unchanged. No ports, external network or production credentials are supplied.
The parent baseline tag still resolves to
`sha256:78f3cb9fa91e7a64960699899d8fe2eb56bdd77c8ee56490f1f5255855b3c235`.
Changed candidate tags and evidence are retained, not overwritten/pruned.

Final exact-label queries checked **38 recorded fixture projects: zero remaining
containers, networks or volumes**. See `artifacts/phase01-cleanup-verification.json`.
Scratch cleanup did not remove persistent diagnostic receipts. Read-only checks
observed both `seha` containers running and the `seha_data` and retained
`agent-control-phase01_data` volumes/recovery directory present. No retained
container, network, volume, configuration or image tag was changed/recreated.

## Residuals and forward ownership

No phase-01 required implementation/test remains missing or failing.
Successful bounded fixtures are not a large-tenant support claim.

| Remaining evidence | Status, containment, signal/threshold and continuation |
| --- | --- |
| Full 100k users/agents, 1m observed facts, sustained exports, storage/WAL/temp and peak-sensitive V8/heap evidence | **Not run in 01; 06 implementation/proof, 07 production owner.** Dormant domain admission remains unopened here. Preserve fixed budgets; any `oom_kill` delta ≥1, batch >250/1 MiB, residual >256 KiB or active-pool count >4 is a fix-forward trigger, not permission to raise budgets. Current cgroup peaks are charged-memory evidence, not JS heap peak proof. |
| Real-process restart/takeover and real 600-second provider quiet wait | **Not run in 01; 05/06 proof, 07 owner.** SQL fences and controlled-time tests contain stale work. Any accepted expired/stolen-owner publication or renewal gap reaching 60 seconds triggers quarantine/repair before opening affected publication. |
| Browser, restore, restart and fresh-installation campaign suites | **Not run; owning 05/06/07 suites intentionally refuse until implemented.** No route/UI cutover in 01. Any cross-scope row, truncated-success export, failed restore integrity check or failing real 5/5 gate is a zero-tolerance trigger; 07 must repair while continuing safe schema/services/observability work, never bypass the gate. |
| Existing frontend bundle warning | **Observed warning, build passed.** Bundle remains 829.63 kB against the existing 500-kB warning threshold; frontend is unchanged. Carry into 05/06 browser/performance proof and 07 observation; exceeding that existing warning or the campaign page/heap bounds triggers targeted inspection, not suppression or fabricated failure-free output. |
| Production deployment/observation | **Not run by design; only 07 authorized.** Preserve `seha` and retained duplicate recovery resources. Reverify exact identity/configuration before the authorized path. Any identity mismatch or maintenance/authorization/publication guard failure blocks that unsafe action and requires repair; it does not authorize another target or an overall test-only ending. |

Model/evaluator benchmarks are not applicable: no model, prompt inference path or
evaluator changed. PostgreSQL/container/software evidence above is the relevant
phase proof. No feed/tool availability blocker remains.

## Exact next-phase preconditions

1. Phase 02 uses the tested typed directory/plan/activity APIs and synthetic
   goldens, not a runtime conversion from old snapshots. Keep all producers,
   readers, routes and UI dormant until the joint 02B cutover.
2. Use the shared bounded pool and `DataGenerations.execute`; capture durable
   `sessionEpoch`, pass its signal to provider waits, preserve expected
   page/count evidence, and supply transactional source-job `completeJob`.
   Integrate real session/clear/cancel hooks in the owning activation/lifecycle
   phase; this foundation does not silently install them.
3. Domain normalizers must emit bounded typed rows and child facts, shrink at
   either batch boundary and reject a single oversized record. Reuse the
   resumable validation contract and preserve paid/unknown/count meanings.
4. Selections use canonical persisted query values, existing-secret cursor
   authentication and bounded SQL. 02A supplies tenant-history reachability and
   03 inventory baseline/delta validators; do not enumerate dependencies beyond
   16 roots or treat an absent validator as success.
5. 02A supplies domain export producers, exact CSV columns and transactional
   audit adapters; 02B registers routes/backpressure/disconnect handling and
   frontend native downloads together. Do not expose metadata-only scaffolding
   as an activated export feature.
6. Append domain migrations; keep 1–47 immutable after this handoff and apply
   grants through the operator. Extend the owned runner with the phase's real
   suites and add them to `all`; unimplemented suite names must keep failing.
7. Consume the final evidence and residual matrix above. Parent owns ledger
   advancement; 07 owns production convergence through the existing safe path.

## Parent-review repair addendum: selected-read isolation (2026-09-28)

**Repair implemented and focused verification passed; `complete_with_risk`
pending parent acceptance.** This addendum supersedes the earlier evidence for
the repaired candidate, not the historical outcomes recorded above. The required
aggregate was attempted three times; none was an all-green run. The remaining
failure is an intermittent, unchanged frontend test described below. There is no
missing selected-read implementation or failing selected-read regression.

The parent identified that plain `BEGIN` did not satisfy the pinned-query
REPEATABLE READ contract. The falsifiable repair hypothesis was: one explicit
selected-read boundary preserves a single PostgreSQL snapshot across multiple
queries and concurrent commits, while ordinary writer/renewal transactions keep
their original isolation and every durable fence. The first executable check was
the runtime-role selected-read regression, before wiring the domain consumers.
Editor test discovery found no tests; the actual owned PostgreSQL runner supplied
the behavioral evidence.

### Implemented boundary and preserved behavior

- `DataConnections.selectedRead` explicitly begins REPEATABLE READ on the same
  bounded pool. `run` still begins ordinary writer/renewal transactions with
  `BEGIN`; no global isolation/default change, redundant pool or compatibility
  alias was introduced.
- Capture, directory pages and exact reads use the new boundary.
  `DataSelections.read` exposes a single callback/client plus validated selection
  and pins for 02/02A multi-query composition. All bounded rows/counts/facets and
  dependency reads must use that client and the captured evaluated-at instant.
  `assert` remains a low-level transactional **writer fence**, not a projection
  entry point. Scope/principal/selection locks and domain validators remain.
- Selection admission keeps the existing tenant advisory key but acquires its
  session lock **before BEGIN**, releasing it after commit/rollback. Otherwise,
  waiting inside REPEATABLE READ would freeze quota counts before the preceding
  capture committed. Failure/cancellation release is tested; unlock failure
  discards the client and surfaces the cleanup error. Concurrent captures at the
  100-selection principal boundary admit exactly one of the last two requests.
- Export producers receive `context.read`, which validates the lease and selected
  roots within each bounded REPEATABLE READ batch. Selected-ID pages, persisted
  chunk verification, status and downloaded chunks use the same boundary.
  Admission, lease renewal, chunk writes, cancellation, ready publication and
  transactional audit writes retain their writer behavior. No SQL transaction
  spans a generator yield, provider wait or download backpressure.
- A real SQLSTATE `40001` rolls back and becomes `503 data_read_conflict` with
  `Retry-After: 5` and the original error cause. There is no implicit replay,
  weaker-isolation fallback or success-shaped response. A fresh retry still
  observes invalidation. Export source conflicts durably fail/audit the job with
  that explicit code and publish no partial artifact.
- Runtime-role PostgreSQL tests assert `transaction_isolation`, unchanged writer
  and renewal isolation, coherent rows/counts across a second runtime
  transaction's commit, serialization rollback/no callback replay, changed
  scope fences, domain validators/page/exact reads and all export read surfaces.
  Export audit callbacks also assert writer isolation.

No migration was required or changed: migrations 1-47, grant logic, schema
verification and generation implementation retain their parent-reviewed hashes.
The only generation-test change replaces a 30-ms scheduling assumption in the
existing commit/revocation race with a bounded assertion against
`pg_blocking_pids`: revocation must actually be waiting on the held scope lock
before publication starts. The full aggregate exposed that timing-dependent test
failure; the fix strengthens, rather than weakens, its original fence assertion.

### Exact repair validation receipts

Commands used `pwsh -NoProfile -NonInteractive -File` and the existing synthetic
owned fixture, without dependency installation or registry/provider contact.

| Command / evidence | Observed result |
| --- | --- |
| `./scripts/large-tenant-tests.ps1 -Suite selected-reads` | Initial boundary check: **15 passed**, then wired checks **18 passed**; final selected-read/export check **20 passed**. Logs: `artifacts/phase01-repair-selected-reads-{initial,wired,qualified}.log`. Final run `0a3eb5019b0f4a94aa72083cec5faeb5`. |
| `./scripts/large-tenant-tests.ps1 -Suite foundation` | **92 tests passed**, backend typecheck passed, including after deterministic race repair. Final log `artifacts/phase01-repair-foundation-qualified.log`; run `15b5868689e6472d8fe96bdbd9ab562c`. Bounds remain 1,048,576 parameter bytes, two batch residents and 262,144 residual bytes. |
| `./scripts/local-deployment.tests.ps1` | **1,291 assertions passed**, `artifacts/phase01-repair-deployment.log`. |
| `./scripts/large-tenant-tests.ps1 -Suite all`, first | **Failed:** backend **4,303 passed**; frontend **2,344 passed/1 failed**; typecheck/lint/build passed. `artifacts/phase01-repair-all.log`; run `f63d68ca6ef14362a5a0fe8747b53f94`. |
| Focused `npm run test --workspace frontend -- src/App.session.test.tsx -t "does not reattach a post-action package-summaries read"` through the existing owned-fixture helpers and same candidate | **1 passed**, 264 intentionally unselected tests. `artifacts/phase01-repair-frontend-focus.log`; run `aca6a7fa690a4cf18a2aa142358082ef`. No frontend edit or test weakening. |
| `./scripts/large-tenant-tests.ps1 -Suite all`, second | **Failed:** backend **4,302 passed/1 failed** (the 30-ms revocation-race test, subsequently repaired); frontend **2,345 passed**; typecheck/lint/build passed. `artifacts/phase01-repair-all-repeat.log`; run `4d84959908474ab78c0ea11b3f7cb2c4`. |
| `./scripts/large-tenant-tests.ps1 -Suite all`, final | **Failed:** backend **4,303 passed**; frontend **2,344 passed/1 failed** (same intermittent frontend test); typecheck/lint/build passed. `artifacts/phase01-repair-all-qualified.log`; run `1d4d412358594fd4b6bb403206ae4a03`. The filename is not a passing qualification claim. |
| Exact candidate/source comparison, prompt hashes, diagnostics and whitespace | **Passed:** 27 executable/config files plus two operational docs match the final image; only eight executable/test/runner files differ from the parent's 27-file receipt. All nine prompt hashes match the unchanged parent ledger; editor diagnostics and `git diff --check` passed. `artifacts/phase01-repair-evidence.json`. |

One intermediate new export assertion expected unquoted numeric CSV values.
The existing `csvValue` correctly quotes them; only the expected fixture string
was corrected. The failed attempt remains in
`artifacts/phase01-repair-selected-reads-final.log`; the subsequent 20-test,
foundation and backend aggregate passes verify the corrected exact output.
No original deployment-gate run or production deployment was performed in this
repair. The pre-repair **5/5** receipt above must not be attributed to this
candidate, and the aggregate's independent passing commands are not a fabricated
combined **5/5** result.

### Scope, environment and next-phase handoff

Repair files: `backend/src/db/dataConnections.ts`,
`backend/src/db/dataGenerations.test.ts`,
`backend/src/services/{dataSelections,dataSelections.test,dataExports,dataExports.test}.ts`,
`backend/scripts/largeTenantFixture.ts`, `scripts/large-tenant-tests.ps1`,
`docs/{record-data-foundation,operations}.md`, and this exact completion record.
The runner only gains the narrow `selected-reads` entry point; existing foundation
and aggregate commands and safeguards are unchanged. There were no deletions of
runtime/schema/UI surfaces.

Cross-root impact checks found no live route/server or frontend imports of these
dormant APIs. Backend contracts and tests were updated; scripts expose the
focused command and docs specify 02/02A composition/error obligations. Frontend,
shared wire types, root manifests/lockfile/Compose/Dockerfile, production
configuration, `AGENTS.md`, `.npmrc`, all plan prompts and the parent ledger were
left unchanged. No commits, pushes, branches, nested agents, production/reset
actions or retained duplicate resource mutations occurred.

The final candidate is
`agent-control-ltdp-1d4d412358594fd4b6bb403206ae4a03-operator:local`,
ID `sha256:3d2ad5d920d132b14578384dfc17d864a8a3cd3263bb76cf5683ad5c397ab109`.
The protected baseline still resolves to
`sha256:78f3cb9fa91e7a64960699899d8fe2eb56bdd77c8ee56490f1f5255855b3c235`.
All ten repair-owned fixture projects were checked by exact labels after final
diagnostics: **zero remaining containers, networks or volumes**. Candidate images
and sanitized evidence are retained; the temporary focused-run helper was removed.

| Residual | Containment, signal, threshold, owner and fix-forward trigger |
| --- | --- |
| Intermittent unchanged frontend `App.session.test.tsx` package-summaries post-action observer test: expected call count 2, observed 3 in two aggregates; focused test and middle full frontend run passed | **Failed/intermittent, not resolved or green.** Keep dormant foundation exposure unchanged and preserve the real deployment gate; never bypass it. Signal: this exact regression plus post-action observer freshness in owning UI qualification. Threshold: any recurrence (already observed), stale observer result, or non-passing gate. Parent tracks a bounded frontend follow-up with 02B/05; **07 owns final convergence** and must resolve any gate refusal before official deployment while continuing safe dormant work. No unrelated frontend redesign was attempted in this tightly scoped repair. Evidence is the three aggregate logs and focused receipt above. |
| Existing frontend 829.63-kB bundle warning against 500-kB warning threshold | Unchanged from the original record; build passed. Retain the existing 05/06 performance and 07 observation ownership/trigger, without suppressing the warning. |

All original scale/process/browser/restore/production evidence obligations above
remain with their named phases. 02/02A may rely on the tested selected-read
callback contract, snapshot-safe capture admission and explicit conflict outcome,
subject to parent acceptance. They must compose bounded SQL through those
callbacks, keep mutable-dependency invalidation/lock ordering, and preserve
export/route error handling at their owning activation. Parent alone advances
the campaign ledger; 07 alone owns the authorized production path.

### Parent acceptance

Parent reviewed the repaired isolation/composition implementation and runtime-role
concurrency tests, matched all 29 source/documentation hashes against the final
repair receipt, and independently reran `-Suite selected-reads`: **20 passed**.
Evidence: `artifacts/phase01-parent-selected-reads.log`, owned run
`245fc6d27e654ac2bc687b765e692320`. Editor diagnostics and diff hygiene passed.

Accepted as **complete_with_risk**, not a combined aggregate pass. The unchanged
intermittent frontend observer regression remains explicitly tracked for 02B/05
and final 07 gate convergence under the residual's containment and zero-recurrence
threshold. Phase 02 may proceed with the dormant foundation; no production
feature activation, reset or deployment is authorized by this acceptance.

### Parent follow-up: observer test race resolved

While 02 implemented the dormant backend, the parent traced and deterministically
reproduced the carried frontend failure. The initial automatic-refresh response
publishes its first source revisions and triggers a legitimate reload. The test
had recorded its baseline before that startup work necessarily finished, so a
startup reload plus the manual verification could be counted as two action reads.
Controlling that response reproduced **expected 2 / observed 3** for both
package-summary and refresh-job-history cases against unchanged frontend runtime.

Only `frontend/src/App.session.test.tsx` changed: a controlled startup completion
barrier precedes peer attachment and baseline capture, and the peer uses the latest
admitted key. Existing exact-count, non-cancellation and returned-result assertions
remain unchanged. No runtime change, arbitrary delay, assertion weakening or
suppression of valid refreshes was made.

Evidence:

- `artifacts/observer-race-reproduced.log`: deterministic original failure, two
  affected cases; owned fixture `9da493747f4449dc8228021fe35a37ea`.
- `artifacts/observer-race-fixed.log`: **4 focused cases passed**; owned fixture
  `9a073b34c4694963a22ab669ebacacc9`.
- `artifacts/observer-frontend-qualified.log`: **2,345 frontend tests passed** in
  77 files; owned fixture `5baf1c621de24dc79da664fd55115f2d`.
- Test SHA-256:
  `0428f6716a14dd5207afdc48f3e203b0df5ecbcef361ee0a9be31fe6bd3cc1c9`.
  Editor diagnostics and diff hygiene passed.

The temporary session helper invoked the existing owned fixture/capture/cleanup
functions with the fixed phase-01 repair image and only frontend source mounted
read-only; concurrent phase-02 backend edits were excluded. It is removed after
use, while receipts remain. This specific residual is closed. Earlier failed
aggregate results remain failures; later integrated qualification and the exact
production deployment gate are still mandatory, not inferred from separate runs.
