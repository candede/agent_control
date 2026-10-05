# Phase06 — capacity qualification

**Closed under the user's stop/redirect; capacity is not qualified.**

The parent owns acceptance. No production action, commit, push, branch change,
protected-image removal, or parent-ledger edit is authorized to this worker.
The approved prompt SHA is
`6b03347872612958fe5b07154dfdd4230c005431cb3e1b3e16dcee6b82aeff68`.
The inherited HEAD is `7e2be0b6b844bd538dbdd15f3e8261ea0fc6aeb6`.

## 1. Executable entry points and fixed resources

- `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite capacity`
  executes three separately owned full attempts. Diagnostic suites are
  `capacity-query`, `capacity-probe`, and `capacity-focused`; none substitutes
  for the mandatory full cardinalities.
- App:1,536MiB,1.5CPU,768MiB old-space,four database connections.
- PostgreSQL17:1,024MiB,0.5CPU,32MiB shared buffers,4MiB work memory,
  64MiB maintenance memory,no parallel gather,15-second ordinary statements.
- Provider/load/browser controller:separate1,024MiB/1CPU.
- Owned disk PGDATA/WAL/temp volume,internal-only network,no host ports,no
  retained configuration/credential mounts. The runner requires64GiB backing
  free space and stops at48GiB owned storage.
- Inspect,effective PostgreSQL settings,raw cgroup counters,250ms Node
  samples,raw V8 GC,SQL/stage checkpoints,storage,source,image and cleanup
  receipts are retained per attempt before exact resource removal.

Missing counters are not zeros. Charged PostgreSQL memory includes file cache:
several attempts reached its1GiB cap and recorded `memory.events.max` without
an OOM. They do **not** pass the80% headroom or zero-max-events gates.

## 2. Initial falsifiable hypothesis and measured repairs

The initial hypothesis was that broad inventory query plans/materialization,
not a need for more application heap, caused10k→100k cursor cost growth.
Actual diagnostic attempts:

| Attempt |10k p95|100k p95|Interpretation |
|---|---:|---:|---|
|`84b224005b414a8ebe0c4178772bc314`|13,136.45ms|7,388.66ms|Both failed latency|
|`ea816d61729444109b0f5c1e4e3f083c`|Statement timeout|Statement timeout|Correlated-root experiment reverted|
|`6858e9cc1f9948c0985d33ac7be05eb6`|571.734ms|5,891.314ms|Correctness passed;100k latency failed|

Subsequent repairs prune union branches by captured source/scope, remove native
roots' canonical-member expansion, retain indexed point/detail paths, and
discourage the measured broad nested-loop/JIT pathology. A newly exercised
mixed-identity pair query timed out at10k in the second full run; its
transaction now disables JIT without increasing the statement deadline.
Final-source rerun evidence remains required.

The second full run then exposed a distinct post-publication staging-cleanup
root:PostgreSQL terminated a5-second lifecycle transaction sorting the complete
million-row staging set by physical`ctid` before its25-row limit. Cleanup now
uses its existing parent/ordinal index. An already durable acceptance returns
its successful idempotent receipt even if later cleanup is deferred; a warning
and unreleased quota remain visible for bounded retention,not a false claim
that publication failed. New regression and fresh integration evidence remain
required.

Additional root repairs:

- Activity download timing now bounds header/pending-network-read idle time,
  not database backpressure, retaining the30-minute deadline and independent
  heartbeat. The next full attempt completed100k users and100k activity
  identities in132,397.861ms.
- Migration76's sparse invalid-fact index and FK-backed completeness predicate
  replace million-row typed-payload joins at acceptance/history/read metadata.
- Migration77 adds a separate scoped GC keyset cursor and missing reverse
  reference indexes.250 candidate keys/50 eligible keys share the original
  1,000-row/1MiB/5-second budget; partially collected keys cannot be skipped.
  Authorization-scope rows are not updated merely to advance GC.
- Pending reconciliation keys advance from the previous pending watermark,
  rather than repeatedly copying the active worker's whole accumulated range.
- Backup fingerprinting uses bounded250-row keysets and streaming32KiB binary
  COPY fragments under one exported repeatable-read snapshot.
- Physical counters aggregate bounded flushes. Transaction-local heap/index
  tuple visits and precommit cluster WAL intervals are recorded after commit.
  Rolled-back work is explicitly excluded; cluster WAL is not attributed as
  exact per-transaction WAL.
- Real controller requests flush progress headers, cancel on disconnect, and
  distinguish successful timings from failed/unknown outcomes.

## 3. Failed attempts are preserved

All IDs refer to `artifacts/large-tenant-data-platform/<id>/`.

| Attempt | Actual result and response |
|---|---|
|`2bb300d94f044578bca946f07dd408cd`|ESM top-level-await cycle; extracted `capacityRuntime.ts`; exact-owned worker terminated with143|
|`90228bd3dd8841bc8d9cff0bef3f006d`|Real100k/200k/1m bundle accepted390.88s;600s retry31 renewals/642,903ms; actual expiry/takeover; wide collection hit unchanged30-minute deadline after5,800users/2.9m plans|
|`9d9c4fea5b13464ebeacd8c45ba4e3e2`|100k directory/activity120.57s,Graph/PP445.33s; final1m validation timeout; fixture canonical oracle/heartbeat error-handling defects repaired|
|`81a24b51518849c58d4eb12319086de4`|Completed all profile attempts with functional failures; clean exact teardown; detailed results below|
|`0258e578f8a341089c27742a385fddc7`|Executed migrations1–77;100k users/activity,Graph/PP,and opposing scope passed;5s cleanup termination then an unhandled checked-out-client error aborted Node; clean exact teardown|
|`46df3c0b8e0e4fbabc4c63004b8df220`|Third serial full run failed and cleaned;100k directory/activity168.650s,Graph/PP526.081s,opposing49.585s;10k pair probe still timed out despite JIT repair;report response failed postcommit cleanup385.215s;100k canonical199,998 and mixed-identity summaries passed831.948s;all five replacement cycles failed;checked-out-client error aborted before the first detail batch|
|`bbfbcbe4f7a8457fa35199dc52091b1a`|Fresh dual-image query diagnostic;probe60,218,152 retained bytes/94.454ms passed;10k pair query timed out15,000.572ms;cursor10k786.462ms/100k7,591.050ms p95;clean teardown|
|`c6bcf3bae25e4f7b945a3f0c78f48584`|Repaired10k pair setup completed;actual20-key probe1,273 physical writes and7,941,784 WAL bytes,with excessive read work;newly reached fast-page enrichment timed out15,000.390ms before a cursor response;clean teardown|

The serial `all` parent is `f2344028961c42c7a9f884bd7e0e11a4`.
Its running host Python retains the source loaded when the invocation began;
each later application image captures fresh repository source. Later runner
changes, including the compiled-UI/browser-controller build and removal of an
incorrect aggregate4-hour watchdog, require a fresh invocation. A report must
not silently assign those changes to an older running host process.

The checked-out-client crash prompted a shared lifetime error guard and
discard-on-rollback-failure repair in the bounded pool and transaction owners.
A real PostgreSQL transaction-timeout regression checks process survival and
admission reuse. These latest changes are not present in the third image.
Fresh diagnostics now preserve a failed pair query's nonexecuting plan instead
of spending another full run merely to rediscover its15-second timeout.

Third-run HTTP evidence:1,008 requests,1,006 failures; the subsequent export
hit its unchanged15-minute deadline. The full cursor walk expired its unchanged
selection after607.147s. Actual plans are persisted in
`artifacts/phase06/third-full-plan-records.json` and
`third-full-slow-plans.json`:pages8.10–8.29s and summaries6.27s,
including1.3million report facts and two absent-predicate scans over8.9million
inventory facts. Latest repairs link agent headers before scoped report-fact
aggregation,add migration78's sparse Teams/availability indexes,and cache only
bounded immutable unfiltered aggregates behind the existing selection fences.
Current freshness is never cached. These changes await fresh integration and
capacity validation; no latency improvement is yet claimed.

The fresh pair plan is explicitly nonexecuting,not an ANALYZE result:
`artifacts/phase06/post-root-query-plans.json`. Its cold estimates chose
whole partial match-index scans as if only one fact existed. Pair reconciliation
now materializes one record's facts and retains parameterized scope/kind/value
probes. A real-plan regression preserves those predicates.

The next actual fixed20-key probe exposed separate N-sized reads:
canonical publication visited3,580,296 tuples in its largest transaction;
an isolated-component lookup visited813,174. Exact relation-level counters
remain in `artifacts/phase06/keyed-10k-physical-reads.json`. Current repairs
parameterize previous-component/record lookups and staged delta interval
closure,including the final tuple-ID update under the existing publication
lock. The regression requires an actual PostgreSQL Tid Scan,not a mocked
logical-write count. The100k identical-component probe now precedes replacement
cycles instead of comparing a fresh10k source with an already churned100k source.

The diagnostic's native`inventoryScope=catalog` is a no-op for a package
source,but previously bypassed the bounded name path and summary cache.
That source-specific no-op is now recognized without treating canonical
catalog filtering as unfiltered. A subsequently exposed planner-scope defect
left nested loops enabled for enrichment after the indexed name seek; its
failed SQL is retained in `artifacts/phase06/keyed-failed-summary.sql`
(despite the historical filename,this is page enrichment,not summary SQL).
The seek now restores the broad-join planner setting before enrichment.
Fresh failed diagnostic queries persist planning-only evidence before cleanup.

### Completed full attempt81a24...

-100k Graph/PP438.599s;100k publisher facets20.69s(functional only).
-100k directory/activity failed118.678s due the old stream timeout.
- Opposing scope failed a wrong fixture assertion; the corrected next run
  passed52.685s.
- Report bundle failed324.029s at the old typed-fact join.
- Canonical count200,000 differed from independent199,998 because the fixture
  omitted required matching Graph revision markers. Those markers are now
  supplied; no identity fallback was added.
- HTTP load failed305.65s because the old RPC withheld response headers.
- Concurrent cycles aborted at the first failed replacement; the harness now
  records and attempts all five rather than counting an incomplete cycle.
- Two actual sweeps completed5,000×20 keys each:
  - Sweep1:100,000 inserted/closed/changed,5,000 publications,
    WAL25,048,360,464 bytes,final convergence264.559ms.
  - Sweep2:same cardinalities,WAL27,911,455,472 bytes,
    final convergence349.514ms.
  - Maximum publication gap87,367.346415ms exceeded60seconds.
    No active+pending overlap was observed. These old-source sweeps lacked
    matching enrichment revisions and therefore do not prove intended final
    detail values. The repaired fixture verifies every changed value.
- Fixed20-key probes:1,193 physical rows at both sizes; WAL1,479,024 versus
  7,708,304 bytes,about5.21×,failed. Checkpoint age was uncontrolled; later
  comparisons explicitly checkpoint before each isolated interval.
- Retention failed at the unbounded orphan-count diagnostic's15-second
  timeout. That diagnostic is now bounded and distinguishes zero from a
  positive lower bound.
- Real600-second retry/cancel profile passed644.14s; actual worker death/
  expiry/takeover passed62.35s.
-10kusers×500plans passed796.89s.
-100agents×10k observed children hit the existing total-fact ceiling.
  Normalized10k-fact boundary tests do not establish support for10k provider
  children plus metadata.
- One user's10k observed relationships timed out after20.17s.
-32 retained report sets/history pins passed3.01s.
- Backup failed286.88s on an operator-only table because the harness used
  runtime credentials. The repair uses an operator snapshot plus two runtime
  slots and one `pg_dump` connection,still within four.
- Exact256MiB staging succeeded; the over-limit attempt hit retained staging
  quota first. The repaired harness discards and boundedly reclaims the exact
  stage before testing256MiB+1,without changing the old publication.
- App sampled heap77,536,208 bytes,stage heap78,831,088,
  sampled RSS244,789,248,charged peak357,859,328.
  **11,206 telemetry events were dropped at the256MiB log cap**,so heap
  coverage is inconclusive regardless of those low sampled values.
- Final reported DB24,792,384,015 bytes; tables9,520,644,096;
  indexes15,259,205,632;cumulative temporary writes21,257,348,685.

`artifacts/phase06/first-full-reinterpreted.json` preserves a new,
parser-hash-labelled interpretation without replacing the original receipt.
Its actual raw-GC preheap maximum is78,835,432 bytes. PostgreSQL charged peak
is1,074,151,424 bytes(including up to1,025,359,872 file-cache bytes),with
1,969,216 max events and zero recorded OOM/oom_kill events. PostgreSQL backend
RSS maximum173,314,048 and simultaneous RSS sum606,052,352 are distinct
process observations,not additive unique physical memory. Observed swap peaks
are98,869,248 app,96,112,640 PostgreSQL,and65,515,520 controller bytes.
The controller charged peak is135,049,216. Ordinary SQL and sampled lock-wait
gates failed; incomplete/unknown request timings cannot satisfy latency,
1,000-successful-request or five-complete-cycle claims.

## 4. Validation evidence and source distinctions

The historical focused run
`fc1ef96ccb63474cad50bea50991f29b` passed183 backend tests and types.
Subsequent retained focused attempts:

-`1b2062f8022147bfa6a6b6c81350a782`:432/442;types failed. Repaired
  summary narrowing,CSV limit precedence,mock lifecycle contracts,dynamic
  responsibility parameter offsets and the original1,000-plan ceiling.
-`e12930f5683e441593ade8e8052cb8f9`:441/442;types passed;one stale
  500-plan test expectation corrected.
-`740e7a40483646a99c9cc8385818cbe9`:441/443;types passed;two new
  regression-test defects corrected without weakening runtime assertions.
-`b11454e492b44fb18ecdf49a6234da94`:443/443 and types passed.
-`800be5e6cbcb44b69e043b10604e9341`:443/443 in198,153ms and types
  in2,942ms passed,including pointwise closure,actual pair plans and restore.

Fresh full-capacity and independent software/browser evidence for these latest
repairs remains required. Earlier full passes are not relabelled final-source.

Original unchanged software gate:
`artifacts/software-checks/8fe967651054429bb83f121a4a9ef601`:
backend180-second timeout,remaining four commands not run.

Independent `all` software commands:
backend600,065ms ETIMEDOUT/SIGTERM;frontend2,393 passed/115,085ms;
types2,315ms;lint12,045ms;build10,996ms. **4/5,not the original gate.**

Serial auxiliary receipts:

- Browser `38b629f567164cd99e232ed194b04b8e`:4 focused+509 full passed,
  nine existing skips.
- Restore `5bb4d7f6c69d48e68472f515a2edc207`:initial5/6 due stale test
  interception of removed `FETCH FORWARD`; repaired to intercept the actual
  exported snapshot,not weaken concurrent-commit assertions.
- Restore `a539d909a563465f8847c130a968d580`:6/6.
- Lifecycle `848a656c74a84e8b9bf74ecb7724dd90`:passed.
- Compiled restart `afcf9284c8e64f239bf6ba05126715ca`:passed.
- Full browser `43c9c385b4c34dfbb2fd9056abb6b50d`:509 passed,nine skips.

Current pure parser/resource contracts:10 passed. Editor diagnostics and
`git diff --check` are clear at the recorded inspection; fresh fixture tests,
types/lint/build,query/full/browser/restore and exact gate attempts remain.

## 5. Integrity proof already obtained

`artifacts/phase06/second-full-schema-proof.json` verifies the second run's
actual1–77 migration records against all75 frozen phase05 checksums.
The actual public inventory contains105 tables; the new GC cursor grants are
exactlySELECT/INSERT/UPDATE. Migration75 remains
`26fda951b402de9645f307cf49b7552030718e8a4efd2c19dcf81721e62ede73`.
Final source/image/deletion overlays and independent final re-verification
remain required.

## 6. Outstanding acceptance evidence

No100k production-capacity support claim is made. Required finalization:
complete the measured sequence; validate every latest repair; run fresh
query/full/browser/restore/gate attempts; report every numerical threshold and
per-profile support status; verify exact cleanup and protected resources; and
attach final source/image/migration/deletion overlays.

Phase07 alone owns seha localhost3002 deployment and the unchanged5/5 plus
clean-teardown guard. Every remaining unsupported dimension must receive a
specific closed admission/publication boundary,numerical live alert,and
phase07 fix-forward trigger in the final handoff. This execution record does
not authorize deployment or claim acceptance.

## 7. Same-phase contract trace

| Changed producer/consumer | Coupled contracts and verification |
|---|---|
|`dataBounds`,generation writers,user-source provider|Original1,000-plan ceiling;incremental CSV/network idle bounds;250-row/1MiB batches;lease/epoch fences;50 user-source and19 generation contracts|
|Official report stream/import/history/query helpers|Sparse typed-fact validation,immutable version memberships,known-zero/null aggregation,idempotent acceptance,ordinal cleanup and continued quota accounting|
|Inventory writers/reconciliation|Pointwise intervals,source pins,coalesced pending watermark,oldest-ID merge/split rules,real physical read/write/WAL counters and no safe-update cancellation|
|Inventory query/responsibility/identity expiry|Captured tenant/principal/source joins,opaque cursors,C/ICU ordering,report semantic links,dynamic parameter offsets,bounded immutable aggregates and current freshness fences|
|Pool/transaction owners|Original four connections,5-second acquisition and reserved renewal lane;real client-disconnect containment;discarded unusable connections|
|Lifecycle collectors/operator retention|Shared1,000-row/1MiB/5-second slices,250 scanned/50 eligible keys,durable wrap/revisit cursor,pins and exact reservation convergence|
|Backup/fingerprint/restore|105-table allowlist,one exported repeatable-read snapshot,bounded indexed COPY,distinct guarded restore target and provider-disabled authority review|
|Schema76–79/readiness/grants|Sparse report/summary indexes,GC cursor/reverse references,short/long name partitions,and set-based membership insert fencing;all frozen1–75 checksums independently compared|
|Peak hooks/harness/controller/parsers|Live parse/stringify/result/transform/export checkpoints,raw Node24 GC,real sub250ms probe,250ms samples,scoped SQL/plans and actual cgroup/disk/inspect evidence|
|Checked-in fixture entry points/docs|Exact`-Suite capacity`,internal owned resources,approved-feed propagation,no installs,source/image proof,serial independent suites and diagnosed exact cleanup|

Frontend runtime code is unchanged: the inherited paginated UI already owns
current/previous/next bounded pages. New`capacityBrowser.ts` exercises that
compiled UI against the real large fixture; the independent full browser suite
continues to check cache eviction,disconnect and terminal-polling behavior.
No runtime compatibility store,legacy fallback,shadow mutation authority,
host Docker/VM tuning,ordinary small-fixture resource change or production
resource change was introduced.

Migration79 was an additional measured publication repair. It preserves the
original insert predicate for every distinct baseline/revision through an
AFTER-statement transition-table guard; update/delete/pin/FK guards remain.
Its mixed-valid/invalid insertion regression rejects the whole statement.
The first restore attempt exposed the expected`pg_restore --no-privileges`
loss of function ACLs; restore now revokes that helper before retention
readiness while retaining table grants after authority review.
Focused`7b5c8c46418a4a81a8d281a346de6c9c` passed446 tests/205,537ms and
types/3,084ms. Actual executable79-migration proof is
`artifacts/phase06/final-79-migration-proof.json`; frozen1–75 aggregate is
`69e08c5e402d0e1f040a7f253e9f3cfebcd57e428a52e69e83009b092666f271`.

## 8. Containment and numerical fix-forward ownership

These are residual-handling requirements,not claims that production was changed.
Phase07 owns every row and must first satisfy the unchanged original5/5 plus
clean-teardown guard,then reverify the authorized seha identity. No capacity
failure permits bypassing that guard or increasing resources/deadlines.

| Unsupported/unproven dimension | Containment using existing controls | Signal and numerical alert | Phase07 fix-forward trigger |
|---|---|---|---|
|Cache-inclusive PostgreSQL/app headroom|Keep affected large provider/import publication admission closed;retain safe reads of valid existing pins|PG charge>858,993,459 bytes;app>1,288,490,188;any increase in`memory.events.max`,OOM/oom_kill or unplanned signal9/restart|Fresh fixed-budget full receipts show≤80% and zero forbidden events before reopening|
|Heap coverage or retained growth|Do not advertise the heap bound or open affected large workloads on sampled-only evidence|Observed heap>644,874,240 bytes;any dropped event/missing required stage/invalid GC stream;cycle5−cycle1>67,108,864 bytes or monotonic>16MiB/cycle|Successful real≥32MiB/<250ms probe plus complete GC/stage/sampler coverage and all five settled cycles|
|Warm lists/details/summaries/facets and UI|Keep costly scope/filter/fan-out admission closed,not truncated;retain explicit bounded API diagnostics|List/detail p95>2s or p99>5s;summary/facet p95>5s;list>1MiB/detail>512KiB;more than three cached pages or any automatic terminal polling|At least1,000 successful varied measured requests per full run and actual100k browser evidence under unchanged budgets|
|Atomic publication/SQL/pool contention|Close new affected replacements/imports while preserving prior publications and admitted leases|Publication transaction p95>1s,lock wait>2s,ordinary SQL>15s,any5s acquisition timeout;more than4app/worker/operator connections,missing budget coverage or wrong shared DB/runtime role;report rejection counts separately|Constraint-preserving preparation/query repair plus five complete concurrent replacement cycles and same-pool/bootstrap/counter proof;never time only the head UPDATE and hide its surrounding transaction|
|Detail churn/amplification/progress|Keep large sustained detail refresh closed;do not cancel a safely running worker merely for a newer vector|Read/write/close/delete ratio>1.10,WAL ratio>2;active>1 or pending>1;safe-update cancellations>0;publication gap>60s;latest vector lag>300s after stop|Two complete5,000×20 changed-value sweeps at100k with independent value oracle,concurrent pins/export/GC and matching10k/100k physical work|
|Lease/cancel/worker recovery|Keep affected background admission closed on any missing renewal/owner fence;never reopen restored providers automatically|Fewer than30 renewals during actual600s Retry-After;any append during wait;renewal/publication after cancellation;old-owner acceptance after actual60s expiry/takeover|Real-time contention/validation-idle/cancel/death receipts without fake clocks or widened leases/acquisition bounds|
|Wide plans/residuals/observed children/relationships|Reject the unsupported complete request explicitly and preserve the old publication;no silent child or row truncation|Any required exact-boundary rejection or over-bound acceptance;10,000 observed children plus metadata exceeding existing10,000 total normalized facts;byte/row diagnostics inconsistent with actual input|Separate full required profiles and exact/+1 preservation receipts;normalized-fact tests alone cannot authorize observed-child support|
|Retention,32-set history and restore|Use bounded existing collectors;close new admission when quota fails to converge;restore remains maintenance/provider-disabled|Unpinned obsolete data age>600s;any quota-ledger mismatch;deferred staging cleanup>600s;restore table/schema/checksum/pin mismatch|Real collection under reader/export pins,exact quota reconciliation,106-table guarded restore with reviewed authority and no provider reopening|
|Disk/host availability|Stop only owned synthetic work at the guard;do not reduce cardinality or touch other workloads|Backing free<64GiB before start;owned PGDATA/WAL/temp+backup usage≥48GiB;missing cgroup/disk counters|Repair owned fixture/storage or record unavailable;rerun full cardinalities with actual mounts/counters|
|Unchanged software/deployment gate|No application stop/reset/deployment from phase06;no internal-start/direct-container escape in phase07|Any of backend/frontend/types/lint/build not passed,or any owned teardown residue|Exact original5/5 and clean teardown,followed by phase07's authorized identity-checked deployment/live canaries|

## 9. Final-runtime diagnostic and gate receipts

Diagnostic`f4133164a623431a8cf5c267ecf8f4b3` used migrations1–79 and the
fresh application/browser-controller build. Functional producer/oracle checks
passed; resource/latency qualification did not. Its three requests/cardinality
are diagnostic only:

| Cardinality |Cold first page|Second page|Third page|
|---|---:|---:|---:|
|10,000|1,100.860459ms|168.563875ms|105.441125ms|
|100,000|6,812.250087ms|522.198209ms|389.573333ms|

These two warmed samples/cardinality do not satisfy the1,000-request formal
gate. The request-window peak-sensitive delta was712,776 bytes,below64MiB.
The actual20-key10k probe wrote1,273 physical rows; its old observer reported186,004 heap-returned
tuples/140,646 index-returned tuples/139,134 heap fetches across61 committed
transactions,and observed7,760,512 cluster WAL bytes. The read attribution is
withdrawn by the counter diagnosis in section10; writes/WAL are separate.
Measurement queries
accounted for59.987ms. The100k comparison remains a full-run obligation.
Broad publication transaction p95 bucket upper bound was5,700ms(maximum
5,691.158ms),still failing1second after the constraint-preserving set guard;
bounded publications had20ms p95 upper bound. No UPDATE-only timing is used
to hide the broader transaction.

Memory observations were sampled heap62,785,104 bytes,raw-GC preheap65,475,344,
stage heap65,470,616 and peak-sensitive observed65,475,344. App charged peak
210,784,256/1,610,612,736 bytes passed its80% gate. PostgreSQL charged peak
1,074,106,368/1,073,741,824 bytes,including1,009,729,536 file-cache bytes,
failed headroom and recorded32,661 max events;OOM/oom_kill remained zero.
PostgreSQL swap peak was41,824,256 bytes,maximum backend RSS155,095,040 and
simultaneous backend RSS sum461,103,104—not additive unique physical memory.
Controller charged peak87,896,064/1,073,741,824 was measured separately.
The real probe retained60,218,592 additional bytes in128.293ms and passed.
Query-only missing import/export stages still make the overall heap-bound
claim inconclusive.

`artifacts/phase06/final-query-reinterpreted.json` is an append-only,
parser-hash-labelled interpretation. The parser now distinguishes a correct
diagnostic's latency failure from functional correctness; qualification
remains failed. All11 pure parser/resource contracts passed.

The final-runtime unchanged software gate is
`artifacts/software-checks/1f4737c649c442daa72c3496d476c561`:
**0/5**,backend`spawnSync npm ETIMEDOUT` at its unchanged180-second limit,
the other four steps not run,no OOM reported. Parent fixture
`ca45093938f74e129da5dc3e7e0f24bd` used the fresh candidate operator.
Independent`all` is running serially under parent
`be1e7de76f794176b6bb578db6d82131`; its later results are not yet claimed.
Driver receipts:
`artifacts/phase06/verified-source-validation-ladder.{log,json}`.

## 10. Repairs discovered during the first new full attempt

Full run`83b8af82dcea41e2964e30fdbf535acf` is still running the79-schema image.
It accepted the100k/200k/1m report bundle in435,384.125ms and independently
verified199,998 canonical records,then failed its first canonical summary at
the unchanged15-second SQL limit. The HTTP controller attempted1,008 requests:
936 failed; native request-scoped readers were recreating their aggregate
cache on every request. Full cursor traversal reached its unchanged selection
expiry after604,903.358ms. These remain failed observations,not passes.

Subsequent candidate builds include four targeted repairs:

- Migration80's scoped categorical-fact index and set-based unfiltered
  summaries remove per-record singleton probes; filtered semantics remain the
  independent parity oracle. Duplicate singleton facts still cause rejection.
- A weakly held,at-most32-entry/16KiB-per-entry cache is shared by one database
  pool,not recreated with each HTTP reader. Every request still performs all
  authorization,scope,selection,pin and epoch checks before cache access.
- Name-preselected enrichment also predicates membership identities and uses
  scoped parameterized record lookups,avoiding an N-record hash-join scan for
  each bounded page. The generic filtered path and exact ordering remain.
- Browser qualification now awaits the initial API response under its existing
 20-second bound before asserting no auto-drain. Controller failures preserve
  bounded name/message/stack evidence instead of becoming an unexplained
  truncated HTTP response. A bounded launch-only diagnostic in the exact owned
  controller passed with Chromium145.0.7632.0; it was not an application/browser
  qualification pass.

The read observer also had a reproducible attribution defect. PostgreSQL17.11
exposed3 prior-transaction tuples immediately after a new `BEGIN`,then6 after
reading the same3 rows again. The new transaction did3 reads,not6.
`artifacts/phase06/pg17-pending-counter-reproduction.log` preserves the actual
read-only,three-row diagnostic,including runtime version and timestamp.
The upstream implementation corroborates pending-backend semantics:
`https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/pgstatfuncs.c`
and`src/backend/utils/activity/pgstat_relation.c`.

All earlier **unsubtracted physical read totals and ratios are withdrawn as
transaction-work evidence**,including the apparent large enqueue scans in
this first new full run. They are retained,not rewritten. Existing actual
EXPLAIN plans,physical write triggers and cluster WAL observations remain
separate valid evidence. New instrumentation differences bounded snapshots
after`BEGIN` and before`COMMIT`,measures both snapshots' overhead,and rejects
counter resets/disappearances/overflow. The parser requires the explicit
`transaction-difference-v2` marker on both probes before judging read
amplification. Fresh actual validation and later full-run outcomes are pending;
none of these repairs is yet presented as a passing capacity result.

Additional admission/measurement repairs preserve the original limits:

- Both collector leases reach their first provider request,and both export
  jobs are created,before releasing work into12-reader/GC contention. This
  exercises admitted replacements instead of only queue-starved startup
  requests. Every later rejection remains a failed measurement.
- Inventory capacity reservations are reduced from the documented8GiB maximum
  to the shipped runtime's1GiB default; directory/activity retain8GiB.
  The first new run's observed baseline charges were373,775,000 bytes
  (Graph),527,029,029(PP),and691,547,803(canonical).
  `artifacts/phase06/current-full-source-byte-diagnostic.log` preserves the
  actual read-only observation; it is not a retroactive1GiB-admission proof.
- The12 pure result-parser tests pass after rejecting unversioned read-counter
  attribution. Editor diagnostics report no errors for the changed source.
  Real focused/runtime validation of these later repairs is still pending.

The completed independent software portion of`be1e7de76f794176b6bb578db6d82131`
was4/5:backend timed out at600,071ms;frontend2,393 tests,types,lint and build
passed. The backend log also contains a5,004ms test timeout in
`officialUsage.test.ts`'s null-expiry retention case,not merely the outer
deadline. Its30 completed files reported492,760ms;5001-source HTTP/mutation
coverage took106,875ms and native pagination's92-test file91,139ms.
Those unchanged fixtures/assertions are now included in the focused selection
alongside the repaired query paths; neither deadline nor cardinality changed.
The independently rerun lifecycle,restore,restart and509-pass/9-existing-skip
browser checks passed on the79-schema source before these later repairs.

The first new full run subsequently completed all5,000 first-sweep batches
(100,000 changed keys),but its independent value digest failed:
actual`4a10b7ba4853bb3bef6be9ff481dd2bd48c05573f117e950b2418abc23a90dad`,
expected`971a3a40fb2fddb8858f7d59925d5d73f59e942d2981cead25e33ee1e7c45b92`.
The second sweep did not run in that image. The persisted mismatch query
returned exactly one record: the deliberately conflicting`package-000003`
correctly retained detail value0 with`detailFreshness=invalidated`,rather than
accepting non-authoritative value11. Files`first-sweep-value-diagnostic.log`
and`first-sweep-mismatches.log` under`artifacts/phase06/` preserve the diagnosis.
The later merge/split setup also tried to reuse aged/stale mixed-scope inputs
and failed its original-link assertion before its mutations.

The repair does **not** relax conflict/expiry/mutation-authority checks or
exclude that row from the claimed cardinality. The main100k mixed baseline
remains unchanged. A separate full100k Graph+100k PP uniform sparse baseline,
with independently expected200k singleton canonical components,is collected
before detail measurement. Both complete changed-value sweeps use that scope.
The separate fresh100-source adversary uses real authoritative exact collection
for deliberate identity changes. Digest discrepancies are now recorded for
both complete sweeps before final assertions,not hidden or called successful.
Completed broad replacement cycles must also publish their canonical result.

An exact-owned boundary watcher waits for this first full run's normal
diagnostics and clean teardown. Only during the next image build,with no next
fixture containers/networks/volumes,may it stop the old driver so focused
checks and three fresh final-source attempts can run serially. Its ownership,
process identities,action and cleanup outcome are persisted in
`artifacts/phase06/planned-boundary-stop.{log,json}`. No measured workload is
interrupted by that planned source-change boundary.

## 11. Executed boundary, corrected attribution and final-source repairs

The boundary watcher completed as described. Full attempt
`83b8af82dcea41e2964e30fdbf535acf` completed all28 profile attempts and
clean teardown before stopping the next unexecuted image build
`1da91170c29e499fb6973d00e59eb04f`. Its containers,networks and volumes
were absent before and after that action. This was not a terminated measured
workload; the old driver's second/third full attempts were not executed.
`artifacts/phase06/83-prior-full-profile-summary.json` preserves all outcomes.
In particular,600-second renewal failed acquisition in this run,retention did
not prove zero orphan keys within ten minutes,and the old full restore was
not attempted after its backup writer hit the accidental deep-provider profile.
Earlier successful heartbeat/restore evidence must not be reassigned here.

The first80-schema focused runs were
`23859b03b841481f8833bf9a68250a89`(584/585,a nested test declaration fixed)
and`4655fa91c5cd434781e1ecd2d5802480`(585/586,a real5-second retention
timeout). Repeated schema verification on every convergence slice was the
retention root. Shared migration-fenced verification reuse preserves bounded
slices without a global schema cache or skip-verification option.
`11ad292e59084d6c891622603dae231b` failed its new test's incorrect
one-connection configuration;the required configured pool remains four.
`618cf7f762154470bf75d27e6a14350b` then passed206/206 plus types.

Actual80-schema diagnostic`bcf5e5f68dfa4a25875098de1221d866` completed
with10k406.610ms/100k2,799.546ms maximum across each three-request
diagnostic. These are cold-plus-warm diagnostics,not the required1,000-request
latency proof. Request-window heap delta was6,253,448bytes.
The corrected v2 counter still exposed40,022 unchanged membership tuples
scanned in one enqueue transaction. The volatile expiry predicate prevented
an indexed candidate range;the repaired query uses an execution-time
wall-clock range followed by exact membership/source probes. A real
transaction-before-expiry regression and range-index eligibility check passed
in`0fb6097c3d7d4316b7279420768f9f31`:232/232 tests plus backend types,
with clean teardown. The runtime mutation-authority expiry predicate remains
unchanged. Its new real diagnostic is recorded separately when complete.

The same diagnostic measured a2,177.348ms100k-row duplicate
`inventory_changes` insertion in broad publication and a4,713.084ms
10k membership insertion. Broad baseline changes already force complete
captured-root reconciliation;only within-baseline deltas need per-key journals.
The new publication path counts broad changed identities without storing that
duplicate journal,and locally disables JIT. Reported counts,delta journals,
old-root reachability,atomic publication and source/vector fences remain.
Dedicated rebuild/delta regression and final-source qualification are required.
The retention assertion now explicitly distinguishes an incomplete bounded
orphan traversal from zero instead of rendering`unknown`as`NaN`.

The deep-child failure includes a stricter frozen provider bound:
50 groups/100 elements per group. Its one10,000-element group is rejected
before normalization;the separate10,000-total-fact boundary also includes
metadata. Neither test establishes support for10,000 observed children.

Actual expiry-repair diagnostic`f04ae26bd7964cd688522584830bd8f7`
completed with clean teardown. Its enqueue transaction fell from40,029
sequential tuple visits/20,058 scans to8 sequential tuples/60 scans;
the expiry index returned zero candidates without scanning40,022 memberships.
Whole20-key probe:1,273 writes,7,922 sequential tuples,8,044 index tuples,
7,943 heap fetches,7,135 scans,61 transactions,107.548ms measurement overhead,
8,139,480cluster-WAL bytes. The actual transient probe retained60,211,024bytes
for128.271ms and crossed the tripwire while the timer missed it.
PG cache headroom/max-event,large publication and lock gates still failed.
This run predates the following publication/GC repairs and must not validate them.

The retention review also identified an OR combining current closed intervals
and unpinned retired roots,preventing a bounded indexed range and enabling
whole-population sorting. The new path resolves unchanged pin/inherited-root
eligibility under its existing scope lock,selects through the appropriate
closed-interval or primary-key index,and deletes at most998 exact tuple IDs.
The original1,000-row/1MiB/five-second ceilings and per-row fences remain.

Expanded focused`565bd3a6ab114f1cb84d8ec0ffa1bae9` retained606/612
passes plus types and six failures:four outdated restore mocks omitted the new
shared schema lock;one metadata test still expected30 redundant broad journal
rows plus20 real deltas;the new GC regression combined fixture creation and
both range checks inside one five-second test. The mocks now model lock/unlock,
the unchanged30-record fixture asserts its20 real delta journal rows,and the
new1,000-member current/retired fixtures prepare in their setup hook,with each
actual GC/index-plan assertion retaining its ordinary five-second test deadline.
No application deadline,existing fixture cardinality or assertion was skipped.
`6c0732cda225497bb4ded273c4f6742a` then passed279/279 across12 implicated
files plus backend types,with clean exact teardown.

`artifacts/phase06/final-80-migration-proof.json` records all80 actually executed
checksums,exact equality of every frozen1–75 checksum,105 public tables and326
grant rows. Migration80 is
`c97b80d1f10bee2eba45831fd4846a0826f4d210061c69060b58b1d6a963f429`.
The fresh strictly serial ladder is
`artifacts/phase06/final-repairs-validation-ladder.{py,json,log}`:
query diagnostic,expanded focused,unchanged original software gate,and
independent`all`including three separately owned full capacity attempts.
Its final receipts remain to be appended;being launched is not a pass.

## 12. Remaining broad-head work moved before publication

The80-schema repeat`f221abc78dc745578e282db0c12a306d` completed its
functional query comparison,but broad head p95 remained4,590ms
(maximum4,588.464ms). Journal/JIT repairs reduced the earlier6,922.560ms
maximum but did not satisfy the1-second bound. Expanded focused
`2ccebf82bca841fd8b779ea9e6a637c7` passed613/613 and types.
The original unchanged gate then again stopped at its180-second backend
timeout,0/5;other four checks were not run. Its check project is
`agent-control-check-fffe34111e5d410ba07dcdbe21fa49ee`.

Only the exact owned serial orchestrator was paused while that already-running
gate completed normally. It was terminated after its child had finished and
cleaned,prior to any independent-all or full attempt. The persistent ownership
and process receipt is`artifacts/phase06/publication-preparation-boundary.json`.
This avoids knowingly launching three long runs with the same unattempted
broad-publication root. No measured workload or production process was killed.

Forward81 now stages the same baseline membership rows—not a second serving
authority—in bounded250-key transactions behind a noncurrent root. The final
transaction atomically switches the sealed root and revision metadata rather
than inserting N membership/FK/index entries while holding the head lock.
All generation owner/version/epoch/lease and captured-source fences remain.
Readers cannot select the hidden root. An insert seal blocks later population
changes; new delete and lifecycle predicates protect active preparation.
Abort/cancel leaves the previous head intact; bounded GC later reclaims the
failed stage. Exact corrections,older catalog precedence,opaque IDs,compaction
references and within-baseline delta journals retain their semantics.
Compaction scratch references now leave the head transaction and are reclaimed
through existing bounded metadata retention.

The first81 validation`37827eaccc664bd2bd3b045a31e08a87` exposed a
real coupled contract:the frozen attempt guard only allowed staging-state
metadata updates,so sealing in validating state failed. It retained211passes,
70failures and two tests not reached after fixture setup failed;types passed.
The forward migration now adds only the fenced validating-to-sealed transition
and preserves the original staging-only intent/field restrictions.
`1f4422ee9f5f48dea2848ec6e8523045` then passed283/283 plus types with
clean teardown,including actual restore grants and501-member preparation as
250/250/1 batches,old-head isolation,GC protection,post-seal insert/delete
rejection,and cancelled-stage reclamation. No frozen1–75 SQL was changed.
The new real fixed-budget query diagnostic is
`artifacts/phase06/prepared-publication-query.log`;its receipt and the fresh
full serial ladder remain required before this in-progress record is final.

The protected-integrity preflight found an intentional parent-only ledger
append,not a worker edit:removing exactly the14:22UTC status checkpoint
reproduces the launch hash`a37129a4…`;the complete current ledger hash is
`68e6af3fa3e87fc853e6cacd27ffa5b6a8c2e1b4207208d6678dc74319305da4`.
`protected-integrity-before-final-runs.json` proves this append-only delta
alongside unchanged HEAD,Azure file,feed configuration,three protected images
and recovery volume. The80-source overlay has858 entries/819present/
39tombstones:38 inherited plus the explicitly receipted owned generated
bytecode deletion. Migration81 requires a subsequent final overlay.

Real81 diagnostic`59a55f04c4e74e7b80ae10936e16edfc` completed and cleaned.
Its five large head transactions had p95 upper10ms;all eight publications
had p95 upper40ms/maximum34.189ms,including pool acquisition and the complete
final transaction. End-to-end ingestion still includes bounded preparation;
that work was not renamed or subtracted from source deadlines.
Functional profiles and ordinary15-second SQL passed;PG cache headroom/max
events and the diagnostic cold-plus-warm latency gate remained failed.

The new SQL/activity evidence found a remaining6.859-second advisory wait
behind the preparation seal's whole-baseline changed-count query
(`de9aa585adea2688f0a4052101ba1388` PostgreSQL query hash). This was not
declared acceptable simply because the final head transaction became fast.
The implementation now counts changed identities within its existing250-key
preparation slices,using only a scalar accumulator and exact bounded
intersections for older-catalog/newer-exact cases. Sealing is a constant-sized
fenced metadata update;the database rejects a count larger than the prepared
root and rejects post-seal edits. The earlier81 checksum
`0afdcb4f42bf9a5fe5d13916b62c6a1e13c1bab3971b1ae0e32afa52ff4fe57c`
belongs only to the preceding measured candidate,not this repaired81 body.
Its actual migration receipt remains in that run's`query-schema.json`.

`artifacts/phase06/prepared-source-validation-ladder.{py,json,log}` is the
new serial sequence:narrow retention/publication contracts,real query,
expanded focused,original software gate,and independent`all`with three full
capacity attempts. The narrow step has completed successfully;the remaining
steps are still in progress,not an acceptance claim.

That repaired81 query run is`beafc6e6326a4f93b5bbef9fa088e04e`,completed
with clean teardown. Large head p95 upper20ms;all-publication p95 upper50ms/
maximum45.479ms. Maximum **sampled** lock wait was0.252478seconds,so the
previous6.859-second violation was not reproduced;sampled-only absence remains
`inconclusive`,not a proven lock upper bound. Three-request10k/100k diagnostic
maxima were474.497ms/2,339.771ms,including the cold request,not a warm
1,000-request qualification. Request-window heap delta5,290,568bytes passed;
observed peak-sensitive heap65,830,128bytes has query-only missing stages and
therefore cannot establish the complete-workload heap bound.
The real probe retained60,205,880bytes for103.513ms and the timer missed it.
The v2 fixed20-key probe retained61 transactions/1,273 writes:
8,203 sequential tuples,7,915 index tuples,7,794 heap fetches,7,177 scans and
196.504ms measured counter overhead. Full100k comparison remains required.

Current executed81 checksum is
`c0a4bd9593e9fac138d5057466515bd792f0c59471b566c709b96b9ac45521d5`.
The actual proof compares not only frozen1–75 but all preceding1–80 unchanged,
with105 public tables/326 grant rows. The earlier candidate proof was retained
as`initial-81-full-count-migration-proof.json`;the latest
`final-81-migration-proof.json` points to this run's immutable schema receipt.
`prepared-source-before-full.json` records859 entries/820present/39tombstones.
`prepared-source-query-summary.json` contains the complete diagnostic and probe
observations. PG cache-inclusive80% headroom and max-event gates still fail;
these performance improvements do not establish full capacity support.

## 13. Fresh unfiltered export failure and full-run source distinction

The prepared-source narrow fixture`df3398e95af24e6e9ad6b201af7ce2ec`
passed283 tests;expanded`d2d031d6d031472e9083172ca0ebeec8` passed617,
both with types/clean teardown. The original gate again stopped at180seconds.
Independent-all parent`3066c96ab54c4ac386383fbb01cc0b3c` recorded
backend600,118ms ETIMEDOUT/SIGTERM,frontend2,393passed/123,891ms,
types2,567ms,lint13,319ms and build12,445ms:4/5,not the original gate.
`prepared-source-backend-timing.json` records32 completed file summaries/
585,222ms,not coverage of the unfinished backend suite.

This unfiltered attempt reached a concrete failure not selected by the earlier
focused list:`unifiedAgentsIntegration.test.ts` published all5,000 Graph plus
5,000 native targets and5,000 canonical pairs,but its selected-count/export
test exhausted its60-second test deadline without completing the export.
Its individual15-second read/export assertions and production provider pacing
were not increased or removed. Export member joins could again flatten into
whole-population work;child cursors applied a concatenated key only after
joining facts. They now use parameterized membership/source/record lookups,
and indexed per-member ordinal seeks capped at251 candidates. These preserve
the complete source/child stream and existing250-row/512-KiB page envelope.
The large integration and existing301-child export cases are now explicitly
selected in both capacity-focused/retention tooling. Their post-repair
execution remains required after resource qualification,not concurrently.

The same all invocation passed lifecycle
`73a2c04e7e544775ab27f9f0e4cb2a44`,restore
`260a9614f9eb41c682478ce0fed2ee9f`,compiled restart
`7d42d438d9a84f7797c06b6a82aa2352`,and browser
`5ac7c44a60c34ced9b0d670de6120735`(509passed/nine existing skips).
These software/auxiliary images predate the export repair.

**Own orchestration incident:**a guarded attempt to pause before capacity first
identified the PowerShell shim and stopped before signalling it. The verified
underlying all coordinator was then paused while its browser child continued.
The child remained running;PowerShell-managed output forwarding may require
that parent,so it was resumed rather than assuming timing isolation. No
termination signal was sent. Browser eventually passed and cleaned;its
ten-minute elapsed time includes possible pause impact and is not an
unaffected performance benchmark. Full ownership/timing and guarded refusal
receipts are in`export-repair-boundary.json`.

All continued normally. First full attempt
`328624ccc29a4a79a92fcd0c852fedfd` began after browser cleanup and its
source/image manifest captures the export repair
(`inventoryExports.ts` SHA`a411ea45cdb111a51f4e77b40a0de95e80cf86c4f83875bf44f5c38525b47d9a`)
and repaired81 schema. It was **not interrupted**. Its full profiles,and the
next two fresh full attempts,remain in progress;post-export focused and
software-source distinctions must be retained in the final handoff.

##14. Current full diagnosis and unverified next-source repairs

This section is an in-progress checkpoint,not acceptance or a capacity pass.
Full`328624ccc29a4a79a92fcd0c852fedfd` remains the81-schema image described
above. It has not been interrupted. Its main100k collectors,1m sparse
relationships,199,998 canonical oracle,source+1 rejection and100k facet
profile completed. Its HTTP profile failed at the900-second export deadline;
the separately preserved controller receipt reports1,008 requests and935
failures. Browser response wait and the600-second selected cursor traversal
also failed. All five replacement cycles reached two real collector and two
export admissions; completion/results remain pending.

`first-full-http-query-diagnosis.json` records actual HTTP-stage SQL and
admission evidence. Whole-directory/activity projections were repeatedly
executed merely to obtain inventory person labels; a matched-activity count
also ran inside each capture. Individual statements took about5seconds and
scope/principal/admission waits reached11–12seconds.
`first-full-current-slow-queries.json` separately retains10–15second
Users/report projections. The observed v2 fixed20-key probe had identical
1,273 writes at10k/100k and WAL8,295,048/8,218,152 bytes, but sequential reads
grew8,160→20,024. `first-full-v2-read-amplification.json` identifies retained
generation/attempt/root metadata as the excess; this is a real failed read
amplification gate,not the withdrawn v1 attribution.

The next source now contains,**pending real execution and verification**:

-82:transactional derived scope byte charges,live/positive-charge indexes,
  and scoped indexed admission/fencing/reconciliation plans. Charge-changing
  retention claims the scope before the generation and accounts for the
  trigger's additional row/bytes inside the original quota. Runtime guards
  prevent direct charge edits; restore closes helper execution privileges.
-83:the exact PostgreSQL normalized directory/report name index. Activity
  matching groups both sides' aliases without a duplicate-key cross product.
  Metadata caches only32 immutable generation-pair counts. Inventory labels
  now fetch exact directory identities without activity projection.
-Selected Users aggregates:32×16KiB maximum per-pool immutable results,
  always behind existing selected-read fences. Direct-filter/name pages
  preselect101 keys and retain complete alias counts and global unresolved
  evidence. Unsupported fast-path filters continue through the full semantic
  query. Known zero/null, mixed aliases and reverse cursors have new regression
  assertions.
-Mixed canonical source exports filter source kind before their indexed
  cursor seek. The earlier member/ordinal-child repair is retained.
-The HTTP controller now measures one cold selection separately and still
  issues1,008 warm concurrent requests; cold failure is fatal,not retried.
  A harness-only report oracle defect used`row.identity`instead of the actual
  `row.directory`; the exact DTO consumer and a regression are corrected.
  Earlier failures remain retained and are not retroactively reclassified.
-A practical unchanged-software-gate cost repair: isolated tests clone a
  fully migrated,granted,verified,connection-disabled template bound to the
  owned base database and compiled migration vector. Every leaf is independent
  and bootstrap/runtime-verified; migration tests remain fresh/empty.
  Ownership mismatches fail closed. No test cardinality,assertion,deadline,
  file parallelism or production database behavior is relaxed.
-The physical observer keeps v2 before/after subtraction for every tagged
  committed transaction, but combines each endpoint's counter/LSN/operation
  data into one bounded query instead of two. The existing row-wise snapshot
  remains an independent real-PostgreSQL calibration. Actual overhead and WAL
  receipts,not presumed speedups,are required on the next source.

Language-server tracing shows the changed source/report SQL builders are
runtime query dependencies,not frozen migration composition. Actual compiled
1–81 checksum comparison and new82/83 execution remain required; source
inspection is not that proof. Editor diagnostics/diff checks are clear so far,
but do not constitute functional validation.

Owned watcher`stop-before-unverified-next-full.py`(PID4616) waits for the
first full result and verified clean resource removal. It may stop only the
next unexecuted owned image build of driver66497/parent66496,not the current
measurement. Its receipt is`unverified-next-full-boundary.json`. This prevents
automatic next images from qualifying unverified82/83 changes before focused
checks. The earlier PowerShell coordinator remains resumed. No production,
commit,registry install,host tuning or protected-resource cleanup occurred.
Queued driver`read-path-repairs-validation-ladder.py`(PID5476,shell
`phase06-read-path-repairs-ladder`) also waits for the prior all driver to
finish and checks all prior exact projects are absent before starting tests.
It then runs focused→query→unchanged software gate→independent all serially,
stopping for repair if focused fails. No independent test workload overlaps
the current full measurement.

**Subsequent first-full receipts:**both sparse sweeps actually completed
5,000 batches×20 keys,with100,000 inserted/closed/changed and independently
verified changed values each. Their expected/actual streamed checksums match:
`971a3a40fb2fddb8858f7d59925d5d73f59e942d2981cead25e33ee1e7c45b92`
and`c4879187ee5feb75f5a52bf38be51fb151230d9fe9bfafcaa4af4489032e2e33`.
Each published250 canonical jobs; maximum observed publication gap was
55,702.201ms,with final convergence7.777/347.250ms. Whole-sweep cluster WAL
was28,951,622,112/30,444,521,400 bytes,including concurrent/maintenance WAL.
The full detail profile nevertheless **failed** after5,450,716ms because no
sample saw simultaneous active and pending work. Receipts:
`first-full-completed-detail-sweeps.json`,`first-full-sweep-receipt.json`.
The five replacement cycles all admitted2+2 but failed acquisition under
reader load; none completed. Per-cycle reader failures were214/212/202/205/205.
`first-full-replacement-cycles.json`preserves every nested failure.

The next source makes the active/pending scenario deterministic without
inventing queue state: the first real worker of each sweep pauses at its
second authorization callback,after staging and outside any SQL transaction,
while the next real20-key provider update publishes and enqueues. The harness
reads active+pending+one generation,then releases publication. Its readiness
wait is30seconds; real leases/heartbeat and all5,000 batches remain unchanged.
The existing real reconciliation regression now covers both pre-work and
pre-publication authorization pauses. This repair and the added per-cycle
cold-page receipts remain unverified until the queued focused run.

### 15. Completed first-full gates and new-source validation

Full`328624ccc29a4a79a92fcd0c852fedfd`finished and its exact fixture was
removed at2026-10-01T22:48:44Z. The next unexecuted image build
`9bc1ecebf13541b7b4569a2942fa699f`was stopped only after that teardown;
its containers/networks/volumes were absent before and after. Both orchestration
drivers subsequently ended. This was not an interrupted full measurement.
`first-full-formal-gates.json`contains every original formal status:
heap coverage and both complete changed-value sweeps passed, but overall
qualification **failed**, including charged memory, PostgreSQL max events,
ordinary SQL, admission, lock waits, most latency classes, and read amplification.
Five-cycle settling and10k→100k request working-set growth are inconclusive.

Actual Node24.20.0/V8`13.6.233.17-node.53`workload PID327 had59,372
timer samples. Sampled heap83,150,776; raw-GC preheap85,369,056;
live-stage85,362,840; combined observed heap85,369,056bytes. There were
16,512 rawGC records,16,422 workload records,zero incomplete/dropped records,
no missing required stages,and a successful real burst probe. Timer peaks
remain lower bounds. App charged peak1,441,538,048/1,610,612,736bytes;
PostgreSQL1,076,621,312/1,073,741,824bytes,with4,401,776 max events
but zero OOM/oom_kill. No container OOM/restart occurred. Maximum sampled
lock wait12.390838seconds; ordinarySQL15,105.403ms;1,038 reader rejections.
Publicationp95upper80ms/max710.125ms passed. File-cache maxima were
1,186,693,120app and1,035,788,288PostgreSQL bytes; no cache subtraction
or cgroup-to-heap substitution is made. The1,139,877,980-byte backup file
is part of the measured app-charged filesystem work,not free controller memory.

New-source focused attempts`2348cf40a7fa4797bdb5754745d0b95b`and
`74d1036f0f90440497e392d09b171cfa`failed the83 readiness expression
checker. Narrow`793e32450ecc40569994c18753730d93`captured PostgreSQL's
uppercase`NORMALIZE`deparser. The corrected case-insensitive expression
check still verifies the exact index,table,validity,NFKC and actualCcollations.
Real`ced7909216984ed2b194a82e5cdcca11`then passed135tests+types,
including all83 executable migrations and isolated,sealed schema-template
cloning/grants/no shared rows. The queued ladder stopped after its first
failure; it did not silently continue to query/full qualification.

Comprehensive`8e4d8261002b4658ad4459855c6afa1c`completed655passed/
12failed out of667,types passed,and exact teardown completed. One new
accounting test omitted the append ordinal; its leaked active writer caused
nine subsequent admission failures in the same test file. The ordinal is
repaired,not an admission relaxation. Two independent cost failures remain:
the unknown-role4,140-row native last page5700ms exceeded its unchanged5s
test deadline; the5,000-logical/10,000-source export54627ms exceeded its
unchanged15s assertion(150reads/51634ms,50,000CSVrows,32,002,324bytes).

The export diagnosis found transaction-local JIT settings applied only while
initializing a cached context; later page/child transactions reverted to JIT,
and member seeks inherited the broad page's disabled nested-loop setting.
Every export read now independently disables JIT and pointwise member/child
lookups restore nested-loop planning. Bounded per-query integration evidence
is added without relaxing deadlines/cardinality.

`first-full-retention-query-diagnosis.json`shows metadata-frontier deletes
up to780ms per50-row slice; old membership intervals reached zero only at
572216ms,leaving orphan content at the600s deadline. Metadata GC now
selects one completed inactive scoped worker,then seeks its indexed keys.
Journal/request slices use indexed revision/sequence order instead of
repeated physical-tuple sorting. Active-worker protection and unchanged
1000row/1MiB/5s budgets have new real regressions. Backup failures now
report elapsed/unchanged120s timeout/killed status without database payloads.
The previous large restore cancellation during inventory-factCOPY remains
a failed restore; no timeout/resource increase or selective restore was made.

Narrow`capacity-cost`run`0af2dec4ec074e20a7bf2bd626b4e54e`is currently
executing these repairs serially in its owned disposable fixture. New fixes
are not yet claimed functionally accepted or full-capacity qualified.

**Cost follow-up:**`0af2dec4ec074e20a7bf2bd626b4e54e`completed170passed/
1failed,types passed,and clean teardown. Accounting/active-worker-GC/retention/
native-last-page/export semantics passed; the sole unchanged failure was the
54,078ms large export. The new query observer attributed42,442ms of that cost
to50 bounded page-projection queries,5,105ms to50 enrichment queries,and only
754/676ms to child/member queries. Thus JIT initialization alone was not
misreported as the repair.

The core projection still forced broad hash/merge planning after selecting at
most101 exact IDs. The next repair keeps indexed nested-loop planning for that
bounded projection and bounded enrichment,while full count/summary relations
retain set-based planning. Actual`fa743d455f7944bbaf24c3b9f838aba9`then
measured the same5,000agents/10,000sources/50,000CSVrows/32,002,324bytes at
12,604ms,including150readtransactions/9,559ms. Its50 projection queries
totaled6,219ms(max171.268ms),not42,442ms. The original15-second assertion
passed without larger resources,deadline,batches or fewer records.

`bounded-reader-validation-ladder.py`waits for that integration's successful
result and verifies its exact containers/networks/volumes are absent before
running focused→10k/100kquery→unchangedsoftwaregate→independentall. A focused
functional failure stops before full qualification; other failures are retained
without skipping mandatory all/auxiliary/full attempts. No broad suites run
concurrently. Driver evidence is`bounded-reader-validation-driver.log`.

The integration completed29/29 tests+types in93.25seconds with clean teardown.
Before the next focused fixture's cleanup,a read-only query in its verified
owned database captured all83 **actually executed** migration checksums,
105public tables,and`agentcontrol_app`schemaCREATE=false:
`bounded-read-actual-migrations.json`. Independent comparison with the
accepted phase05 actual vector verifies every frozen1–75 checksum:
`bounded-read-frozen-migrations-verified.json`. New82 is
`b6156b4d7f72d9c843a70b0c69806d75557cb167852581cb41b9be6a9f7da430`;
83 is`636636b163aea23bc0502a2af8bd94c34512bd48b0e4d36c28f8b0a4fc97f6d0`.
All three protected image IDs still match. The current source overlay
`bounded-read-source-before-full.json`has863entries/824present/39tombstones,
SHA`00df30102db0cf830fdb3e3fc72df6e6fee0006e07f044f9f3ec71aad68e851c`.
Subsequent completion prose is an explicit docs-only delta.

The subsequent comprehensive`f7b2b71cfe5646019dee7356cca177c5`finished
666passed/1failed+types in480.45s with clean teardown. The serial ladder
correctly stopped before query/software/full work. Its sole failure was the
same unchanged export assertion at30,467ms;50 projections now totaled
24,602ms with one8,224ms query. The narrow12,604ms result is retained,
not promoted into a reliable performance qualification. To remove the
remaining planner sensitivity,the next source materializes only the at-most
101 selected inventory/fact rows once and uses exact canonical-source
lateral seeks. Unbounded full relations remain set-based. The integration
now also emits actual`EXPLAIN(ANALYZE,BUFFERS,WAL,SETTINGS)`after the
unchanged timed assertion. This repair is being verified by
`materialized-bounded-projection-integration.log`; final full evidence remains
pending.

Materialization experiment`3b68527a0224480c96d633a5a2b6e9a6`completed
29/29 integration tests+types in84.83seconds with clean teardown. The same
full export now took7,083ms(150reads/4,429ms,unchanged50,000CSVrows/
32,002,324bytes). Its actual bounded projection plan executed19.813ms,
with101selected/projected rows,no temp reads/writes,7,487shared hits and
815shared reads. No whole inventory/source-table sequential scan appears;
small scope/root/attempt control relations remain planner-selected sequential
scans. The preserved plan is`materialized-projection-actual-plan.json`;
this statement does not substitute for the mandatory100k comparison.
The serial driver now accepts exact prior fixture/prefix arguments and is
running the new focused→query→softwaregate→all ladder with
`--prior 3b68527a0224480c96d633a5a2b6e9a6 --prefix materialized-reader`.
Nine earlier exact projects,including historical2669/1da and the stopped9bc
build boundary,have no containers/networks/volumes:
`bounded-reader-prior-cleanup-verified.json`. No cleanup action was necessary.

Comprehensive`9006eb53fef84f13be0ca90486300f7d`then passed all667tests
and backend types in459.95seconds with clean teardown. Its repeated unchanged
large export passed at7,907ms(150reads/5,175ms,unchanged50,000rows/
32,002,324bytes). The serial ladder advanced to real query attempt
`f90bf3bd8d7e4b81b3c3edc9ffdbffb3`. Its real warmed transient probe passed:
60,185,688extra retained bytes,82.800ms whole burst/release/GC,
79,534,048liveheap against36,125,576tripwire,timer-onlymaximum16,596,560.
This probe's expected missing workload stages do not qualify the full
workload heap by themselves. PostgreSQL17.11 effective settings remain
32MiBshared/4MiBwork/64MiBmaintenance/no parallel gather/15s statement;
backing disk free762,912,276KiB exceeds64GiB. Query/full outcomes remain
pending and are not inferred from the successful probe or focused tests.

Query`f90bf3bd8d7e4b81b3c3edc9ffdbffb3`completed and cleaned. The
functional comparison passed,but formal diagnostic status is**failed**:
100k first/cold page3,079.661ms exceeds its diagnostic2s gate; subsequent
100k pages93.917/22.024ms.10k pages434.935/174.725/27.994ms.
The10k→100k request working-set delta10,762,696bytes passes64MiB.
OrdinarySQLmaximum4,692.140ms passes15s; head-swapp95upper20ms/
max10.884ms passes1s. The actual10k20-key probe now reads10sequential
tuples(not the prior8,160),9,723index tuples/9,488heap fetches/7,202scans;
1,277writes(1,169insert/106update/2delete),61transactions and
8,232,912WALbytes. The100k probe/amplification is not run in query mode.

PostgreSQLchargedpeak1,074,094,080bytes/max31,505events and sampled
lockwait2.461252s fail their unchanged gates,without OOM/oom_kill/restart.
Appchargedpeak219,164,672bytes passes80%. Query-only missing import/export
stage coverage makes its heap bound inconclusive; no passing full-heap
claim is derived from it. The cold summary produced65,771,244tempbytes/
8tempfiles. Exact receipts are`materialized-query-summary.json`and the
original run directory. The driver continued to the unchanged software gate,
then must attempt independent all and three owned full profiles.

The unchanged original software gate`6ad96b5fba694008b78de1e7fdf7f63e`
again failed backend at the180-second`spawnSync npm ETIMEDOUT`boundary:
**0/5 original checks**,other four not run,no OOM. Its actual nested fixture
was`agent-control-check-c213440193bd4b099f064da45d4bea36`;diagnostics,
cgroups/mounts and cleanup are under
`artifacts/software-checks/c213440193bd4b099f064da45d4bea36`.
Template cloning actually executed all83migrations(395ms)then independent
leaf clones; this repair and the faster export did not make the original
gate pass. Independent`all`started afterward as
`1404c60fd22541feabff1fc24d96d594`,not concurrently,and retains its
separate unchanged600-second backend command bound. Neither focused667,
its backend types,nor any eventual independent all result is an original
five-check pass. Phase07 still owns repairing that refusal before any
production stop/reset/deployment.

### 16. Independent all and checkpoint-frequency root

Independent`1404c60fd22541feabff1fc24d96d594`software completed**4/5**:
backend600,057ms/ETIMEDOUT/SIGTERM;frontend2,393passed/120,411ms;
types2,597ms;lint13,241ms;build11,713ms. It additionally recorded a
60,006ms timeout in the unchanged5,000-source Graph publication test;
that test passed in the prior narrow and comprehensive focused fixtures.
No OOM occurred. Exact results:`materialized-independent-checks.json`.
This remains separate from the original180-second0/5 gate.

Already-captured PostgreSQL diagnostics reveal a concrete isolated-fixture
cost root: within23:53–23:54UTC,207unique checkpoint log lines include
73too-frequent warnings,with intervals as low as0–1seconds. The ordinary
64MiB WAL target was inherited into the disk-backed large fixture and
repeatedly forced WAL checkpoints during that timeout. Evidence:
`aggregate-checkpoint-storm-diagnosis.json`.

The repair changes **only the campaign-owned**
`compose.large-tenant-test.yaml`checkpoint disk target to1GiB,PostgreSQL's
ordinary default.32MiBshared buffers,32MiBminimumWAL,all hard memory/CPU,
the180/600s gates,fixtures,assertions and backend file serialization remain
unchanged. The ordinary small-fixture`compose.yaml`64MiB WAL target and
production resources are untouched. Merged Compose validation confirms
app1,536MiB/1.5CPU andPG1,024MiB/0.5CPU:
`checkpoint-headroom-config.json`. It is **not** actual runtime proof yet.
The separate capacity model already used default1GiBmaxWAL;its resource
model is unchanged. Capacity capture now additionally records effective
WAL/checkpoint/compression settings. All12checked-in parser/resource-model
tests pass; editor diagnostics and whitespace checks are clear.

New fixture regressions preserve the ordinary configuration and ensure
`capacity-software`contains exactly the five independent`all`software
commands. That retest selector does not replace original`software-gate`,
the actual`all`run or its mandatory auxiliaries/full profiles. The queued
`checkpoint-repair-validation.py`waits until the current all/full cohort
finishes and every exact project is absent,then runs schema→originalgate→
independentfivecommands→allbrowser serially. This avoids overlapping
software tests with the measured capacity fixture and does not repeat three
full runs merely for a test-fixture-only WAL change. No checkpoint repair
success is claimed before those actual attempts.

Current-runtime all auxiliaries already passed:
`576c658c039f4c1eb729bb783d926f67`lifecycle410backend/410frontend plus
types/lint;`e9919b02facd417b840157f4cfc92985`guardedrestore6tests+types;
`fab57ffb3ee14f21bb3e9ba475417e57`compiledrestart. Their fixtures cleaned.
These precede the checkpoint override and retain that source distinction.
The large full-data restore remains a separate mandatory attempt.

###17. Explicit HTTP defaults and remaining control scans

This supersedes the preceding coordinator's **queued** status,not its retained
evidence. The checkpoint-only coordinator was stopped while still waiting;
it launched no tests. Browser`fd492f70b4c0471eac6d2a8c11b23ab9`subsequently
passed509/nine existing skips plus its fixture test,with clean teardown.

**Own source/build incident:**full attempt
`c25dc8db84784d75b502e557b2228053`correctly refused an application/source
checksum mismatch in`largeTenantFixture.test.ts`while that file was edited
during image construction. No workload command ran; its command list is
empty and cleanup errors are empty. It is not a full workload or a pass.
`checkpoint-edit-build-boundary.json`retains the exact hashes/timing.

The next attempt`bea6e9dfeaa744fabe47166f844d4a41`passed source/image proof
and is an immutable **schema83** candidate. Its actual probe retained
60,187,328bytes for123.055ms. Main100k source profiles,10k opposing scope,
100k/200k/1m reports,199,998 canonical oracle,+1 source rejection and100k
facets passed. Its HTTP profile had853failed requests of1,008;browser's
20-second response wait failed. The real slow-reader export nevertheless
completed47,102,840bytes/300,013rows/539chunks with two status polls and
disconnect cancellation. The full100k cursor oracle subsequently passed:
100,000rows/1,007requests,checksum
`5eae6164b792be373413ca8dc17f8fcf6bc5ae5ed14cb14d09aa971d2a3ec70e`,
first/middle/last/reverse plus three filters and unchanged selection lease.
Five replacements and remaining full profiles are still running.

Two measured,distinct runtime roots now have **unverified next-source**
repairs:

1. The HTTP parser always supplies`source:"all"`,but only an omitted source
   had retained bounded key preselection/summary caching. Real requests
   repeatedly ran3,814ms summaries/1,431ms pages and accumulated10.5s scope
   waits,while direct`capture({})`diagnostics misleadingly avoided the defect.
   Explicit`source:"all"`now remains neutral. Literal facet`"all"`values
   remain filters. Native/canonical regression pages verify at-most-four
   projected keys for a three-row request and pool-shared summary reuse;
   the10k/100k diagnostic now records normal explicit HTTP defaults.
2. The identical20-key physical probe retained1,277writes at both scales.
   Index reads9,761→10,358,heap fetches9,523→10,060,scans7,205→7,210 and
   WAL8,254,464→7,976,416bytes met their amplification ceilings. Sequential
   tuple reads10→26(**2.6×**)did not. No small-count waiver applies.
   Exact SQL trails locate unindexed tenant admission and two independently
   opened root-validation transactions. Forward migration84 supplies the
   partial tenant admission index; validation sets its own indexed/JIT
   planning. Tests retain the exact20/plus-one limit and fail readiness for a
   missing or pending-excluding index. Migrations1–83 are unchanged.

`bea6-{http-sql-diagnosis,http-nonlock-sql,fixed-probe-amplification,
sequential-amplification-root,sequential-transactions}.json`retain the
measurements. The new source is **not** attributed to the running83image.
The exact-process boundary watcher lets that complete workload finish and
clean normally,then stops only the next unexecuted image build before any
fixture resource exists. Fresh focused/query/schema/original/independent
and three-full-attempt qualification is required for the repaired source.

###18. Full-cycle report projection root, pending qualification

The running83candidate completed all five replacement attempts: both real
collectors and both exports were admitted each time, but the cycles failed.
`bea6-cycle-query-diagnosis.json`retains the actual failures and SQL templates.
Warmup official-user/relationship pages took roughly10–13seconds; the
official-agent combined page/envelope exceeded its unchanged15-second
statement bound. Repeated whole-report materialization then held reader
fences and caused5-second pool acquisition and source/fence failures.
Fixing inventory's`source=all`alone cannot fix that separate report path.

The next source therefore also contains **unverified** report repairs:
immutable counts prove complete unique primary coverage before an at-most101
fact-key name seek; bridge-only/duplicate-primary selections retain the full
relation. Selected user enrichment preserves global directory/report alias
ambiguity. Migration85 adds bounded128-character normalized-name-prefix
indexes,without truncating full names,identities or cursor ordering. New real
fixture regressions exercise all three endpoints,ascending/descending/reverse
pages,complete independent ID sets,accepted512-character names whose NFKC
sort keys approach6KiB and differ past the index prefix,and bridge-only fallbacks.

Large official-agent cold pages split page/summary/analytics into separate
statements inside the same selected repeatable-read transaction. No SQL,
request,export or fixture deadline is increased. The capacity plan observer
remains capped at eight queries and captures cold/contended page plans before
selection invalidation,not after GC could make the supposedly100k query empty.
Editor diagnostics and whitespace checks pass; actual focused/large-query
execution is deferred until the immutable83full workload finishes normally.
Its separate merge/split adversary passed and its100k sparse-detail baseline
has started. No85runtime success or unchanged-source full pass is claimed.

###19. Lease-process heap coverage correction

A coverage audit found that actual lease-worker memory files existed but the
formal heap parser only consumed the primary workload's timer/stage file.
The child file's pool was also absent and intentional SIGTERM left no terminal
dropped-record receipt. **Earlier full heap-pass labels do not prove the
complete app/worker bound.**`full3286-worker-coverage-review.json`preserves a
stricter analysis: observed peak remains85,369,056bytes, but its two worker
files each have one sample,no pool counters,no terminal receipt and unknown
dropped counts. Its full heap gate is **inconclusive**,not passed. Original
run artifacts are not overwritten.

The next source records the real worker pool and terminal telemetry before
re-raising the same SIGTERM. No database cleanup, abort or publication is
performed by that hook,so the61-second real expiry/old-owner/takeover proof
remains required. The parser now requires both lease-only workers' identified
SQL checkpoints,raw GC,samples,pool/memory fields and terminal zero-drop
receipts,with per-process scope explicitly recorded. Their observations join
the separate sampled/stage/GC maxima; missing observations are not zeros.
The checked-in pure parser suite passes13tests,including missing terminal,
pool/memory counter and over-limit-worker cases. Actual child termination
regressions and full real-clock qualification remain queued,not passed.

The already-running83application is unchanged. Its eventual host-side
evaluation will use this stricter on-disk parser and must retain that source
distinction; it cannot acquire the new worker shutdown/pool telemetry by
relabeling its old image.

###20. Complete detail sweeps, precise GC rewind and exact-read repair

The immutable83run completed both actual5,000×20 changed-value sweeps.
Each wrote,closed,changed and independently verified100,000keys,with
250canonical publications,real active+pending overlap and zero mismatches.
WAL intervals were29,113,739,248/30,869,208,776bytes; catch-up was
5.668916/102.377166ms. Maximum recorded publication gap was51,120.923981ms.
Checksums are the independently expected
`971a3a40fb2fddb8858f7d59925d5d73f59e942d2981cead25e33ee1e7c45b92`
and`c4879187ee5feb75f5a52bf38be51fb151230d9fe9bfafcaa4af4489032e2e33`.
These measured successes do not erase its other failed profiles.

Retention failed after602,510ms/1,721iterations. Membership intervals were
zero and all recorded quota/reservation/scoped-charge discrepancy counts
were zero,but orphan-key traversal still found at least one. A bounded,
read-only post-failure diagnosis verified the exact owned PostgreSQL
container/volume/no published ports,used198.043ms and observed **three total
database connections including itself**. Its two examples each retained
24facts: keys`package-000108`/`package-000112`were already behind the
same generation's`package-006974`GC cursor. This extra diagnostic and its
cost are explicit,not silently treated as an uncontaminated performance pass.
Receipt:`bea6-bounded-orphan-diagnostic.json`.

Forward migration86 now schedules an inclusive rewind to the earliest
released key per source scope when any of the four real reference relations
removes/replaces a reference,or staging keys become collectable. No
reference or pin check is removed. Transition tables coalesce updates and
lock progress rows in scope order; there is no dataset clone or unbounded
JavaScript worklist. Generic lifecycle slices reserve a cursor update per
distinct affected scope,then include actual trigger row/byte counters.
Membership cleanup reserves the same work by reducing998to997 candidate
intervals. The1,000-row/1MiB/five-second ceiling is unchanged. New real
tests cover reference release behind an advanced cursor,failed staging,
missing-trigger readiness and exact cursor-budget accounting.

The real retry profile then failed its initial acquisition after11,888ms,
before600seconds elapsed. Actual20-key exact inventory reads each took
roughly560–601ms. That previously unchanged path still expanded an
unrestricted union and allowed JIT. It now uses local JIT-off,indexed
parameterized seeks and the captured scope/domain,with a retained-generation
regression and actual plan receipt. Its full600-second proof must be rerun;
the earlier902run's real wait remains separate historical evidence.

The first repair coordinator was stopped **while waiting**,before launching
any test. A new`capacity-core`selection precedes comprehensive focused/query/
original-gate/independent-all requalification.86and the exact-read repair
are not yet runtime-validated,and the old83full run is still allowed to finish
normally. Earlier1–85migration bodies are unchanged by86.

## 21. Actual86 core proof and the remaining selected-read root

The preceding86 paragraph was an in-flight record. The83full fixture
`bea6e9dfeaa744fabe47166f844d4a41` subsequently completed every profile attempt
and cleaned normally. Its next unexecuted build was stopped only at the verified
empty-resource boundary; no full workload was interrupted.

Fresh core`9a13223086bd4ce09427fcda17873af6` passed236tests and backend types.
The real natural cursor rewind,failed-staging rewind,missing-trigger check,
native/canonical`source=all`pages and twenty-key indexed exact-read plan all
executed. `reference-rewind-actual-migrations.json` contains the executed86-step
vector; `reference-rewind-migration-comparison.json` proves all previous1–83
checksums identical,including every frozen1–75 migration. This is a focused
proof,not full-capacity acceptance.

The preceding core failures remain preserved: duplicate test imports and an
incomplete schema mock; three accidentally nested tests; then a too-short test
cursor secret and a nonexistent test-only`store.begin`call. The latter now uses
the real `execute`/failed-staging path. Each failure cleaned; types alone did
not detect these test mistakes. Logs are `reference-rewind-capacity-core.log`
and `reference-rewind-core-repair-{1,2,3}.log`.

The83full run's two sweeps each really completed5,000×20 changed keys,100,000
verified values and250canonical publications. **Their concurrent profile did
not pass.** Both readers and the export rejected with`data_read_conflict`;
the collector rejected after PostgreSQL's unchanged five-second transaction
timeout,including its failed rollback. Thus those completed sweep counts are
not evidence of sustained reader/export/GC pressure. Exact results are retained
in `bea6-detail-background-results.json`.

Root reproduction`e1c16d2fb32246a7813db61abca15422` deterministically observed
scope row versions3326→3328,3331→3332 and3336→3337 during ordinary generation
begin,abort and collection. All three genuine selected repeatable-read
transactions then failed with`40001`/`data_read_conflict`. Generation begin
performed a no-op scope UPSERT; quota accounting also rewrote the authorization
epoch row. Forward87 now moves only derived quota into a runtime-read-only
counter relation,removes the obsolete counter column,and reuses existing scopes
without writing them. Authorization,epoch locks,repeatable read,admission limits
and the explicit no-callback-replay conflict contract remain unchanged.

That same reproduction caught a coupled86 accounting bug: adding actual cursor
writes discarded already-reserved quota-counter rows. The unchanged retention
assertion observed5rather than6physical writes. Lifecycle accounting now adds
actual cursor writes to the base physical-row charge rather than the deleted-row
count. The expanded selector's expected command list also required updating.
The before log is `authorization-quota-before.log`;87and this repair still
require fresh runtime validation. Full concurrency/600-second/retention and all
remaining qualification gates are still open.

The first87runtime fixture`ef824b8db53544988f5d4e3bc253201c` subsequently
passed279backend tests in53,991ms and types in2,285ms. All three selected-read
regressions retained authorization row version3322 before/after and completed
under real repeatable read; the unchanged six-write retention assertion passed.
`authorization-quota-actual-migrations.json` proves actual1–86unchanged and87
checksum`dee5793b91d6bc0a020b413c9d45ab85c59f580a07c9dd96abaa72214a0e5488`.
No synthetic replay or weakened isolation was used.

The collector now attempts,never waits for,the existing sync/scope fences.
Busy scopes remain eligible on subsequent fair traversals; reads and mutation
fences are unchanged. Real tests hold each fence and exercise all three
collection paths before releasing it. The detail harness also keeps known
transiently rejected background operations running,records every rejection,
and still fails the concurrent profile if any occurred. Exports repeat with
real backpressure throughout the sweeps and release their own completed export
pins through the existing cancellation API. Fatal invariant errors are not
reclassified as transient cleanup failures. The previously stopped background
operations are therefore no longer silently absent for the rest of a sweep.
These post-core changes still require their fresh checked-in validation and
the full-sized workload; earlier sweep counts remain explicitly insufficient.

Post-repair core`0a5817dba01b4448939caabd29e77fdc` passed all283tests,
including the held-fence and continuing-background regressions. Its typecheck
correctly rejected the now-unused`lockDataScope`import; the import is removed.
This failed overall attempt remains intact in`continuous-pressure-core.log`.
Known transient retries have a minimum100ms backoff rather than an admission
failure spin. A fresh core→focused→query→original-gate→independent-all chain
must validate this final delta before any further capacity support claim.

Fresh core`a721b297f0664d1297ecdfe1bee832ad` passed283tests in53,437ms and
types in2,388ms; `continuous-pressure-core-verified.json` also verifies the
entire actual1–87vector. The following comprehensive focused fixture
`c55e2334a0a342afacde625f7c09065b` then failed15of800tests
(785passed;423,899ms),with types passing. Its coordinator correctly stopped
before query/original-gate/all/full execution.

The broader tests found real contract omissions:87needed an explicit
`data_generation_charges:["scope_id"]`backup inventory entry; historical
migration-grant fixtures needed the existing presence-guard pattern; lifecycle
SQL mocks needed explicit new physical/cursor counters. Most importantly,the
official-report query calculated `count_primary_complete` but omitted it from
the returned projection,so the new name-page optimization never activated.
The three full-name/cursor tests correctly observed zero bounded queries.
That result column is now returned; the optimization still needs its real
first execution and semantic verification.

The unchanged50-page/5,000-package Graph publication assertion also timed out:
actual publication completed64,183ms after start,not within its60,000ms bound.
Its following50,000-row export passed at6,237ms,so that earlier export repair
is not the remaining publication cost. A bounded128-statement diagnostic now
attributes actual SQL timings only to the Graph async context,even if a timed
out test overlaps its successor. It does not change pacing,cardinality or
deadlines. The failed focused log remains
`continuous-pressure-final-capacity-focused.log`; fresh cost diagnosis and
focused revalidation are pending.

The focused cost fixture`2a2d78b1ae654192bf4f88650f534f4e` passed173tests
in114,573ms and types in2,289ms. Its unchanged Graph publication took
15,877ms:50actual fetches consumed26.117ms,while700bounded fact inserts
accounted for13,872.976ms and170,000physical fact rows. No query class was
dropped from the bounded diagnostic. `graph-publication-cost-detail.json`
retains every class and `graph-publication-cost.log` the complete run.
This standalone result does **not** explain away the broader64,183ms failure
or prove the original gate; the fresh comprehensive run retains the same
instrumentation to identify any suite/resource interaction.

The next comprehensive fixture`bc049aee49f246c6925ce73d1e14966a` passed798
of800tests (421,939ms) and types. All three bounded official-report paging
tests now executed their optimized paths and passed their complete-ID,
full-name and reverse-cursor oracles. Graph publication also passed at
55,226ms; its170,000fact rows took52,061.704ms in700inserts. The two remaining
failures were isolated restores still revoking the function87had removed.
That stale helper name is removed,while the surviving security-definer charge
helper remains explicitly revoked from PUBLIC before restored-authority review.

Fresh isolated restore`d55976d1746e4dbca28eb720f1a76f2c` passed all6restore/
backup tests in8,608ms and types in2,447ms. Both previously failing real
snapshot/content/schema restores now complete. Evidence:
`quota-schema-restore-repair.log`. Neither focused ladder proceeded beyond
its functional failure; no query,original-gate,independent-all or full87
result is claimed by these targeted repairs.

## 22. Source87 qualification and measured next repairs

Comprehensive`55372811d3744fb5ae5fc1b6e17f99f8` passed all800tests
(374,695ms) and types (2,349ms). Query fixture
`6d6f34c0bd824be7829cbc3313c9d892` passed its real **60,162,088-byte**
retained-heap probe in83.886ms,with the timer missing the tripwire. The three
page samples at10k/100k had maxima253.749/1,817.465ms and a19,363,576-byte
request working-set delta. Functional comparison passed. PostgreSQL charged
peak1,074,106,368/1,073,741,824bytes,file-cache maximum1,011,621,888bytes
and27,411max-events fail the formal envelope. Query-only heap coverage is
inconclusive,not a full heap-bound pass. Exact receipt:
`restored-projection-query-summary.json`.

The unchanged original gate`2ef1898a869b45cfbc46b2d0e3991ff6`
(nested`e91a30d45f7145f7a15904cf1aa43561`) remained0/5 after the180-second
backend timeout. Independent`31d0769de87042c8b6c0ab6e149091cc` was4/5:
backend600,105ms timeout; frontend2,393passed/111,816ms; types2,302ms;
lint11,956ms; build10,650ms. No completed backend assertion failure preceded
its timeout. Completed-file cost hotspots are preserved in
`current-independent-backend-cost.json`,not represented as complete coverage.
Its serial auxiliaries passed: lifecycle445backend/410frontend,6restore
tests,compiled restart,and509browser tests plus9existing skips and the
fixture contract. `restored-projection-auxiliaries.json` preserves exact IDs.

The first full87fixture`94d8544b07b04b88a04fa6fbe7e7d2e6` really passed
the10kphysical comparison,100k directory/activity,100kGraph/PP,10kopposing
scope,100kusers/200kagents/1mrelationships,the mixed canonical oracle,
1,008authenticated HTTP requests with zero errors,slow/disconnected export
I/O,and the full100k cursor oracle. The HTTP stage's inventory/detail p95
upper bounds3,090/3,080ms still fail2seconds; p99bounds3,400/3,290ms pass
5seconds. The initial real-browser inventory response still timed out at20s.
Its original controller stack and ordered SQL window are retained,including
10,699.948ms report-summary and6,110.832ms history-related statements.

This full attempt **did not complete**. The existing disk observer received a
failed`du`response and safely stopped the exact workload at2,910.768seconds
with exit143. Last reliable owned-volume usage was15,596,015,616bytes,not
48GiB. PostgreSQL was running and healthy with no OOM/restart; the missing
command stderr means the actual cause is unknown. `full-result.json`is absent;
remaining profiles are not_run for this attempt. Cleanup completed.
`source87-first-full-guard-exit.json` preserves the distinction.

The boundary watcher was installed after full2
`7367ad69f1de4bab9390e8c68cd1a79a` had already started. It correctly resumed
that executing attempt and now waits for its finished,owned boundary rather
than interrupting it. Its eventual paused host runner must be explicitly
resolved before final completion.

The editable workspace now implements shared selected-read scope fences,
bounded browser failure diagnostics,and a disk observer that records every
failed response and retries completed invalid measurements at most twice.
Missing/malformed/foreign output never becomes zero; control-plane timeouts
still fail closed,and48GiB is unchanged. Sixteen pure tests passed. Real
concurrent-read/epoch/writer-mode regressions have been added but not yet
executed. Full2continues from verified immutable87images with no workspace
source mount; the running host parser is unchanged. None of these workspace
repairs is attributed to its already-built runtime.

## 23. Child-fact statement fencing and live cadence enforcement — awaiting execution

The measured Graph cost profile attributed13,872.976ms of15,877ms to700fact
inserts/170,000facts; a broader run attributed52,061.704ms to those same700
statements. Each inserted fact executed the identical parent generation,
epoch,and worker-pin checks. The wide directory profile additionally performs
five million plan-row checks and has repeatedly reached its unchanged30-minute
deadline. These are concrete CPU-cost roots,not evidence that more memory is
needed.

Forward migration88 replaces **insert-only** row fencing on
`inventory_facts` and `directory_service_plan_rows` with atomic AFTER INSERT
transition-table fences. It groups only the current statement's inserted rows,
locks each actual parent by primary key,checks every parent's original
state/lease/deadline/cancellation/scope/session and schema constraints,and keeps
inventory worker-input checks. Existing composite FKs,field constraints,and
per-row UPDATE/DELETE immutability/reachability guards remain. No published
authority,data conversion,quota,resource,deadline,or batch-size change is made.
Readiness verifies both trigger modes and closed helper ACLs;restore closes
the two new helper ACLs before readiness. New real PostgreSQL tests exercise
250-child statements,mixed valid/fenced parents,scope/session/cancellation,
schema/tenant ownership,worker pins,and disabled-fence readiness.

The current immutable87full2still executes its original guards. Its renewed
background readers/export/GC remain active,but its first detail batches are
already far beyond the60-second canonical progress requirement. The old
harness only checked cadence after both complete sweeps. The editable harness
now checks the **unchanged60-second deadline after every real batch**. Crossing
it fails the incomplete full-cardinality attempt explicitly;it does not count
partial batches as a smaller-data pass or bypass the remaining separate
profiles. Exact and+1 deadline/unit cases were added. Actual DB/full validation
and new source/migration receipts remain pending the guarded fixture boundary.

### 23.1 Measured cadence failure and removal of an artificial scheduling delay

While full2remained active,168real20-key batches and8canonical publications
were observed. Its first publication gap was636,005.707ms;the next seven
were117,546.585/116,341.634/119,466.422/111,526.775/135,686.990/
127,495.709/127,461.022ms. All exceed the existing60,000ms gate.
The old harness withheld an idle canonical worker until20source batches had
accumulated. That artificial delay is not the application's prompt scheduling
and makes a roughly6-second source batch wait about120seconds before claiming
work.

The editable harness now claims a canonical worker whenever one is idle.
Its first actual staged worker is still held at the real publication barrier,
but only until the next real20-key batch creates the required safe pending
vector. It continues to require one active/one pending,no safe cancellation,
both5,000×20sweeps,and every value oracle. Publication cadence measures active
producer windows;the independently verified stopped-and-caught-up interval
between sweeps is not an invented publication. No clock,deadline,cardinality,
admission or resource is relaxed.

The already irrecoverably failed old87attempt is eligible for an exact-owned
cadence stop after preserving diagnostics,so the repaired source can be tested
instead of spending many more hours behind a known harness delay. Such a stop
is a **failed,incomplete full attempt**,not a complete sweep or a clean
qualification. The separate stop receipt must preserve its actual batch counts,
publication intervals,PID/image/mount ownership and signal;the old runner's
unaltered command receipt and cleanup remain authoritative. Remaining old-run
profiles are not_run,and must be attempted on the repaired source.

## 24. Cadence-stop ownership and verified shared/child fences

The explicit cadence stop occurred after189real20-key batches
(3,780changed keys),not two complete sweeps. Exact owned app PID324 received
SIGTERM after pre-stop image/mount/cgroup/log diagnostics;the command returned0.
`source87-detail-cadence-stop.json` preserves all observed publication intervals.
The original runner's `full-command.json` remains unmodified:exit143,
`guardStop:null`,7,019.703seconds. That null distinguishes an external numeric
gate stop from the runner's disk/log guards;it is not an unexplained clean exit.
`result.json` reports no cleanup errors. The partial attempt is failed and
remaining separate profiles not_run.

The boundary watcher then paused only host runner23511after cleanup. Both
completed7367… and following9058… projects had zero containers,networks and
volumes. The resolver rechecked the exact PID/UID/start/command fingerprint,
sent SIGTERM followed by SIGCONT,and confirmed exit;no paused process remains.
Following9058… was build-only/not qualification. The old ladder ended,and no
old-source full workload overlapped subsequent tests. The full app cadence
stop and later empty-boundary host stop are separate recorded actions.

Fresh core7e6f7a77dac54507a5690070cd5fa34e passed304/305tests and types;
the sole failure was the selector contract still expecting the old file list.
After adding the new required child-fence test to that exact contract,
433bdae441904ed182ff38fc1aeed81c passed **305/305 in51,575ms**,types2,326ms,
with clean teardown. This includes real overlapping selected readers/capture,
epoch-write blocking,exclusive ordinary writers,and context cleanup,plus
16actual child-fence cases. Its complete88migration proof is retained in
`child-fence-actual-migrations.json`;88checksum:
`9f5a9adfeb2de1bceb4d90ec31d3cedbc81d1b93f17c46419475175a57220d03`.

The first core's real EXPLAIN ANALYZE/BUFFERS/WAL/SETTINGS evidence reports
250child rows with exactly one statement-fence call and all250FK checks:
plans2.668ms and inventory1.872ms. These bounded statement observations do not
substitute for wide/full workloads.

Serial cost fixture9e72219e3f42452a9dff635f0ea5f5d5 passed173tests108,824ms
and types2,469ms. Its unchanged50-page/5,000-package Graph workload took
15,533.519ms;700fact INSERTs/170,000facts took13,207.752ms. That is only a
modest improvement over the earlier narrow15,877/13,872.976ms observation,
not proof that the broader software gate or full CPU envelope now passes.
Restore fixturefac68164616e4581817f18ad0c177b84 passed6real new-schema
backup/guarded-restore tests8,898ms and types2,497ms. All three owned fixtures
cleaned normally. Focused/query/original-gate/independent-all/full reruns are
still required.

## 25. Current-source reruns and the now-observed full-app fixture binding defect

The source88focused fixturebcbbc29ab6d9417fa2dc53e33fc22e2c passed
839tests354,080ms and types2,507ms. Query58a417ed29a647378ca33f43f6eeca1f
passed its functional comparisons and actual transient probe
(60,154,440retained bytes/89.987ms;timer maximum16,781,240below the36,357,128
tripwire). Its three-request/cardinality maxima were282.239/2,512.165ms;
the latter includes a cold page and fails the diagnostic2-second gate.
Request working-set delta9,605,720bytes passed. Observed heap67,306,144bytes
is not a full coverage pass. PostgreSQL peak1,074,106,368bytes and27,610
max-events fail the unchanged headroom/zero-max-events gates.

Original gatefe4f52b721934b6aa7aca011a0832889 remained0/5 at the unchanged
180-second backend timeout;the other four commands were not run.
Independent3088931ed8c04a9284debd58df1455cf remained4/5:
backend600,108ms/SIGTERM/ETIMEDOUT;frontend2,393passed113,344ms;
types2,440ms;lint12,368ms;build10,912ms. Its45completed backend files
reported590,010ms,including agentIdentity116,450ms. This is measured cost
debt,not a replacement original-gate pass.
Serial auxiliaries passed: lifecycle447backend/410frontend
(7fcdae4cc3ad4837ac81410b370752db),restore6
(b373de8792554c1b862ca086638104ed),compiled restart
(919f23c6a54e464f9fcf76adb11ccc53),and exact browser509with9existing skips
plus the fixture test(8b19232a2cf84d81bc9b78eab90d3462).
Receipts are in `shared-child-{query-summary,independent-software,backend-cost,auxiliaries}.json`.

Full1of that ladder,24ed18f48b074842bf9d84d676239153,is still executing
its immutable source88images:
app`sha256:b73fc89e67b60b758885eb8ac93c0f1cb7454f6d4a33b1c3cad418b0508eff57`,
controller`sha256:ac4d64ff4aadcf8f8ca98b0a57883b6a89ed47faaf91ca851001a147bd7f372b`.
Its actual probe passed60,152,648bytes/132.066ms;10kphysical,100k
directory/activity129,126.680ms,100kGraph/PP335,430.828ms,
10kopposing46,977.222ms,100k/200k/1mreports331,129.161ms,
mixed canonical592,964.520ms,exact/+1source count,100kphysical/facets,
1,008HTTP requests/zero errors,and the100k cursor oracle passed.
HTTP plus slow/disconnected export took539,722.487ms. This is not a final
full-run or latency/headroom pass.

### 25.1 Actual browser cause, not another timeout guess

The real100kbrowser again timed out before its first inventory request.
The new bounded diagnostic now establishes the cause: GETs for
`/api/capabilities`, `/api/data-sync/state`, and `/api/inventory/refresh-jobs`
returned500;the rendered error was
`relation "power_platform_refresh_jobs" does not exist`.
Authentication and static assets returned200,and there were no page errors.
`source88-first-browser-result.json` preserves the exact network/rendered
evidence.

The capacity harness created a private pool for the populated child database,
while process-scoped capability/sync/job services retained the application's
default pool,still pointing at the empty owned control database. Production's
normal composition uses one configured pool;it does not have this divergent
fixture setup. Prior full-app startup and **whole-app four-connection coverage**
are therefore not established by the private pool's counters. The correctly
bound record-route and collector results remain separately scoped evidence.

The editable harness now binds the existing application pool exactly once,
before any client/foreground permit exists,to the owned populated fixture DB
and runtime role. It preserves the operator environment and rejects
nonisolated targets,wrong host/control names,budget drift,missing credentials,
reuse or already-open pools. Every process-scoped and explicitly supplied
repository then shares that same four-slot object;no second application pool
or compatibility reader is added. `capacityHttp` rejects a different pool.
Three actual authenticated bootstrap GETs must return200 **before loading
the large dataset**. Operator/lease/backup clients receive diagnostic names,
server-side connection counts are sampled,and diagnostic ANALYZE releases an
idle application slot before taking its one operator slot.

### 25.2 Remaining measured identity-lock serialization

The same full HTTP stage recorded read-only actor epoch lookup
`FOR UPDATE` waiting1,197.797ms;selected scope SHARE waits peaked113.939ms.
The shared scope repair alone could not remove this separate serialization.
`DataGenerations.sessionEpoch`,a read-only accessor used by `reportIdentity`,
now takes a shared actor fence. Generation admission and actual revocation
retain their default exclusive actor locks. New PostgreSQL regressions require
the accessor to overlap existing selected readers and require a real actor
epoch update to remain blocked until readers commit.

These workspace repairs are **not yet executed** and are not attributed to
the running immutable full1. The exact-host boundary watcher72207 waits for
that full attempt's final cleanup before allowing fresh validation. Its pause,
if produced,must be explicitly resolved;no new DB/browser workload has been
started alongside the active full attempt. The host result parser remains
unchanged during it;new connection-budget interpretation/tests must be added
at the completed boundary.

One diagnostic print exceeded the tool's inline-output budget and was
automatically spooled by the tool. The worker did not open or modify that
generated external path;it reread bounded fields from the owned repository
artifacts instead. All intentional file writes remain inside this repository.

## 26. Full-cycle report aggregate expiry repair — validation pending

The running source88 full1's first cycle admitted both real replacements and
exports,but all12readers suffered failures. Its cold selected pages took
2,978.581ms inventory and10,978.761/10,374.772/26,952.713/13,095.143ms for the
four report endpoints. Subsequent plan capture runs real SQL as required.
Under concurrent pressure,queries containing the whole-directory/activity
and report relations plus summary/analytics envelopes reached15,099ms and
timed out. Both source producers, both exports and GC recorded acquisition
failures; these are failed capacity results,not successful admission alone.

The report memo discarded immutable selected aggregates after60idle seconds,
even though the captured selection remained valid. The cold warmup sequence
and actual diagnostic plans can consume that interval before concurrent
readers start. Once discarded, otherwise bounded warm pages execute the
whole-selection envelopes again; their timeouts starve the four-slot pool.
Workspace code now retains these exact scalar aggregates until the already
captured selection expiry. The32-entry/16KiB caps,source/query identity,
defensive copies,selected-read before/after fences and all deadlines remain
unchanged. No lifetime of a selection or provider result is extended.

The existing real PostgreSQL ambiguity/known-zero/reverse-page regression now
advances only its cache clock by61seconds and requires the bounded selected
directory SQL without a new envelope. Its principal and epoch rejection
checks remain. This mocked cache-unit interval is **not** real heartbeat,
probe or full-run timing evidence. The repair is not in the running immutable
attempt and awaits the completed boundary,focused tests and real rerun.

After four completed **failed** cycles, the worker stopped only this exact
owned Node workload to validate those identified root repairs instead of
repeating known-failing cold-envelope contention. Receipt
`artifacts/phase06/source88-full-root-stop.json` retains the four cycle results,
SQL maximum, process start identity and immutable image. Full logs, inspect,
mounts and cgroups were captured before the signal. Later profiles are
not_run for this attempt; no complete fifth cycle or full-run pass is claimed.
The first signal command exited127 because the minimal image lacks a
standalone`kill` executable and delivered no signal. The worker reverified
the container,Node command and process start time,then used the shell builtin
to send SIGTERM to that exact PID. The original checked-in coordinator owns
the subsequent diagnostics and guarded cleanup; its completed-boundary pause
must still be resolved before new validation.

### 26.1 Exact generation lookup and read amplification

The same stopped attempt's identical20-key probes wrote exactly1,275physical
rows at both10k and100k (1,169inserts/104updates/2deletes),with WAL
8,170,832/8,084,992bytes. However,index tuples grew6,170→8,025
(1.300648×;failed),while heap fetches5,950→6,395 remained1.074790×.
The transaction-difference-v2 per-index records attributed1,339extra visits
over57scans to the tenant/state admission index; point-generation lookups
included several independent predicates that allowed this broader plan.

Workspace sync and writer fences now first materialize the one generation ID,
then evaluate the existing predicates. Writer row locking remains after the
sync/scope/head locks,with unchanged owner/version/epoch/cancellation/time
checks. No migration,authority bypass,counter normalization or dataset
reduction is introduced. A real PostgreSQL regression captures
EXPLAIN(ANALYZE,BUFFERS,WAL,SETTINGS),requires an exact-generation index
instead of the admission index,and retains stale owner/version rejection.
This root repair needs actual rerun ratios; the previous1.300648× stays failed.

The prior stopped full exited143 after3,976.971seconds with
`guardStop:null`,and its original receipt records no cleanup errors.
The exact host coordinator72207 was terminated/resumed at the completed
boundary and exited; the following allocated fixture`1c0c33f508cb472cac704c939e2d52bb`
has no workload or resources and is not a qualification attempt.
New parser regressions17/17 and capacity-core316/316+types passed before the
point-lookup change. A separate exact host ladder pause lets its already
running focused child finish/clean without pausing that child or its deadlines;
the new core regression must pass before that ladder resumes.

## 27. Verified single-pool bootstrap, selected memo and exact-key fences

- `68ee2310f189445fbc042bf6a29f98a5`:316core tests48,077ms;
  types2,326ms;cleaned.
- `30440cbc04594e4f904d67752d994f96`:850focused tests345,266ms;
  types2,449ms;cleaned. This includes the idle selected-aggregate,
  shared actor/scope and binding regressions,not the later point-fence test.
- `cdc38c66e31f457a888ac9f7dbe517cf`:317core tests51,088ms;
  types2,423ms;cleaned. The two actual exact-key EXPLAIN plans executed in
  0.010/0.030ms and use generation-key indexes,not the tenant admission
  index. Small-plan timings are not a100k amplification pass.
- The exact host ladder46249 resumed only after both its prior focused
  child and this added core fixture had no containers,networks or volumes.
  `app-pool-validation-boundary.json` records the completed pause/resume.

Fresh query`da5d5fed186a42aeb59cd1bf430877e3` actually bootstrapped all three
formerly failing routes with200responses (22,408/932/54bytes),using
`agentcontrol_app` in the populated child DB and the shared four-slot pool.
Named server-side connections peaked at3;the new connection-budget gate
passed with completed sample/terminal evidence. Functional collection and
the independent identity oracle passed. Actual migrations1–88 equal the
previous executed list;runtime CREATE privileges are false and inventory
contains106tables (`point-fence-actual-migrations.json`).

The real transient probe retained60,149,032bytes in77.276ms;its live
79,759,232bytes exceeded the36,387,416tripwire while the burst timer maximum
16,802,664 missed it. Sampled/GC-pre/live-stage heap maxima were
79,848,896/86,200,272/86,195,544bytes;app charged peak247,398,400.
The six diagnostic request windows had−11,007,192bytes100k-minus10k observed
peak difference,passing the64MiB delta gate. This is not full-workload heap
coverage:lease-worker and all full-stage evidence remain required.

The three-request10k/100k maxima were205.330/3,212.512ms,so the cold-inclusive
diagnostic2s gate still failed;ordinary SQL peaked4,616.510ms. PostgreSQL
charged1,074,073,600bytes including1,012,170,752file-cache bytes and30,088max
events;OOM/oom_kill stayed zero. Its80%/zero-max gates remain failed.
App image`sha256:6c12b04614176e0997c8c7430415f2bf7096a3df35860e1197e4c7f143eb289c`,
controller`sha256:958ba8d5f96eb529bb580146841ad000e5fd2660b2d59157ae3c06a7d121c11a`.
Full budgets,GC/probe receipts,bootstrap and counter results are preserved in
`app-pool-cache-query-summary.json` and the original attempt. The serial
original software gate,independent all and three full attempts are still in
progress;none is inferred from this successful bootstrap.

The latest original gate
`artifacts/software-checks/13c459ca3859481f977caf581bb26686/` again stopped at
0/5:backend reached the unchanged180-second ETIMEDOUT,other four steps
not_run;its operator wrapper fixture`6ee6d53c9cae4d9bbaffbb707c5428f9`
did not change production. Independent all remains separate.

A later shell-metadata listing unexpectedly returned all historical completed
sessions and was automatically spooled by the tool because of its size.
Again,the worker did not open,modify or delete that external generated file.
It is not repository evidence and is not counted as a validation receipt.
Subsequent operational checks use bounded exact-process/project queries.

## 28. First repaired full running; remaining lineage reads under repair

Independent all`b1030ef095da4ba390fa0272541fb68a` software finished4/5:
backend600,106ms ETIMEDOUT;frontend2,393tests112,071ms;types2,370ms;
lint12,033ms;build11,469ms. Serial lifecycle`c38cbd32168c49eb91aaa4031f78a377`
passed447backend/410frontend;restore`611d4fc6208a495297bf4a2188dca5c1`
passed6;compiled restart`55b8ba2a9e804915bc59384b13bb5b26` passed;exact
browser`9d4a664ef7a846f595eaf47076979877` passed509with9existing skips
in9.2minutes,then its real fixture test passed. Those are independent
receipts,not an original-gate pass.

Full1`7057dd6b8efc457d8c2ee16c844e2d4d` has actually passed bootstrap and
the full directory/activity,Graph/PP,opposing-scope,100k/200k/1m report,
canonical and facet baselines. It remains running and is not a completed
qualification. App image
`sha256:b71cdf448d5db4f41bd78d12c9ada97ce84e81faf61a0e1fde467334e56b2958`,
controller`sha256:71107aabcbb7dc6741fa5fe754706e6d29c57064991384d21cbe17149442da37`.
`app-pool-full1-start-integrity.json` verifies the actual1536/1024/1024MiB
and1.5/0.5/1CPU limits,owned disk volume,no inherited tmpfs,unchanged
HEAD/.npmrc/Azure plan and all three protected images.

The generation-key repair reduced read amplification,but did **not** pass
the10%gate:10k/100k index tuples6,054/6,756(1.115956×),heap fetches
5,853/6,476(1.106441×). Writes remain1,275/1,275 and WAL
7,728,320/7,927,840bytes. These failures are not rounded down.
The remaining42generation-PK scans returned720tuples at100k;the component
loader's two ordinary LEFT joins can read the metadata table instead of
seeking just the catalog/detail lineage IDs.

Workspace code now makes both joins correlated exact-ID lookups,retaining
LEFT/null semantics and all existing field/byte/cardinality bounds. The
existing real catalog/detail/empty-child regression additionally captures
EXPLAIN with nested-loop planning disabled and requires both metadata
lookups to return one indexed row. This change is **not in the running
immutable full1 and has not yet been executed**. No test workload overlaps
that full run. The exact coordinator7786 has a completed-fixture boundary
watcher;any eventual pause must be resolved after the new core regression.
The read-only full1 receipt observer changes no workload deadline or process.

## 29. Post-binding full-browser platform defect — repair pending execution

This full1 completed1,008authenticated HTTP requests with no failures and
the real slow/disconnected export profile,but its100k browser again failed
the unchanged20-second initial-response wait. The new bounded diagnostics
are decisive:capabilities,data-sync and history returned200;the UI displayed
`crypto.randomUUID is not a function`,and emitted no inventory request.
`app-pool-full1-browser-result.json` preserves the failure. This is a
different fixture defect from the now-fixed empty-control-DB binding.

The separate controller accesses the app at HTTP`test-db:8081`,not a
trustworthy localhost origin. Workspace browser launch now grants
secure-context treatment to **only that exact internal fixture origin**;
the isolation guard and origin allow-list remain. It neither replaces
`crypto.randomUUID` nor changes application authentication,production
browser configuration,resource budgets,UI assertions or timeouts.
A native Chromium authenticated platform probe now runs during bootstrap,
before expensive data loads,and records secure-context status and an actual
version4 UUID check. The full100k browser still runs separately;this cheap
platform probe cannot pass its workload gate.

This and the component-lineage lookup repair await the current full fixture's
completed boundary and real validation. The running immutable full1 includes
neither change,and its browser and1.115956/1.106441read-amplification results
remain failed.

## 30. User-directed qualification stop; unvalidated workspace handoff

The parent stopped full attempt`7057dd6b8efc457d8c2ee16c844e2d4d`
at2026-10-02T12:41:20–12:41:31Z after the user requested no further
capacity testing. Its authoritative receipt is
`artifacts/phase06/parent-user-directed-stop.json`; qualification status is
**user_stopped_incomplete_not_passed**. It records exact-owned workload
PID322 termination, coordinator/boundary-watcher resolution, diagnostics
and removal of the disposable containers/network/volume, with no remaining
owned resources. No completed full-workload result or later-profile pass
may be inferred. On discovering that receipt, this worker started no
further test/fixture and stopped its now-obsolete, read-only
`phase06-app-pool-full1-receipt` observer.

Before discovering the parent stop, the worker continued the pending
history-read root repair: appended **migration89**, an exact derived
per-version membership-count ledger maintained by statement INSERT,
UPDATE and DELETE triggers. History/selected metadata use its bounded
count while retaining sparse untyped-fact rejection. Import/publication
validation retains physical membership counts. Runtime access is
SELECT-only; explicit snapshot-backup and restored-database integrity
checks reconcile ledger counts against physical memberships. The reviewed
backup inventory is provisionally107tables.

Migration89 is **unexecuted and unvalidated**. Its schema/trigger/grant,
rollback, cascade, backfill and actual-plan regressions were added to
`reportMembershipCounts.test.ts` and the checked-in core/focused selectors
but were **not run**. The source guard now freezes executed1–88 at aggregate
`a1dac1eea0cd42edad77af1803389210603d9cf35f9fddf6e8173a8d59935286`;
this does not constitute actual89 migration proof.

Pending component-lineage, native browser-platform and expired-reader
selection-rotation changes likewise remain unvalidated. Rotation preserves
expired-pin failures and only restores useful current-selection reader
pressure; it cannot retroactively pass old-pin evidence. The latest source
overlay predates these later reader edits and both new membership-count
files. No updated manifest, image, schema checksum, probe, capacity,
browser, restore or software-gate success is claimed for this workspace.
Only the final whitespace/diff check passed. Phase06 remains incomplete;
the parent owns further disposition and acceptance.

## 31. Changed scope: freeze and handoff to phase07

The user's redirect dated2026-10-02T13:35+04:00 supersedes the remaining
phase06 execution requirement: **no additional synthetic full runs,
repeated sweeps/wide profiles, broad qualification ladders, original-gate
retries or optimization/refactor work**. Code is frozen. Unexecuted and
user-stopped proof remains unexecuted/incomplete, never passed. This worker
concludes under that changed scope; the parent independently owns candidate
safety review, phase07 bounded real-data validation, unchanged mandatory
5/5 deployment guard and its root-cost repairs, configuration preservation,
exact seha preflight and the authorized initial reset. This worker has not
touched production, altered deployment guards, committed or delegated.

### Frozen identity and source distinctions

- HEAD remains`7e2be0b6b844bd538dbdd15f3e8261ea0fc6aeb6`.
- The final documentation/evidence-only receipt is
  `artifacts/phase06/user-redirect-frozen-handoff.json`. Its base plus
  file-change map identifies the frozen workspace; it is **not a built
  image or validation receipt**. Parent-ledger changes are observed, not
  authored here. A previously tombstoned Python bytecode file reappeared;
  it is recorded as observed and preserved, not silently removed.
- Last full image, independently re-inspected:
  app`sha256:b71cdf448d5db4f41bd78d12c9ada97ce84e81faf61a0e1fde467334e56b2958`;
  controller`sha256:71107aabcbb7dc6741fa5fe754706e6d29c57064991384d21cbe17149442da37`;
  PostgreSQL`sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`.
  These are retained evidence images, **not images of the frozen edits**.
- Actual executed schema is1–88/106tables, proved by
  `point-fence-actual-migrations.json`. Migration89 and107-table inventory
  are only source changes; neither schema execution nor restore is proved
  for that candidate.

### Changed contracts and outstanding validation

Previously verified changes include the single shared four-connection app
pool binding, authenticated bootstrap, selected-read SHARE fences, exact
generation-key fences, selected-report aggregate lifetime and set-based
child INSERT fences. Latest focused proof is850backend tests+types
(`30440cbc04594e4f904d67752d994f96`), followed by317core tests+types including
the generation-point regression(`cdc38c66e31f457a888ac9f7dbe517cf`).
There are also17parser tests,447backend/410frontend lifecycle,6restore,
compiled restart and509browser passes/9existing skips plus1fixture test.
All precede the unverified edits listed below. The original software gate
is0/5 after its unchanged180s backend timeout; independent all is4/5 after
600106ms backend timeout. Neither result passes the deployment guard.

Unverified frozen edits are:

1. `streamedInventory.ts` and`inventoryGenerations.test.ts`: correlated
   catalog/detail generation lookups and their physical-plan regression.
2. `capacityBrowserEnvironment.ts`,`capacityBrowser.ts`,`capacityHttp.ts`,
   `capacityHttpLoad.ts`,`largeTenantCapacity.test.ts`: exact isolated
   secure-context/native-UUID bootstrap and tests; full UI behavior is
   not re-proved.
3. `capacityBackground.ts`,`capacityWorkloads.ts` and their capacity test:
   reader selection rotation only after actual expiry, retaining every
   expired-pin failure.
4. `reportMembershipCountsSchema.ts`,`reportMembershipCounts.test.ts`,
   `reportCapacitySchema.ts`,`officialReportHistory.ts`,
   `largeTenantUsersReports.ts`,`schema.ts`/its test: migration89,
   maintained cardinality, bounded read checks, unchanged physical import
   checks, schema readiness and regressions.
5. `database.ts`,`backup.ts`,`backupInventory.ts`,
   `largeTenantFixture.ts`/its test: SELECT-only ledger grant, snapshot and
   restore reconciliation,107-table inventory and exact test selectors.

### Limits, defects and phase07 containment

No full100k support claim is justified. Last built code still repeatedly
recounts report memberships during history validation; the untested89
repair is intended to remove that O(N) read cost. Measured identical
20-key100k/10k read amplification is1.115956(index)/1.106441(heap), exceeding
1.10. The full browser failed on native`crypto.randomUUID` availability.
Expired selections produced invalid requests rather than sustained useful
reader pressure. Five complete replacements, retained-pin/export
concurrency and repaired-source complete sweeps remain unproved.

The fixed fixture remains app1536MiB/1.5CPU/oldspace768/four connections,
PG1024MiB/0.5CPU/32MiBshared buffers/4MiBwork memory/64MiBmaintenance/no
parallel gather/15sordinary SQL, separate controller1024MiB/1CPU. There is
no permission to enlarge these or count controller memory as app headroom.
Latest completed query PG charged peak1074073600bytes and30088max-events
fail the80%/zero-max gates; full-workload heap coverage is inconclusive.
The successful77.276084ms/60149032retained-byte transient probe does not
repair missing full-workload coverage. Observed10000children plus metadata
exceeds the existing10000total-fact limit: reject explicitly, never truncate
observations or raise that limit to manufacture support.

Phase07 owns each residual. Until its bounded real-data evidence and
candidate safety review permit opening, use existing maintenance,
provider/capability, job/admission and publication controls to keep the
affected high-cardinality replacement, reconciliation, report-history and
export paths closed; do not invent a smaller-data capacity claim.
Fix-forward signals remain charged memory>80%, anyOOM/max-event, observed
heap>615MiB or coverage loss, list/detailp95>2s/p99>5s,
summary/facetp95>5s,SQL>15s,lock>2s,head swapp95>1s,
canonical publication gap>60s,catch-up>300s,GC>600s,amplification>1.10 or
WAL>2x,and any stale/incorrect identity/count/export/epoch result.
No counter or unexecuted proof is implicitly zero/passed.

### Exact cleanup and remaining activity

The parent preserved before/after logs, inspect, cgroups and cleanup log
for`agent-control-ltdp-7057dd6b8efc457d8c2ee16c844e2d4d` before removing its
three containers, internal network and owned data volume. This worker
subsequently verified no container/network/volume remains under that exact
project label. Host coordinator7786, ladder46249 and boundary watcher45740
are absent; no paused coordinator remains. The read-only receipt observer
was explicitly stopped. **No phase06 process or resource remains known
active, and nothing will launch another run.** All three protected image
IDs and`agent-control-phase01_data` were re-inspected and retained.
The user-stopped attempt's missing terminal result is not repaired with
a fabricated successful result.

## 32. Parent handoff disposition

Parent observed the completed worker's explicit stop acknowledgement and
verified its frozen source receipt:874entries/836present/38tombstones,
zero hash mismatches,unchanged HEAD. The receipt SHA is
`2c94fe1df3011761d1d91e07de2f1736fa724ac0f5df267879a6867b47ebff93`.
All queued stop messages are processed; no worker restart is requested.
Exact current-fixture resources and recorded coordinator/watcher PIDs are
absent. Parent removed its own generated Python bytecode file after its hash
check; that temporary cleanup and this appendix/ledger update are intentional
post-handoff deltas,not new application work.

Phase06 is **curtailed_by_user**,not a passing capacity result. The user's
remaining-proof waiver closes this execution phase without rewriting any
failure,incomplete run or unverified change. Phase07 explicitly owns safety
review and focused verification of pending migration89/count/grant/backup
integration and other deployment-critical edits before production.

No further full synthetic capacity runs,sweeps or soak cycles are required.
The official deployment guard,configuration/checkpoint preservation,target
verification and bounded real-data observation remain required. The current
unbuilt workspace must not be deployed merely because earlier images passed
focused tests. Production remains unchanged at this handoff.
