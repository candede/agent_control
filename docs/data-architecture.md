# Saved-data architecture

This reference describes data ownership, publication, selected reads and
retention. For app workflows, use [usage imports](official-usage-import.md) or
[licenses and adoption](copilot-license-usage.md).

The API owns provider collection, calculations, saved selections, exports,
jobs and administrative audit. The browser and FastMCP service use canonical
API contracts; neither queries the database/providers directly or acts as a
separate business authority.

## Current schema

[Current DDL](../backend/src/db/currentSchema.ts) and the
[schema verifier](../backend/src/db/schema.ts) define one supported schema.
Initialization accepts an empty database or verifies that exact schema and
runtime grants. Startup does not migrate an incompatible installation.

The `app_schema` fingerprint is computed from the compiled SQL artifact.
Changing only the marker is not schema recovery. The
[database operator](../backend/scripts/database.ts) and
[explicit reset guard](../backend/scripts/databaseReset.ts) own installation
and reset. Backup and isolated restore also require the current schema.
See [reset operations](operations.md#reset-application-data).

The runtime role has only the required data privileges. Verification checks
individual grants, immutable-evidence guards, tenant-owned foreign keys and
publication/clear trigger bindings. A read grant cannot satisfy a write
requirement; an operator workflow does not confer runtime authorization.

## Scope, publication and selection

| Evidence | Owner / scope |
| --- | --- |
| Directory and Office-app report sources | Shared tenant-owned saved generations, collected with application Graph credentials |
| Graph packages and Power Platform inventory | Source-qualified saved records reconciled into canonical agents; Power Platform collection uses delegated authority |
| Official agent CSVs | Tenant-owned immutable accepted report sets and version/artifact membership |
| Office observations | Current person facts and weekly aggregates derived from saved directory/app evidence |
| Selections and cursors | Actor-bound read context over exact source roots, revisions and expiry |
| Jobs, controls, exports and audit | API-owned execution, receipts and lifecycle state |

Delegated authority uses verified `(tenantId, MSAL homeAccountId)`, not report
usernames, guest resource IDs or display names. Tenant sharing does not share
tokens, initiating sessions or mutation authority.

### Collection and publication

1. Admit a writer under tenant/scope limits and a persisted deadline.
2. Stream provider JSON records or activity CSV rows into awaited bounded writes.
3. Record validated physical page receipts separately from database batches;
   reject repeated continuations, conflicting identities and count mismatches.
4. Validate the complete staged generation and current authorization/source
   epochs.
5. Publish the complete head transactionally. Partial, failed, cancelled or
   unauthorized collection cannot replace the preceding complete source.

Provider collection has no fixed tenant-record, provider-page, wire-row or
whole-response byte ceiling. Record work, safe representable counts, batches,
storage reservations, provider backoff and deadlines still bound it.

| Resource boundary | Current bound |
| --- | --- |
| Ordinary database batch | 250 rows and 1 MiB of encoded PostgreSQL Bind parameters |
| Provider JSON record/scalar work | 16 MiB, not a whole-page response limit |
| Provider app-activity CSV record | 64 KiB |
| Generation reservation | Up to 8 GiB; tenant admission also enforces a 64 GiB budget |
| Directory service-plan children | At most 1,000 per user |
| Native source roots / selection pins | 16 / 20 |
| Worker admission queue | At most 32 pending requests per database pool |
| Selected JSON pages | 1–100 rows and bounded response bytes; individual endpoints can use smaller pages |

Provider waits do not hold database transactions. Authority is rechecked after
pending operations and before publication; cancellation before commit rolls
back. A confirmed commit remains published if later cleanup fails, with cleanup
reported separately. Writer leases cannot outlive their persisted deadlines.

Routine collection is due every six hours. Ordinary failed attempts normally
wait an hour, subject to provider backoff. Missing sources, initial collection,
newer-sign-in authentication recovery, changed report inputs and explicit
refresh have their own eligibility rules. Initial read-only sync starts
automatically while signed in, visible and online; no release approval or manual
enable step is required.

### Authority and saved reads

- Principal/session and source epochs fence revoked authority and explicit
  clears. Sign-out revokes old sessions, selections and unfinished writers
  without deleting complete retained sources.
- A new authorized session can read shared saved evidence. Observation age
  describes freshness; it does not itself delete a source or renew provider
  authority for writes.
- A selection freezes its actor, authorization, roots, query, revisions and
  expiry. Signed cursors continue that selection, not a newly captured dataset.
  The read rechecks its actual dependency fences and database-clock expiry
  before returning.
- Safe replacement can retain valid pinned reads. Explicit invalidation,
  revocation, source clears and expiry deny affected reads. Unrelated publication
  need not invalidate every selection.
- Data filtering, ordering, counts and pagination run server-side over the
  complete selected dataset. Child collections have independent bounded pages;
  neither the browser nor an API response materializes a tenant-sized source.

Selections last at most ten minutes, sometimes less because of their
dependencies. Exports can renew a live read lease but cannot extend revoked
authority or an expired execution dependency.

Implementation owners:
[generations](../backend/src/db/dataGenerations.ts),
[inventory generations](../backend/src/db/inventoryGenerations.ts),
[selected reads](../backend/src/services/dataSelections.ts),
[user sources](../backend/src/db/userSources.ts) and
[sync coordination](../backend/src/services/dataSync.ts).

## Inventory and provider evidence

Canonical inventory reconciles exact supported source identities, not names.
Package records and logical agents are different counts. Every captured
agent-capable native scope contributes to membership checks; environment-only
records are enrichment, not additional agents.

Absence, unavailable evidence, explicit null, zero and false remain distinct.
Complete older observations can remain readable without becoming current
management authority. Configuration, provenance and source references come from
the captured member; current detail evidence cannot override invalid catalog
authority.

Package detail reconstructs hosts, element types and categories from saved child
facts. Complete About text uses bounded continuation rather than the table's
short preview. Inventory search normalization is not identity matching.
Source-qualified record IDs and native/environment identities retain their
own exact bounds and normalization rules.

### Maker-controlled sharing and captured agent configuration

Power Platform's Preview
[`sharedWithViewers` and `sharedWithEditors`](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-agent-inventory)
remain separate from Graph administrative availability/installation.

| Provider field | Saved field / meaning |
| --- | --- |
| `sharedWithViewers` | `details.makerSharing.viewers`: observed `entireTenant`, user/group counts |
| `sharedWithEditors` | `details.makerSharing.editors`: observed editor user/group counts |
| `isWebSearchEnabledForKnowledge` | Same exact name under `details` |
| `harness`, `titleId`, `instructionsCharactersCount` | Bounded metadata under `details`, not instruction text |
| `componentsCounts` | Observed component/knowledge-type counts under `details` |
| `capabilitiesCounts.distinctFlows` | `details.distinctFlows` |
| `flows`, `triggers` | `details.flowReferenceCount`, `details.triggerCount`: array lengths, not item definitions |
| ResourceItem `id` | `providerResourceId`, separate from native `name` identity |

Sharing is stored in `power_platform_record_rows.residual.details`. The generated
nullable `maker_org_wide_chat` field distinguishes reported true/false from
absent/null; residual evidence preserves finer distinctions. New observations
replace earlier evidence, including omitted values. Malformed typed evidence
rejects collection; unknown fields are not raw provider archives.

Graph separately retains observed `ownerId`, `agentIdentityId` and
`providerUsage` counters (`activeUsers`, `totalSessions`, `totalRunTimeInHours`,
`exceptionRate`, `lastUsedDateTime`). These do not establish a reporting window
or verified exception-rate unit and never replace official imported usage.
New catalog evidence takes precedence over reused older detail telemetry.

Maker sharing is read-only and does not prove effective personal chat access.
Manage changes supported package/quarantine settings, not maker sharing.
Power Platform refresh, not Graph detail enrichment, observes maker changes.
See [provider contracts](provider-contracts.md).

## Official reports and user evidence

### Report ownership and interpretation

The Agents, Users & agents and Users CSVs are the authority for reported agent
usage. Office activity, package telemetry, Defender and Purview are separate
sources and cannot replace them.

Imports validate/stage all companions before atomic acceptance. Exact duplicates
reuse retained content. Changed ordinary imports create independent sets;
explicit corrections supersede their targets. A superseded original does not
revive automatically when its correction is deleted.

Parser version `1` accepts `m365-agents-observed-v1`,
`m365-users-agents-observed-v1` and `m365-users-observed-v1`. The
[import guide](official-usage-import.md#file-requirements) owns the exact headers,
field formats and per-file row/byte limits.

The automatic default chooses the newest complete, available report by reporting
end, then start, acceptance time and report ID. Publication, deletion, expiry and
report/inventory reads reconcile it. Reader-personal report selection does not
mutate this default.

| Evidence | Contract |
| --- | --- |
| Report identities | Exact case-sensitive dataset-scoped agent IDs and usernames; no guessed cross-report user identity |
| Report dates | `activity_range` derives observed last-activity bounds; optional explicit metadata is `operator_asserted`; source refresh is not inferred |
| Response totals | Each source remains separate; report headlines use Agents only |
| Active users | Exact positive-response identities, deduplicated within the relevant report/agent context; licensed and unlicensed categories are never added |
| Recency | User recency comes from Users, not the agent-wide date in Users & agents |
| Missing evidence | Null/unknown, not zero or an inferred substitute total |

`OFFICIAL_USAGE_STALE_AFTER_DAYS` defaults to 35 and accepts integers 1–365.
Saved report staleness considers both coverage-end age and acceptance age.
Unknown source freshness is not proof of a current provider export.

Overlapping snapshots cannot be summed into all-time activity or subtracted to
produce exact daily events. Trend comparisons require appropriate source-window
and cohort interpretation.

Accepted report history has no default time expiry. Deleted/unreferenced
payloads and abandoned staging use bounded cleanup; shared payloads remain while
retained sets reference them. Drafts expire after 30 minutes. Content-free
acceptance receipts last 180 days; minimal import audit lasts 90 days. A completed
request retry returns its original result, not a newly imported replacement.
See [CSV limits and user recovery](official-usage-import.md#limits-and-retention).

| Import staging boundary | Limit |
| --- | --- |
| Concurrent upload streams per application process | Four total, at most two per tenant; database writer admission also applies |
| Upload deadline | 30 minutes |
| Unexpired file drafts | Nine per actor, 30 per tenant |
| Staged bytes | 1 GiB per actor and bundle, 2 GiB per tenant |

Retained-history admission counts allocated sets, versions and reserved rows.
Reusing a version or retrying pending acceptance does not charge it again.

Implementation owners:
[imports](../backend/src/db/officialReportImports.ts),
[history](../backend/src/db/officialReportHistory.ts) and
[queries](../backend/src/db/officialReportQueries.ts).

### Directory entitlement and identity

Directory users, individual service plans and app-report rows are typed records,
not whole-source JSON snapshots. Discovery uses tenant product membership to
find candidates, then verifies effective paid service-plan state.

| Recognized paid service | Exact service-plan ID |
| --- | --- |
| `M365_COPILOT_APPS` | `a62f8878-de10-42f3-b68f-6149a25ceb97` |
| `M365_COPILOT_TEAMS` | `b95945de-b3bd-46db-8437-f2beb6ea2347` |
| `M365_COPILOT_BUSINESS_CHAT` | `3f30311c-6b1e-48a4-ab79-725b469da960` |

Current assignment membership, per-product disabled plans and individual
capability evidence determine entitlement. Product names and catalog provisioning
states are not license classification. `enabled`, `warning` and
`partially_enabled` qualify as active paid access; unknown is not unpaid.
An active feature in one assignment can qualify despite another disabled source.

The saved directory contains product-filtered candidates plus exactly verified
active report identities. It is not tenant headcount. Provider counts and
continuations must reconcile before publication. Newly reported identities stay
unknown until automatic or explicit directory collection verifies them.

Directory/report matching requires a unique exact trimmed, case-normalized UPN
or directory object ID. Compatibility Unicode search folding, names and
pseudonyms are not identity evidence. Ambiguous aliases remain unmatched.
Opaque report identifiers retain their case; directory GUID casing canonicalizes.

The Office-app source collects the Graph v1.0 per-user detail CSV with
`period='D28',version='v2'`. Supported signed downloads are restricted to exact
validated HTTPS hosts/paths and receive no Graph bearer token. Activity dates,
provider refresh date, collection time and original retained-row provenance stay
separate. Assignment timestamps retain their validated UTC precision.

Current saved-user app freshness is evaluated on reads: a whole-day age above
three days after the refresh date's UTC end-of-day is stale. Last-known dates
remain visible, but stale app evidence does not drive measured-activity or
inactive-app attention counts. Frozen Office observations retain their captured
metrics independently of this current-source freshness.

### Inventory associations and adoption

Automatic usage matching follows **exact report Agent ID → full Graph package ID
→ existing canonical agent → established native membership**, where present.
It preserves prefixes and case, calls no provider and writes no association.

Admin-reviewed associations are explicit set-scoped overrides to one exact
source-qualified target. Canonical UUIDs are navigation references, not native
targets. Writes require current source authority, exact revisions and confirmed
intent; the association and success audit commit together. Associations never
create management targets or grant permissions.

Linked metrics count each report identity once. Positive companion usernames are
deduplicated across linked identities; missing companion evidence keeps distinct
active users unknown. Deletion removes the set's associations. Principal cleanup
does not delete another reader's tenant-owned mappings.

Agent-adoption champions rank by reported responses, distinct positively used
agents, lowercase display name and exact identity, with up to three per group.
Positive responses or positively used agents qualify. Agent creation and
responsibility do not qualify or boost a champion.

### API and CSV reads

Selected report/user APIs expose scalar rows with separately paged children.
The principal, selection, report versions and source revisions must match across
pages, details and export publication.

| Route family | Saved contract |
| --- | --- |
| `/api/copilot-usage/users` | Selected directory/entitlement, report metrics, counts and source coverage |
| `/api/copilot-usage/users/:objectId/{service-plans,agents}` | Independent paged children under that selection |
| `/api/official-usage/{aggregate,users,overview,history}` | Exact report or retained-history evidence; explicit selected scope is not fallback history |
| `/api/agent-inventory/:recordId/usage-*` | Exact/reviewed usage under the inventory selection and pinned retained history |
| `POST /api/data-exports` | Export job bound to the displayed selection, dataset and applied filters |

Report-user CSVs contain all relationships of the matching users, including a
row without agent fields for people with no relationships. Repeated user totals
are not additive. Export status/download routes replace direct report `.csv`
routes. For endpoint parameters, use the
[canonical API reference](mcp-integration.md#users-licensing-official-reports-cohorts-and-retained-history).

## Retained Office observations

Normal saved directory/license and D28/v2 app publication prepares Office
evidence locally. Interrupted preparation is recoverable without another Graph
call, agent CSV import, administrator session or page visit. Derived failure is
visible separately and does not invalidate a healthy source publication.

`office_observations`, `office_group_facts` and `office_person_facts` own the
derived evidence:

| Generation | Contents |
| --- | --- |
| `office_app_adoption`, selector `current` | One current frozen person dataset, header, organization/group metrics and provenance |
| `office_history` | One aggregate point per tenant/UTC Monday-start week/D28/v2; no historical person records |

Current person facts freeze exact identity, paid-feature context, company and
department, seven app dates and evidence reasons. Recent participation uses the
refresh date minus 27 days through that date, inclusive. Chat, Edge, overall last
activity and agent usage do not contribute. Unknown is a subset of no recent
evidence, not a disjoint population. App totals overlap; user-app pairs are not
distinct people.

Only current, fresh, validated saved heads seed a capture. Source/clear epochs,
leases and the tenant sync mutex fence preparation and atomic publication of
both current and weekly heads. Bounded copies use indexed exact identity lookup
and account for headers, child facts and group identities. Published evidence is
immutable; history has no source-generation read dependency.

Identical semantic replay preserves the capture. Newer evidence or a correction
within a week replaces that week's aggregate. Later licenses, departments or
observations never recompute older metrics. Current source staleness is disclosed
separately rather than aging frozen metrics into zeroes.

Office history retains twelve UTC calendar months by provider refresh date,
including the whole cutoff day. Explicit directory/app clears fence history;
source garbage collection alone does not erase it. Lifecycle removes dependent
reads before bounded fact/header cleanup and storage-charge release.

Office selected reads use `/api/office-app-adoption` independently of agent
report/inventory context. Groups page separately from people. App filters narrow
matching people and suggestions, not full-group paid denominators or the seven
saved app totals. Organization cards remain organization-wide.

Office Champs rank by positive app breadth, qualifying recency, normalized label
and exact identity, at most three per group. Historical person reads fail
with `office_history_aggregate_only`. Office observation/baseline pins are separate
from agent report pins, and every panel/page must use the same selected context.
See [Office interpretation](copilot-license-usage.md#office-adoption-saved-read-contract).

## Browser saved-read cache

Authenticated saved-read caches are memory-only and scoped to account, roles,
query, report and publication revisions. Cache reuse never extends the server
read lease. Logout/account changes remove private context.

Saved rows may remain visible during renewal or a retryable failure, with their
real error and source dates. Invalid/denied evidence is withdrawn. Expired
display data cannot authorize facets, children, exports or mutations; those
require a current successful selection. Late cancelled responses cannot restore
rejected evidence.

Focus/reload and lease renewal recapture saved data, not providers. Background
status polling observes saved progress; it is not provider synchronization.

## Jobs, controls and audit

Jobs own execution state and bounded outcomes. Polling does not dispatch, resume
or reconcile work. Expired initiating authority requires fresh same-principal
authorization; workers do not borrow the waking request's credentials.

Package and Studio controls require exact current identity, actual provider
permission, current prestate, confirmation and readback. A sent-but-unknown
mutation is reconciled read-only before a separately confirmed retry. Receipts
bind intent and evidence, not an additional business approval.

Pending control receipts fence canonical publication until their outcome is
resolved. Audit success commits with the local mutation; audit failure rolls it
back. A durable success is not rewritten as failure after commit.

Administrative audit records verified actor, `webapp|mcp|unknown` origin,
reported client labels and provider source separately. It is append-only
application evidence, not cryptographic proof against database administrators.
Only Admin can read/export it. Microsoft investigation events remain separate.

## Lifecycle and recovery

Retention invalidates affected references before bounded physical cleanup.
Generation byte charges remain until owned headers/facts are removed; provenance
metadata remains while referenced. Current-schema backup/restore verifies
fingerprints and checksums, revokes recovered authority and respects source
clears and supersession before reopening.

An operator database reset deletes saved reports, audit and jobs; provider sync
cannot recreate imported CSV history. In-app saved-user/inventory clearing is a
different operation and preserves accepted report history.

Only actual maintenance pauses dispatch. Normal installation or completed reset
returns to authenticated operation with automatic first-run read-only sync.
See [operations](operations.md) and [security](security-model.md).
