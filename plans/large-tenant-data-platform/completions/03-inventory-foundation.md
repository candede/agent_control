# 03 — Dormant inventory foundation

Position **5/9**. Prompt SHA-256:
`3aa24dc28fa71d1074dee72eb9e5b06d35ef7a6c105a638388e4328832ef9ac6`.
Parent acceptance and the campaign ledger remain parent-owned. The inventory
implementation is dormant; **04 is its activation/deletion boundary**.
Implementation is complete and submitted for parent acceptance, 2026-09-29.

No production action, provider mutation, installation, commit, branch, push,
nested agent, feature flag, compatibility alias or new runtime registration was
performed. The existing inventory remains the sole runtime authority. Accepted
record-backed users/reports, the 2-GiB tenant report quota, protected source
receipts, approved feed and existing deployment guards are preserved.

## Hypothesis and implemented boundary

The falsifiable hypothesis was that immutable source/canonical content plus
once-closed temporal memberships allows twenty changed keys to append/close
twenty intervals independently of a 100- or 1,000-key baseline, while old pins
still read exact prior membership. The cheapest initial check combined a
three-page pull producer with the existing matching fixtures. Subsequent real
PostgreSQL tests measure row counts, tuple bytes and actual query plans.

### Schema, publication and completeness

Migration **51** adds typed package, Power Platform and canonical record rows;
relational child/matching/presentation facts; source attempts, page receipts,
immutable keys, roots/revisions and temporal memberships; bounded compaction
references; canonical identities/source memberships; durable reconciliation
claims, pending ranges, frontiers/edges and worker pins; selected read contexts.
The final verifier checks twenty relations, thirteen enabled guards, nine
required indexes, scoped root foreign keys and least-privilege grants.

Migrations 1–50 were not edited. Removing only the three phase-03 additions
(import, migration entry, final-verifier invocation) from `schema.ts` reproduces
its frozen 02B hash exactly. The separate migration 47–50 source files also
match the frozen receipt. Fresh initialization, repeat migration, all applied
version/checksum pairs, runtime grants and immutable-row UPDATE refusal are
executable tests, not a DDL-only claim.

`InventoryGenerations.execute` uses `DataGenerations.execute`, including shared
admission, reservations, session/job/owner fencing, independent twenty-second
renewals, sixty-second leases and the reserved heartbeat connection. Inventory
and run-backed operations acquire the per-principal data-sync mutex before
generation/scope/head/input locks. Multi-scope reconciliation locks are sorted;
domain GC observes the same mutex-before-scope ordering.

Supported dormant ceilings are 100,000 unique records per authorized source,
10,000 pages, 5,000,000 observed wire records, 250 records **and** 1 MiB per
encoded batch, 256 KiB residuals, 10,000 facts per record, 250 records/1 MiB
per identity component and 10,000 candidate edges. Graph keeps its four-hour
enumeration budget; PP pages use thirty minutes, not the predecessor's
120-second budget. Declared 100,001 counts fail explicitly. Durable page/token,
raw/unique/expected-count and continuation evidence rejects loops, partial
scans, duplicate identities, mismatched counts and late writes.

Graph/PP generators pull only when the durable consumer is ready. Their old
array-returning callers are unchanged and remain the active path until 04.
Graph exact/detail enrichment is separately bounded and paced, not catalog-wide
fan-out. Provider origin/selector checks, byte bounds, authorization refresh,
retry ceilings and abort signals remain enforced. A fake-clock provider test
proves thirty heartbeat renewals through an accepted 600-second Retry-After.
The 100,001 boundary is also rejected after computing effective membership,
not only per provider attempt; that counter-boundary test is deliberately sparse
and is not represented as a populated 100k qualification.

### Temporal precedence and collection

A baseline is immutable storage, not the latest observation's freshness or
authorization. Each selected revision identifies its effective generation.
Catalog, detail, exact and control evidence are separate. Exact target lists
and PP environment/type selectors are persisted and validated. Exact missing
targets close only those keys. Older-started broad scans preserve newer exact
present/tombstone evidence. Clear retires the root and advances epoch
transactionally; later exact work starts a new partial root, not resurrected
old membership.

Delta publication appends changed content and once-closes only affected
intervals in the head-CAS transaction. Failed/aborted stages cannot close visible
intervals. Count changes are affected-key deltas, not whole-source copies.
`compact` copies bounded references, never record bodies. `gc`, `gcContent` and
`gcMetadata` bound interval, content/fact and metadata deletion. Returned
content-byte measurements use actual deleted tuple sizes. Current/pinned
canonical input revisions, worker pins and reader pins protect source
membership/content; this includes empty historical source roots and a current
revision whose old baseline generation has naturally expired.

The generic retainer cannot collect an inventory-owned generation until domain
reachability is released. Original immutable byte accounting remains
conservative until whole-generation collection.

Schema 51 exceeds the previous one-hundred-table backup-name limit. Native
fingerprinting now permits at most 128 names with 129-row lookahead, retaining
the existing repeatable-read snapshot and four 32-KiB chunks per fetch. A new
negative test rejects 129 names. Restore first invalidates/prepares authority,
then applies runtime grants and verifies them. Historical upgrade fixtures now
grant and verify through the runtime role rather than expecting the new
positive EXECUTE grant before operator grant installation.

### Canonical reconciliation and control

One active capture and one coalesced latest pending vector exist per output
scope. Queue admission is tenant-serialized and bounded at twenty runnable
active/queued scopes. Active input pins survive safe newer heads; those heads
accumulate changed-key ranges for the next job. Identical/late requests are
no-ops. Polling compares explicitly declared source scopes to their durable
heads, heals missed post-commit enqueue and takes over expired claims.

Indexed SQL frontiers and matching facts find affected identity components.
Only bounded components enter the existing matching rules, `buildRecords`
and augmenting-path `assignSurvivors`. There is no tenant-sized JS source map
or package-by-resource comparison. Merge/split survival, opaque versus GUID
identity normalization, declarative/custom-engine evidence, ambiguous
collisions and dense-component failure retain existing semantics. A failure
does not publish partial canonical membership.

Safe active work may publish its captured vector and report `catching_up`,
then drain the latest pending vector. Epoch/session/clear/expiry and verified
unsafe-control fences still stop it immediately. Verified existing block/access
readback advances source invalidation in its own recording transaction.
Historical readability never grants mutation authority.

### Selected SQL read contract

`InventoryQueries` provides capture, list, global/scope/filtered summaries and
counts, facets, exact IDs, exact source references, source membership pages,
children, people, native report usage, responsibility and current-control
validation. One explicit repeatable-read callback/client/evaluated time owns
rows, counts, summaries, facets and dependencies.

Captured roots include inventory input/output temporal revisions, report
history, directory/app metadata, people epoch and association revision.
Presentation facts reuse existing pure semantics; SQL composes dynamic
environment, resolved-person labels and official report measures. Unknown
metrics remain null. Byte-short pages retain real SQL lookahead; oversized
first rows/exact responses fail rather than silently omitting identities.
Continuation boundaries are authenticated and bound to endpoint, selection
and query; source-member ordering includes source scope and identity.
Facets use bounded digest cursors with SQL lookup of the full selected value
and 512-KiB byte-short pages. Unicode publisher values at the provider's
4,096-character bound are paged completely. Bounded index prefixes, compound
identity digests and the partial matching-key index prevent oversized B-tree
tuples without truncating final comparisons or matching evidence.

Current control rejects application scope, historical canonical revisions,
behind/reconciling inputs, expired source references and failed existing
qualification. SQLSTATE 40001 retains explicit 503/Retry-After with no callback
replay or fallback.

## Verification receipts

| Check | Actual result and evidence |
| --- | --- |
| Final exact inventory selector | **430 passed / 83.04 s**, backend typecheck **2.314 s**. `artifacts/phase03-inventory-final-verified.log`; run `6b07587847b340b7a6c5c5ef18c13ce7`. |
| Shared foundation | **109 passed / 5.61 s**, typecheck **2.357 s**. `artifacts/phase03-foundation-final.log`. Includes the deterministic lock-order regression, selections, exports, schema and reset/preflight. |
| Shared retention, native backup/restore and historical upgrades | **154 passed / 20.83 s**, typecheck **2.247 s**. `artifacts/phase03-cutover-retention-contract-ready.log`; run `89d56c6b9cc84cf4ad567db5a6e4dc33`. |
| Independent aggregate | **5/5 commands passed**: 4,302 backend tests / **335.99 s**; 2,351 frontend tests / **87.26 s**; backend typecheck **2.494 s**, frontend lint **12.059 s**, root build **11.314 s**. `artifacts/phase03-all-ready.log`; run `dfe829d8841244dd8c0be1193ee700af`. See the exact final overlay below. |
| Original unchanged software gate | **Failed, 0/5**: backend `spawnSync npm ETIMEDOUT` at unchanged **180 s**; no OOM; four later commands not run by that gate. `artifacts/phase03-software-gate-verified.log`, inner owned project `agent-control-check-5310f73c49ca47d4987a011c979956c9`. |
| Browser | **58 Playwright tests passed**, five existing inventory specs, one worker; outer fixture **80.63 s**, command **80.871 s**. `artifacts/phase03-browser-verified.log`; run `3097dd02bea74bd8bc22da8c02a8d61a`. This verifies unchanged active inventory consumers, not dormant activation. |
| Fresh schema/repeat/grants | **Passed** in the final exact suite; all 51 applied checksums emitted. Final migration-51 checksum `9bc24d9098b0b5406b44500141c299fb5cd33cceeba6707de66ce3be1b9b1f03`. |
| Capacity/fresh-installation selectors | **Unavailable**: both commands were attempted and explicitly refused as unimplemented before allocating resources. `artifacts/phase03-capacity-attempt.log`, `artifacts/phase03-fresh-installation-attempt.log`. |
| Deployment/live | **Not run**, expressly prohibited in 03; required continuation remains with 07. Model/evaluator checks do not apply to this non-model storage refactor. |

The successful aggregate preceded a four-file final overlay:
`inventoryGenerations.ts` and its test (effective-count admission and bounded
unsubscribed change-log collection), `inventoryRecordProjection.ts`
(bounded compound identity digest), and `streamedInventory.test.ts`
(long-identity regression). The **final 430-test exact suite and typecheck
cover that overlay**. Do not describe the older aggregate as a whole-tree
rerun of these final four files, or either result as original-gate success.

### Measured write/read evidence

| Real fixture | New immutable content rows | Closed intervals | New content tuple bytes | Other measured bounds |
| --- | ---: | ---: | ---: | --- |
| 100 source keys, twenty changed | 20 | 20 | 14,350 | Maximum encoded bind 69,775 bytes |
| 1,000 source keys, twenty changed | 20 | 20 | 14,350 | Maximum encoded bind 70,105 bytes |
| 100 canonical keys, twenty changed | 20 | 20 | 12,950 | Exactly 20 frontier rows; maximum bind 5,089 bytes |
| 1,000 canonical keys, twenty changed | 20 | 20 | 12,950 | Exactly 20 frontier rows; maximum bind 5,089 bytes |

The real scoped PP fixture publishes **5,001 rows through 51 accepted pages**:
raw=unique=5,001; maximum encoded bind **176,825 bytes**. Its exact matching
probe returns **one candidate / 81 response bytes**. Actual EXPLAIN ANALYZE /
BUFFERS plans are retained before and after ANALYZE. Analyzed matching uses
`inventory_fact_match` and an exact membership lookup; the fresh-statistics
planner can scan the 5,001 membership references. The 100-row as-of fixture
can choose a sequential scan; the 1,000-row fixture uses
`inventory_member_asof`. These are real planner choices, not forced-index
claims. The canonical pending-frontier lookup uses
`inventory_frontier_component`. Old pins, once-only closure and aborted-stage
nonvisibility are asserted alongside these measurements.

The bounded content-GC fixture reclaims **154,760 actual tuple bytes** after
old-pin expiry. Metadata GC also collects unsubscribed change ranges while
preserving published, active and pending input ranges. Wide typed presentation
facts fail before returning an oversized first row; valid 4,096-character
Unicode facets traverse byte-short pages without losing continuation.

### Source identity and cleanup

`artifacts/phase03-source-receipt.json` is the final source/proof/attempt receipt:
SHA-256 `fb54d9b238001370bf6d712ee930d361554b13dfe9bb752effcc9fe2f0240441`.
It records hashes for all 32 implementation/test/documentation files, every
retained phase-03 command log, measured SQL proofs, historical migration
preservation and the precise aggregate overlay.

The final focused candidate
`sha256:5bbd63fcd03da411ae8b676802a4edac370b5a823bf9825c9b0c3418d39d408c`
matches all 32 current files. The aggregate candidate is
`sha256:8bb67b79f0f1a765d51a7f7cedc8522bad6c6a4cfa07099b65794427f81f2230`.
Candidates are retained as evidence. Independent exact-label inspection
verified **zero containers, networks and volumes across 33 owned projects**
(including the original gate and two short-lived source-hash probes).
Protected operator/browser image IDs match their supplied identities exactly.
All three parent-accepted quota-overlay files, `.npmrc`, nine unchanged
build/deployment/dependency files and historical migration sources were checked.
No production registration reference exists outside the phase-03 source/test
files. No global prune, unrelated-resource cleanup or production mutation occurred.

The exact selector is:

```powershell
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite inventory-foundation
```

It runs the three named new tests and eleven named predecessor
publication/admission/filter/identity/control/provider suites, followed by
backend typecheck. Shared `foundation` and `cutover-retention-contract`
selectors cover generation/selection/lock order, grants, retention, backup and
reset contracts. Independent `all` is not the original software gate:
`software-gate` invokes the unchanged original five-command gate and its
180-second backend deadline.

All owned runs use the checked-in source-copy operator and installed approved
dependencies, Node 1,536 MiB/V8 old-space 768 MiB, PostgreSQL 1,024 MiB,
disk-backed exact-owned PGDATA/WAL/temp, no host ports and no production
configuration or secret mounts. Backend file parallelism remains disabled.

Earlier nonpassing iterations are retained, including permission/bind-count,
projection/fixture/cursor, GC UUID-cast, missing-import and immutable-test-input
failures, native backup table/grant ordering, oversized B-tree keys and a
PostgreSQL integer-counter expectation. They were repaired, not hidden by skipped assertions or larger
resource/deadline limits. Passing-test proof telemetry is written to stdout
so the existing `silent: passed-only` setting does not discard measurements.

## Cross-root impact and exact 04 handoff

| Root | Phase-03 impact |
| --- | --- |
| `backend/` | New typed schema/storage/projection/reconciliation/query modules, provider page APIs, required tests and synthetic fixtures. Additive grants/final verification and narrowly implicated shared generation/selection/retention changes. Existing pure survivor/presentation helpers and exact control reader are exported for reuse. |
| `frontend/` | Checked columns, query cache/contracts and unified detail consumers; unchanged. No dormant API is imported or registered. |
| `scripts/` | Added exact `inventory-foundation` and narrow protocol/core fixture selectors; operator budgets, dependencies, cleanup and original gate unchanged. |
| `docs/` | Updated `record-data-foundation.md` and `operations.md` with temporal authority, limits, progress, retention and activation ownership. |
| Root build/deployment configuration | Checked compose, Docker/feed and local deployment paths; unchanged by 03. `.npmrc` preserved. |
| Plan records | This completion only. Parent ledger and prior/frozen receipts not edited. |

Changed files (32 implementation/test/documentation files plus this record):

- `backend/src/db/`: `inventoryGenerationSchema.ts`, `inventoryGenerations.ts`,
  `inventoryGenerations.test.ts`, `inventoryQueries.ts`, `schema.ts`,
  `schema.test.ts`, `dataGenerations.ts`, `dataRetention.ts`,
  `packageInventory.ts`, `unifiedAgentRegistry.ts`,
  `defenderHuntingMigration.test.ts`.
- `backend/src/services/`: `inventoryRecordProjection.ts`, `streamedInventory.ts`,
  `streamedInventory.test.ts`, `inventoryReconciliation.ts`,
  `inventoryReconciliation.test.ts`, `graphPackages.ts`,
  `powerPlatformResourceQuery.ts`, `dataSelections.ts`, `unifiedAgents.ts`,
  `largeTenantUsersReports.ts`.
- `backend/src/types/inventoryRecords.ts`.
- `backend/scripts/`: `inventoryFixtures.ts`, `largeTenantFixture.ts`,
  `largeTenantFixture.test.ts`, `database.ts`, `database.test.ts`,
  `backup.ts`, `backup.test.ts`.
- `scripts/large-tenant-tests.ps1`, `docs/record-data-foundation.md`,
  `docs/operations.md`.

04 can use the implemented factories/contracts without designing new schema:

1. Supply existing authenticated source/job/session ownership to
   `StreamedInventory` and its exact/detail/control methods. Source
   `completeJob` remains transactional with publication.
2. After source commit, call `InventoryReconciliation.request` with the
   authorized source vector, then poll/drain `runNext`. Do **not** call
   `request` from the publication transaction. Captured active work is stable;
   source head/change logs recover an enqueue missed after commit.
3. Atomically replace list/summary/facet/exact/detail/children/people/usage/
   responsibility/control/CSV consumers using the selected SQL contracts and
   existing export dispatcher/chunk machinery. No predecessor fallback.
4. Remove the old inventory materializers and array-returning provider paths.
   Move the small surviving pure `buildRecords`/`assignSurvivors` helpers and
   exact control-only repository out of predecessor modules as they are
   deleted. Preserve the existing **control-only** readback/qualification
   authority and atomic fence; it is not legacy inventory-kind observation
   storage and must not be replaced with a second control authority.
5. Register the existing bounded compaction/GC methods with lifecycle ownership
   in 04/05. No new reconciliation, export, generation or selection framework
   is needed.

## Residual ownership and production continuation

No 100k/1m capacity qualification is claimed: 06 owns full-envelope fixed-budget
measurement and both 100k detail-churn sweeps. Until then these are enforced
implementation ceilings, not demonstrated production scale.

Production deployment/live checks remain `not_run` in this phase by the explicit
no-production boundary. 07 owns the verified `seha` localhost:3002 continuation,
original 5/5 software gate and cleanup, single authorized initial app-DB reset,
restore/fresh-installation/capacity evidence and live observation. Protected
configuration, credentials, registry, ports, recovery data and images remain
untouched. No internal Start/direct deployment bypass was used.

| Residual | Containment, threshold, owner and exact continuation |
| --- | --- |
| Original software gate remains `blocked_safety_check` | Deployment/reset stays closed. Signal: backend exceeds **180 s**, **0/5** completed commands, OOM=false. **07** must repair the actual root cost, rerun the unchanged `software-gate` path to **5/5 with zero cleanup failures**, then use the guarded deployment path. No larger deadline/RAM, skipped assertions or internal Start bypass. |
| Full-envelope/cold-statistics capacity remains unqualified | No scale-support claim or inventory activation in 03. Signal: cold 5,001-member scan versus analyzed one-candidate lookup; full targets remain **100k/source, 200k logical agents, 1m observed facts**, **1-MiB/250-row binds**, **15-s statements**, **30-min PP/canonical work**, fixed RAM. **07**, with execution in **06**, owns real populated/churn/restore/fresh-installation qualification. Trigger: any bound breach, timeout or incomplete count keeps affected publication/control closed until measured repair. |
| Production/live observation not yet executed | **07** must reverify the already-selected `seha` physical/configuration identity and backups, obtain original **5/5** plus cleanup, perform only the one authorized initial `agentcontrol` reset, deploy and observe **localhost:3002**, then fix forward without another reset. This phase does not claim production readiness or target-access failure. |

## Parent acceptance review: repair required

The parent independently passed **430 inventory tests/typecheck** and **154
retention/backup/restore tests/typecheck**, verified all 32 source hashes and
nine prompt hashes, preserved migration 1-50 and protected configuration
identities, checked dormant registration, and verified exact cleanup of the
33 worker projects and two parent runs. Evidence is
`artifacts/phase03-parent-focused.log` and
`artifacts/phase03-parent-retention.log`. These passing checks did not expose
the subsequent bounded read-only review findings.

**03 is not yet accepted.** Required repair/regression cases:

- Preserve newer exact-present/deleted evidence through a second older-started
  broad baseline swap, compaction and GC, without full-manifest delta copies.
- Preserve opaque Graph package IDs verbatim in canonical survivor mapping;
  case-distinct GUID-shaped IDs must not collapse or lose stable UUIDs.
- Keep valid wide text sort keys out of 4-KiB authenticated cursors, recovering
  exact boundary values through pinned selected-row references instead.
- Correct organization/unknown view conjunction with `relevance: "all"` and
  explicit relevance restrictions.
- Include normalized native authoring-platform facts and normalize package/
  query/facet semantics to preserve the established filtering contract.
- Validate child-page bounds with actual staging/publication and legal wide
  facts. The review's 600,051-byte payload probe alone does not prove silent
  omission: the existing DB payload check rejects values above 262,144 bytes.
  Prove that boundary without bypassing guards, correct any real byte/count/
  continuation defect, and explicitly document any disproven review claim.

The delegated directory/people mode in `currentInventoryData` was separately
traced and is correct; it is independent of inventory source token mode.
No change is requested there.

A fresh bounded repair worker owns these cases, directly coupled tests/docs
and an appended verification/source-identity handoff. Preserve this historical
receipt and all prior failures. Migration 51 remains unaccepted and can be
corrected; migrations 1-50 remain frozen. No production activation or mutation
is authorized by this review.

## Bounded repair addendum — 2026-09-29

**Verified repair; parent acceptance remains pending.** This addendum addresses
only the six findings above and directly coupled schema/restore/GC contracts.
The parent ledger and original `artifacts/phase03-source-receipt.json` are
unchanged. No activation, production operation, dependency installation,
commit/push/branch, nested worker or sibling message occurred.

### Reproduction and implemented decisions

The falsifiable starting hypothesis was that published per-key precedence and
selected SQL boundaries, rather than tenant-sized copies or larger limits, could
repair the five mismatches; actual staging would distinguish the disputed child
claim from a genuine page-budget defect. The cheapest discriminating check was
the checked-in `inventory-core` real-PostgreSQL fixture with regressions added
before implementation.

`artifacts/phase03-repair-reproduced.log` records **9 failed / 34 passed** with
valid fixtures, plus passing typecheck: repeated broad resurrection, opaque-ID
survivor churn, two wide-publisher cursor failures, organization/all mismatch,
three platform cases, and a real legal-multibyte child response failure.
The earlier `phase03-repair-before.log` remains historical evidence, including
initial fixture-construction errors (omitted required `isBlocked`).

1. **Repeated replacement precedence — reproduced and repaired.**
   Migration 51 now adds `inventory_exact_heads`: one scoped observation-epoch/
   identity reference to the latest accepted exact key, including tombstones.
   The root carries the observation epoch through broad swaps, compaction and
   control projection. Publication updates only the supplied exact targets
   (maximum 100), within the existing fenced `DataGenerations.execute`/head
   transaction. Constraints, composite FK, indexes and a head/epoch/lease/
   deadline/monotonic-time trigger guard updates. A complete catalog timestamp
   supplies the scope-wide absence watermark. Older broad replacements retain
   effective current references; newer replacements preserve later exact
   exceptions in SQL. Stale exact reads cannot restore or remove newer state.
   No tenant-sized JavaScript map or N-row delta manifest was introduced.

   Exact heads protect immutable keys/content from deletion and are collected
   in **50-row** metadata slices after catalog supersession or invalidation.
   Pins retain their independent historical temporal references. The real
   stream/DB test uses `exactMissing` and `packageObservation`, then the second
   broad replacement, compaction, GC, a third older observation, old selection
   access and genuinely newer publication. Additional tests cover stale exact
   evidence, abort nonvisibility, rejected direct mutation/deletion, bounded
   head GC and clear/new-source behavior. Native backup/restore includes an
   actual exact tombstone, exact fingerprint equality, restored-read rejection
   and runtime-role GC of invalidated heads.

2. **Opaque Graph IDs — reproduced and repaired.**
   New and previous survivor mappings preserve package IDs verbatim; only native
   PP identifiers use native normalization. Case-distinct GUID-shaped package
   IDs sharing environment/CDS-bot evidence with conflicting schema retain both
   distinct source memberships and their original canonical UUIDs after a real
   reconciliation update. Existing merge/split/conflict fixtures still pass.

3. **Wide sort cursors — reproduced and repaired.**
   List cursors now authenticate a bounded selected-row digest, not the sort
   text. SQL resolves full boundary keys in the pinned matching relation.
   The **4-KiB** cursor limit is unchanged; there is no truncation, hash sorting
   or stored cursor array. Tests round-trip 4,096-character Unicode publisher,
   authoring-platform and version values for ascending/descending order, equal
   keys, null-last placement, ID ties, previous/next navigation, endpoint/
   selection rejection and byte-short list pages.

4. **View/relevance conjunction — reproduced and repaired.**
   Meaningful organization/unknown predicates apply independently; `all` adds
   no restriction. The real selected SQL test compares all 12 combinations of
   all/organization/unknown/first-party view and all/organization/unknown
   relevance against the established `matchesAgentFilters` oracle.

5. **Native platform facts — reproduced and repaired.**
   Native and Graph sources emit shared normalized authoring-platform values
   with display labels. Linked records deduplicate normalized platform facts;
   filter inputs use the same normalizer and facets group by normalized value.
   Real reconciliation/selected-page tests cover native-only, package-only and
   linked records, equivalent filter spellings, one facet and stable counts.

6. **Child claim — oversized-publication inference disproven; a different real
   byte defect reproduced and repaired.** Actual normal staging of the wide
   element fails with SQLSTATE **23514**: the fixture's PostgreSQL JSONB text is
   **600,056 bytes**, exceeding the unchanged **262,144-byte** payload CHECK.
   The review's pure projection did not establish successful DB publication.
   No constraints or admission limits were disabled or expanded.

   However, **80 legal facts** with 4,096-character multibyte values and small
   payloads did publish normally and previously raised `data_response_bytes`
   during an otherwise pageable read. Child budgeting now includes encoded
   ordinal/kind/value/payload instead of payload plus a fixed 4,096-byte guess.
   All 80 values round-trip, with byte-short continuation, within the 1-MiB
   selected response bound. Existing legal 180,000-byte payload pages also pass.
   Full encoded fact GC budgeting fixes the directly coupled undercount while
   retaining the 1,000-row/1-MiB cap. The new proof collected **136** fact/content/
   key rows in bounded calls. Under current kind/value/payload constraints a
   legal first child cannot exceed 512 KiB; a defensive
   `inventory_child_record_bytes` failure nevertheless prevents an over-budget
   first row from masquerading as an empty final page.

### Bounds, schema, source identity and cross-root scope

The final 100-versus-1,000 baseline proof reports identical twenty-key work:
**20 inserted, 20 closed, 20 changed, 20 new content rows / 14,350 bytes** and
**20 exact-head rows / 2,237 bytes**. Maximum recorded binds were **69,775 /
70,105 bytes** respectively. Canonical changed-component tests, reserved
heartbeat slot/independent renewal, scope mutex ordering, selected repeatable
reads, invalidation and current-control rejection remain passing.

Final fresh/repeated schema verification and runtime grants pass. Migration
**1-50 checksums exactly match** the historical receipt; only unaccepted 51
changed. Runtime grants explicitly cover the new guarded heads. Verification
also works as the restoring operator before runtime grants are installed,
then verifies the runtime role after grants; no restore privilege bypass was
introduced.

`artifacts/phase03-repair-source-receipt.json` records the **11-file overlay**
and unchanged remaining 21 historical sources, exact image/source hashes,
per-command timings, all attempts, proof rows, nine unchanged prompt hashes,
protected files/images and cleanup. All 32 current source hashes match the
actual **four final focused/foundation/retention/aggregate operator images**.
There is **no post-aggregate code/test/schema overlay**; this appended
completion and the receipt are subsequent evidence documentation.

- `backend/`: `scripts/{backup.test,database}.ts`,
  `src/db/{inventoryGenerationSchema,inventoryGenerations,
  inventoryGenerations.test,inventoryQueries,schema.test}.ts`,
  `src/services/{inventoryReconciliation,inventoryReconciliation.test,
  inventoryRecordProjection}.ts`.
- `docs/record-data-foundation.md`: precedence-head lifecycle, opaque IDs,
  selected-row cursor boundaries, platform normalization and actual child bounds.
- `frontend/`: inspected existing inventory query/UI consumers; unchanged because
  the repaired factories are dormant and have no active wire registration.
  Active 02B users/reports/exports are unchanged and aggregate-tested.
- `scripts/` and root deployment/config: inspected harness/registration/build
  boundaries; unchanged. The checked-in selectors already cover the repair.
  Approved feeds, protected images, deployment files and manifests match the
  prior receipt. `currentInventoryData` delegated directory/people semantics
  are unchanged. No new scheduler, route, writer or feature flag was registered.

### Validation and exact owned cleanup

All commands used `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite`
with its existing fixed Node **1,536 MiB**, V8 **768 MiB**, PostgreSQL **1,024
MiB**, disk-backed owned DB/WAL/temp, synthetic configuration and no host ports.

| Final selector / evidence log | Observed result |
| --- | --- |
| `inventory-foundation` / `artifacts/phase03-repair-final-focused-3.log` | **444 passed** (430 + 14 new), backend typecheck passed; tests **91.532 s**, typecheck **2.704 s** |
| `foundation` / `artifacts/phase03-repair-final-foundation-2.log` | **109 passed**, backend typecheck passed; **6.775 / 2.479 s** |
| `cutover-retention-contract` / `artifacts/phase03-repair-final-retention-2.log` | **154 passed**, backend typecheck passed; **21.117 / 2.398 s**; real native backup/restore and upgrade/grant coverage |
| `all` / `artifacts/phase03-repair-final-aggregate.log` | Independent **5/5**: **4,318 backend**, **2,351 frontend**, backend typecheck, frontend lint and production build passed |
| Editor diagnostics / `git diff --check` | Passed for repaired source/test files / repository diff |

Final aggregate command timings were **364.989 / 87.636 / 2.343 / 11.543 /
10.095 seconds**, in the order above. These are this candidate's timings,
not the earlier 335.99-second standalone backend measurement and not a pass of
the original deployment gate.

All intermediate logs remain intact: original reproductions; the corrected
cursor null marker; the GC test's missing invalidated-pin retention step; and
the restore verifier's pre-grant role correction. Final reruns are separately
named, not overwritten failures. The scoped receipt independently verifies
**all 13 repair-owned projects** have **zero containers/networks/volumes**.
Final fixture cleanup reported no failures. Source-copy images remain as
qualified evidence; the two protected baseline/browser image IDs are unchanged.

### Residual status and exact 04 handoff

- **Original software gate:** historical **failed 0/5**, backend
  **ETIMEDOUT at 180 seconds**, no OOM; **not_run in this bounded repair**.
  The independent 5/5 aggregate does not replace it. This remains
  `blocked_safety_check`: **07** must repair actual cost, pass the unchanged
  original 5/5 and cleanup before maintenance/reset/deployment. No deadline/RAM
  increase, skipped tests or internal Start/direct-container bypass.
- **Browser/live provider/full-envelope capacity/production:** **not_run in this
  repair**, not fabricated passes. No active UI or provider registration changed;
  prior browser evidence remains historical, while deterministic provider/DB
  coverage and the full frontend aggregate pass here. **06**, with **07** final
  ownership, must execute full 100k/1m and repeated-churn qualification. Any
  bounded-page/SQL/GC breach, identity churn, stale tombstone resurrection or
  authorization leak (threshold **1**) keeps affected publication/control closed
  pending measured fix-forward; fixed budgets and source ceilings stay unchanged.
- **04:** consume these repaired dormant factories without a new architecture
  decision. Preserve opaque Graph identities and normalized platform facet
  values/labels, carry selection tokens unchanged, and wire exact-head GC with
  the existing domain metadata lifecycle when activating inventory atomically.
  Continue the previous complete producer/consumer deletion handoff; no
  predecessor fallback. The parent alone accepts/advances this phase.
- **07:** the overall campaign still must reverify and deploy/observe authorized
  `seha` localhost:3002 through the guarded path, with the one authorized initial
  application-DB reset only after original qualification and cleanup. Preserve
  all configuration, credentials, sessions/secrets, backups and retained recovery
  resources; fix forward afterward. This bounded repair makes no production
  readiness claim and creates no new production-access ambiguity.

## Final parent acceptance

Parent accepts **03 complete_with_risk** after verifying the bounded repair,
with the original-gate obligation above preserved. All five confirmed semantic
findings are closed. The oversized-child publication inference remains
explicitly disproven; the actual legal-multibyte paging/GC defect is repaired.
The delegated-directory source contract is unchanged.

Parent inspected the repaired exact-head publication, epoch/monotonic guards,
bounded cleanup and real repeated-swap/old-pin/newer-observation regression,
opaque Graph-ID survivor mappings, full-key SQL cursor recovery, relevance
conjunction and platform normalization. Parent verified all **32 source hashes**
using the **11-file repair overlay**, the preserved historical receipt,
protected files, nine prompt hashes and frozen migrations 1-50.

Independent final `inventory-foundation` verification passed **444 tests plus
backend typecheck**:
`artifacts/phase03-parent-repair-focused.log`, run
`57c038cbaaf749738acae626ee435b6e`. Editor diagnostics and diff hygiene passed.
Exact-label verification found no owned containers/networks/volumes across
the **13 repair projects and final parent fixture**. Production readiness
remained HTTP 200 on port 3002; no production mutation occurred.

The worker's **109 foundation**, **154 retention/backup/restore**, and
**5/5 aggregate (4,318 backend / 2,351 frontend)** results apply to the final
source, without a later code overlay. Parent did not rerun or relabel the full
aggregate/browser checks. Latest independent backend duration is **364.989s**;
the historical original gate still failed **0/5 at 180s**, no OOM, and was not
rerun by this repair. Phase 07 owns actual root-cost repair and unchanged
5/5-plus-cleanup convergence before production maintenance/reset.

**Handoff:** migration 51 is now frozen at
`32d1333b0e15ac2f4b70cddd1c0ccb4262d9d153f3cb3da64e9610f4f04ed322`.
04 activates the complete producer/consumer boundary using forward DDL and
deletes predecessor runtime/storage without compatibility. Preserve exact-head
GC, opaque Graph identifiers, normalized platform values/labels, bounded
authenticated cursor tokens and separate current mutation authority. 06 owns
full-envelope, deep/wide paging and sustained-churn measurement. Safe later
implementation continues; this acceptance is not a production-ready claim.
