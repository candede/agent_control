# Record-data storage and selected reads

The current schema defines typed records, independently published user/report
sources and inventory. There is no historical schema chain, snapshot conversion
or migration replay. Initialize an empty development database or explicitly
reset an incompatible owned target, then collect/import current source data.
The singleton `app_schema` marker must match the compiled `schemaFingerprint`.
No database or deployment was executed for this code-only schema update;
earlier phase measurements in this document are historical evidence only.

## Persistence and publication

- `data_principal_epochs` persists account revocation independently of source
  existence. Capture `sessionEpoch` before beginning work; `revokePrincipal`
  rejects both existing writers and late starts from that session.
- `data_scope_epochs` identifies a tenant or principal/token/source/selector scope.
  A tenant scope has a SQL NULL principal, with `UNIQUE NULLS NOT DISTINCT`;
  it is not a principal sentinel. Scope and session epochs are durable fences.
- `data_generations` reserves bytes and stores schema version, source job/run,
  owner/version, 60-second lease, deadline, expected output revision, counts,
  content digest and availability expiry. Global admission is four active streams,
  two per tenant and one per selector. Logical tenant storage is bounded at 64 GiB;
  each generation at 8 GiB and 100,000 source records (200,000 for the frozen
  future derived/canonical envelope, still requiring domain validation).
- `data_generation_heads` publishes a complete generation with revision CAS.
  `data_generation_batches` records ordinal/digest idempotency and measured encoded
  parameter bytes. `data_generation_pages` records bounded page/token digests and
  wire-row counts without an in-process seen-token set. The generation digest is
  updated as a fixed-size hash chain, never a concatenation of all batch digests.
  Validation persists its phase, key cursor and counts every 250 parent records;
  plan checks inspect at most 1,001 child keys per parent to detect cardinality
  violations. Interruptions resume from the last committed slice.
- `directory_user_rows`, `directory_service_plan_rows` and `app_activity_rows`
  store typed identity, licensing and date facts. Residual JSONB is at most 256 KiB
  in PostgreSQL's textual representation. Children are relational; plan counts are
  validated in SQL, at most 1,000 per user. Generation/scope/tenant composite FKs
  reject cross-scope references. Record updates and truncation are not granted.
- `data_read_selections` and `data_generation_pins` retain at most 16 typed roots.
  History roots refer to a tenant-history identity/revision, not every retained
  report; inventory roots refer to baseline plus delta revision. Domain repositories
  must supply a relational root validator before these future root kinds can work.
- `data_exports`, `data_export_items`, `data_export_chunks` persist jobs, up to
  5,000 explicit identities and immutable ordered/checksummed chunks <=256 KiB.

Run-backed generation fencing/publication first takes the existing per-principal
data-sync transaction mutex, including before a derived input validator. This
matches sync status updates and publication-fenced people-cache writes and
prevents a run/source-row lock cycle. The remaining lock order is principal
epoch when needed, scope epoch, output head, generation lease, source job.
Multi-scope operations sort scope IDs. Revocation,
clear and abort use the same scope/head order. Derived publication requires a
transactional domain input validator, which locks captured input scopes first;
it does not compare safe input replacements against the latest head. Domain
integrations must provide `publish(..., { completeJob })` to commit source-job
completion in the publication transaction. Non-fixture publication refuses to
proceed without it; derived publication also requires `validateInputs`.
No provider wait or iteration owns a SQL transaction.
Inventory mutation/current-control callers take the shared principal epoch fence
before any captured/current scope locks, including before nested selection
assertions, so revocation cannot hold the principal while waiting for their scopes.

`DataGenerations.execute` owns independent 20-second renewal and cancellation.
Consumers pass its signal into provider and validation work. Renewal failures abort
the signal and durably cancel the generation. SQL fences remain authoritative even
when an old process ignores cancellation. Publication pauses and joins renewal
before its final transaction, keeps cancellation armed through COMMIT, and then
stops the timer/listener. Cancellation after a successful commit does not turn that
published result into a false failure; inventory execution returns the committed
root without a post-commit authorization check. All record consumers use `dataConnections`.
The shared application `BoundedPool` also admits legacy direct pool callers through
three foreground acquisitions, keeping one renewal connection available. This
infrastructure change does not replace any reader/writer's data authority.
There is a 32-request queue,
five-second acquisition timeout, four total pool connections and 15-second SQL
statement timeout. Admission errors return HTTP 429/503 and `Retry-After: 5`;
limit errors carry safe limit/observed counts. Do not open another unbounded pool.

Append is <=250 records **and** <=1 MiB encoded parameters (UTF-8 text Bind payload
and four-byte parameter length prefixes), with one producer batch
and one consumer batch at most. Identical batch retries are no-ops; changed replay
or duplicate identities poison the unpublished generation. Failed attempts retain
the preceding good head. Published data is immutable; retirement changes metadata.
The current schema freezes inventory attempt intent from its first provider page and all
attempt evidence after sealing. Runtime and operator updates cannot relabel a
published source's executed types, environment, role hint or provider totals.
Power Platform and Graph package refresh-job progress and completion use the same
100,000-record and 10,000-page bounds as streamed collection. Startup schema
verification requires those validated constraints. Power Platform role hints
remain diagnostic only: every supported plan preserves its requested agents,
supporting environments and environment filter.

## Read and export contracts

Inventory reads use selected SQL keysets. `GET /api/agents` returns source
`selection`, `counts` and `page` metadata, not a snapshot list or an offset.
Exact Graph detail is `GET /api/agents/:id/detail?selectionId=...`; the selection
may be the displayed canonical inventory or an explicitly selected Graph source.
IDs remain opaque and case-sensitive. The retired unselected `/agents/:id`,
`/agents/snapshots` and batch `/agents/details` routes are not supported.
Detail responses do not embed definition/category collections. Canonical source
members expose independently counted sections/children through
`/agent-inventory/:recordId/sections` and `/agent-inventory/:recordId/children`,
using the pinned canonical selection and bounded cursors. The saved
control editor may read at most 1,000 principals and 60,000 encoded assignment
bytes; exceeding that bound explicitly disables access editing rather than
presenting missing assignments as an empty scope. Neither a historical detail
selection nor its displayed control values authorize a mutation.

The browser captures inventory criteria with the CSRF-protected metadata-only
`POST /api/agent-inventory/selections` resource, then reads
`GET /api/agent-inventory?selectionId=...&limit=...&cursor=...`.
Before any canonical inventory is published, capture returns HTTP 200 with
`{state: "not_collected" | "preparing", message: string}` and no selection or
counts. This is an explicit availability result, not an empty successful
inventory. The browser shows collection guidance and checks again every five
seconds while visible and online, stopping when inventory is readable or a real
error occurs. These checks do not initiate provider collection. Published
inventory captures still return HTTP 201; a genuinely empty published inventory
has a real selection and zero counts. Existing selections retain their HTTP 409
invalidation semantics, and legacy initial GETs still return
`409 inventory_unavailable` when there is no published inventory.
The body contains `{query: { ...encoded wire criteria }}` without pagination
fields. Continuations never retransmit criteria: the immutable selection owns
filters, ordering and inventory scope. This keeps a legal 4,096-character Unicode
facet out of HTTP URLs without truncating its value. Initial GET capture remains
supported; neither capture transport changes source, canonical, control or job
authority. Shared selection metadata retains its original small bound; the current schema
stores the canonical criteria separately under the inventory-specific byte budget.
The Agents footer separates the localized result count from grouped secondary
Previous/Next controls, wrapping on narrow screens. Controls are disabled during
loading and at cursor boundaries; desktop/mobile browser tests verify spacing,
containment, styling and navigation on the same selection.
Standalone Graph pages use the same transport at `POST /api/agents/selections`
with `{query, mode}`, followed by short `GET /api/agents?selectionId=...` URLs.
Application captures and reads each require the existing shared-data capability;
the actor owns the selection while its source remains the authorized application
owner. A source selection cannot become a canonical selection or change token
mode. Both browser capture/read sequences abort across a principal revalidation.

Inventory selections pin only dependencies used by their selected projections.
Ordinary inventory reads use the captured immutable directory generation for
people labels, not the mutable people cache. Background person lookups therefore
cannot invalidate the first inventory read, subsequent pages, responsibility
results or export chunks. Explicit selected-person reads follow the same rule.
Search and owner/creator ordering do use the people cache: these selections retain
its revision fence and freshness deadline, and changed dependencies still return
`409 selection_invalidated` with `reason: "changed"`. Every pinned scope's session
and ownership authorization is checked before returning dependency-change or
expiry reasons, including when a different, earlier scope changed. Session and
ownership rejections do not disclose a dependency reason. Source-completeness expiry is
evaluated at the selection's captured time, consistently with the other saved
inventory checks.

`DataConnections.selectedRead` starts `BEGIN ISOLATION LEVEL REPEATABLE READ` on
the existing bounded pool. `DataSelections.capture`, `directoryPage` and
`exactDirectory` use this boundary. For domain composition in 02/02A, use
`DataSelections.read(id, identity, async (client, { selection, pins }) => ...)`:
all row, count, summary, facet and dependency queries for one bounded response
must use that callback's client, captured roots and `selection.evaluated_at`.
Do not call the pool, nest another read, return a lazy iterator/client, or wait
for a provider inside the callback. Return the bounded materialized result;
the boundary commits/releases before callers send it or yield the next batch.
Mutable dependencies still require domain revision/invalidation fences, held in
the common lock order; MVCC is not a substitute for authorization or invalidation.
Capture and assertions acquire **all** scope fences in sorted order before any
generation/domain revision locks. Capture preparation discovers roots in the
snapshot without taking downstream revision locks; inventory's reviewed-association
fence is acquired when persisting the context, after the scope fences. This avoids
deadlocks with writers that lock the same scopes before updating associations.
Inventory capture snapshots its actor and canonical filters before its first await;
later caller edits cannot change the selected owner, operation reference, facets,
people-cache dependency pins or freshness deadline.

Browser verification uses `backend/scripts/browser-fixture.browser.ts`, not a
generic Vite server. Its isolated synthetic-auth capability setup supplies the
repository's required publication fences explicitly; this does not make those
fences optional for runtime callers. The fixture serves and checks the compiled
frontend, blocks external provider requests, and creates its own test database.
Build the frontend with `NODE_ENV=production` before running this test-only
backend harness; inheriting `NODE_ENV=test` bundles development React and its
Strict Mode effect replay. The full campaign includes the saved-backend lifecycle
controller as well as explicitly selected lifecycle runs. Its held successor
publications are owned by that controller, while the ordinary inventory worker
continues to service the other synthetic principals. Lifecycle scenarios use a
separate synthetic tenant because report history is tenant-owned; report imports
elsewhere in the campaign must not contaminate their empty-history assertions.
Layout fixtures settle
permission metadata before exposing workbench actions, so request-count assertions
measure steady-state refresh rather than a legitimate startup authorization
transition. Separate App regressions retain coverage of early observers and
changed permission evidence without reloading unchanged saved content.
Synthetic selection capture returns the complete captured metadata, including
publication revisions, consistently with subsequent selected reads. Returning
to an unchanged, unexpired filter reuses its existing selection and page. Focus
revalidation of pinned agent usage checks report history, not unchanged summaries.
Explicit browser-file selections match whole filenames at a path boundary, not
other filenames ending with the same case-insensitive suffix.
While sorting an existing inventory, its saved-source warnings remain visible
with the retained rows; initial loading and inventory-scope changes do not show
warnings from another scope.

`DataConnections.run` remains the ordinary writer/renewal transaction boundary
(`BEGIN`, unchanged default isolation). `DataSelections.assert` is its low-level
transactional writer fence, not a selected-projection API. Export admission,
lease renewal, chunk writes, cancellation and transactional audit/publication
retain writer isolation and every existing durable scope/selection/lease fence.
Selection capture keeps tenant-wide quota serialization: it acquires the same
advisory admission key before starting the snapshot, then releases the session
lock after commit/rollback (and discards the client if unlock fails). Taking a
waiting transaction advisory lock *inside* repeatable read would allow stale
quota counts; concurrent captures at the limit must not over-admit.

PostgreSQL serialization conflicts (`40001`) roll back the entire selected read
and surface as `503 data_read_conflict`, `Retry-After: 5`, through the existing
error/telemetry path; the original SQLSTATE remains in the error cause. There is
no automatic callback replay, READ COMMITTED fallback, partial success or silent
recapture. Retry the whole bounded request with the same selection; a subsequent
authorization/dependency invalidation still returns `409 selection_invalidated`.
Routes added in 02B/04 must preserve these error semantics. Export builds persist
and audit `data_read_conflict` as failure rather than publish partial artifacts.

Cursors are HMAC-authenticated using an injected existing server session secret;
they bind tenant/principal/authorization, endpoint, selection/revision, canonical
query hash, direction and null/key/identity boundary. Encoded size <=4 KiB.
Selection and revision UUID bindings compare case-insensitively without rewriting
the signed payload. Opaque bindings, actor identities, hashes and row keys remain exact.
The encoder refuses boundaries the decoder cannot accept, and noncanonical
base64url signatures are rejected even when they decode to the same HMAC bytes.
Report and user-source readers resolve compact hashed boundaries in the same
immutable selected relation when valid Unicode keys would exceed that budget.
Canonical allowlisted query values and a root count are persisted, not just their
hash. User-source searches normalize with NFKC, lowercase, NFKC again, then trim;
both raw and canonical search must fit 256 characters, with matching SQL folding.
Selections expire within ten minutes or the earlier source/freshness transition,
and explicit epoch invalidation wins. Published inventory observation freshness
is not its read-retention deadline: retained current inventory roots use the same
bounded thirty-minute dependency pin as their captured inputs. New selections
can read aged saved publications without extending observation freshness or
granting current mutation authority. Agent usage summaries, reviewed associations,
users and report history resolve the same captured memberships even when their
observation freshness expired before capture. These saved-source queries are used
only after selection validation; live reads and association mutations retain their
current, fresh delegated-inventory authority checks.
Page leases still expire within ten minutes,
and people-cache freshness transitions still shorten dependent leases.
Package and native last-success timestamps follow their validated current
publication, independently of observation freshness and finite job retention.
Saved environment context likewise remains available from its exact captured
native root after freshness expiry; its original observation deadline is preserved.
Verification counts account for every captured source membership, including aged
publications; detail freshness is evaluated separately at the selected instant.
Historical browser fixtures keep read-start timestamps consistent with their
synthetic observations and use the production exact-observation writer, so
replacement evidence includes the required detail provenance without live reads.
Pages default to 50, maximum 100; exact
identity reads accept <=100 IDs. Invalid cursors are HTTP 400; invalidated
selections are HTTP 409. No cursor draining, full getter or offset API exists.
The complete page envelope is included in the 1-MiB response ceiling. Selection
admission (100 active per principal, 1,000 per tenant) returns HTTP 429 with a
five-second `Retry-After`.
History-root expiry uses PostgreSQL's current clock, as source/generation fences
do, rather than an independently skewed application-host clock.

Exports persist all/explicit selection mode and supply canonical query values,
selection identity and a bounded selected-ID iterator to their async source.
Domain producers in 02A/04 must read each <=250-row/1-MiB SQL batch through
`context.read(async client => ...)`, using that one client for all composed
queries. It rechecks the export lease and selected roots inside repeatable read
and returns before the generator yields; no transaction spans backpressure.
Selected-ID pages, persisted chunk verification, status and downloaded chunk
reads also use short repeatable-read transactions. Export-retained roots can be
used by composed queries through `DataSelections.read`'s `exportId` option.
Export-local advisory serialization is acquired before each read snapshot and
lease/chunk write, then released before yielding. A healthy independent renewal
cannot invalidate its own repeatable-read row fence. Cancellation, epoch
invalidation and genuine serialization conflicts still fail closed without
replay. Inventory producers retain one immutable selected context and summary
per artifact, not a tenant dataset. Member and child windows use the existing
250-row/one-MiB SQL batch budget; the individual export-record ceiling remains
512 KiB. Every bounded batch still reauthorizes its
lease and selected roots; the first member/child windows share their parent
page transaction and further windows use the same bounded read contract.
They require a transactional audit adapter.
The adapter records start/success/failure/cancellation semantics; domain-specific audit
actions and producers belong to 02A/04. CSV formula defenses reuse `csvValue`.
Ready publication verifies persisted chunks, counts and SHA-256 under source/lease
fences. Persistence and verification batch at most four unchanged 256-KiB chunks
(one MiB) per transaction, avoiding a selected-root fence round trip for every
individual chunk without retaining the full artifact. Repeated string cells
reuse formula-safe CSV encoding only within one producer batch, capped at
256 KiB of encoded values; objects are never cached. Status contains metadata
only. Downloads iterate one chunk at a time,
recheck authorization and source fences, and record failure on disconnect.
There is no filesystem dependency or full-artifact string/Buffer. The route owner
must stream with backpressure, abort on disconnect, destroy an already-started
response on error, and apply the provided private/no-store attachment headers.
HTTP creation and cancellation carry the current account/session fence into
their transaction's pre-commit check; status responses revalidate before release.
Native downloads validate the stored session,
local account authority and selected source before each release, including after
the transactional verification audit. Their transport finish runs inside the
download attempt: the last chunk remains withheld until those checks commit.
HTTP verification records `inconclusive`, not success, while transport is pending.
An on-time response `finish` then appends success with that observed finish time;
a failed finish records failure or cancellation instead. Terminal audit failure
after acknowledged transport completion is logged separately and cannot deny or
relabel the completed attachment. A missing terminal receipt remains inconclusive;
there is no automatic delivery reconciliation, and server finish does not prove
browser receipt or a saved file. Non-HTTP iteration retains transactional success
at its acknowledged verification COMMIT. Connection cleanup after acknowledged
creation, build publication, cancellation or iteration completion is reported
separately without changing that durable outcome.
Artifact expiry bounds stalled backpressure. Audit-settlement failures are
reported separately and never replace the primary producer/download failure.
Receipts retain bounded phase, persisted dataset kind, all/explicit mode, selection
ID and query hash, plus the pinned report-set/history identity when present.
They never retain query filters, selected record IDs, CSV cells or session roles.
Creation snapshots the minimal actor identity before awaiting admission. The
adapter rejects actor/kind mismatches and uses the supplied transaction client;
it never owns COMMIT or a separate connection. Build starts represent admitted
queued intent, not the moment the background producer begins. Explicit cancellation,
shutdown of an owned build and interrupted iteration are recorded as cancelled;
authority, expiry, checksum and producer failures remain failures with allowlisted
codes. Shutdown before lease admission leaves queued work retryable.
Cancellation shares the in-process builder signal across engine instances using
the same pool; other processes still stop at their durable lease/heartbeat fence.
After registering its local cancellation signal, a builder rechecks its durable
lease before invoking the source, including cancellation during admission.
Inventory export fences also recheck the captured reviewed-association revision
on creation, source reads, publication, status and download, even when the producer
retains its immutable context. Retention expires artifacts and releases pins invalidated
by that revision. Build failures retain the safe `selection_invalidated` code so
consumers can restart their selection.
Cancelling a ready artifact revokes download access without rewriting its already
successful build outcome. Publication and download verification reject missing
or extra persisted chunks as well as byte-count, size and checksum inconsistencies.
Transport completion checks artifact expiry synchronously, rather than relying
only on delivery of the deadline timer.
Read-page TTL and export lifetime are distinct: an export may continue using its
captured roots beyond read-page TTL, but never beyond its own 30-minute expiry,
15-minute build deadline or an earlier source/freshness boundary. Epoch invalidation
always wins. No export routes or producer registrations are added in 01.

## Qualification and reset boundary

```powershell
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite selected-reads
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite foundation
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite all
pwsh -NoProfile -File ./scripts/local-deployment.tests.ps1
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite export-readonly
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite gate-failure
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite software-gate
```

The wrapper uses a new `agent-control-ltdp-<uuid>` project, synthetic passwords, no
published ports, no external network and a labeled disk-backed volume. The override
removes inherited PostgreSQL tmpfs; the ordinary small deployment fixture remains
unchanged. Node/PG limits stay 1,536/1,024 MiB. Candidate images extend the immutable
campaign baseline without installing dependencies or replacing retained tags.
The runner verifies the baseline image ID and every dependency manifest/lockfile
hash before reuse; dependency changes require an explicitly verified approved-feed
baseline build. Candidate source is copied into the image rather than live-mounted.
The read-only smoke proves filesystem refusal and durable build/download audits.
`gate-failure` uses a separately tagged deliberately failing image and succeeds only
when the original helper refuses it and safely cleans its resources; it is never
software qualification. Its persisted receipt contains the flattened failures;
only the single expected exit-17 failure is accepted, not accompanying capture or
cleanup failures. `software-gate` runs the unchanged real `test-all.ts`.
Future suites fail explicitly until implemented; `all` attempts each of the five
software commands independently and does not substitute for the official 5/5 gate.
Each independent command owns a separate process group. At its unchanged
600-second timeout, the runner stops that exact group before another command
starts; a surviving Vitest worker must not compete with later frontend checks.
A cleanup error stops the fixture rather than admitting another workload.
At foundation acceptance, the original gate retained 180-second command deadlines.
The later production-first continuation extends only the whole backend-test step
to 1,200 seconds; the other four steps and all correctness/resource checks remain
unchanged. See the current policy in [operations](operations.md).
`backend-shard-1` and `backend-shard-2` provide supplemental, sequential coverage
of every backend test with Vitest's two disjoint file shards, using the same
resource and command limits. They do not replace the unsharded `all` attempt or
the original deployment gate, and their results must be reported separately.

Persistent evidence is under `artifacts/large-tenant-data-platform/<run-id>/`.
The original deployment gate separately captures under
`artifacts/software-checks/<check-id>/`: live and final state, OOM/exit, cgroup
current/peak/events/stat, bounded sanitized logs and failure receipts. Capture starts
before the workload is released, and finishes before exact test-container removal
and PostgreSQL teardown. Missing counters are unavailable, not zero. Cleanup and
capture failures remain failing gates alongside any original workload failure.

These fixture commands do not authorize a reset of any retained installation.
An explicit development `start -DbReset` remains a separate owned-target action;
it requires credential/ownership preflight and app drain, but no pre-reset
backup. Never reset retained data to run tests or use whole-project destruction
as a schema initialization shortcut. No such operation ran in this code-only task.

## Current user-source foundation

`db/userSourceStages.ts`, `db/userSources.ts`,
`services/userSourceProvider.ts`, `services/userSourceRecords.ts` and
`types/userSources.ts` define the current factories/contracts used by source
collection and selected reads. There is no legacy snapshot activation path.

### Producer and publication boundary

- `UserSourceProvider.refresh` consumes one directory or app-activity source;
  `refreshSources` settles at most two independently successful sources and
  returns SQL metadata/status, not an array of users. The caller supplies
  `authorize(source, signal)` **both before collection and before publication**.
  02B must bind the existing capability, fresh-principal, token, provider-admission
  and source-job checks; no permissive default exists. Directory requires
  `User.Read.All` plus `LicenseAssignment.Read.All`; app activity requires
  `Reports.Read.All`. Existing viewer/provider-role distinctions remain.
- `UserSourceStages.execute` owns a `DataGenerations.execute` lifetime, including
  its independent heartbeat. Supply the captured session epoch and a 30-minute
  user-source deadline. Non-fixture execution requires
  `completeJob(client, { source, generationId, jobId, runId, rows, bytes })`.
  This runs in the **same writer transaction** as the head and attempt-success
  update. With a shared Users job, record each independent source's progress;
  do not terminate that job while its other source is still collecting.
  Failed completion rolls back the head, generation state and job update together.
- JSON reads retain 100 directory rows/16 MiB per page, 1,000 catalog observations,
  200 catalog pages, 1,000 discovery pages and 6,000 exact-verification pages.
  Discovery predicates use at most 20 SKUs. Exact verification uses at most
  20 normalized IDs/UPNs and shrinks further at an 8,192-character encoded URL.
  Endpoint/origin and unchanged continuation filters are checked before the
  next authenticated request; repeated tokens are checked against SQL hashes.
- `identities(lease, values)` accepts at most 250 bounded synthetic/new report
  identities at once. SQL deduplicates plausible exact IDs/UPNs, caps unique
  inputs at 100,000, and never guesses aliases for concealed labels.
  `verificationBatch` processes at most 250 pending inputs in a short transaction,
  marks already-known identities, then returns at most 20 unresolved inputs.
  `verified` records completion even when Graph returned no matching user.
  02A supplies positive-activity report identities through this API, not an old
  full-report getter.
- `user_source_queries`, `user_source_query_members`, `user_source_skus` and
  `user_source_identity_inputs` retain query/count/dedup work in SQL.
  Identical directory/catalog observations coalesce where provider overlap is
  allowed; conflicting observations poison the attempt. Counts reconcile
  distinct query members, separately from wire rows. CSV records do **not**
  coalesce: repeated UPNs and ID/UPN aliases remain ambiguous matching evidence.
  Evidence parameters are charged against the generation reservation, including
  repeated membership inputs conservatively; they are not free storage.
- `streamAppActivity` incrementally decodes strict UTF-8 and uses installed
  `csv-parse`, with 16-KiB input slices/backpressure, exact shared v1/v2 fields and
  the current D28/v2 request. Current typed records bind
  the requested period per attempt, including empty reports; old data is not converted.
  Wire bytes are capped at 64 MiB, data rows at 100,000, supported fields/headers
  at 1,024 characters (UPNs at 320), and one CSV record at 64 KiB. Unknown extra
  columns remain ignored within that record bound. Empty/header-only input,
  blank dates, impossible dates, reordered columns and added columns have
  explicit tests. A signed download gets no Graph token; only the two established
  report download origins/paths are allowed.
- Requests enforce a 15-second deadline even when the transport ignores abort;
  late responses are discarded without following redirects or continuations.
  JSON page reads share that deadline. Reports bound headers separately, then
  enforce 15 seconds without body progress only while a network read is pending;
  database backpressure remains covered by the source deadline and lease.
  Request/body deadlines report `provider_timeout`, while received HTTP denials
  and cooldowns retain their original status and Retry-After.
  Retryable HTTP responses get at most three
  attempts, honoring Retry-After through 600 seconds without a held DB client.
  Larger delays fail explicitly. The 60-second lease/20-second heartbeat stays
  independent during backoff and validation. No source success is inferred from
  an incomplete page or failed CSV tail.
- Directory records contain scalar typed facts and a fixed-size evidence digest.
  Display names retain the accepted 512-character bound; NFKC/lowercase sort keys
  may expand to 9,216 characters and are retained in full. Name indexes store only
  a 128-character prefix without wide included labels; name paging orders by
  that prefix, then the complete key and exact ID. Cursors still bind complete
  keys (or their selection-bound compact anchors), so prefix ties never merge
  users or change forward/backward ordering.
  Service plans remain relational, at most 1,000 per user. The original
  submillisecond assignment timestamp is retained as a bounded scalar residual;
  its typed timestamp remains available for relational date operations.
  Mapping and staging accept bounded, finite own-data evidence only: accessors,
  proxies, sparse arrays, custom serialization and cyclic data fail explicitly
  before encoding or writes. Staging detaches each input batch before its first
  await, so parent hashes and child evidence always describe the same snapshot.
  Directory and plan GUIDs are exact, case-insensitive Graph identifiers;
  assignment timestamps share the provider's genuine-calendar/explicit-timezone
  validation and UTC normalization before hashing. Activity ordinals remain
  bounded integers, and typed dates use genuine positive four-digit years.
  Text cannot contain NUL or unpaired surrogates; normalized identity keys retain
  lowercase expansion up to the existing 512-character storage limit.
  All SQL record batches are at most 250 rows **and** 1 MiB of encoded parameters;
  a single oversized record fails. No full-domain array is reconstructed.

### Selected reads and 02A composition

`UserSourcesRepository.capture(identity, tokenMode, filter)` captures metadata
and roots on the **same repeatable-read connection/evaluated-at instant** through
the new additive `DataSelections.captureWith` callback. The existing `capture`
delegates to it without changing its authorization, quota-admission or fence
semantics. No selected projection uses plain writer isolation.

A `user_sources` root refers to the principal/token-mode scope and its mutable
people-dependency epoch. Its validator checks exact scope, revision and expiry;
there is no permissive root stub. Up to two generation roots identify directory
and activity. `user_source_read_contexts` stores only the two sources' captured
scalar metadata, not user data. Normal replacement preserves old pinned
generations and metadata. Cache writes invalidate the mutable root; selections
also expire before the earliest relevant cache/source/freshness transition.
Already-stale data does not cause immediate selection expiry.

Public dormant methods are `page`, `exact`, `plans`, `facets`, `people`,
`projectPeople`, `refreshStatus` and `savePeople`. For 02A composition, use
`userSourceFactsSql`, `userSourceSqlParameters`, `metadataInRead`,
`countsInRead`, `summaryInRead`, `contextInRead`, and `read`.
All composed queries must use the supplied callback client and evaluated-at
instant. Combined report selections may reuse the source SQL/metadata and root
validator within their own history-aware context. Do not call an old getter or
fill report metrics with zero/null placeholders. 02A owns actual report facts,
combined cohorts/thresholds, agent usage and export producers.

Candidate filters are `search`, exact nullable `company`/`department`,
`entitlement` (`paid_active`, `paid_inactive`, `no_paid`, `unknown`),
`serviceState`, and `activity` (`active`, `inactive`, `unknown`). Sorts are
`name`, `upn`, `company`, `department`, `service`, `activity`; order is `asc`
or `desc`. Unknown keys/values fail. Search/name keys use Unicode normalization
and lowercasing; SQL keyset comparison and ordering use explicit C collation,
nulls last, and immutable identity tie-breaks. Reverse pages retain display
order. No offset/all switch exists.

Pages default to 50, maximum 100. Exact object-ID requests reject more than 100
inputs, normalize case and never broaden to directory enumeration. Plans are
separately paged. Company/department facets are separately keyset-paged,
including a distinct null option; they omit their own selected facet filter but
retain all other row filters and facet search. Their counts are exact distinct
options, while each option's count is matching people. Page totals are the
unfiltered authorized source cohort; filtered counts/summaries honor every
applied filter. Checked directory count remains separate from licensed count
and is never called tenant headcount.

Entitlement distinguishes active paid features, assigned inactive paid features,
verified no paid feature, and unknown. `no_paid` is **not** evidence of basic/free
Copilot Chat access. A failed latest directory attempt retains rows but makes
current licensed/adoption counts unknown. App matching preserves the original
exact-identity ambiguity rules, the inclusive recorded window (D28 for new v2
reports, D30 for retained v1 reports), and three-day freshness
policy. An empty app report is partial/unknown, not stale or zero activity;
stale dates remain labeled source facts. Official-report measures are absent
from these contracts.

The entire response is bounded to 1 MiB; counts use checked safe-integer
conversion. Existing cursor/authentication, `400 invalid_cursor`,
`409 selection_invalidated`, and explicit non-replayed
`503 data_read_conflict` / `Retry-After: 5` semantics remain.

### People and current selected reads

`savePeople` writes the existing exact person cache under the
principal/session and sorted dependency-scope fences, with a mandatory
transactional caller fence. It invalidates all token-mode people roots on change.
Legacy full-directory cache save/read hooks are retired. Resolved/not-found/
failed TTLs remain seven days/one day/15 minutes. A newer directory observation
wins over an older check; a later failed lookup overlays failure metadata but
preserves the latest conclusive identity or 404, without reviving stale names.

`projectPeople` accepts at most 100 caller records, checks their tenant before
any lookup, and batches at most 300 referenced IDs into exact reads of at most
100 each on the same selected client. It discards preexisting people overlays
and never loads unrelated directory people. Both current and selected people
projections capture bounded own-data inventory and scope before asynchronous
reads, returning detached inventory rather than retaining mutable caller records.
Current service reads accept a caller client only inside an owned
`DataConnections.selectedRead` callback; repeatable-read connection defaults
alone do not establish a shared transaction snapshot. Native people references
require a Power Platform source and matching record presence. Reprojection also
refreshes existing owner/creator column labels from the selected evidence, so
discarded overlays cannot leave stale names or lookup statuses in display columns.
Only exact Graph GUID references are case-canonicalized; opaque responsibility
identifiers retain their case, Unicode and whitespace in facts, display and
exports. Padded GUIDs are not directory IDs and never become navigable users.
Inventory and responsibility searches normalize both query and compared labels
with NFKC/lowercase/NFKC, enforce the 256-character bound after expansion, and
leave the original evidence unchanged. Equivalent responsibility searches share
the same cursor fence.

Current selected-data routes and readers consume bounded exact records. Old
whole-source getters, snapshot codecs, `copilot_usage_snapshots` and
`copilot_usage_source_state` are retired together with historical schema
definitions. Initialization does not recreate those tables. Cleanup, grants,
backup inventory and browser/restart fixtures target the same current schema;
no dual reader, schema handoff or frontend old-data conversion remains.

Run `pwsh -NoProfile -NonInteractive -File ./scripts/large-tenant-tests.ps1
-Suite user-sources-foundation`. Its six exact suites plus backend typecheck
exercise current factories and runtime behavior. SQL/parameter/EXPLAIN
receipts at 1,000 and 10,000 users are printed from the actual runtime-role DB.
They are not the later 100k/fixed-budget capacity qualification.

## Active inventory storage

The current schema supports
`StreamedInventory`, selected SQL reads, off-request canonical reconciliation
and the shared durable export dispatcher. Users and reports retain their
record authority. There is no predecessor inventory schema to activate.
Graph and Power Platform refresh services publish source completion and job
success in one transaction; only a committed complete source enqueues canonical
work. GET handlers neither reconcile nor publish. `PackageRefreshJobs` and
`PowerPlatformRefreshJobs` retain only bounded job admission, metadata and
target-page operations, not source readers or publication methods.

### Sources and temporal storage

`presence`, `link_state`, `availability` and `management` are typed columns
on the three current inventory record tables, not generic scalar facts.
These columns are authoritative for list, detail, summary and filter reads.
Classification values must be complete and valid for their source domain;
missing or conflicting classifications are not replaced with defaults.
New canonical residual JSON contains only identity-reason metadata, rather than
another copy of its identity, name, environment and classification columns.
Source residual JSON remains bounded provider evidence; presentation facts
are derived projections, not an alternative classification authority.

Current collectors write native modification timestamps and typed classifications
directly. Duplicate or invalid classifications fail validation; there is no
singleton-fact copy, old-data backfill or data-preserving schema upgrade.
Scalar-fact inserts for these fields are rejected. An incompatible development
installation requires explicit reset; ordinary current-schema initialization
preserves current records.

Only four fields are promoted: they replace repeated scalar fact lookups in
existing queries. Identifier, responsibility, access and connector collections
do not gain speculative tables. Package/API contracts are shared with the
frontend; browser-only detail metadata is an explicit extension.

`StreamedInventory.graphCatalog` and `powerPlatformCatalog` consume pull-based
provider pages. They persist the continuation digest before requesting the next
page, then persist accepted raw/unique/expected counts. A duplicate identity,
conflicting count, cycle, unaccepted final page or scope mismatch aborts the
unpublished generation. Expected counts remain nullable, not invented zeroes.
Source ceilings are 100,000 records, 10,000 pages and 5,000,000 wire observations;
Graph retains its four-hour deadline and PP has a thirty-minute deadline.
Existing authentication refresh, pacing, cancellation and response-byte guards
remain in the clients. Both streams retain the persisted execution deadline and
recheck durable generation authority before every physical request, including
same-page retries. Native fetches, continuation visits and progress callbacks
are interruptible even when their implementations ignore cancellation; late
response bodies are disposed without delaying failure. A native generator
closed by its durable consumer records an interrupted, not completed, query.
A separate, sequential, at-most-twenty-target automatic
detail job avoids catalog-wide detail fan-out. Manual exact jobs retain their
5,000-target ceiling and read persisted targets in twenty-row pages.
A confirmed exact 404 is a tombstone for
that explicitly persisted target, not a replacement of its catalog.
Token renewal caused by slow Graph preparation is followed by a fresh durable
fence before dispatch. Only an exact read's provider-backed HTTP 404 may stage a
tombstone; token, authorization, staging and diagnostic failures are not absence
evidence. Exact-job progress follows durable target staging and is interruptible
by cancellation, the persisted execution deadline or its thirty-second callback
budget, without advancing another target or publishing incomplete work.

`InventoryGenerations.execute` uses the shared owner/lease/admission/heartbeat
protocol. Inventory and run-backed transactions take the per-principal sync
mutex before generation/scope/head locks. The reconciler locks its input and
output scopes in one sorted order, including during renewal/publication.
The independent twenty-second renewal continues through the accepted
600-second Retry-After. Canonical staging additionally fences the current durable
reconciliation claim, not just its generation lease.

The activated Graph, native, directory and activity producers share the existing
four-global/two-per-tenant ingestion limit. Worker `execute` calls wait in a
per-pool, at-most-32-request admission queue instead of turning an ordinary
automatic run into a partial failure when its siblings occupy both slots.
The same queue preserves one writer per source selector: a newer catalogue waits
behind an already active bounded detail generation without cancelling it,
attempting a second writer, or replacing the prior readable complete catalogue.
The queue retains request order, allows independently admissible tenants to
proceed, releases the database connection between one-second admission attempts,
and respects the original deadline and cancellation signal. Only the explicit
`data_ingestion_admission` refusal is retried: serialization, authority and
storage failures are not replayed. A lease acquired after cancellation is fenced
before returning. Direct `begin` remains fail-fast, and no ingestion limit,
memory budget, upload quota or timeout is increased.

Immutable `package_record_rows`, `power_platform_record_rows` and
`unified_agent_rows` hold bounded scalar/residual content. `inventory_facts`
contains indexed matching, filter, sort, people and child facts. Presence markers
preserve empty versus missing collections; connector operations have separate
child rows. Native connector parent references must be exact zero-based source
ordinals, and operations may only attach to the current source-ordered parent
that reported an operations collection, before another connector or detail
collection begins. Contradictory saved structure fails with `saved_source_invalid`,
never numeric-alias parentage or manufactured operations.
Native provider timestamps normalize to UTC while retaining all supplied
fractional digits (up to nine) in residual evidence and CSV exports.
Saved channel views consult the selected source's collection section when no
child rows exist: an explicit empty collection says "None reported", while an
absent collection remains "Not reported". The marker read shares the same
selection, source identity and cancellation signal as its child read.
Writes use at most 250 rows and 1 MiB of actual encoded parameters.
Residuals remain at most 256 KiB. A component requires at most 250 source
records, 10,000 candidate edges and 1 MiB of reconstructed source data; a record
has at most 10,000 facts. Exceeding a bound is a named failure, never truncation
of identity evidence or partial canonical publication.

`inventory_roots` is a baseline anchor; `inventory_memberships` has immutable
content references, `valid_from_revision` and a once-closed
`valid_to_revision`. A twenty-key delta inserts/closes only its changed keys.
Head CAS, interval closure, counts, changed-key receipt and job completion commit
together. A failed stage never closes a live interval. A complete broad
replacement may create a new anchor; SQL preserves later-started exact present
and missing observations against an older-started scan. An initial exact-only
root is explicitly partial rather than a fictitious complete catalog.

`inventory_exact_heads` retains one fenced latest exact observation reference per
key and observation epoch, including missing-target tombstones. Broad swaps and
reference compaction preserve that epoch; a new source after clear/revocation
starts a new epoch. The complete catalog timestamp is a scope-wide absence
watermark, not a per-key substitute for newer exact evidence. Older catalog
replacements retain the current effective references; newer replacements carry
exact exceptions in SQL. Exact writes touch only their at-most-100 target keys,
and stale exact reads cannot replace newer presence or absence. Heads protect
their immutable key/content from GC; superseded/invalidated heads are removed
in at-most-50-row fenced metadata slices. Old selection/worker pins independently
retain their temporal references, not mutable precedence heads.

The baseline generation is storage identity, not the freshness/authorization
authority for every future revision. `DataSelections` checks its existence and
scope; the inventory validator checks the selected `inventory_revisions`
generation's current scope/session epochs, validation, expiry and inputs.
Per-record expiry and the next availability transition bound a captured read.
Catalog observation/expiry/completeness are retained independently on the root;
detail, control and reference compaction do not refresh them.

Controls reuse the **existing verified block/access readback authority** and
qualification gates. The current schema's control-readback fence invalidates dependent
inventory epochs in the transaction recording a verified readback, before a
new effective control observation is projected. `controlReadback` only consumes
that authority; it does not call a mutation provider or manufacture qualification.
Application observations cannot authorize delegated controls. `clear` invalidates
the epoch and retires the root atomically, so later exact work cannot resurrect
cleared membership.
Native mutation and explicit provider-GET reconciliation workers settle committed
control projections off GET before the next exact target check. This barrier
retains the existing per-item deadline, cancellation, session, maintenance and
provider-admission checks; it neither replays provider writes nor authorizes from
the job's historical snapshot. Dispatch rechecks current native membership,
environment/bot identity and the frozen provider prestate/timestamp. A changed
control-derived generation therefore does not strand a verified canary's
restoration or unrelated confirmed targets, while a replaced native identity
still denies dispatch.
Recovery sweeps include pending control owners even without a surviving source
scope, so bounded orphan cleanup does not depend on another refresh. Cleanup
and settlement recheck cancellation and initiating authority after their final
read, including empty batches. Settlement waits on canonical work only while
a current, unexpired delegated source remains in the current scope/session
epoch; abandoned work cannot consume the next item's deadline after all sources
are unavailable. This does not restore target authority: dispatch still requires
the current exact membership and identity checks above.
Identity-cache writes use the same live membership authority and source
provenance. The current schema separates exact membership, typed identity and
cross-agent uniqueness checks into indexed, parameterized statements; digest
lookups always retain full-value equality. The trigger still takes the
account data-sync lock and rejects a changed, expired or ambiguous source.

### Reconciliation and selected reads

`InventoryReconciliation.request` coalesces the latest current input vector
without replacing an active capture. One active claim and one pending vector
exist per scope; queue admission is tenant-serialized and bounded at twenty
active/queued scopes. `runNext` claims/pins a vector, uses indexed SQL frontiers
and candidate edges, and invokes the existing matching and augmenting-path
merge/split survivor rules only for bounded components. Each frontier vertex is
a separate short transaction. Safe new inputs do not cancel active work;
clear, revocation, source expiry and control fences do.
If a failed attempt's claim cleanup also fails, both failures are retained rather
than replacing the original staging/publication failure with the cleanup error.
Isolated and paired fast paths shrink their source-ordered batches when combined
child facts exceed the canonical work-byte budget. A single oversized component
still fails explicitly without publishing partial membership.
Graph package IDs remain opaque and case-sensitive in both new and previous
survivor mappings. GUID/native normalization is limited to native PP domains.

After publication, call `runNext` again to drain a pending vector. Normal polling
also compares the previously declared source scopes with their durable heads,
recovers an enqueue missed after publication, and refreshes expired claims.
Repeated identical or late older requests are no-ops, not backwards revisions.
An identical vector is a no-op only while its canonical output remains reusable
in the current scope/session epoch and has not expired. Recovery rebuilds an
unavailable output from the full source vector, retaining available prior survivor
IDs. Delta work rechecks that reusable output through staging, renewal and
publication; losing it fences the attempt for a full rebuild rather than publishing
only changed records as a replacement baseline.
Call `request` **after** the source publication transaction has committed, never
from its transactional `afterPublish` callback. The committed heads/change log
are the restart evidence. The source `completeJob` callback still belongs in its
publication transaction. First registration supplies the explicit authorized
source vector; the worker does not discover other principals or invent scopes.
Within that captured vector, native agents and environment context independently
choose the newest complete tenant-wide query for their resource type; a scoped
query cannot replace an available tenant-wide query. Selection is by the original
catalog observation, not a later control-readback or compaction timestamp.
Canonical processing excludes superseded native membership while retaining
all dependency pins/fences. Exact native survivors retain their canonical IDs
when the winning query scope changes, and a verified empty query removes the
old membership rather than unioning obsolete rows back into the current view.

Forward69 stores the next identity-evidence expiry on each immutable canonical
record and indexes expiry work. Current live authority is clipped by that
timestamp immediately, including inside an already-open transaction. The
existing off-GET worker queues affected components when their source vector is
unchanged, re-evaluates detail age at one canonical generation time, and
publishes the derived result without copying sources, claiming a provider
refresh, or changing source heads. Repeated passes do not regenerate an already
aged component; pending expiry never replaces a running captured vector.
Selected pages/details age only their bounded presentation at the pinned
selection instant, with matching SQL checked/stale counts. An older pin remains
historical evidence, never current mutation authority. Before the worker catches
up, new reads identify the stale details and `catching_up` state rather than
claiming the identities are current. Catalog and exact-detail observation IDs
remain separate from later verified control readbacks.
Completed empty detail reads retain their observation/expiry and detail-generation
provenance after expiry or an identity conflict; loss of reusable identity is not
a never-collected read. Invalidated observations stay invalidated through catalog
reuse until a new exact read replaces them. Missing detail observations have no
detail-generation reference, including when an older detail job retains a newer
catalog observation. A missing detail read does not clear a sticky identity
conflict; only an authoritative exact reread can replace that evidence.
Access enrichment and child-fact carry use the same
known scope aliases while preserving raw catalog strings and explicitly newer
catalog collections; different unknown scope strings are not equivalent.
The forward69 guard requires empty pre-expiry derived rows; it neither converts
nor backfills an older canonical representation.
CDS control qualification requires an own fresh observation keyed by the exact
opaque Graph package ID; inherited observation-map properties are not evidence.

Saved presentation rejects malformed row, person, environment and identifier
evidence with `saved_source_invalid`. Environment scalar fields, Power Platform
provenance and paired generation IDs/timestamps are validated; freshness uses the
exact pinned selection instant, inclusive of observation and exclusive of expiry.
Native identifiers retain their closed kinds and opaque values, with explicit
resource/environment identifiers agreeing with their source identity. Bounded
identifier previews remain valid without requiring omitted identifiers.

Automatic detail admission stores an immutable, bounded catalog-revision hash
beside each of its at-most20 staged targets (forward70). Per-target provider
backoff applies to that revision rather than suppressing a newly changed
identity for an hour. Descriptive catalog changes do not reset backoff; missing
or invalidated revisions precede stale refreshes. Authentication/permission
backoff still fences the entire lane. These hashes are scheduling evidence, not
current mutation authorization. Forward70 requires empty pre-cutover refresh
targets and does not backfill them.
Revision binding and scheduling hashes canonicalize typed manifest GUID casing,
but preserve opaque `appId`, `assetId`, `version` and `manifestVersion` markers
exactly, including GUID-shaped values. Modification timestamps must be valid
timezone-bearing calendar instants before binding reusable details.
Browser inventory-cache expiry uses complete validated instants, including
one-to-nine fractional digits and timezone offsets. It parses only the
millisecond ISO portion with `Date.parse`, comparing the remaining fractional
evidence separately; stale optional details remain non-active dependencies.

`InventoryQueries` provides active selection capture, list, global/scope/filtered
summary, facets, exact IDs/source references, source memberships, children,
people, usage, responsibility and current-control checks. Each response uses one
shared repeatable-read callback/client/evaluated instant. Source roots, report
history, directory/app metadata, people epoch and association revision are
captured together. People labels/statuses and report metrics use the activated
02/02A/02B SQL authority. Unknown metrics remain null. All presentation columns
and views reuse `agentPresentation`; SQL composes dynamic people, environment
and report values. List/facet/child/responsibility cursors are authenticated and
bound to the exact selection, endpoint and query. Byte-short pages retain real
lookahead; oversized exact results fail explicitly.
List cursors contain a bounded authenticated selected-row digest, never a
publisher/platform/version sort value. SQL recovers the full sort boundary
within the pinned context, retaining null-last order, identity ties and reverse
paging. `view` and non-`all` relevance constraints are independently conjoined.
Canonical text ordering uses the predecessor English base-sensitive ordering,
including accent/case equivalence and numeric version comparison, implemented by
the forward68 ICU collations. Exact identity ties remain ordinal and reverse
with descending order. Source-domain ordering remains its original ordinal
order. The same full-value collation governs keyset comparisons in both
directions; wide values are neither truncated nor replaced with hash ordering.
Platform facts use the shared authoring-tool normalization for both native and
Graph sources; linked records deduplicate normalized values. Facets expose the
normalized value with its shared display label and normalize filter inputs.
Dynamic facet API/route parameters use `~string:<literal>` and `~null`; absence
alone means unrestricted. Assigned access additionally accepts `~some-or-all`.
Facet responses retain typed nulls and the explicit `{kind:"some-or-all"}`
choice. Provider strings such as `all`, `__unknown__`, `available:all`, and the
tag spellings remain exact literals, never aliases. The current schema stores bounded
inventory criteria in the immutable inventory read context (32 KiB serialized,
64 KiB JSONB), with assignment criteria encoded as one tagged scalar. Shared
selection metadata contains only its canonical digest and, when present, the
operation reference needed by audit invalidation. The shared 2-KiB canonical
filter and 4-KiB JSONB limits remain unchanged. This preserves full-width
Unicode facet criteria without putting their values in cursors. The current schema
requires empty read contexts rather than converting older selections.
Browser selects encode their option keys
and keep null, combined, literal and unrestricted choices separate.
The selected-facet lookup resolves the captured value and label even when
another filter leaves no matching rows. It never walks all facet pages to find
a long publisher or the selected environment's display name.
Facet cursors carry a bounded digest resolved against the same selected SQL
options, not an arbitrarily long publisher/host label. Facet pages are byte-short
at 512 KiB as well as row-bounded. Storage indexes bound text prefixes and exact
matching keys so valid Unicode values cannot exceed PostgreSQL's B-tree tuple
limit; final equality and ordering still use the complete stored values.
Child-page budgets account for the encoded ordinal/kind/value/payload, including
multibyte values, rather than estimating each value at 4 KiB. Legal byte-short
pages retain continuation, and a first row beyond the 512-KiB child budget raises
`inventory_child_record_bytes` rather than appearing empty. The unchanged DB
payload constraint rejects JSONB child payloads above 256 KiB during staging;
a pure projection alone is not evidence of successful publication. Fact GC
likewise budgets the full encoded fact rather than payload plus a fixed estimate.

`currentControl` rejects application scope, historical output revisions,
reconciling/behind inputs and expired source membership before invoking the
existing transactional qualification callback. A readable old selection is
never itself mutation authority. SQLSTATE 40001 retains the shared explicit
503/Retry-After behavior with no callback replay or fallback.

Inventory exports use the shared durable dispatcher for `graph_packages`,
`power_platform_agents` and `unified_agents`. Export kind is checked against the
selected root inside its repeatable-read transaction, including empty sources;
an empty noncanonical page cannot masquerade as a unified selection. Source
reads are at-most-one-hundred-record keyset pages, member/child reads are independently bounded,
and the durable encoder owns cancellation, deadlines, row/byte ceilings,
formula defenses and 256-KiB artifact chunks. Explicit source IDs must each resolve
to one exact pinned source before admission and again before build paging; missing
or ambiguous IDs fail the entire export, including a native ID reused across
environments. Canonical references intentionally include all their distinct members.
Chunk writes, lease renewals and ready publication also fence lease expiry immediately
before COMMIT. Every artifact read verifies its persisted query hash against the
authorized selection, including status and each download chunk.
Build-time `export_selection_changed` withdraws the frontend selection
and download link, just like selection invalidation. Access/install principal assignments
remain excluded from CSV, including child rows and their collection markers;
their exact authenticated detail/control contracts are unchanged.
Native connector status and reported totals remain distinct from SQL-counted
saved connector/operation totals. Configured operations are exported as bounded
child rows with the same explicit safe-field allowlist, never connection IDs or
callback URLs. Graph catalog publication projects at most 100 records at once,
splitting at the 1-MiB work boundary before bounded append; exact/control reads
retain the same current-authority and observation-order fences. A single legal
high-fanout provider record retains its per-record limit; its children are
written in independently bounded batches instead of rejecting their aggregate.
Operation-reference selections pin their matching, principal-owned, bulk audit
evidence at the selected evaluation time. Unrelated export audit records and
newer operations cannot invalidate that pin; removal of matching retained
evidence still invalidates it before publication or download (current schema).
Pure CSV projection accepts at most
one hundred records and performs no whole-artifact buffering. Historical
synchronous 5,000-row/8-MB/15-second builder tests are replaced by current
projection tests and the actual durable worker's bounds/cancellation/integrity
tests, rather than retaining the deleted builder as a test adapter.

The durable schema permits at most 128 columns, including the unified inventory
and source/child provenance columns. Source rows use their own saved display
names and presentation facts, never the canonical row's aggregate fields.
`sourceEvidence` and `sourceProvenance` retain exact membership and field evidence;
source scope/generation, observation/expiry, catalog generation and detail
generation are explicit. Graph snapshot columns describe the catalog; source
observation columns describe the stored member. Unified `packageStates` preserves
catalog currency/scope, detail observation/freshness and control/field provenance
independently. Missing host/type collections remain absent, and supplied empty
collections remain empty. Zero saved connectors exports `[]`, not unknown.
Package element child rows retain their kind, ordinal and exact element identity,
but export only validated identity fields for AgentMetadatas, Bots and bot-backed
CustomEngineCopilots. `definitionStatus` is `identity_only`, `invalid`, or
`not_exported`; unrestricted definitions, runtimes, URLs and credentials are
never copied into CSV. Browser downloads still use the checked native attachment
URL, without downloading or parsing artifact contents into a Blob.

### Retention and predecessor removal

`compact` copies bounded reference batches, not record bodies. `gc` removes
bounded unreachable intervals; `gcContent` removes bounded facts/content and
reports actual deleted tuple bytes; `gcMetadata` removes bounded revision,
frontier, edge, request and completed-generation metadata. Read pins, active
worker pins and current/pinned canonical input references protect both content
and its temporal source revision. Immutable generations retain their original
accounting until fully collected by the shared retention path. The generic
retainer must not transition an inventory-owned generation to deletion before
domain reachability is released.

Native backup fingerprints verify the explicit current table/primary-key
inventory and compiled schema fingerprint. Content streams in stable key order
from the same exported snapshot as the dump; no legacy inventory is inferred.
Restore invalidates authority and prepares maintenance state before granting
runtime access; final schema/grant verification follows grants.

Current DDL excludes the old Power Platform snapshot/resource tables, package
detail cache, canonical registry tables and obsolete publication/clear helpers.
It does not convert, copy or backfill predecessor data. The package snapshot/resource
tables remain solely for the existing delegated, exact, single-package
block/access readback authority, enforced by `package_control_only`; they
cannot hold inventory observations. `packageControls` owns this existing
control authority and its fences, not a parallel snapshot inventory.

The old package/Power Platform inventory repositories, canonical registry
repository and whole-set unified service are removed. Only bounded selected
queries and small pure presentation/matching/survivor helpers remain in the
active path. Both provider clients expose backpressured page streams rather
than whole-catalog collection methods. Native streams use the foundation's
existing thirty-minute budget, while capability checks retain their independent
ten-second one-page budget. Page progress and diagnostics follow durable page
acceptance; repeated continuation and cross-page identity checks belong to
the persisted staging layer.
Native page identities JSON-encode the raw continuation string, with JSON `null`
reserved for the first page, so an opaque token such as `initial` cannot collide
with that first page. Provider requests still receive the unchanged raw token.
Native test-support collectors mirror staging's hashed page-identity uniqueness
without retaining raw continuations.

Runtime grants, clear, retention, backup and restore use the surviving tables.
Restore retains typed content for forensic evidence but invalidates selections,
source heads and current mutation authority before runtime admission.
Current inventory stores durable omission/page metadata.
Source acceptance accumulates omitted fields in SQL;
native job success commits that exact count. Compaction retains the original
catalogue page count, omission count and authorized role scope rather than
presenting the compactor's zero provider pages as the source observation.
Package refresh jobs have no obsolete catalog-only switch.
Every broad refresh streams catalogue observations; detail
enrichment remains the separate, paced, at-most-twenty-target queue required by
the foundation. Unknown collection totals stay null until the provider supplies
a total or finishes enumeration. Published refresh metadata includes its exact
committed generation ID.

Inventory browser caches retain only the selected current and adjacent pages,
discarding other filter families and fencing abandoned responses. Group and
all-matching selections persist only their selected read, filter identity and
server-counted target total in principal/role-bound session storage, never a
downloaded group-member list. Safe background publications preserve an active
page/detail/target selection; explicit reload or invalidation clears it.
Restored selections remain read references, not mutation authorization.
Canonical work batches at most fifty proved two-source components. A candidate
must have exactly one current neighbor, no third edge and no previous membership
outside the pair. Any gap or failed proof returns to the general durable
component expansion; survivor order is unchanged. Both sides explicitly retain
the matching-fact index predicate.

Selected page planning leaves scalar facts inline until their requested
projection/filter needs them. It does not materialize all tenant status and
presentation columns merely to choose the next keyset window. Inventory and
people projections remain inline so the selected window constrains their exact
joins. The current schema adds the partial person-fact index used by those joins and
global person filters; unrelated child facts are not scanned to find ownership.
The shared source-membership relation contains only exact identity, domain,
generation/native/environment keys and observation times needed by filtering,
responsibility, associations and export selection. It never materializes every source's residual JSON merely
to calculate those joins; full presentation is still selected independently.
Responsibility unknown-role totals aggregate each record's known roles once,
rather than rescanning the complete people projection for every inventory row.
The selected window projects its bounded primary members once in SQL and budgets
their actual encoded values, rather than reserving a fixed per-member estimate
and fetching the same primary records again. Export source-member queries use
the already-validated root domain to join canonical or native membership
directly; neither branch reads a predecessor representation.
The current schema adds an environment-only native-ID index. Exact environment context
and byte-budget checks can reject missing environments without repeatedly
scanning an agent-only source for every selected row. Temporal membership,
captured root precedence and environment ambiguity checks remain authoritative.
Startup schema verification requires every named target, live-authority,
identity and predecessor-removal guard. Missing rows or missing guard fields
are failures, not empty successful checks; retired enrichment-table checks are
replaced by the active generation, control and detail-admission contracts.
Historical schema33 preservation fixtures seed and inspect the retired registry
through their owned operator connection. They also prove the current runtime
cannot insert or read that registry, and still prove the nonempty cutover guard;
no retired privileges or compatibility reader are restored for the fixture.
Overview availability uses SQL membership rather than a repeated nested scan
of the complete Teams-available set. Export-only selected windows can use the
full 1 MiB SQL budget, still at most 100 records and 512 KiB per logical record;
interactive list/detail budgets are unchanged. Members and children remain
independent, bounded windows rather than embedded high-fanout arrays.
CSV source rows are produced lazily and coalesced into at-most-100-row,
1 MiB encoded batches instead of one asynchronous batch per member. The
consumer independently rechecks each encoded batch; all CSV columns, child
rows, chunk checksum verification and authorization fences are unchanged.
Export admission snapshots the requested kind, selection and explicit references
before awaiting validation or item writes. Producer reads enforce their checked
lease after work, immediately before COMMIT and after transaction cleanup.
Cancellation stops further member/child reads and every resumed output batch;
no already-read batch bypasses these fences. Download checks artifact expiry
after chunk and publication awaits, before yielding bytes or completing delivery.
An open package detail is owned by its immutable selection ID, not only the
selection's revision number: two captures can share a revision number while
referring to different roots. Replacing the capture refreshes the detail without
replacing its dialog or discarding the previous visible content while pending.
The source-member section retains its measured space during a replacement read;
old member actions and cursors do not cross into the new capture. Management
read locks retain focus with guarded, visibly disabled controls; pending reads
cannot dispatch changes. The all-matching selector shares the existing table
toolbar instead of adding a permanent row above the inventory. Anchored filter
panels clamp both horizontal edges to the viewport
after toolbar changes, scroll and resize, and clear those offsets when switching
to the fixed mobile/short-height layout. Above/below placement and focus remain
independent of the toolbar's compact selection action.

Committed source notifications coalesce while a canonical sweep is active.
The worker drains bounded twenty-principal pages to the end of that sweep, then
performs any requested follow-up sweep. It does not lose an arrival behind its
scope cursor or wait for the thirty-second recovery timer before visiting a new
principal. Internal reconciliation does not recursively enqueue wakeups.
The sweep's cancellation signal also fences canonical queue admission and the
retention transaction: cancellation rolls back collection and cursor changes
before COMMIT. A retention stage belongs only to its persisted scope; when
pending controls make that scope ineligible, the next scope starts at its roots.
Account revocation still invalidates historical selections immediately; a
returning account must explicitly recollect its private sources before they can
authorize new work.
Bounded GC preserves same-session source membership while a verified control
receipt is waiting for publication, and preserves the recoverable canonical
membership through that transition. It does not restore read or mutation
authority: epoch validation still rejects every old pin immediately. Expiry,
clear and session revocation remain collection fences. Quarantine job polling
notifies the page when an active job finishes, clears its old target selection
and reloads current inventory; direct status then compares against the published
readback rather than an obsolete pre-mutation capture.

Run `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite
inventory-foundation`. The required three new tests and eleven retained
inventory/identity/provider suites are followed by backend typecheck. Real
100/1,000 baseline, twenty-key row/byte/EXPLAIN receipts, a 5,001-record scoped
stream and pinned-read/control/coalescing proofs are logic evidence, **not**
the 06 full 100k/1m capacity qualification.

### Durable mutation authority and stale optional reads

Current package targets have no legacy-data conversion path.
Staging freezes each package's source generation, opaque identity,
canonical identity and authority deadline. Submission copies that evidence to
immutable durable job items, without generation foreign keys or extending a
browser selection's retention. Staging reads current authority once per bounded
100-target page, not once per target; it retains the existing 5,000-target and
row/byte limits. Immediately before `sent_at`, dispatch takes the
tenant/principal publication mutex before source-scope and job locks and validates
the frozen evidence against the shared, clock-expiring live-source relation.
Replacement, withdrawal, principal invalidation, or either frozen/current expiry
fails the item without a provider mutation.

Prior verified readbacks settle through the existing inventory runtime before a
staged worker proceeds. Package and native quarantine workers retain their
initiating session, capability and provider-admission guard through settlement,
including immediately before each queue, cleanup and publication COMMIT.
An unaffected target may survive a new canonical
projection, but never a changed source generation, canonical identity, or frozen
deadline. Approved direct canaries continue using their separate exact approval
and per-dispatch reauthorization authority rather than a catalog selection.

Historical catalog reads retain optional detail evidence that was already stale
when captured. Browsers display it as stale and do not register its past deadline
as an active dependency; current optional details and selection deadlines still
invalidate normally. Readability does not authorize preview, submission or final
dispatch. Viewers can select bounded canonical groups for exports without
enumerating all members; only Admins request mutation counts/previews or controls.
Quarantine status GETs do not repair jobs. Tenant-bounded recovery runs through
the existing maintenance-aware startup/recovery/draining lifecycle.

## Phase 05 lifecycle closure

Current DDL defines durable bounded collector progress and immutable scoped
export setup idempotency. Record, temporal inventory,
history, staging and operator collection share row/encoded-byte/time budgets and
retain control-settlement dependencies. Invalidating a selection also releases
export ownership and quota; safe newer input does not revoke valid captured reads.
Native CSV delivery withholds its final chunk until completion checks succeed.
Backup receipt format `agent-control-backup-v1` binds `schemaFingerprint`,
an explicit reviewed table/key inventory and a shared exported snapshot,
not whole-table JSON aggregation or an old-format converter.

See [the lifecycle matrix, exact bounded collections, diagnostics and isolated
browser/restart/restore commands](operations.md#record-lifecycle-recovery-and-bounded-work-diagnostics).
These proofs do not claim the phase06 100,000-user/agent and million-relationship
capacity envelope or replace phase07's unchanged production software gate.
