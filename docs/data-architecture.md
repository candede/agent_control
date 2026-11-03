# Saved-data architecture

Data ownership, publication, selected reads and retention follow this flow:

1. Collect directory, Office-app and inventory evidence, or import agent-report CSVs.
2. Validate staging and publish a complete tenant-owned source.
3. Reconcile canonical agents and derive Office observations from saved evidence.
4. Serve actor-bound selections, paged children and exports through the API.

The API owns collection, calculations and saved reads. Browser/FastMCP clients
use its contracts, not direct database/provider reads or separate business
authority. Initial read-only synchronization starts automatically while signed
in, visible and online; CSV history requires import.

## Ownership and storage

| Data | Source and saved owner |
| --- | --- |
| Directory and Office-app activity | Application Graph; tenant generations of typed `directory_user_rows`, `directory_service_plan_rows`, `app_activity_rows` |
| Inventory | Graph application / Power Platform delegated collection; source-qualified `package_record_rows`, `power_platform_record_rows`, canonical agents |
| Official agent usage | Imported Agents, Users & agents, Users CSVs; immutable tenant-owned sets, versions and artifact membership |
| Office adoption | Saved directory/app evidence; frozen `office_observations`, `office_group_facts`, `office_person_facts` |
| Selections and cursors | Actor-bound read context over exact roots, query, revisions and expiry |
| Jobs, controls, exports and audit | API-owned execution, receipts and lifecycle state |

Delegated authority uses verified `(tenantId, MSAL homeAccountId)`, never report
usernames, guest resource IDs or names. Tenant sharing excludes tokens, sessions
and mutation authority.

## Current schema

[Current DDL](../backend/src/db/currentSchema.ts) and
[verification](../backend/src/db/schema.ts) define the only supported schema.
Initialize an empty database or verify this schema and runtime grants; startup
does not migrate incompatible installations.

`app_schema` fingerprints compiled SQL; changing the marker is not recovery.
The [operator](../backend/scripts/database.ts) and
[reset guard](../backend/scripts/databaseReset.ts) own installation/reset.
Runtime cannot own schema objects. Verification checks individual required
grants, immutable evidence, tenant-owned foreign keys and publication/clear
triggers; read grants do not satisfy write requirements.
See [reset operations](operations.md#reset-application-data).

## Publication and selected reads

### Collection boundaries

Writers require tenant/scope admission and persisted deadlines. Records stream
into awaited bounded writes; complete-generation and authority validation precede
transactional publication. JSON page receipts are separate from database batches.
Repeated continuations, conflicting identities and count mismatches reject
collection. Failed, partial, cancelled or unauthorized work cannot replace a
complete source.

Streaming directory, Office-app and inventory collection has no tenant-record,
page-count, wire-row or whole-response byte ceiling. Record work, safe-integer
counts, storage, backoff and deadlines remain bounded.
[Shared bounds](../backend/src/db/dataBounds.ts) do not replace operation-specific
limits.

| Resource | Bound |
| --- | --- |
| Ordinary database batch | 250 rows; 1 MiB of encoded PostgreSQL Bind parameters |
| Provider JSON record/scalar work | 16 MiB, not a whole-page limit |
| Saved inventory residual / agent element | 256 KiB / 4 MiB; a single element permits a 5 MiB transfer batch |
| Provider app-activity CSV record | 64 KiB |
| Generation reservation / tenant budget | 8 GiB / 64 GiB |
| Directory service-plan children | 1,000 per user |
| Native source roots / selection pins | 16 / 20 |
| Worker admission queue | 32 pending requests per database pool |
| Selected JSON pages | 1–100 rows, bounded bytes; endpoint-specific smaller pages |

Provider waits hold no database transaction. Recheck authority after pending work
and before publication; pre-commit cancellation rolls back. Confirmed commit
survives separately reported cleanup failure. Leases cannot outlive deadlines.

Collection is due every six hours; ordinary failure retries normally wait an hour,
subject to provider backoff. Missing sources, initial collection, newer-sign-in
authentication recovery, changed report inputs and explicit refresh have separate
eligibility rules. No manual enable or release approval is required.

### Authority and read leases

- Principal/session and source epochs fence revocation and explicit clears.
  Sign-out revokes old sessions, selections and unfinished writers, not complete
  retained sources. New authorized sessions can read shared saved evidence.
- Selections freeze actor, authorization, roots, query, revisions and expiry.
  Signed cursors continue that dataset; reads recheck dependency fences and
  database-clock expiry before returning.
- Safe replacement may preserve pinned reads. Explicit invalidation, revocation,
  source clears and expiry deny affected reads; unrelated publication need not.
  Observation age describes freshness, not deletion or renewed write authority.
- Filtering, ordering, counts and paging cover the complete selected dataset
  server-side. Children page independently; responses/browser state never
  materialize tenant-sized sources.

Selections last at most ten minutes, shortened by dependencies. Exports may
renew a live read lease, never revoked authority or expired execution dependencies.
Owners: [generations](../backend/src/db/dataGenerations.ts),
[inventory generations](../backend/src/db/inventoryGenerations.ts),
[selections](../backend/src/services/dataSelections.ts),
[user sources](../backend/src/db/userSources.ts) and
[sync coordination](../backend/src/services/dataSync.ts).

## Inventory and provider evidence

Canonical inventory reconciles exact identities, not names. Package-record and
logical-agent counts differ. All captured agent-capable native scopes participate
in membership checks; environment-only records are enrichment, not agents.
Canonical compaction preserves the compacted revision's captured source inputs,
not the inputs of a pending or failed reconciliation.

A completed, count-reconciled Power Platform catalog replaces that collector's
older observations within its requested resource types and environment filter.
Omitted in-scope records leave the current snapshot; this is not proof of
provider-side deletion. Other collectors' visibility, equally new or newer
observations, out-of-scope records and pinned history remain intact. Compaction
preserves the original catalog provenance. Failed or incomplete collection never
replaces the preceding snapshot. Automatic sync requires a complete unfiltered
agents-and-environments collection without unreconciled older observations from
that collector, so narrowed or incorrectly merged evidence is automatically
recollected without manual sync. A genuinely different collector's visibility
does not cause an endless automatic retry.

Automatic package-detail collection treats identity-revalidation flags as pending
even when descriptive details are fresh. Such batches use the existing
authoritative exact-read path to re-establish identity, rather than repeatedly
enriching descriptions while leaving identity invalidated. Failed reads retain
the preceding evidence and the normal retry cooldown.
Detail coverage and automatic target selection use the same complete, unexpired
catalog and validated published-generation checks. Exact-only or expired catalogs
do not start automatic enrichment; a successful scheduled catalog sync makes
eligible details available without an additional approval or enable step.

Absence, unavailable, null, zero and false stay distinct. Older complete evidence
can remain readable without current management authority. Configuration/provenance
comes from the captured member; detail cannot override invalid catalog authority.
Package hosts/types/categories reconstruct from saved child facts; full About
text uses bounded continuation. Search folding is not identity matching;
source-qualified/native/environment IDs retain exact bounds and normalization.
Source-reference lookups normalize Power Platform GUID casing and preserve exact,
case-sensitive opaque native IDs and Graph package IDs.

### Maker sharing and configuration

Power Platform's Preview `sharedWithViewers` and `sharedWithEditors` are separate
from Graph administrative availability/installation.

| Provider field | Saved field / meaning |
| --- | --- |
| `sharedWithViewers` | `details.makerSharing.viewers`: observed `entireTenant`, user/group counts |
| `sharedWithEditors` | `details.makerSharing.editors`: observed editor user/group counts |
| `isWebSearchEnabledForKnowledge` | Same name under `details` |
| `harness`, `titleId`, `instructionsCharactersCount` | Bounded `details` metadata, not instruction text |
| `componentsCounts` | Component/knowledge-type counts under `details` |
| `capabilitiesCounts.distinctFlows` | `details.distinctFlows` |
| `flows`, `triggers` | `details.flowReferenceCount`, `details.triggerCount`: array lengths, not definitions |
| ResourceItem `id` | `providerResourceId`, separate from native `name` identity |

`power_platform_record_rows.residual.details` retains sharing; nullable generated
`maker_org_wide_chat` separates reported true/false from absent/null.
Observations replace prior evidence, including omissions. Malformed typed values
reject collection; unknown fields are not raw-provider archives.

Graph retains observed `ownerId`, `agentIdentityId` and `providerUsage`
(`activeUsers`, `totalSessions`, `totalRunTimeInHours`, `exceptionRate`,
`lastUsedDateTime`): no established reporting window or verified exception-rate
unit, never a substitute for imported usage. New catalog evidence overrides
reused older detail telemetry.

Maker sharing is read-only, not proof of effective personal chat access.
Manage changes supported package/quarantine settings, not maker sharing;
Power Platform refresh, not Graph enrichment, observes maker changes.
See [provider contracts](provider-contracts.md).

## Official reports and user evidence

### Report sets and metrics

Agents, Users & agents and Users CSVs own reported usage; Office activity,
package telemetry, Defender and Purview cannot substitute. Companions validate before atomic
acceptance. Duplicates reuse content; changed ordinary imports create independent
sets. Corrections supersede targets; deleting a correction never revives its
original.

Parser `1` accepts `m365-agents-observed-v1`, `m365-users-agents-observed-v1` and
`m365-users-observed-v1`. The [import guide](official-usage-import.md#file-requirements)
defines headers, formats and per-file row/byte limits.

The default chooses the newest complete available report by reporting end, start,
acceptance time, then ID. Publication, deletion, expiry and report/inventory reads
reconcile it; personal selection does not mutate it.

| Evidence | Rule |
| --- | --- |
| Identity | Exact case-sensitive, dataset-scoped agent IDs/usernames; no guessed cross-report user identity |
| Dates | `activity_range` derives observed last-activity bounds; optional explicit metadata is `operator_asserted`, not inferred source refresh |
| Responses | Source totals stay separate; report headlines use Agents only |
| Active users | Exact positive-response identities deduplicated within the report/agent context; never add licensed and unlicensed categories |
| User recency | Users dates, not the agent-wide date in Users & agents |
| Missing evidence | Null/unknown, not zero or inferred substitute totals |

`OFFICIAL_USAGE_STALE_AFTER_DAYS`: default 35, integer 1–365; staleness considers
coverage-end and acceptance age. Unknown freshness does not prove a current
export. Overlapping snapshots cannot yield additive all-time activity or exact
daily differences; trends need compatible windows/cohorts.

| Import admission / retention | Rule |
| --- | --- |
| Upload streams per application process | Four total, two per tenant; database writer admission also applies |
| Upload deadline / draft expiry | 30 minutes |
| Unexpired file drafts | Nine per actor, 30 per tenant |
| Staged bytes | 1 GiB per actor and bundle; 2 GiB per tenant |
| Accepted report history | No default time expiry; shared payloads survive while retained sets reference them |
| Content-free acceptance receipts / minimal import audit | 180 / 90 days |

Cleanup bounds abandoned staging and unreferenced/deleted payloads.
History admission counts allocated sets/versions and reserved rows; reuse/retries
are not charged twice. Completed retries return their original result.
Owners: [imports](../backend/src/db/officialReportImports.ts),
[history](../backend/src/db/officialReportHistory.ts) and
[queries](../backend/src/db/officialReportQueries.ts).

### Directory entitlement and identity

Directory discovery finds tenant product candidates, then verifies effective paid
service-plan state.

| Paid service | Exact service-plan ID |
| --- | --- |
| `M365_COPILOT_APPS` | `a62f8878-de10-42f3-b68f-6149a25ceb97` |
| `M365_COPILOT_TEAMS` | `b95945de-b3bd-46db-8437-f2beb6ea2347` |
| `M365_COPILOT_BUSINESS_CHAT` | `3f30311c-6b1e-48a4-ab79-725b469da960` |

Assignment membership, per-product disabled plans and individual capability
evidence determine entitlement, not product names/catalog provisioning.
`enabled`, `warning` and `partially_enabled` qualify as active paid access;
unknown is not unpaid. Active assignments can qualify despite another disabled
source. Assignment timestamps preserve UTC precision.

Directory candidates plus verified active report identities are not tenant
headcount. Counts/continuations must reconcile; newly reported identities stay
unknown until automatic/explicit directory collection verifies them.

Match only unique exact trimmed, case-normalized UPNs/directory object IDs, never
ambiguous aliases, Unicode search folding, names or pseudonyms. Opaque report
identifiers preserve case; directory GUIDs canonicalize casing.

Office-app collection uses Graph v1.0 per-user detail CSV, `period='D28',version='v2'`.
Signed downloads require exact validated HTTPS hosts/paths and receive no Graph
bearer token. Activity dates, provider refresh, collection time and retained-row
provenance stay separate.

App evidence becomes stale above three whole days after refresh UTC end-of-day.
Dates stay visible; stale evidence cannot drive measured-activity/inactive-app
attention counts.

### Inventory associations and adoption

Automatic matching is **exact report Agent ID → full Graph package ID → existing
canonical agent → established native membership**, where present. It preserves
prefixes/case, calls no provider and writes no association.

Each Admin-reviewed association maps a report agent to one exact source-qualified
target within its set; canonical UUIDs are navigation only. Current source
authority, exact revisions and confirmation are required; association/success
audit commit together.
Mappings grant no permissions/management targets. Set deletion removes them;
principal cleanup preserves tenant-owned mappings.

Linked metrics count report identities once, deduplicating positive companion
usernames; missing companions leave distinct active users unknown.
Agent-adoption champions rank by responses, distinct positively used agents,
lowercase display name and exact identity:
at most three per group, qualifying through positive responses or agent use,
never creation/responsibility.

### API and CSV reads

Pages, details and export publication must share principal, selection, report
versions and source revisions. Rows are scalar; children page separately.

| Route family | Saved contract |
| --- | --- |
| `/api/copilot-usage/users` | Directory/entitlement, report metrics, counts and source coverage |
| `/api/copilot-usage/users/:objectId/{service-plans,agents}` | Independent children under the same selection |
| `/api/copilot-usage/users/:objectId/agent-relationships` | Used/created/owned/modified relationships; also requires pinned inventory selection |
| `/api/official-usage/{aggregate,users,agent-users,overview,history}` | Exact report or retained-history evidence; explicit scope does not fall back to history |
| `/api/agent-inventory/:recordId/usage-*` | Exact/reviewed usage under inventory selection and pinned retained history |
| `POST /api/data-exports` | Export job bound to displayed selection, dataset and applied filters |

Report-user CSVs include every relationship of matching users, or a row without
agent fields when none exist. Repeated user totals are not additive.
Use export status/download routes, not direct report `.csv` routes.
Parameters: [canonical API reference](mcp-reference.md#users-licensing-official-reports-cohorts-and-retained-history).

## Retained Office observations

Directory/license and D28/v2 app publication automatically derives Office evidence
locally. Recovery needs no Graph, agent CSVs, administrator session or page visit.
Derived failure is separate from healthy source publication.

| Generation | Saved evidence |
| --- | --- |
| `office_app_adoption`, selector `current` | Frozen person facts, organization/group metrics and provenance |
| `office_history` | One aggregate per tenant/UTC Monday-start week/D28/v2; no historical person records |

Person facts freeze identity, paid-feature context, company/department,
seven app dates and evidence reasons. Metrics use captured **paid-active** people;
other entitlement states remain coverage evidence.

| Metric | Definition |
| --- | --- |
| `savedLicensedPeople` | Captured paid-active denominator, not tenant headcount |
| `reportedActiveUsers` | People active in at least one of Word, Excel, PowerPoint, Outlook, OneNote, Loop or Teams |
| `perApp`, `activeUserAppPairs`, `appsUsed` | Overlapping people-per-app counts, their sum, and number of apps with positive counts |
| `noRecentEvidencePeople`, `unknownEvidencePeople` | No qualifying app date; unknown is a subset with evidence reasons |

Qualifying dates are refresh minus 27 days through refresh, inclusive. Chat,
Edge, overall last activity and agent usage do not contribute; user-app pairs
are not distinct people.

Capture requires current validated heads: directory under six hours old and
fresh, nonfuture D28 app evidence. Source/clear epochs, leases and tenant sync
mutex fence bounded exact-identity copies and atomic current/weekly publication.
Storage accounts for headers/children/groups. Evidence is immutable; history has
no source-generation read dependency.

Semantic replay preserves capture; newer evidence/corrections replace the week's
aggregate. Later licenses/departments never recompute older metrics.
Current-source staleness is separate; frozen metrics never age into zeroes.

History retains twelve UTC calendar months by refresh date, including cutoff day.
Directory/app clears fence history; source garbage collection does not erase it.
Remove dependent reads before bounded cleanup and storage-charge release.

`/api/office-app-adoption` has separate observation/baseline pins from agent reports/
inventory; all panels/pages must share selected context. Groups/people page
separately. App filters narrow people/suggestions, not paid denominators or seven
saved app totals; organization cards stay organization-wide.

Office Champs rank by positive app breadth, qualifying recency, normalized label
and exact identity, at most three per group. Historical person reads return
`office_history_aggregate_only`.
See [Office interpretation](copilot-license-usage.md#what-office-metrics-mean).
Owners: [capture/storage](../backend/src/db/officeAppAdoption.ts),
[metrics](../backend/src/services/officeAppAdoption.ts) and
[reads](../backend/src/services/officeAppAdoptionReads.ts).

## Browser saved-read cache

Authenticated caches are memory-only, scoped to account, roles, query, report and
publication revisions. Reuse never extends the server lease; logout/account
changes remove private context.

Renewal/retryable failures may retain visible rows with actual errors/dates.
Withdraw invalid/denied evidence. Facets, children, exports and mutations require
current successful selections, never expired display data. Late cancelled
responses cannot restore rejected evidence.

Focus/reload and lease renewal recapture saved data, not providers. Status
polling observes progress; it does not synchronize providers.

## Jobs, controls and audit

Jobs own execution/bounded outcomes; polling never dispatches, resumes or
reconciles. Expired initiating authority needs fresh same-principal authorization,
not the waking request's credentials.

Package/Studio controls require current exact identity, provider permission,
prestate, confirmation and readback. Unknown mutation outcomes reconcile
read-only before a separately confirmed retry. Receipts bind intent/evidence,
not extra business approval; pending receipts fence canonical publication.
Native control staging accepts GUID casing aliases so superseded receipts can
settle without rewriting the captured resource. Applying a quarantine receipt
still requires the case-exact native resource and matching current bot evidence.

Audit/local mutation commit together; audit failure rolls back, never rewrites
durable success. Append-only audit separates verified actor, `webapp|mcp|unknown`
origin, reported client labels and provider source, without cryptographic proof
against database administrators. Only Admin reads/exports it; Microsoft
investigation events remain separate.

## Lifecycle and recovery

Retention invalidates references before bounded cleanup; byte charges remain
until owned headers/facts disappear, provenance while referenced.
Current-schema backup/isolated restore verifies fingerprints/checksums, revokes
recovered authority and respects clears/supersession.

Database reset deletes saved reports, audit and jobs; provider sync cannot restore
imported CSV history. In-app saved-user/inventory clearing preserves accepted
reports. Maintenance pauses dispatch; normal installation/completed reset returns
to authenticated operation with automatic first-run sync.
See [operations](operations.md) and [security](security-model.md).
