# 02A — Official reports foundation

Position **3/9** (`01,02,02A,02B,03,04,05,06,07`).
Implementation is complete and dormant. The independent aggregate is **5/5**;
the unchanged original software gate is **not qualified**, timing out its first
command at 180 seconds. This explicit qualification obligation remains with 07.
The parent owns campaign-ledger acceptance. No production operation was performed.

## Implemented boundary

- Streaming multipart/file ingestion uses installed `csv-parse`, fatal incremental
  UTF-8 decoding, incremental SHA-256, serial backpressure and strict parser
  validation. File/count/field/draft/byte quotas, immutable intent, session
  epochs, independent heartbeat, cancellation, replacement and cleanup are real
  implementations, not registered runtime writers.
- Migration **49** adds typed indexed facts to the existing immutable report
  fact table, ingestion/selected-context relations and temporal history
  references. Existing artifacts, versions, complete three-kind sets and
  memberships remain content authority. Nothing backfills old app-data/facts.
- Individual and bundle acceptance preserve deduplication, receipts, complete-set
  publication, corrections, supersession and audit. Failed replacement preserves
  the previous preview. Incomplete accepted sets are deletable but not selectable.
  Final select-confirmation consumption rechecks completeness, typed references
  and retention; null expiry retains the existing indefinite-retention meaning.
- Tenant history has monotonic revision plus invalidation epoch, temporal
  retained/superseded memberships and one dependency root. Ordinary acceptance
  preserves pinned membership. Non-active correction/delete/expiry invalidates
  old selected reads and exports without changing the active head.
- Combined SQL composes the accepted phase-02 directory/activity/licensing
  relations on the same selected client/time. It supplies filters, cohorts,
  sorts, exact counts, summaries, analytics, facets, unresolved identities,
  details, child pages, history and overview, without a users-by-agents matrix.
  Positive report identities feed phase-02 bounded exact verification.
- Targeted agent summary/candidate/association reads use exact current
  source-qualified references, bounded fingerprinting and reviewed CAS writes.
  `packagesInRead` accepts at most 100 exact stored snapshot/native references;
  it never scans a 5,000-item inventory. Report-only rows stay report-only.
- The dormant router fixes real authentication, roles, CSRF and private/no-store
  behavior; its identity callback must match the authenticated session.
  Multipart fields may precede or follow the file; disconnects clean staging.
  It uses the existing canonical policy helper and preserves classifications;
  the real factory test verifies the complete declared endpoint/CSRF inventory.
- Real persisted `copilot_users`, `official_agents`, `official_users` export
  producers use the existing fenced export engine. Official-user CSV remains
  relationship-row output, not one row per user. Formula defense, nullable
  metrics, ordered columns, kind binding and audit are preserved.

No old route, writer, export, storage or frontend surface was deleted or
activated. Those replacements are deliberately owned by **02B**.

## Frozen contracts and autonomous decisions

The normative complete contract and caller/deletion inventory are
[`docs/official-reports-foundation.md`](../../../docs/official-reports-foundation.md),
`backend/src/types/officialReport{Data,Api}.ts`,
`reportExportColumns`, and executable `candidateReportEndpoints`.

- Lists use `{value,page,selection,counts,reports,sources,filters,summary,analytics}`;
  details/facets/children/preview/confirmation/agent/export shapes are explicit
  additive candidate types, not changes to live wire types.
- Page defaults/maxima remain 50/100; cursors 4 KiB; roots 16; exact reads 100;
  SQL batches 250 rows **and** 1 MiB; residual JSON 256 KiB.
- SQL limits returned row prefixes to 512 KiB before transfer. Valid wide UTF-8
  rows may produce short pages with a continuation. Consumers and producers
  follow cursors, not a full-page-length heuristic.
- Exports retain 256 KiB chunks, 15-minute build, 30-minute expiry,
  1 GiB/2,000,000 output rows, persisted filters/selection and explicit-ID limits.
- Missing metrics remain null; verified zero remains zero. Unknown/ambiguous
  identity evidence is not verified unpaid status. Positive Users **or** bridge
  evidence means activity; stale evidence cannot become current activity.
  No-agent-activity is independently represented from combined app activity.
- Agents-report date/response ownership includes a blank Agents date.
  Bridge-only fallback is explicitly labeled. User recency uses Users dates,
  not the bridge's agent-last-used-by-anyone date or upload time.
- Tenant report visibility is independent of importing actor; user sources remain
  principal/token-mode scoped. Root/context capture and compound reads use the
  same repeatable-read callback and captured time.
- Indexed LATERAL fact lookups and materialized FULL joins replace a measured
  quadratic join plan, without increasing statement time or RAM budgets.
- Isolated original software checks now reuse the existing disk-backed fixture
  override and verify its exact owned PGDATA mount. This was necessary to obey
  the supplied disk-only qualification boundary. The original five-command
  `backend/scripts/test-all.ts`, refusal, and fixed RAM limits were not weakened.

## Files and cross-root impact

**Backend additions:** `db/officialReport{Schema,Bounds,History,Queries,Imports,Maintenance}.ts`;
`services/{officialReportStream,largeTenantUsersReports,officialReportAnalytics,
officialAgentUsage,officialReportExports}.ts`; `routes/officialReportData.ts`;
`types/officialReport{Data,Api}.ts`; `scripts/officialReportFixtures.ts`; required
`services/largeTenantUsersReports.test.ts` and
`db/officialUsageHistorySelection.test.ts`.

**Backend prerequisite changes:** additive migration/verifier registration and
schema tests; least-privilege fixture grants; shared ingestion admission;
public phase-02 `ensureScope`/pure fact helper; exports of existing pure report
parser helpers; exact focused fixture commands/selector tests. No parser
behavior or phase-02 source algorithm was replaced.
The schema33 upgrade regression compares every preexisting fact field unchanged
and additionally proves all twelve additive typed fields remain null.

**Scripts:** `large-tenant-tests.ps1` recognizes the exact focused suite.
`local-deployment.ps1` and its tests require the existing disk fixture override
and exact mount verification for isolated software checks.

**Docs:** new frozen contract, report/user operational links, and corrected
software-check storage documentation in `operations.md`.

**Frontend:** no phase-02A edit/import/contract activation. The report/user,
history/import/detail, agent-usage, API/cache and test consumers were inventoried
in the handoff document for atomic 02B replacement. The parent's session-test
repair remains byte-identical, SHA-256
`0428f6716a14dd5207afdc48f3e203b0df5ecbcef361ee0a9be31fe6bd3cc1c9`.

**Root build/deploy configuration:** no feed, manifest, lockfile, Dockerfile,
production compose/config, public port or secret change. The existing
`compose.large-tenant-test.yaml` is reused, not a new alternate gate.

Static runtime import traversal from `backend/src/{server,app}.ts` found 121
reachable modules. Only the additive schema module is reachable among new
report modules; no handler/provider/export/maintenance registration is reachable.
Receipt: `artifacts/phase02a-dormancy.json`. Nine prompt hashes match the prior
receipt; the campaign ledger was not edited by this worker.

Historical migrations **1–48 remain immutable**. The frozen 1–47 aggregate is
`38127337787c35454a0d972fb132ff60f2326b1f9b474a5e992bb6bd087a9438`;
migration-48 SQL is
`3ad74ca70f834ab5315d76362cf4fa605f346d37db03cb9fa77d5b6407250463`.
Its unchanged source file SHA-256 is
`2a7017ba16d99bda298835cbcf96021f740bb79716b27b06f62c874151be3290`.
The schema tests assert both frozen histories.

## Executed falsification and scale evidence

The first small proof was a combined verified-unpaid cohort query and **32
retained sets with one history root**. The expanded tests prove:

- 32 pinned sets remain 32 after the 33rd acceptance;
- non-active correction, deletion and expiry leave the active head/revision
  unchanged yet return `selection_invalidated` and deny old ready/pending
  exports, status and download;
- user/license states, UPN/object-ID ambiguity, stale/partial sources, Users/
  bridge missing/zero distinctions, blank Agents dates, cohorts, sort families,
  forward/reverse cursors, facets, children and positive identity verification;
- streamed UTF-8/file/count limits, actual 256 MiB and 100,000-row boundaries,
  serial batches, actual HTTP disconnect cleanup, real role/CSRF failures;
- accepted 1,000-wide-row UTF-8 facts produce byte-short SQL pages, and the real
  persisted export still emits all 1,000 rows;
- exact current agent mappings, CAS conflicts, package references, all three
  CSV schemas/values, formula defense, immutable grants and bounded collection.

Actual full page statements were captured and executed with
`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)` on the selected repeatable-read client.
The receipt includes exact SQL, parameters and plans:
`artifacts/phase02a-query-evidence.json`.

| Directory users / observed Users facts | 1,000 / 1,000 | 10,000 / 10,000 |
| --- | ---: | ---: |
| Verified active-without-paid count | 500 | 5,000 |
| Page SQL rows including lookahead | 51 | 51 |
| Response rows | 50 | 50 |
| Full page execution, ms | 12.352 | 359.638 |
| Maximum SQL batch rows | 250 | 250 |
| Maximum report bind bytes | 77,591 | 78,092 |
| Measured source bind bytes | 127,950 | 128,951 |
| Maximum measured result rows | 250 | 250 |
| Maximum measured result bytes | 54,942 | 55,292 |
| Response JSON bytes | 35,900 | 36,067 |

Plans use existing scoped set/version indexes and the exact fact primary index;
the 1k plan also uses `directory_user_upn_order`. No tenant row array or
reconstructed CSV was returned to the application.

## Validation receipts

All commands run from the repository root, with unique owned synthetic
disposables, no published ports/provider calls/production secrets or installs.

| Command | Result |
| --- | --- |
| `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite official-reports-foundation` | **371 passed**, 9 files; backend typecheck passed |
| `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite user-sources-foundation` | **427 passed**, 6 files; backend typecheck passed |
| `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite foundation` | **97 passed**, 8 files; backend typecheck passed |
| `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite all` | **5/5 independent commands passed:** backend **4,373** tests/166 files; frontend **2,345** tests/77 files; backend typecheck; frontend lint; production build |
| `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite selected-reads` | **20 passed**, 2 files |
| `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite export-readonly` | Passed: read-only application filesystem, **1,250 rows**, **10,709 bytes**, **2 durable successful audits** |
| `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite gate-failure` | Passed: original gate refuses intentional **exit 17**, with OOMKilled=false and owned cleanup |
| `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite software-gate` | **Failed honestly, 0/5:** first command `npm run test --workspace backend` exceeds the unchanged **180s** per-command deadline; `spawnSync npm ETIMEDOUT`, exit 1, OOMKilled=false; remaining four original-gate commands not run |
| `pwsh -NoProfile -File ./scripts/local-deployment.tests.ps1` | **1,299 orchestration assertions passed** |
| Editor diagnostics / `git diff --check` | No errors |

The exact focused inner command is the nine-file command specified by 02A,
followed by backend typecheck; `backend/scripts/largeTenantFixture.test.ts`
asserts that selector. Logs are retained under `artifacts/phase02a-*`.
Focused run: `c5a1e25cf3474e58a4717288b6f5faf9`;
source regression: `9c3d4f05f2f540dfa74c71a37cd8801c`;
foundation: `394393e38cda49e585b90f77183bf80e`.
Aggregate: `993bcb70f65d4b1bb45d9ae137cdae2e`;
selected reads: `7099bf056c484564b04f86d98cabb004`;
readonly: `84dd47becc834eec9efb6df54b2c05ff`.
Original-gate fixture: `agent-control-check-789382f758b14c45acabe34ac59f46ff`;
its full diagnostics are in `artifacts/software-checks/789382f758b14c45acabe34ac59f46ff`.
Final command logs end in `-converged-final.log`; foundation's final log is
`phase02a-foundation-qualified-final.log`. The existing **829.63 kB** frontend
bundle warning remains visible and unchanged.

Development failures were preserved and repaired, not hidden: fixture API
assumptions, SQL alias/collation errors, immutable-association locking, measured
20-second quadratic query failures, wide-result byte overflow risk, nullable
retention confirmation checks, and schema-verifier mock/format expectations.
Aggregate-only route-policy and schema33 preservation failures were also
repaired: canonical policy registration now remains mandatory, and all legacy
fact fields plus all-null additive columns are explicitly verified.
No threshold, memory ceiling, production gate or original semantic assertion
was reduced.

## Environment and remaining campaign obligations

Protected baseline remains
`agent-control-scale-5096-operator:local`,
`sha256:78f3cb9fa91e7a64960699899d8fe2eb56bdd77c8ee56490f1f5255855b3c235`.
New candidate images are built offline from its already-installed dependencies.
The focused run's measured Node peak was **568,901,632 bytes** and PostgreSQL
peak **363,159,552 bytes**, under fixed **1536/1024 MiB** budgets. OOM events,
OOM kills and zswap were zero. During/final captures precede exact-label/mount
verified cleanup. Across the additional live samples, Node peak was
**1,167,147,008 bytes**, PostgreSQL **543,162,368 bytes** and actual swap **0**.
PostgreSQL temporary work reached **28 files / 87,610,368 bytes on owned disk**,
not RAM-backed PGDATA. One separately captured allocation was **106,300 KiB
PGDATA / 65,548 KiB WAL / 4 KiB temp directory**. Configuration samples show
memory limits **1,610,612,736 / 1,073,741,824 bytes** and empty port bindings.
`artifacts/phase02a-live-resource-samples.jsonl` includes during-work and last
live pre-cleanup samples; wrapper `capture.jsonl`/state/cgroup logs include the
explicit final capture before teardown.

All **28** discovered actual phase-owned project boundaries have zero remaining
containers, volumes and networks. No image pruning or retained-project action
was used. Receipt: `artifacts/phase02a-preservation-cleanup.json`.

The aggregate-tested candidate is
`agent-control-ltdp-993bcb70f65d4b1bb45d9ae137cdae2e-operator:local`,
`sha256:4cb8b526f818f5d6c154d386206514a05df734c5bcb91abe6defe3afb83d2ede`.
The original-gate attempt used
`agent-control-ltdp-8848f17099f5448aaf77d89ab94fa3db-operator:local`,
`sha256:e411e397787f345a4ad6c0fb3a3d62ef7e60c5a9f14de3a14c52e2a4ee4cc235`.
`artifacts/phase02a-source-manifest.json` freezes **33** phase source/doc/test
hashes. `artifacts/phase02a-final-receipt.json` ties the final completion,
preservation checks and candidate identities together.

### Original-gate deadline obligation

The independently completed backend suite took **228.85s**, versus the original
gate's fixed **180s** command deadline. The actual gate was attempted only after
repairing its disk-fixture prerequisite and testing original refusal; it then
failed on elapsed time, not memory or a reported assertion. Its timeout was
**not increased**, tests were not skipped, and the successful independent
aggregate was **not substituted** for original-gate qualification.

**Owner/trigger:** 07 must converge the original gate to five successful steps
before authorized production action; 05/06 may improve bounded implementation
or qualification execution cost. Trigger is any original command exceeding
**180s**, nonzero exit, or fewer than **5/5** successful steps. Containment
remains the existing pre-maintenance refusal: no app shutdown, DB mutation,
admission opening or production publication. Preserve the real gate, reduce
the measured cost and rerun it, then continue the mandatory safe deployment
and observation. This is a recorded fixed-budget qualification obligation,
not an unimplemented 02A algorithm or a claim of production readiness.

The six explicit future-suite attempts (`lifecycle`, `capacity`, `browser`,
`restore`, `restart`, `fresh-installation`) return exit 1, “not yet implemented.”
Receipt: `artifacts/phase02a-future-suite-attempts.json`. These are later-phase
qualification obligations, not missing 02A algorithms and not production passes:

- **05** owns lifecycle/browser/restore/restart qualification and scheduler/GC
  integration; **06** owns 1m-fact/fixed-budget capacity and repeated replacement;
  **07** owns the actual authorized fresh installation, real authentication,
  safe-gated deployment, observation and fix-forward.
- Keep producers dormant until the whole 02B boundary is activated. Quarantine
  invalidated outputs and close affected admissions on any leaked stale row/
  CSV byte, SQL batch above 250 rows/1 MiB, chunk above 256 KiB, OOM kill,
  nonzero swap under capacity qualification, or missed 60-second lease fence.
  Fix and rerun the responsible suite; never suppress a failure or relax the
  real five-command gate.
- Production convergence remains mandatory, not a test-only/NO-GO campaign
  ending. No production deployment/reset or retained-resource action occurred
  in this phase. The `seha` localhost:3002 and initial-reset authority remain 07.

## Exact 02B preconditions

1. Parent accepts these candidate contracts and receipts; no foundation
   implementation is delegated forward as scaffolding.
2. Activate the entire user/report producer, API, UI, cache, import/history,
   agent-usage and persisted-export boundary in one cutover, using the complete
   cross-root inventory in the handoff document.
3. Supply the real job dispatcher and lifecycle ownership, preserve existing
   middleware and role-policy classification, and update all scripts/fixtures
   to the same shapes and cursor continuation rules.
4. Delete predecessor full-source/report/matrix/CSV paths and extract the
   reused pure parser/record-ID helpers before deleting their containers.
   Do not add aliases, dual readers/writers, conversions or shadow publication.
5. Keep inventory authority unchanged until 04; report-dependent inventory
   consumers use the targeted candidate service. Retain the existing report
   content tables and phase-02 source contracts.
6. Re-run the full focused/aggregate/original-gate boundary after activation,
   complete 05/06 qualifications, then execute 07's safe deployment and
   observation obligations.

## Parent acceptance

Accepted **complete_with_risk** after contract/code review and independent
verification. Parent verified all 33 source/documentation hashes and all nine
campaign prompt hashes, reran **371 focused tests in nine files** plus backend
typecheck successfully (76.13s), and reran gate orchestration tests successfully.
Editor diagnostics and diff hygiene passed.

Evidence: `artifacts/phase02a-parent-focused.log` and
`artifacts/phase02a-parent-orchestration.log`. Exact-label checks after focused
run `593594149a254b7eab2430ea3cbd8b7d` found no remaining containers, networks or
volumes. Production readiness on port 3002 remained HTTP 200.

The original-gate **0/5 timeout failure** remains open with the unchanged
180-second deadline and the containment/owner/trigger above. The independently
passing 5/5 aggregate does not supersede that failure. Dormant implementation
and frozen handoff are accepted for 02B; no production readiness or large-tenant
capacity claim is made.
