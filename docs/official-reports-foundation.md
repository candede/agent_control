# Official report data

Agent Control stores Microsoft 365 Copilot Agents CSV reports in PostgreSQL and
combines them with authorized inventory and user data.

For user instructions, see
[Microsoft 365 usage report import](official-usage-import.md).

## Source authority

The three Microsoft exports are the authority for reported agent usage:

- Agents
- Users & agents
- Users

Audit, Defender, telemetry, transcripts, package events, and Microsoft 365 app
activity do not replace these reports.

## Import

Import validates:

| Access | Paths |
| --- | --- |
| Viewer GET | `/copilot-usage/users`, `/copilot-usage/users/facets`, `/copilot-usage/users/unresolved-identities`, `/copilot-usage/users/:objectId`, `/copilot-usage/users/:objectId/service-plans`, `/copilot-usage/users/:objectId/agents` |
| Viewer GET | `/official-usage/aggregate`, `/official-usage/aggregate/facets`, `/official-usage/users`, `/official-usage/users/facets`, `/official-usage/agent-users`, `/official-usage/agents/:agentId`, `/official-usage/agents/:agentId/users`, `/official-usage/users/:username`, `/official-usage/users/:username/directory`, `/official-usage/users/:username/service-plans`, `/official-usage/users/:username/agents` |
| Viewer GET | `/official-usage/history`, `/official-usage/history/options`, `/official-usage/history/:setId/observations`, `/official-usage/overview` |
| Admin | POST `/official-usage/staging`; GET `/official-usage/staging/:id` and `/official-usage/staging/:id/diagnostics`; DELETE `/official-usage/staging/:id`; POST `/official-usage/staging/:id/accept`, `/official-usage/bundles/:id/preview`, `/official-usage/bundles/:id/accept`, `/official-usage/sets/:id/preview`, `/official-usage/confirmations/:id` |
| Agent/report boundary | Viewer GET `/agent-inventory/:recordId/usage`, `/agent-inventory/:recordId/usage-history`, `/agent-inventory/:recordId/usage-users` and `/agent-inventory/:recordId/usage-associations`; Admin GET `/agent-inventory/:recordId/usage-candidates`; Admin POST/DELETE `/agent-inventory/:recordId/usage-associations` |
| Viewer exports | POST `/data-exports`; GET/DELETE `/data-exports/:id`; GET `/data-exports/:id/download` |

An exact duplicate reuses the accepted report set without storing another copy
or changing the selection.
Failed imports do not replace accepted data.

## Selection

The compact report selector on Agents and Users reads
`/official-usage/history/options`. It returns only
`{value, page, selection, counts, reports}` using the same bounded history
keysets and validated selection roots. It does not compute user summaries or
whole-history observation analytics that the dropdown never displays.
The full history endpoint retains its existing analytics contract. Selecting a
report still uses the fenced Admin preview/confirmation flow and changes the
shared active report; browsing cached cohort pages does not mutate it.
History rows always expose a boolean `active`; retained rows are `false` when
the shared active report has been cleared.
An authorization denial keeps report options hidden and its explicit Retry
action visible across saved-data revision changes. An uncertain confirmation
outcome, including malformed successful JSON, warns that the selection may
already have been saved. Retry reloads report evidence; it never replays the
confirmation.

Changing the selected set changes the displayed report data but does not delete
another set or trigger provider collection.

The import wizard automatically selects only the tenant's first complete report
set. Later wizard imports preserve the selection, even if it is empty. The first
acceptance is identified by the durable tenant history revision under the same
transactional locks as publication, not by the number of retained sets or an
empty active selection. Deletion, retention, and receipt retries cannot reset
this exception.

`counts.total` is the authorized unfiltered endpoint relation;
`counts.filtered` applies all row filters. Detail returns
`{value,selection,reports,sources}` and 404 `data_record_not_found` outside the
selected cohort. Child lists retain parent metadata/selection; their own counts
describe the child relation. Parent row filters are not incorrectly applied to
child columns. Relationships and plans are paged, never embedded in a user.
History observations are paged version metadata; overview creator types and
reviewed agent associations are separate paged collections.
Historical set UUIDs are case-insensitive and canonicalized before the
observation route checks selected-cohort membership. Report usernames and
agent IDs remain exact opaque strings, including GUID-shaped values.

Report agents and users are connected to inventory and directory records through
verified identifiers and reviewed associations.

- Unmatched report records remain visible.
- Names alone do not establish identity.
- Concealed identities remain unresolved.
- A changed source revision revalidates affected associations.

Limits are default 50/max 100 rows, 1 MiB JSON response, 512 KiB detail, 4 KiB
authenticated cursor, 16 roots, 100 exact IDs. Counts are checked safe integers;
overflow is 409 `official_usage_total_limit`, not rounding. Cursor ordering uses
the same normalized keys, `C` collation, null-last rank and immutable identity
as SQL. Previous pages are returned in display order.
Overview ties use the exact agent ID ascending in either primary sort direction;
the reverse cursor reverses both comparators before returning display order.
Unicode search/sort folding explicitly uses the database's default UTF-8
collation, independently of the `C`-collated opaque identity columns. It never
merges case-distinct report identities.
Selection authorization captures bounded own-data tenant/account and role values
before reading the session epoch. App roles are exact sets; contracted provider
role GUIDs use their canonical role-set representation. The resulting identity is
immutable; account and tenant identifiers are never case- or compatibility-folded.
Report-set, bundle, staging, confirmation, selection and export-request UUIDs are
canonical lowercase before hashing or comparison. These are not opaque report
agent IDs or usernames, even when an opaque report identity resembles a GUID.
Browser import resumes and export ownership use the same canonical UUIDs; a
casing-only prop change cannot abandon an admitted export or change its explicit IDs.
Import acceptance and confirmation snapshot their consumed own-data intent
before asynchronous checks or retries. Revisions are canonical decimal strings
within PostgreSQL's signed-bigint range; staging revisions fit a signed integer.
Directory joins instead use the lowercase original username without compatibility
normalization. Genuine full-width or decomposed directory aliases remain exact;
a folded lookalike cannot acquire another user's identity or licensing. Bounded
report reads probe a 128-character exact-alias prefix index and recheck the full
alias. The stored compatibility-folded keys and full Unicode sort/cursor keys
remain unchanged.
SQL applies a 512 KiB cumulative row-byte prefix before transfer; a page can be
shorter than its requested limit while still having `nextCursor`. Continue by
cursor, never by `value.length===limit`. Export producers follow the same rule.
Facet pages share the compact signed-boundary fallback for blank values and
wide Unicode keys. The exact boundary is resolved within the same selected
facet relation; missing or non-unique matches invalidate the selection.

Report lists, details, filters, and exports use bounded database queries with
stable ordering and opaque cursors. Exports are created from the same authorized
selection as the displayed data.

## Deletion and retention

An Agent Control Admin can delete an accepted report set from
**Sync > Manage reports** after confirmation.

Deletion removes the selected set from use and retention removes unreferenced
content in bounded batches. Other accepted report sets remain available.

Saved inventory people projection also shares one selected-read transaction,
client, directory metadata lookup and captured timestamp across all three
possible 100-ID batches for a 100-record caller page. A caller-owned client is
reused, never replaced by per-batch transactions. People-cache writes validate
their publication fence both before and after the write, inside the same
transaction; late cancellation rolls back the observation and its dependency
epoch changes. Live regressions in `largeTenantUserSources.test.ts` exercise
both ownership modes and prove that the prior captured selection remains
valid after the cancelled write.

### Query registry

All queries reject unknown fields, arrays, offsets, all-record switches,
out-of-range values and unsupported enum/sort combinations. A query must be a
non-null object; an explicit null sort is invalid rather than a default.

For nullable HTTP organization filters, `~null` means SQL null; `~string:`
escapes any literal value, including a company literally named `~null`.
Rendered facet option values and React keys use the same null/string tags for
every string, including `null`, `~null`, the empty string and strings beginning
with `~string:`. Only the untagged empty option means no filter. The selected
raw value reaches the query serializer unchanged; exports keep that selection's
exact server-side filter scope. Creator-type option values use these UI tags
but still serialize as the existing raw creator-type query value, including
`creatorType=` for a literal empty creator type; omitting the parameter means
no creator-type filter.
Agent usage contexts carry the same `reports` metadata, so stale/unknown
freshness cannot be mistaken for current evidence. Select confirmations
revalidate complete typed membership and expiry when consumed; incomplete
imports are deletable but not selectable.

| Family | Row filters | Sorts |
| --- | --- | --- |
| `copilot_users` | `search`, nullable `company/department`, `entitlement`, `serviceState`, `appActivity`, `reportActivity`, `cohort`, `licenseCohort`, `creatorType`, `agentId`, `username`, `responsesOnly`, `startDate/endDate` | `name` (default), `upn`, `company`, `department`, `service`, `appActivity`, `responses`, `agentsUsed`, `lastActivity` |
| `official_users` | Report/user/organization/licensing filters above, except app activity and the `licensed/using_agents/no_agent_activity/needs_attention/unknown_metrics` cohorts | `name` (default), `responses`, `agentsUsed`, `lastActivity` |
| `official_agents` | `search`, `creatorType`, `agentId`, `responsesOnly`, `reportActivity`, `startDate/endDate` | `responses` (default), `name`, `activeUsers`, `licensedUsers`, `unlicensedUsers`, `lastActivity` |
| `relationships` | `search`, `creatorType`, `agentId`, `username`, `responsesOnly`, `reportActivity`, `startDate/endDate` | `name` (default), `responses`, `lastActivity`, `creatorType` |
| `history` | `search` | `reportingPeriod` (default), `acceptedAt` |
| `overview` | `search`, `scope=history|selected`, `startDate/endDate` | `name` (default), `lastActivity` |
| unresolved/plans/observations | Parent selection and separately scoped child identity | Name order; unresolved also supports responses in a directly captured unresolved selection |

`setId` selects a readable historical report set without changing the active
head; on history it changes selected-report metadata, not the temporal history
row cohort. Its UUID is canonicalized before query hashing, so casing changes
do not invalidate an otherwise unchanged saved selection.
`order=asc|desc`, default descending for history/official agents, ascending
otherwise. `lowResponseThreshold` defaults to 5 (1..100,000,000);
`inactiveDays` and `activityWindowDays` default to 30 (1..365). Dates are valid
UTC `YYYY-MM-DD` in years `0001` through `9999`; PostgreSQL's unsupported year
`0000` and reversed ranges are rejected before selection capture. Search is bounded to 256
UTF-16 code units both before and after normalization. Queries and searched SQL
text use NFKC, lowercase, then NFKC again to canonicalize combining sequences
introduced by case conversion. Queries are trimmed afterward so generated
whitespace cannot change the query hash when a saved selection is read again.
Expanded searches over the limit return 400 `invalid_cursor` before database
acquisition.
Facet option searches use the same normalization and input bounds; their cursors
are bound to the normalized option search, so canonically equivalent spellings
can continue the same page sequence.
Exact report IDs are case-sensitive,
max 512, and reject control characters and unpaired surrogates before database
acquisition. GUID-shaped report agent IDs and usernames remain opaque and are
never case-folded. Organization matches are exact; HTTP `~null` denotes the null facet.

Enums: entitlement `paid_active|paid_inactive|no_paid|unknown`; service states
`enabled|warning|partially_enabled|disabled|suspended|locked_out|unknown`;
app activity `active|inactive|unknown`; report activity
`all|recent|inactive|no-activity`; cohorts
`all|zero|low|review|licensed|using_agents|no_agent_activity|needs_attention|unknown_metrics`; license cohort
`active_without_paid`. The validator rejects domain-inapplicable filters.

Facets use `field=company|department|creatorType`, `selectionId`, optional
option `search`, `limit`, `cursor`. Company/department apply to user lists;
creator type applies to official agents. The facet's own selected value is
removed while other filters stay applied. Option counts are exact matching-row
counts; top-level counts are total distinct and filtered distinct options.

Before capturing a new report selection or directory report-identity input
selection, expired report sets are retired in bounded maintenance transactions
until no invalid sets remain, rather than assuming a fixed batch size.
Maintenance failures propagate before selection capture.

### Semantic goldens

- Enabled/warning/partial are paid active; suspended/locked-out are paid inactive;
  verified absence is no-paid. Unknown/ambiguous identities never become
  verified unpaid users. When directory verification is not available, every
  active report identity counts in `unknownLicenseActiveReportUsers`, including
  identities whose retained directory rows previously indicated paid or unpaid
  licensing. The paid/unpaid summary counts remain null.
- Directory evidence is principal/token-mode scoped. Accepted report history
  is tenant scoped, not importing-actor scoped.
- A user is report-active with positive Users **or** bridge responses. Missing
  Users metrics remain null; actual zero remains zero. Missing bridge rows
  retain unknown bridge response semantics. Distinct active identities are not
  licensed+unlicensed occurrence sums.
- Users recency uses the Users date and the maximum observed Users date, never
  the bridge's agent-last-used-by-anyone date or upload time.
- The Agents report owns its agent response/date, including a blank date.
  Bridge-only agents retain an explicitly labeled bridge fallback. No companion
  rows means unknown per-agent active users; actual zero-response companions
  produce zero active users.
- `summary` exposes directory checked users, matching-directory licensed/
  measured/using-agents/no-agent-activity/attention/unknown counts, plus separate selected-set report totals
  and licensing reconciliation. `analytics.basis=filtered_rows` owns filtered
  review/rankings/window/history/overview aggregates. Inapplicable analytics
  sections and metrics are null, not fabricated zero. Response rankings display
  the exact report agent ID when an accepted agent name is blank.
- Period/source metadata is not inferred from upload clock or filename.
  `operator_asserted` source-as-of does not become trusted known freshness.
  Empty complete files have actual zero dataset totals; absent report sources
  have null totals. Filtered response analytics likewise return zero for an
  empty cohort with the applicable captured response source; absent sources and
  nonempty cohorts with only unknown Users metrics remain null. Directory-user
  analytics also require a captured directory generation. Empty activity-window
  response observations retain their separate null semantics.

## Streaming import, acceptance and maintenance

Accepted ingestion cleanup drains **both** ingestion and preview children before
releasing the shared staged-byte reservation. Operator retention uses the same
emptiness predicate and never deletes either parent while preview children
remain. Interrupted unpublished versions are collectible independently of
ingestion metadata: no set membership and no unexpired active/ready ingestion
may reference them. Operator retention retires those versions before discarding
their provenance; generic bounded payload GC then releases row quota and facts,
preserving facts referenced by any surviving version. A live accepting lease
and legitimate set/history/read/export references remain protected.

POST staging is multipart with exactly one `file`. Immutable intent is in the
query: UUID `bundleId`, optional UUID `correctionOfSetId`, optional
`rejectDuplicateKind=true|false` (default false, preserving individual draft
replacement). Fields may precede or follow the file: `reportingStart`,
`reportingEnd`, `periodProvenance`, `sourceAsOf`, `sourceAsOfProvenance`,
`downloadedAt`. Period fields are an all-or-none operator-asserted triple;
source-as-of requires its operator-asserted provenance. Unknown/repeated fields
are rejected. The browser upload type and restored companion metadata follow
the same operator-only contract. Source-verified metadata belongs to its original
file and is neither copied into companion multipart fields nor relabelled as an
operator assertion. Complete valid replacement cancels the previous draft; a failed
replacement leaves the valid previous preview intact. Already accepted kinds
cannot be replaced in the same bundle.

Bundle previews include both ready and already accepted companions, at most
three kinds. Resuming a partially accepted bundle accepts only its remaining
ready stages into the same incomplete set. Resuming a completely accepted
bundle verifies its receipt without creating versions or advancing the head.
Discard affects only unaccepted stages. Acceptance retries retain the reviewed
hash and revision; an uncertain response is not permission to discard or upload
the same files again.

When finalization finds a canonical duplicate after an earlier individual
partial acceptance, the final bundle receipt identifies the canonical set.
The earlier partial receipt is not rewritten: its retired, never-published
candidate remains a truthful partial result while an accepted companion in
that same actor-owned bundle proves a live canonical set with the same
accepted kind/content. Bounded retention does not erase that receipt proof.
Deleting the canonical set denies further retries; no draft or report is
revived and no unrelated active head is changed.

Fixed ceilings: file 256 MiB; field 4 KiB; Users 100,000 rows; Agents 200,000;
Users & agents 1,000,000; actor/bundle staged reservations 1 GiB; tenant 2 GiB;
9 actor/30 tenant drafts; 5,000 retained sets/15,000 versions/25,000,000 version
memberships. Both ingestion and preview copies are reserved before writes.
SQL binds/results are at most 250 rows **and** 1 MiB; large UTF-8 fields force
smaller batches. Preview examples max 20, scalar provenance warnings max 20;
cross-file row diagnostics have signed keysets and exact counts. CSV fields are
also capped at the registry's largest supported column count while parsing:
empty delimiters cannot bypass the parser's payload-size budget and accumulate
an unbounded record.
The 4-KiB field budget includes unquoted leading/trailing whitespace and padding
outside quotes, before CSV trimming; quote framing and doubled-quote escapes do
not inflate the decoded field budget. Ignored whitespace-only lines remain
ignored. Padding floods are rejected incrementally without retaining the field.

File/body/validation cancellation aborts parsing, fences publication and cleans
staged rows. Row batches and validation transitions check cancellation before
transaction commit; explicit upload cancellation also stops the receiving
parser. Parser aborts retain the original timeout/disconnect error, and failed
cleanup returns `upload_cleanup_failed` while retaining both underlying causes
internally and emitting the value-free `official_usage_upload_cleanup_failed`
event. Streaming/validation/acceptance uses independent 20-second
heartbeat/60-second leases with a 30-minute upload deadline. Report ingestion
and directory/activity ingestion share 4-global/2-tenant admission; an accepting
three-kind bundle is one operation, not three network streams. No SQL client is
held across input/network waits.

Acceptance carries staging ID, revision, content hash and decimal-string
expected active revision. A bundle preview returns at most three such stages and
a bundle hash; acceptance supplies that hash/revision. Incremental content hash
is insensitive to download timestamp and input order. Existing version/set
authority provides deduplication and immutable receipts. A partial individual
acceptance stays non-active; only a complete validated three-kind set publishes.
Corrections preserve period/provenance constraints and supersession. A
non-active correction does not select itself.

After exact readback conclusively verifies a saved non-active duplicate or
correction, **Cancel import** and Escape dismiss the importer without selecting
or discarding the saved set. **Use imported reports** still requires its own
revision-bound confirmation. Active success acknowledgment and **OK** still
revalidate the exact destination before opening it. Pending uploads retain
confirmed cleanup, and pending/ambiguous acceptance cannot be dismissed as an
unsaved draft.

Optional reporting dates are an all-or-none multipart triple: start, end and
period provenance. Clearing both dates removes the entire triple; one date or
a reversed pair still blocks upload. Source-as-of and its provenance are
independent and survive clearing the reporting dates.

The current schema records the actual reviewed acceptance revision on
each ingestion, independently of the older staging-preview revision. An accepted
receipt cannot be retargeted to another revision, including when a draft was
created before an unrelated publication. The stored revision is immutable after
acceptance. No old acceptance revision is backfilled.
Bundle preview rejects incompatible observation bases
before confirmation. Concurrent identical confirmations across factory instances
wait on persisted accepting state and then verify the same receipt. The wait
releases its SQL client, obeys cancellation and the original lease/deadline,
and never retries serialization failures or arbitrary write errors.

Complete reviewed duplicates are detected from the three immutable content
hashes before allocating another set, artifact, version or membership. Repeated
corrections reuse only the same target or its existing correction, never an
unrelated set with identical report versions. An unchanged correction does not
advance history or select an inactive target. A non-active correction target
is rechecked after bounded copying, inside the publication transaction.
Deletion atomically tombstones versions no longer shared by another live set;
reimport cannot revive them. Runtime and operator maintenance share the same
250-row deletion primitive, which preserves live temporal history pins.
Immutable orphan fact reclamation remains operator-only.

Set operation preview takes `{operation:"select"|"delete"}`. Confirmation returns
and accepts `{id,setId,operation,activeRevision,historyRevision,historyEpoch,hash}`;
path confirmation ID must equal the body ID. The hash also binds actor/session/
authorization. No current-state fallback is allowed after a stale confirmation.

Ordinary acceptance advances history revision without changing invalidation
epoch. A captured one-root history continues to read its temporal membership
even after later acceptance. Correction/deletion/expiry changes the epoch even
for a non-active set, denying old history/overview/export reads. Superseded
originals remain visible in history, excluded from default overview; deleting
their correction does not resurrect them. Sets, versions and artifacts all
constrain root expiry. Runtime cannot rewrite fact payloads or history intervals.

The 02B dispatcher schedules `OfficialReportImports.sweep` and
`OfficialReportHistory.expire/collect`; the existing operator lifecycle invokes
the operator-only `collectOfficialReportPayloads`. Operator
collection retains pin-reachable memberships/facts. There are no untyped
predecessor facts or compatibility-preservation branches.

## Targeted agent usage and exports

Agent usage reads require authorized delegated inventory evidence. Reads with
`inventorySelectionId` use the validated saved inventory's canonical and source
memberships without falling back to live evidence. Reads without that pin and
all association mutations require current inventory authority. Exact package
IDs, native source/environment IDs and canonical memberships are resolved by
scoped indexes. Incremental source-reference hashing uses bounded pages; there
is no whole-inventory revision getter or `list(limit:5000)`. Candidate cursors
bind target record, report selection, association revision and exact inventory
fingerprint. Attach/remove requires that context, `confirmed:true`, exact report
agent ID, and (for attach only) the exact current source target. Reviewed
associations override automatic package matching; stale sources/revisions
conflict. Mutations and existing audit classifications share a transaction.
Usage selection/report UUIDs are canonicalized to lowercase before cursor,
inventory-pin and mutation comparisons; opaque report and source IDs remain
case-sensitive. Agent-user search applies the same bounded NFKC/lowercase/NFKC
normalization to input, SQL usernames/display names and browser query keys.
Equivalent search edits retain their page and pending request; normalization
never changes the exact usernames used for grouping or identity joins.
`packagesInRead` accepts at most 100 exact stored snapshot/native references and
validates tenant, principal, delegated mode, current snapshot and expiry.

Export create is `{selectionId,kind,ids?,idempotencyKey?}`. Admission accepts only
plain or null-prototype objects with own data properties for these fields;
proxies, inherited fields, accessors and unknown extensions (including
non-enumerable and symbol keys) are rejected with 400 without invoking getters.
Omitted IDs means the complete selected filter, while explicit IDs are unique
and capped at 5,000, persisted in bounded batches. Explicit IDs must be a dense
plain, non-proxy array with own data elements and no extra properties or symbol
keys. Admission copies field values and IDs before any selected read or persistence.
Kinds must be supported scalar strings. Explicit identities
retain their exact spelling; NUL and lone UTF-16 surrogates, which PostgreSQL
cannot represent, are rejected with 400 before selected reads or persistence.
Creation returns 202 `{id}`. Status is fixed
`{id,status,rows,bytes,expiresAt,error,limit,observed}` with nullable error fields.
Producers use the export engine's fenced selected-read callback for every batch.
Kind/schema mismatch fails rather than generating a CSV with wrong columns.

`reportExportColumns` freezes exact ordered columns. `official_agents` preserves
the existing aggregate headings and adds `historyRevision`. `official_users`
preserves the existing relationship-row headings and adds `historyRevision`
and explicit `entitlement`. It emits one row per relationship, or one unknown
relationship row for a user without bridge rows. Repeated user metrics must
**not** be summed across those rows. `copilot_users` is one row per directory
user with separate source, licensing and report fields. Null official metrics,
including `copilot_users.ReportedResponses` and `ReportedAgentsUsed`, export as
`Unknown`, not blank or zero. Formula defense applies to every CSV cell.

Limits remain 256 KiB persisted chunks, 15-minute build, 30-minute expiry,
1 GiB/2,000,000 output rows, fenced auth/history on status and download,
backpressured response writes and disconnect cancellation. Build/download audit
uses the existing official-user/aggregate action classifications with the exact
producer kind, phase, selection/query fingerprint and pinned report-set/history
identity in bounded metadata, without filters or exported identities. HTTP
downloads commit an inconclusive verification receipt before releasing the final
chunk, then append success only after on-time transport finish. Missing terminal
audit remains inconclusive, not presumed delivery; later audit/connection failures
cannot relabel acknowledged completion. Cancellation uses the existing cancelled
status without rewriting a ready artifact's successful build receipt.

The dispatcher discovers queued official jobs from persistent storage after a
runtime replacement. It expires only the current discovered job, never another
export family's jobs through the official-report audit callback. Cancellation
also applies after a job becomes ready. A browser checks only status metadata
before native attachment navigation; CSV bytes are not fetched into a Blob.

Discovery excludes this process's active IDs and allocates queue candidates
against both pending local preflight and live leased work in the two-build tenant
budget before its four-work global limit, so one tenant's blocked queue cannot
hide eligible work from other tenants. The
transactional claim remains the authority for global/tenant admission across
processes. Pre-claim database contention, outages and maintenance leave the same
job queued for retry; only known terminal selection/schema failures settle it
as failed. Claims recheck persisted maintenance during admission and fence local
maintenance, shutdown, deadline and lease expiry immediately before COMMIT.
Acknowledged claim COMMIT transfers cleanup ownership to the builder even if
connection release fails. Shutdown cannot restart the dispatcher during drain,
fences an owned lease without waiting for a stalled producer to return, and
reports an active build's failed durable settlement rather than a successful
drain. Cancelled/expired work is never replayed; request a new export from a
current selection. Existing inconclusive/acknowledged download receipts are
unchanged.

Browser export creation, status and cancellation retry at most twice for network
failures, HTTP 429 or HTTP 503, with a 2/4-second minimum backoff and a maximum
accepted `Retry-After` of 10 seconds. Creation snapshots explicit IDs and reuses
one idempotency key for the entire attempt. Retries retain their original client
session: logout, session replacement or a session-wide denial prevents the next
request even without a caller-provided abort signal. Scoped provider denials do
not invalidate unrelated export retries.

Pure formula-safe CSV encoding lives in `services/csvEncoding.ts`. The separate
`csvExport.ts` module retains session/HTTP publication for unrelated bounded
inventory/audit exports. Browser test fixture encoders import the pure module,
not the server's session and database dependency graph.

The official-user producer reads relationships for at most 100 selected users
per fenced SQL batch, not through one transaction per user. Each batch transfers
at most 100 rows and a 512-KiB byte prefix, continuing from its exact parent/
child ordering even when a page is byte-short. It preserves full parent metrics
and all relationships of each matching person, including one unknown row when
there is no relationship. Fresh captures with unavailable/partial directory
evidence export unknown licensing, never a verified unpaid verdict. Ordinary
source replacement does not mutate an older pinned source or its scalar
metadata; mutable people/cache invalidation retains its separate epoch fence.

Valid wide UTF-8 sort keys and opaque identities can exceed a 4-KiB cursor if
both are embedded. Those boundaries use a signed identity digest and an internal
NUL marker (not a PostgreSQL text value). Continuation resolves at most two
candidate boundary records inside the same validated immutable selected
dataset, then applies the original exact keyset ordering. Missing/nonunique
boundaries explicitly invalidate the selection. Query, identity, direction and
selection bindings, the 4-KiB ceiling and ordinary inline cursor behavior remain
unchanged; there is no new persisted report authority or client-side decoder.

Page rows and exact counts share one SQL statement. Its bounded result includes
a scalar count-only record for an empty/byte-rejected candidate page. Analytics
share their filtered relation: review counts come with totals; agent coverage,
window metrics and bounded top/bottom-ten rankings are computed together.
Rankings order the numeric source response column, not its serialized text.
Native report/combined-user envelopes also share the underlying typed report
relation with summary and analytics subqueries. These bounded metadata objects
are transferred once, not repeated in every row. Exact-ID reads count only
their requested identity subset; detail envelopes do not request or expose a
second unfiltered tenant count.

Report projections disable transaction-local JIT compilation; its setup cost
also dominates small selected reads against a large shared fact table. Large
projections additionally prefer hash planning once the captured immutable
lineages exceed one 250-row SQL batch.
History validation/capture/expiry uses a single bounded aggregate of immutable
version row counts to apply the same policy before fact reconciliation. That
early step matters: a fresh 150,000-fact fixture with the ordinary UUID-shaped
tenant key otherwise exhausted the unchanged 15-second SQL deadline during
history expiry, before page planning was reached.
Merge joins are also discouraged: a reproduced fresh-data plan merged only on
report kind and filtered payload hashes afterwards, multiplying each kind's
rows and exhausting the same SQL deadline. The complete equality-key hash join
avoids that multiplication. The mixed 1,000/10,000-user regression inspects its
actual plan as well as exact counts and byte/row bounds.
The initial 10,000-row planning cutoff was insufficient: the actual 1,000-user
plan still discarded 2,001,000 combinations in a nested loop. The policy now
covers every multi-batch projection, and both measurement sizes reject partial
merge joins and nested loops discarding more than 250 candidate combinations.
The final 1,000-user combined read measured 75–98 ms, versus 4,702 ms before
this repair; the 10,000-user read measured 772–938 ms.

Small-tenant lineage counts also bind the tenant directly on both typed facts
and version-row relations, including duplicate/reusable import checks. A
correlated outer tenant alone produced three sequential scans that each
discarded 150,002 other rows when validating a three-row tenant after shared
table statistics were collected (102.609 ms for a history probe; 40.041 ms for
set metadata). Explicit equal predicates preserve every integrity check while
making the tenant's index selectivity available to the planner. The native-view
suite first retains both unanalysed 100,000-identity union tests, then collects
statistics with the tooling role and verifies that a small tenant's actual
fact probes visit no more than 250 rows. Runtime needs no ANALYZE privilege.
The repaired diagnostic measured complete small-tenant capture plus page reads
at 13–48 ms instead of approximately 295–375 ms.

Current DDL omits the old `official_usage_row_facts_observed` index, whose
only timestamp-reader was retired. Exact foreign-key probes were selecting its
tenant prefix and scanning past the timestamp key instead of using the
existing exact primary key. The observation timestamp, immutable facts,
and foreign keys remain defined in current DDL. Directory service-plan
writes additionally use transaction-local custom plans with sequential scans
discouraged; these settings revert at the transaction boundary. Merely changing
the report-write scan preference did not repair the obsolete-index cost, so
that unsuccessful setting was removed.
This is query planning, not a resource/test-limit increase: the database memory,
SQL/API bounds, statement semantics, root validations and retry policy stay
unchanged. The setting rolls back at transaction end. Fresh, unanalysed
publications otherwise caused a separate indexed fact lookup per row; forcing
hash planning alone also triggered expensive per-request JIT compilation.
The owned 150,000-fact diagnostic records both failed approaches and the
combined planning measurement.

## Semantic regression ownership after source retirement

- `services/officialUsageViews.test.ts` is now a native import/selected-read/
  durable-download suite. It retains the disjoint 50,000+50,000 user and agent
  union with server counts, bounded first pages and exact tail identities,
  rather than a 100,000-element client array. It also covers 501-user tail
  facets, 501 relationships, wide UTF-8 byte-short continuations, both cursor
  directions, alias ambiguity, same-relationship predicates, source states and
  formula-safe incremental CSV parsing. Its ordinary default test deadline
  is not raised.
- The removed `routes/officialUsageAgents.test.ts` is consolidated into real
  session/policy `routes/dataPages.test.ts`, native views, and the existing
  native `services/agentUsage.test.ts`. Exact details and children, roles,
  malformed/duplicate/structured intent, principal-private licensing,
  organization facets, retained-set fences and durable export/audit behavior
  remain covered. Removed offset, multi-agent-array and `.csv` contracts are
  rejection/404 assertions, not aliases.
- Combined inventory-agent deduplication remains in
  `services/agentUsage.test.ts` and targeted inventory-summary regressions:
  exact merged memberships deduplicate positive case-sensitive people and
  preserve Agents response authority without a users-by-agents matrix.
- Pure record/schema types now live in `types/officialReportRecords.ts`, and
  source-qualified identity in `types/agentUsageTarget.ts`. The obsolete
  `officialUsage.ts`/`agentUsage.ts` DTO containers and full-source
  `copilotUsageIdentity.ts` matcher are deleted. `copilotIdentityKey.ts`
  retains only the pure scalar normalizer. The app-activity ambiguity golden
  now asserts its exact expected identity, not another full-source algorithm.
  The old no-match activity helper's absent/unresolved/empty cases execute
  against the native combined SQL in `officialUsageViews.test.ts`.

- `services/officialUsageParser.test.ts` now invokes the streaming parser,
  retaining UTF-8/BOM, quoting/newlines, opaque/control IDs, complete English
  dates, grouped numeric counts, independent metric overflow and provenance
  goldens. Bounded preview examples replace full-report result arrays.
  Persisted duplicate-identity rejection, exact 100,000 Users-row and 256 MiB
  boundaries, first-excess-row stopping, multiline record counting and SQL
  backpressure live in `services/largeTenantUsersReports.test.ts`; they replace
  the predecessor parser's artificial per-call tiny-limit overrides.
- `components/CopilotUsersView.test.tsx` exercises the selected-page boundary:
  server counts/cohorts/order/organization facets, null metrics, retained
  licensing labels, exact-ID detail, independent plans, coaching signals,
  accessibility/focus, historical/principal fences and bounded navigation.
  Licensing/report joins are SQL authority and their semantic goldens belong
  in `services/largeTenantUsersReports.test.ts`, not a browser import of a
  whole-report producer.
- `components/UserPurviewAudit.test.tsx` resolves an exact selected directory
  link before scoped audit search. Visited tab state survives same-selection
  refresh; report-only identities never become guessed audit principals.
- `components/OfficialUsageViews.test.tsx` exercises the selected agent page:
  exact tenant totals separately from filtered totals, bridge-only/unknown/zero
  presentation, retained provenance, server ordering/filtering, mounted keyboard
  sort controls, cursor presence on byte-short pages, exact agent/relationship
  reads, historical/principal fences and durable native-download exports.
  Previous-page rows are hidden during navigation; same-page revision reads
  retain controls and focus. Only pinned summary metadata persists between pages.
- `components/AgentUsagePanel.test.tsx` checks exact inventory summaries and
  separately paged associations, four-field context agreement, lazy candidates,
  explicit source/fingerprint CAS confirmations, role checks and mutation
  invalidation. A same-selection revision revalidates the captured selection
  rather than silently selecting a newer report; child search/page/focus/scroll
  survive. Scope changes and read failures hide private evidence, and child
  invalidation restarts the parent explicitly.
- `services/copilotUsage.test.ts` invokes the actual source provider
  and stages under a durable Users job. It covers independent attempts and
  authorization/cancellation/publication fences, exact positive Users-or-bridge
  verification, automatic TTLs/new-sign-in retries and count-only progress.
  App-only retries do not report retained directory rows as observations.
  Publication holds the run/source validity rows locked through its transaction.
  Run-backed generation batches and renewals acquire the existing per-principal
  data-sync transaction mutex **before** scope, head, lease, and source-job
  locks. A status update otherwise locks the child source before updating its
  run while a generation fence holds the run and waits for that child: an
  actual automatic-refresh deadlock produced a partial app-activity attempt.
  The deterministic database regression holds the sync mutex and source row,
  blocks a real fence, and proves that the status transaction can still lock
  the generation scope and update the run. No retry or weaker fence is used.
- `routes/dataPages.test.ts` exercises real middleware, multipart metadata both
  before and after the file, nonactive correction and deletion, unchanged active
  head with invalidated history/overview/export contexts, dispatcher replacement,
  ready cancellation and retired-route 404s.

These are regression ownership statements, not a claim that the complete 02B
suite, browser/restart consumers or original software gate has qualified.

Selected UI regression ownership additionally includes
`ReportedUserActivity.test.tsx`, `useOfficialUsageOverview.test.tsx`,
`OfficialUsageReportSelector.test.tsx`, `OfficialUsageManageReports.test.tsx`
and `OfficialUsageSnapshot.test.tsx`. These use typed selected envelopes, not
the retired in-memory view builders. Exact details verify identity, selection,
report lineage and source generation/scope agreement; dependent requests abort
when their enabling evidence is withdrawn. Unknown licensing remains separate
from verified unpaid membership, and missing Users metrics are not replaced by
bridge totals.

`OfficialUsageImportPanel.test.tsx` additionally owns immutable acceptance
replay after an uncertain response, already-accepted receipt verification,
separate one-use selection confirmation, exact destination verification on
OK, bounded companion cancellation and diagnostic paging. Its real modal
integration proves that persisting an owned resume URL does not remount an
upload or erase a failed file. Explicit staging A-B-A navigation and actual
Admin-role revocation abort the abandoned operation and suppress late results.
Public staging discard, like preview, requires the originating session epoch;
a renewed session cannot discard its predecessor's private draft. The real
middleware regression is in `routes/dataPages.test.ts`.

`UnifiedAgentDetailModal.test.tsx` preserves the surrounding management,
identity, responsibility, quarantine, keyboard and focus behavior while using
exact inventory summaries and bounded selected associations. One unambiguous
automatic association opens its exact detail and paged users without setup;
multiple associations require an explicit choice, and closing a detail stays
closed during refresh. Summary responses must match the requested record,
report set, selected metadata and captured selection. Retiring a reviewed-link
confirmation restores trigger focus once parent inventory verification allows
it. Relationship identities remain native report usernames, not fabricated
directory display names.

App-level regression fixtures now use the frozen selected wire envelopes,
including exact reported-user-to-directory reads. The frozen agent page URL
is `/official-usage/aggregate`; its bounded `ReportPage<ReportAgent>` response
is not the retired whole-report aggregate DTO. Startup/observer tests still
wait for the independent initial revision publication before exercising a
post-action read. Durable export privacy cases cover all three job kinds on
sign-out, account replacement and role loss, with no CSV body buffering.
The former same-revision HTTP-error summary fallback and silent adoption of
changed user snapshots are intentionally replaced by explicit error/restart
contracts: failed HTTP reads do not expose retained totals, and a
`selection_invalidated` response cannot silently adopt a replacement source.

Report selection and deletion now require explicit confirmation, superseding
the former automatic-selection test scenario. Confirmations retain the
displayed active revision, history revision and history epoch. Principal,
role and revision transitions retire pending operations; uncertain consumed
confirmations are verified through fresh history rather than replayed.
Confirmed deletion opens a new history selection, including for nonactive
sets. Retired browser-format acknowledgement scenarios are removal checks,
not compatibility paths.

Management keeps its pre-cutover saved-history-only surface; it does not mount
an additional cross-import agent locator or issue overview reads. The standalone
retained-agent component preserves filters when collapsed, delegates
accessible sorting and creator-type pagination to selected reads, and keeps
inventory summary reads tied to the inventory's exact report set. An explicitly
retained immutable snapshot may keep clearly labelled previously read totals
during a transport failure; it never retains rows/exports or falls back after
an HTTP authorization, invalidation or serialization-conflict response.

Native browser fixtures no longer import `officialUsageParser`,
`officialUsageViews`, `usageInsightsFixture`, `copilotUsageFixture`,
`userCohortFixtures` or `reportHistoryFixture`. `selectedImportData` uses the
real streaming parser with an explicit synthetic 250-row/1-MiB source bound
and at most 20 preview examples. Its semantic checks distinguish missing
bridge rows from zero-response companions, preserve authoritative blank
Agents dates, count positive Users-or-bridge identities, and leave
operator-asserted source freshness unknown. `selectedImportFixture` serves
only frozen selected pages, exact details, separate observations and facets,
query-bound staging, confirmations and persisted export metadata/downloads.
It is synthetic browser infrastructure, not a production report adapter.

`browser/officialUsage.spec.ts` replaces its full-admin verification scenarios
with exact one-row accepted-set reads and complete-lineage rejection. The
automatic-import scenario now requires explicit complete-set acceptance;
duplicate selection additionally requires its separate reviewed confirmation.
Missing/replaced companions, late cancellation, fresh versus exact-resumed
drafts, lost-response idempotency, changed/deleted accepted sets, Viewer
inspection, raw/discrepant metrics, maximum-safe totals, source provenance,
sorts/reach/date filters, native pinned exports, failed reads and destructive
confirmation recovery retain dedicated scenarios. History pagination uses
53 saved sets at the frozen 50-row default rather than changing the page
limit. File counts and row counts come from independently requested
observations, not embedded whole-history report payloads. Wheel/keyboard,
focus, viewport, axe and CSV-header assertions remain browser checks.
The real-server CSV workflow gives desktop and mobile their own existing
synthetic actors within the shared tenant, rather than accumulating both
projects against one actor's 100-live-selection admission quota. Neither that
quota nor the tenant quota is raised. Reimport-after-delete must create a new
set ID; duplicate imports preserve the canonical ID and saved-set count.
Assertions use the frozen three-field acceptance receipt, not the removed
duplicate-result flag. Selecting the already active report (or the placeholder)
retires an unconsumed selection review without a mutation.

Query-key A-B-A transitions reset both cursor and captured selection before
the next read; returning to a prior filter cannot resurrect its later page.
Exact user dialogs handle Escape even inside a nonempty search input and
restore their originating row button. Import success focuses its heading;
Escape, like OK, revalidates the exact accepted set before navigation. Agent
sort controls include licensed and unlicensed occurrences separately, without
adding overlapping categories.

Capability listing is also bounded at this shared connection boundary:
one registry entry at a time may issue its three independent saved-evidence
reads. It preserves registry order, generation/session checks and decisions
without probing providers or occupying SQL clients through network work.
The regression first observed 33 simultaneous repository reads against the
three-foreground-connection budget, then passed with the fixed bound; pool
size, renewal reservation, admission queue and timeouts are unchanged.

Native downloads use an ordinary same-origin link after metadata revalidation.
The server's `Content-Disposition: attachment` owns the filename and download;
the browser does not fetch, concatenate or turn CSV bytes into a Blob. The
link does not force an HTTP error response into a downloaded file through an
HTML `download` hint. The synthetic Chromium suites exercise that native
response path, including actual persisted exports through authenticated HTTP.

Snapshot metrics, all twelve agent sorts, creator facets and date controls
remain visible in a responsive compact layout. The source table starts within
the existing 760-pixel desktop budget; no geometry tolerance was raised.
Hidden file inputs do not introduce a second upload tab stop. Cancelling
deletion restores focus only after the nested native dialog closes, and
repeated Escape cannot dismiss an import while its accepted-set verification
is still pending.

### Native regression ownership during retirement

- `routes/officialUsageImports.test.ts` now uses the actual application,
  signed synthetic sessions, CSRF middleware, streaming parser and database.
  It covers immutable query intent, strict duplicate guards, metadata on
  either side of the file, retained/replaced drafts, exact acceptance receipts,
  duplicate-history preservation and authorization. Each test discards its
  own drafts through the real route rather than increasing admission limits.
- `routes/officialUsageCsv.test.ts` now covers real durable dispatch, frozen
  column order, formula safety, authoritative blank dates, missing versus zero
  companions, one-row-per-relationship user exports, filtered explicit
  membership, Viewer access, CSRF and removed-route 404s. Build and download
  each retain both their started and completed immutable audit events.
  The former generic many-cycle/disconnect tests belong to
  `services/csvExport.test.ts`, where they still exercise 52 writes and an
  exact third-write disconnect without listener leaks.
- `services/copilotUsage.test.ts` owns the live two-source orchestration,
  independent automatic TTLs, partial failures, exact positive-identity feed,
  awaited progress, transactional publication, cancellation and revocation.
  The temporary `copilotUsageActivation.test.ts` has been folded into that
  canonical selector, not retained as a duplicate implementation.
  Former full-array reader assertions belong to
  `largeTenantUsersReports.test.ts` (including 3,993/2,206 and 30,001 licensing
  goldens) and `largeTenantUserSources.test.ts` (bounded provider and exact-read
  contracts); no old source getter is supplied to the new service.
- Saved-people service and inventory integration tests publish bounded native
  generations and exact cached observations. They no longer encode or mock
  directory JSON snapshots. Exact-ID projection, observation/conclusive
  precedence, nullable cached UPNs, supplied repeatable-read clients, tenant
  isolation, current revision invalidation and native identifiers remain
  explicit assertions.
- `db/dataSync.test.ts` retains durable onboarding, retries, history,
  success markers and scope fences, but reads saved users through native
  selections and separate plan pages. The obsolete 32-MiB snapshot encoding
  and old-format compatibility cases are replaced by removed-table/getter
  assertions, typed-input rejection and the record-foundation byte/batch
  boundary tests. The 30,001-user successor additionally proves that every
  user retains all three paid features, with bounded first/last plan reads
  and exact persisted per-plan counts.
- `db/dataSyncSnapshot.test.ts` now asserts removal instead of decoding old
  snapshot formats. Native successors cover independent typed plan children,
  canonical evidence hashes, duplicate-child rejection, nullable observations,
  field boundaries and 250-row batches. No old-format reader or writer is
  retained to satisfy the former compressed-array tests.
- Agent-people service tests now exercise cursor-based references and exact
  directory/cache reads, including 100+3 identities and rejection at 101.
  Existing provider concurrency, role checks, session replacement,
  cancellation, late publication and wall-clock deadline scenarios retain
  their assertions. Persistence tests use durable principal epochs rather
  than legacy clear-run IDs. Historical-schema handoff fixtures have been
  retired; persistence checks target current DDL and explicit reset refusal.

Cache lookup publication carries both a durable session epoch and a dedicated
`agent_people/cache` scope epoch. Scoped data clear advances the write epoch;
ordinary cache writes advance dependent read epochs, not the writer's own
fence. Cache publication takes the data-sync advisory lock before principal
and scope locks, sharing clear/publication ordering and preventing a late
lookup from repopulating cleared data. This does not revoke unrelated sessions
or invalidate the writer after each of its own bounded batches.
Automatic refresh revisions likewise pass one captured time through native
user metadata and bounded inventory-marker hashing on the same repeatable-read
client. Expiry cannot be evaluated against two different instants inside one
response, and serialization conflicts remain unreplayed `data_read_conflict`
failures.
Latest-attempt metadata is scoped by both generation and session epochs, so a
clear or revocation cannot reintroduce an old attempt's progress or failure.

The runtime dispatcher and operator retention now share bounded record
collection. Live selections and exports retain their pins; physical child
rows are deleted in bounded slices before the database permits `collected_at`.
That immutable collection proof releases byte reservations while preserving a
head's revision fence and the latest source-attempt metadata. Terminal export
contents are purged separately from the one-day metadata window, and queued
expiry uses the same append-only audit implementation as ordinary exports.
Modern retention requires the current schema. Historical receipt-retention
tests invoke the same isolated receipt primitive without enabling a legacy
application reader.

Backup table fingerprints preserve the existing receipt-v3 canonical MD5
values but stream bounded byte chunks from one repeatable-read cursor. Dump
checksums also stream from disk. Restored native ingestions are cancelled using
their actual state column, and restored principal generations remain fenced
until fresh authorization and collection.
Current-deletion/access review streams at most 250 IDs and signatures per SQL
page into transaction-local verified-ID tables; it does not build process-wide
maps or UUID arrays. Report membership hashes likewise stream ordinal pages,
and target mutations use bounded tuple cursors. The existing 100,000-object and
10,000-tenant safety caps remain unchanged. Reopening rechecks current source
authority, invalidates removed history memberships, preserves shared versions,
and never changes the current database. Native backup/restore tests cover
later corrections, nonactive deletions, selection invalidation, and 551-row
ownership reconciliation with 250-row/1 MiB observations.

The retired whole-report agent-usage projection suites now exercise exact
native summaries, separately paged candidates/associations, strict mutation
envelopes, and the unchanged inventory authority. Power Platform environment
and GUID normalization never folds package or opaque identities. The report
head lock precedes the association revision comparison, preventing concurrent
administrators from using a stale compare-and-swap. Started/failed audit
receipts remain durable; success receipts commit with the association, and
expiry is revalidated after audit persistence. Selected report reads also
revalidate their fences after their one repeatable-read callback, without
replaying it or replacing its captured data/count time.
Successful association audits also retain the source-selection hash, including
the existing normalized source-key encoding.

The still-authoritative inventory consumes at most 100 exact canonical IDs per
report-summary query. Reviewed and direct memberships are joined relationally;
metrics aggregate by canonical ID and active people are distinct across its
actual report relationships, not an agent-by-user matrix. A missing report
head produces unavailable/null metrics without a fact query. The regression
suite asserts one SQL statement for 100 targets, both byte bounds, merged-user
deduplication, and the existing 5,000-agent/10,000-source read deadline.
Inventory CSV now serializes the native summary's `usageAssociationCount`;
full reviewed/source-qualified associations remain separately paged through
the exact-agent association endpoint, not embedded in every inventory row.

Automatic-admission, clean-sync, and integrated fast-refresh regressions use
real generation stages and the actual streamed provider with synthetic
transport. Their assertions distinguish missing from successful-empty
sources, preserve independent inventory/detail work, and reject late fenced
publishers. Provider transport regressions retain stalled/rejected redirect
cleanup, UTF-8 validation, token nonforwarding, and cancellation before stage
finalization. Native singleton imports receive an explicit synthetic Vitest
session secret; runtime cursor-secret validation is unchanged.
The data-sync orchestrator's unit boundary uses the tenant-scoped
`OfficialReportStatusRepository.read()` summary, including complete zero-row
sets, replacement counts and upload-only workflows; it never constructs a
published report container. Cross-tenant regressions use real streamed imports,
private generation/people scopes, immutable confirmations, and exact canonical
source authorization. Accepted report rows remain tenant-visible while draft
previews and directory evidence remain account-private.

Historical association-schema migration fixtures are retired.
Native physical-cascade checks first expire and collect the actual selected
read, release its history membership, and verify the association still exists
before the report-set foreign-key cascade. No legacy payload is converted.

Import cleanup advances ordinal cursors and deletes exact tuple candidates,
retaining the existing 25-row bound instead of repeatedly scanning deleted
prefixes. Empty uploads with expired leases are also reclaimed. Report
identity matching uses the same non-strict full-join strategy as other
combined projections, and unresolved identities are assembled from disjoint
invalid-match and many-to-one groups rather than a second large join.

Operator retention cancels expired report-ingestion state using the ingestion
schema, not the unrelated generation `cancellation` or `reserved_bytes`
columns. Dry-run and ready-draft lease distinctions are covered explicitly.
Current content/receipt assertions use current DDL and typed report imports.
Nonempty incompatible schemas fail preflight and are never transformed.

The owned `cutover-compiled-restart` selector builds the backend, invokes the
existing tooling seeder, and runs the compiled application under
`agentcontrol_app` in new Node processes with no operator credential variables.
The runtime verifies that it cannot create schema objects. Quarantine, canary
and bulk ambiguous dispatches each receive an actual crash before recovery,
rather than keeping three deliberately never-resolving synthetic providers
simultaneously inside the three-foreground-connection budget. The original
container restart entrypoint uses the same three crash modes. Recovery also
discovers a persisted queued official export and streams its verified bytes.
This process/role proof is not a claim of the complete phase-05 container,
scale, backup and restore campaign.

These caller-specific checks do not replace whole-phase aggregate and unchanged
original-gate qualification; their actual outcomes belong in the completion.

## Atomic 02B caller/deletion inventory

- Backend activation replaces the registered users/report portions of
  `routes/{copilotUsage,officialUsage,agentUsage}.ts`, all report consumers in
  `routes/{inventory,unifiedAgents}.ts`, existing `.csv` handlers and dispatch
  bindings with `officialReportData.ts`. The factory and persisted dispatcher are live,
  retaining the normal route-policy classifications and middleware.
- Old full-source joins/getters in `services/{copilotUsage,
  copilotUsageIdentity,officialUsageViews,officialUsageHistory,
  officialUsageOverview,agentUsage}.ts` and `db/{officialUsage,agentUsage}.ts`
  are removed after caller replacement. Existing report artifact/version/set
  tables remain the authority. Reused pure helpers live in
  `officialReportFields`, `csvEncoding`, `copilotIdentityKey` and
  `agentUsageIdentity`; no compatibility aliases remain.
- Frontend API/wire/cache: `api/client.ts`, `App.tsx`,
  `useOfficialUsageOverview.ts`, `agentColumns.ts`,
  `usageInsights.ts`, `workbenchRouting.ts`, their tests and fixture types.
  Move list/cohort/count/filter/sort selection to the server; page caches include
  selection and query identity; invalidation clears incompatible pages.
- Frontend consumers: `CopilotUsersView`, `CopilotServiceDetails`,
  `ReportedUserActivity`, `AgentUsagePanel`, `AgentInventoryFilters`,
  `UnifiedAgentTable`, `ReportingView`, `OfficialUsageSnapshot`,
  `OfficialUsageHistoryPanel`, `OfficialUsageReportSelector`,
  `OfficialUsageImportModal`, `OfficialUsageImportPanel`,
  `OfficialUsageManageReports`, `SyncHistoryView`,
  `BackgroundRefreshIndicator`, their tests and import presentation helpers.
  Preserve permissions/accessibility/navigation; no old collection fields,
  client CSV assembly, or full-list relationship scans.
- Related audit/permission presentation: `AuditLogView`, `UserPurviewAudit`,
  `PermissionCenter`, `permissionIssues` and capability/permission fixtures.
- Scripts: `browser-fixture.browser.ts`, `restart-fixture.ts`,
  `restart-runtime.mjs`, `cache-load.ts`, `exportReadonlyFixture.ts`,
  `dataSyncPersistence.test.ts`, database/backup/export fixtures and
  `largeTenantFixture{,.test}.ts`; update restart/restore/browser assertions to
  the same new contracts. Existing backup authority and secrets stay intact.
- Docs: this contract, `official-usage-import.md`, `copilot-license-usage.md`,
  `operations.md`, `record-data-foundation.md` and role/provider runbooks as
  applicable. Root Dockerfile, feeds, manifests, compose/public ports and
  deployment policy remain unchanged by this phase.

The isolated original software gate also uses the existing disk-backed fixture
override and verifies its exact owned PGDATA mount. This fixes a qualification
storage prerequisite, not gate criteria: `backend/scripts/test-all.ts`, its
five required commands, fixed RAM limits and pre-maintenance refusal remain.
Both independent qualification and original-gate child processes explicitly use
the fixed `--max-old-space-size=768` budget after environment sanitization; an
inherited `NODE_OPTIONS` value is never forwarded. Diagnostic DOM truncation
affects failure output only. At this phase's acceptance, each command retained
its 180-second deadline. The later production-first continuation extends only
the whole backend-test step to 1,200 seconds; all other safeguards remain.
See the current policy in [operations](operations.md).
Disposable cleanup records and revalidates both containers' exact mounts,
including the complete evidence-bind path and the worker image's inherited
anonymous PGDATA volume. The worker is removed with its verified anonymous
volumes before exact-project teardown. Unknown services, foreign mounts or
shared volume attachments refuse destructive cleanup; no global prune is used.

Do not open 02B with unspecified import/query/export semantics. Its remaining
work is activation, matching UI/scripts, predecessor deletion and cutover
verification—not implementing the algorithms above. Production convergence,
safe-gated deployment and observation remain mandatory phase 07 work.

### Native HTTP lifecycle regression ownership

The real-session `app.test.ts` import flow now uses immutable query intent,
actor-owned bounded previews, three-kind bundle receipts, paged history,
selected user/agent pages and separate relationship pages. Removed admin,
whole-report CSV and legacy-cleanup-acknowledgement routes explicitly return
404. The same test drives actual queued exports through the durable dispatcher,
polls only metadata and checks downloaded CSV provenance, nullable metrics,
relationship-row meaning, formula protection and canonical UTC timestamps.
Workbench export action metadata points to the CSRF-protected
`POST /api/data-exports`, with cancellable work rather than removed CSV routes.

`officialReportMultipart.ts` owns four process-local upload reservations, at
most two per tenant, including incomplete multipart headers. Durable ingestion
admission remains authoritative across processes and shared source work.
Disconnect/deadline responses do not release a reservation while its identity,
ingestion or finalization work is pending. A never-ending body receives the
frozen 30-minute deadline response even before its first file; transport closure
does not depend on the multipart parser seeing EOF. Field metadata may still
precede or follow the file. Failed cleanup emits the existing value-free
`official_usage_upload_cleanup_failed` managed alert.
Native identity/admission/parser failures also respond before EOF; two real
independent source generations occupying the shared tenant slots reject a
still-streaming upload immediately, rather than waiting for its body or deadline.

The old buffered-reader 8-MiB rejection is not an active contract: 02A froze
256-MiB streamed uploads. The exact wire limit remains exercised by
`largeTenantUsersReports.test.ts` (“enforces the exact 256 MiB wire limit with
bounded input chunks”). The packaged multipart regression separately enforces
the unchanged 4-KiB field limit and proves admission recovery. Its outer test
deadline was not increased.

The supersession lifecycle unit scenarios now exercise bounded keyset
signature review at one captured transaction time, transaction-local verified
IDs and 250-row mutation cursors. All four current/restored supersession
combinations and accepted correction-marker retention remain explicit;
full-array restore allowlists are no longer their test contract.

`userSourceGraphFields.test.ts` directly preserves the pure Graph URL,
organization, current-assignment, disabled/partial/unknown service,
submillisecond assignment-time, exact-identity, signed-download and activity-date
vectors. It calls the helpers used by the native provider rather than restoring
a client that returns complete directory or activity arrays.
The native provider now checks persisted logical-page admission before issuing
the next Graph request, not only after receiving its body. Catalog, discovery
and exact-identity ceilings remain 200, 1,000 and 6,000 pages; total evidence
remains 10,000 pages. Real-stage boundary tests retain the last permitted
request and reject the next without an extra fetch or page observation. The
post-response checks remain, including the accepted 02 source foundation's
5,000,000-wire-row and 100,000-unique-user bounds; none of those ceilings changed.

### Retired-container regression successors

- `copilotUsageGraph.test.ts` now exercises the real record-backed provider and
  stages, not the deleted array-returning client: count/filter reconciliation,
  conflicting catalog and exact identity evidence, continuation fencing,
  encoded URL bounds, cancellation/progress backpressure, denied/retried
  requests, byte ceilings and all 2,167 users across 22 enterprise pages larger
  than 2 MB. Pure schema/licensing vectors are in
  `userSourceGraphFields.test.ts`; transport and streamed-CSV vectors are in
  `providerJson.test.ts` and `largeTenantUserSources.test.ts`. The unchanged
  `user-sources-foundation` selector uses those native successors.
- `db/officialUsage.test.ts` and `db/officialUsageImports.test.ts` now use
  streamed native imports, immutable confirmations and bounded selected pages.
  They preserve metadata-free/empty files, partial acceptance, correction
  lineage, exact deduplication without storage growth, immutable receipts,
  simultaneous acceptance/reuploads, ownership, replacement, rollback,
  deletion/reimport and operator retention. Atomic publication failure leaves
  only resumable private preparation; no membership, history, receipt, audit
  or visible page publishes. The same reviewed intent can retry successfully.
- Removed `routes/copilotUsage.test.ts` and
  `routes/officialUsageHistory.test.ts` are covered by the consolidated real
  session/policy matrix in `routes/dataPages.test.ts`, including Viewer/Admin,
  anonymous/unassigned/foreign tenants, no-store, read-only routes, supported
  server search, rejection of retired offsets and no provider or full-inventory
  reads. This is not an injectable router-policy substitute.
- Historical report-schema transformation tests and migration receipts are
  retired. Current native import/history tests cover persisted content without
  instantiating historical schemas or reintroducing legacy report readers.
- `db/officialUsageHistory.test.ts` now preserves cumulative row/observation
  reuse, known versus activity-only coverage, corrections, explicit historical
  snapshots, expiry/reimport, partial-restore exclusion and empty-kind
  accounting through native imports and separate observation pages. Both
  active and nonactive restored corruption invalidate an already pinned read.
- `db/officialUsageOverview.test.ts` now verifies native history/selected scope,
  the 45-day union of overlapping 30-day snapshots, reused versions, exact
  case-distinct IDs, paged creator types, positive same-row activity, literal
  historical-name and Unicode search, deterministic ties, corruption,
  supersession/deletion/purge and zero evidence. Activity is evaluated on UTC
  calendar dates even when the connection uses a different timezone.
- Removed `services/officialUsageHistory.test.ts` and
  `services/officialUsageOverview.test.ts` are consolidated into
  `services/officialReportReads.test.ts` plus those native SQL suites. The
  successor verifies admission before connection, one real repeatable-read
  client/snapshot/time, metadata/count/row/analytics/commit rollback and
  release, separately paged observations, and serialization 503 with five-second
  retry advice and no weaker isolation or replay. Retired offsets and embedded
  observation graphs are rejected/absent, not emulated.
- Removed `routes/officialUsageOverview.test.ts` is covered by
  `routes/dataPages.test.ts`: real roles/sessions, both scopes, frozen bounded
  metadata and strict malformed/duplicate/nested query rejection before
  report capture. Its old `sortBy`/`sortDirection`/offset options are removal
  assertions; native clients use `sort`/`order` and authenticated cursors.

History integrity reconciles distinct referenced versions against typed row
membership, avoiding rescans of a shared version for every retained set.
Corrupt/expired memberships are retired in bounded 100-set transactions;
already pinned reads fail explicitly, while a fresh capture excludes the
invalid set without substituting another active head. Versions with no
remaining live set are tombstoned, while temporal pins still protect their
row links from collection. Reimports do not reuse expired or incomplete
versions. A same-byte artifact may be retained for the new import without
reviving the tombstoned set/version. Operator version collection respects live
ingestion receipts instead of failing their foreign-key constraint.

The history reporting envelope includes only complete known reporting
windows, never inferred activity ranges. Overview search and date predicates
choose matching observations before selecting each agent's name/activity;
the unfiltered identity count remains separate from filtered analytics.
Creator-type children use that same captured evidence predicate. Aggregate
analytics explicitly retain the frozen `basis: filtered_rows` contract, rather
than the deleted overview service's unfiltered-summary envelope.
