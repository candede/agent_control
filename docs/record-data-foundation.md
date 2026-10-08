# Data storage and selected reads

Agent Control stores provider observations in PostgreSQL and serves bounded,
authorized views to the frontend.

## Source records

Each collected source records:

- tenant and account scope;
- provider and source identity;
- collection status and timestamps;
- current published data;
- errors, partial coverage, and source limits.

Package, Power Platform, directory, activity, official-report, Purview, and
Defender data remain separate source authorities.

## Publication

A refresh validates and stores a complete source result before making it
current. A failed refresh leaves the last successful result unchanged and records
the new failure separately. Current inventory anchors and their required input
closure survive freshness deadlines; genuine revocation, clearing and missing
data still stop reads. Superseded, unpinned history remains subject to bounded
collection. Other source authorities retain their explicit policy boundaries.

Empty successful results are published as empty data. Missing, denied, or
incomplete results are not converted to zero.

## Selected reads

List, detail, facet, and export endpoints use server-side selections with:

- tenant and account authorization;
- stable ordering;
- bounded page sizes;
- opaque cursors;
- source revision checks;
- explicit unknown and partial states.

The frontend does not load an entire tenant dataset to implement paging or
filtering.

### Lifecycle simplification contract

The expiration-retry experiment has been removed. Backend and frontend selected
reads and background-observer startup synchronization implement the dependency,
publication and metadata contract below.

- **Saved availability:** the current complete, authorized publication and its
  required input closure remain readable while a successor is slow or fails,
  including after generation/observation freshness timestamps. This includes
  new read admission, not merely keeping previously displayed rows. Publication
  replaces the current anchor atomically. Scope/session revocation, explicit
  clearing, and genuinely missing data still reject reads.
- **Read lease:** retain the existing server-side maximum of ten minutes,
  with earlier query-dependent mutable-evidence deadlines where applicable.
  This bounds selected contexts and is not a synchronization deadline or an
  inherent security guarantee. Fresh read admission does not depend on a
  successor finishing. Existing export pins remain bounded to the thirty-minute
  export retention window, independently of generation freshness.
- **Snapshot consistency:** rows, groups, filters, ordering, counts, facets, and
  exports use the captured source revisions and evaluation time. A selected
  report keeps its exact set and lineage. Age alone must not switch a report,
  regroup an existing selection, or silently replace its targets.
- **Dependency scope:** inventory search and owner/creator ordering pin the
  mutable people-cache epoch and its relevant deadline. Other inventory queries
  use only captured directory labels, or native object IDs when unavailable;
  they do not consult the mutable cache. The directory generation remains pinned
  because CSV exports promise the same labels across chunks. App activity is not
  an inventory input. Users/reports retain immutable directory/activity/report
  roots but no longer pin the unused people-cache scope. Environment
  labels participate in search, ordering, and facets, and remain tied to the
  captured inventory input revisions.
- **Detail age:** preserve compatible stale descriptions with an explicit stale
  state. Missing, contradictory, revoked, and deleted evidence are not stale
  successes. Identity details also govern matching: their existing background
  reconciliation may publish genuinely changed groups after evidence expires.
  That is a semantic change, not permission to reject an older, valid read
  snapshot or to manufacture a publication from a timer.
- **Clock ownership:** the database owns lease and authority deadlines.
  Browser wall-clock skew must not reject a server-valid response or extend
  authority. The frontend charges the entire monotonic request duration against
  `expiresAt - validatedAt`, not against immutable `evaluatedAt`. Reuse is capped
  at thirty monotonic seconds and the remaining lease, whichever is shorter.
  A successful response arriving after that conservative budget remains readable
  history, but cannot admit a new frozen page, export, or management confirmation.
- **Background work:** backend admission owns source collection; the browser
  observes it. Compare captured publication markers with the startup observer
  baseline so unchanged startup does not reload data and racing publications
  are not missed. Job progress and descriptive age do not change publication
  markers. Retain necessary identity reconciliation and bounded retention.
  Generation freshness does not terminate staging, head publication, or a
  reconciliation worker's input pins. Explicit worker leases, cancellation,
  job/resource budgets, authorization, and provider request deadlines remain.
- **Collection:** preserve one current head/root per scope and the required
  current canonical input closure, plus bounded active readers, exports and
  workers. Existing compaction and row/byte/time-limited GC collect superseded
  unpinned history. Current published data is not an expiring cache; historical
  versions are not retained indefinitely. Required directory labels and
  environment descriptions remain available from retained immutable inputs.
- **Action authority:** a readable snapshot never authorizes mutation. Preview,
  submission, and dispatch still require current membership, exact targets,
  unexpired control evidence, and current backend authorization. No automatic
  retry may replay an export intent, confirmation, or management action.

Selected inventory/report responses include `selection.validatedAt` (database
wall time at validation) alongside immutable `evaluatedAt` and `expiresAt`.
Their `selection.publicationRevisions` contains exactly `graph_packages`,
`power_platform`, and `users`, each a lowercase SHA-256 string. This is the
captured marker vector, persisted in existing bounded context JSON, not an extra
field on the inventory capture POST response. It remains
unchanged when an old selection is read after a newer publication. Status uses
the same marker function. Attempt progress, refresh failure, and clock aging are
not publications; stored source/session epochs, heads, people revisions and
report history changes are.

An owned rejected selection can return `selection_invalidated` with
`details.reason` equal to `expired`, `unavailable`, or `changed`. Unknown and
foreign selections remain indistinguishable. These reasons do not authorize
recapture, action replay, or display of revoked evidence. A never-collected
inventory is `not_collected`; actual initial queued/running reconciliation is
`preparing`; retired or missing previously published inventory is `unavailable`.
None is a success-shaped empty result.

The schema changes three existing guard functions: publication no longer checks
the generation freshness deadline, and interval/revision deletion guards retain
the current canonical input closure beyond its former TTL. Only the current
schema is supported. Incompatible installations use the existing explicit
database reset and initialization workflow, then synchronize objects again.
Imported reports and other saved configuration must be restored separately.
There is no old-schema compatibility, in-place migration or automatic startup
reset.

The shared frontend selected-read contract validates server metadata once and
does not derive another deadline from nested person, detail, source, or report
ages. An ordinary lease end preserves authorized rendered rows, detail identity,
and saved totals with historical context. Stale retained directory cohorts stay
readable. Authorization loss, malformed metadata, unavailable dependencies, and
changed selections are still errors; an unknown invalidation is not treated as
harmless expiry.

Fresh unpinned navigation can read the current saved root after a prior lease.
Frozen pagination, report identity, export membership, and targets never
automatically recapture or replay. Explicit replacement clears dependent targets
and unsent previews before adopting new data, while preserving search, sorting,
chosen report, detail tab, and draft search intent. Already-admitted export jobs
continue under their existing bounded server artifact lifetime; ending read
eligibility does not cancel an admitted job or authorize a second one.

`useReportPage` exposes `publicationRevisions`, monotonic `isCurrentData()`,
`leaseEnded`, and `frozenData`. The latter preserves the admitted selection for
facets and an existing export during page transitions; it is not a substitute
for the current page's rows. Detail opening and export admission synchronously
own that selection before asynchronous work starts.

The session publication observer handshakes with successful selected page/report
responses, never with capture POST metadata. Either response can arrive first.
Equal vectors cause no startup reread; a real difference is acknowledged before
one source-scoped synchronization. The last admitted and acknowledged vectors
survive pending page data and an ended lease. Revalidating old frozen evidence
cannot roll the observer backward or cause an endless recapture loop.

Fresh base inventory/report queries may capture a newer publication. Frozen
pages, explicit report selections, details, targets, previews and admitted
exports retain their exact selection; a publication can revalidate it, not
replace its membership. Ending a lease alone never rereads or collapses history;
an ended frozen lease is not automatically replaced. Users reports react to the
Users publication marker; agent responsibility reacts to the inventory markers
while preserving its selected inventory.

Source-job completion is only a hint for an eligible publication check. Job
progress, provider errors, and success without a changed persisted marker never
reload saved content. The observer retains its single-flight lock, request
deadline, bounded backoff, session pause, visibility/offline and authorization
fences. An explicit clean/reset still invalidates the data it actually retires.
Identical exact Power Platform job reads share the existing saved-query
transport, independent of each consumer's polling revision; one departing
consumer cannot cancel its peer. Current-workspace and exact-run status are
distinct queries with separate command/readback ownership. An explicit command's
readback has its own boundary and cannot join a peer's pre-command request.
Completed or
irrelevant observations stop; no new polling framework, source scheduler,
identity-expiry bypass, or retention mechanism is introduced.

## Identity

Provider-native identifiers remain the source identity. Display names and
cross-source associations do not replace native IDs.

Associations are accepted only when their source evidence is available and
authorized. Missing associations remain unresolved.

## Changes

Provider changes use the current source identity and revision. The server checks
authorization and target state before dispatch and verifies provider readback
afterward.

A saved read or export does not authorize a change. If the source or target
changes, the user must review a new preview.

## Retention

Retention removes superseded unpinned snapshots and expired sessions, non-current
evidence, jobs, uploads, exports, and audit data in bounded batches. The current
published anchor and its required inputs remain until replacement or genuine
invalidation. Accepted usage reports remain until an Admin deletes them.

See [operations](operations.md#run-retention).

## Backup and recovery

Backups include a checksum and schema fingerprint. Restore creates an isolated
review database, clears active session and provider authority, and requires
operator review before reopening.

See [operations](operations.md#back-up-a-local-installation).
