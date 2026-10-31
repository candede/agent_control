# Saved-data architecture

The API owns provider collection, durable jobs, saved selections, report
calculations, exports and administrative audit. The browser reads these API
contracts; the implemented FastMCP service uses those same typed canonical
routes rather than querying PostgreSQL or Microsoft providers itself. The API
remains the business authority for both transports.

## Current schema

[Current DDL](../backend/src/db/currentSchema.ts) and the
[schema verifier](../backend/src/db/schema.ts) define one supported schema.
Initialization accepts an empty database or verifies that exact current schema
and runtime grants. An incompatible database is not converted during startup.
The [database operator](../backend/scripts/database.ts) and
[explicit reset guard](../backend/scripts/databaseReset.ts) own installation
and reset; see the [reset procedure](operations.md#reset-application-data).

The `app_schema` fingerprint identifies the compiled SQL contract. Compute it
from the artifact being deployed; a documentation hash or old release marker
is not a supported installation input. Backup and isolated restore also require
the current schema.

## Scope, publication and selection

- Delegated data uses the verified `(tenantId, MSAL homeAccountId)` principal.
  Report usernames, guest resource object IDs and display names do not establish
  that private key. Tenant-wide official reports retain separate source scope.
- Principal and source epochs fence revoked authority. Generations stage
  bounded records and child facts, then publish a complete head transactionally.
  Failed or partial collection does not replace the previous complete source.
  Inventory controls initialize first-use actor epochs before taking the shared
  principal fence and source locks; an absent row never stands in for a locked
  epoch-zero actor.
- Sign-out advances the principal authorization epoch, revokes sessions and
  cancels unfinished generations without invalidating complete saved sources.
  Revocation locks principal-owned scopes and heads before their generations,
  matching writer lock order to avoid deadlocks with in-flight refresh work.
  A new authenticated session captures new selections over those retained
  sources; old selections, exports and writers remain fenced. Explicit source
  invalidation and destructive resets still retire the affected saved data.
  Reviewed usage associations can use those retained current native publications
  after a new sign-in without recollection; source validity and authority-expiry
  checks still apply. Their database write guard uses the same live-source view
  as service reads and rejects expired effective identity authority or pending
  tenant control publication.
- Current directory, app activity, Graph package and Power Platform sources
  publish independently. Canonical inventory reconciles exact supported source
  identities, never display-name guesses. Reconciliation includes every captured
  agent-capable native scope; environment-only scopes remain enrichment inputs.
  Routine collection is due every six
  hours; ordinary failed attempts wait one hour, subject to provider backoff.
  Directory and app-activity retries use the latest attempt's cooldown even when
  the retained successful publication is less than six hours old.
  Initial collection, newer-sign-in recovery, changed report inputs and explicit
  refresh remain independently eligible.
- Automatic admission and setup readiness verify current, owned, validated saved
  publications. Historical success markers retain their counts and dates but do
  not postpone rebuilding missing or invalidated sources. Successful-attempt
  cadence does not delay this recovery; failed-attempt cooldowns still apply.
- Tenant source collection conflicts apply only to newly admitted work.
  Equivalent starts join the account's existing active run without recollection;
  retries check only the incomplete sources selected for that attempt.
- Validated current source generations remain readable when their observation
  dates age. Original collection/expiry timestamps are preserved; age describes
  freshness, not disappearance or renewed provider authority. Replacement,
  explicit invalidation, privacy deletion and real ownership fences still apply.
- A saved selection binds its principal, authorization, source roots, revisions
  and expiry. Cursors continue that selection, not a newly captured dataset.
  Name-page candidates apply the inventory scope before the page limit;
  enrichment-only environment rows cannot consume Power Platform-only agent pages.
  Unrelated publication does not invalidate every selected view.
  The 16 native-source limit is separate from the 20 selection-pin limit, which
  also accommodates the canonical root and report, directory and people-cache
  dependencies.
- Source-qualified inventory filters and exact-detail reads share a
  10,000-character encoded record-ID bound; each decoded native identity remains
  limited to 512 characters. Facet and responsibility searches are endpoint-local,
  may be empty, and never change the captured inventory filters.
- Safe replacement keeps valid pinned reads until their own fences close.
  Revocation, privacy deletion, invalidated source scope and selection expiry
  deny affected reads. Readable retained history never grants mutation authority.
  Selected reads recheck their lease and actual dependency fences using the
  database clock after their callback finishes, before committing the result.
  A live export can extend the page TTL, never revoked authority or an expired
  execution dependency. Source observation age alone does not close saved reads.
- Collection, reconciliation, retention and exports use bounded batches and
  existing resource limits. No provider wait owns a database transaction.
  Background inventory sweeps do not inherit the waking request's credentials;
  each principal's publication uses its own retained initiating authority.
  Revocation stops that principal's work without interrupting unrelated retention.
  Pending canonical reconciliation counts toward its tenant queue limit while
  its deadline and input epochs remain valid, even when source observations age.
  Initial and renewed writer leases are capped at the persisted deadline, so
  expired work stops occupying ingestion admission before its first heartbeat.
  Worker generation admission holds at most 32 pending requests per database
  pool. Waiting requests expire at their original deadlines independently of
  retry backoff or another request's SQL admission. An in-flight admission stays
  owned until it settles; any late lease is released before cancellation or
  deadline rejection, and release failures retain both causes.
- Agent-person cache writes check cancellation before connection acquisition
  and recheck cancellation and current caller authority immediately before commit,
  after their database publication fences and transaction bookkeeping finish.
- Long-running browser inventory and user syncs silently revalidate the
  initiating Microsoft identity before role evidence becomes stale. Actual
  interaction requirements, changed roles and revoked sessions stop collection;
  bearer assertion freshness is never extended. Finished or orphaned sync runs
  release their active slot so a subsequent signed-in automatic check can
  recover eligible sources without a manual resume or replaying a data reset.

Implementation owners:
[generations](../backend/src/db/dataGenerations.ts),
[inventory generations](../backend/src/db/inventoryGenerations.ts),
[inventory queries](../backend/src/db/inventoryQueries.ts),
[user sources](../backend/src/db/userSources.ts) and
[sync coordination](../backend/src/services/dataSync.ts).

## Browser saved-read cache

TanStack Query retains authenticated in-memory Users, overview and adoption
pages, with a fifteen-minute maximum reuse window and one-hour inactive
retention. Inventory families and inactive report pages remain bounded; at most
sixteen inactive report pages are retained. The server read lease, at most ten
minutes, is always the earlier authority boundary. Expired handles are recaptured
from PostgreSQL without recollecting providers or blanking the previous rows.
Focus checks and explicit reloads read saved data, not Microsoft.
Completed adoption history and its dashboard panels stay mounted while a
replacement history is collected. Expired display data never supplies selection
handles to facets, exports or other child reads; those follow the renewed handle.

Transient read failures keep the last successful top-level rows and their real
error. Account/role/session changes, denied access, invalid data and rejected
selections withdraw affected evidence. The cache is not persisted through
logout. Exact details, snapshot inspection, management evidence and volatile
job/permission/progress reads keep their separate current-read contracts;
retained display data cannot authorize an export or mutation.

Healthy idle collection checks and inventory health reads run every five minutes.
First-run and active work use faster status checks; unavailable health retries
after thirty seconds. Status polling is not provider synchronization.
Health reads release their temporary selection before responding. If a read
and its selection cleanup both fail, the read error remains the response and
the cleanup failure is recorded separately; cleanup failure alone prevents a
successful response.

## Inventory and provider evidence

The catalog, additional Power Platform and combined inventory views share the
same canonical source model. Package records and logical agents are distinct
counts. Source absence, unavailable metadata, explicit null, zero and false
must remain distinguishable.

Verification checks every visible member's selected source scope, not only the
preferred Graph and Power Platform observations. Missing, incomplete, invalidated
or future source evidence requires attention even while reconciliation is running.
Complete older saved observations remain readable, including their successfully
collected identity links; elapsed observation dates cannot create duplicate agents
or convert a completed identity check back into missing data.
Native identity matching and agent-person reference discovery include every
requested resource type still present in current membership, even when the latest
collection queried only a subset of types or returned no new records.
API observations and full-source CSV rows apply the same catalog authority checks:
detail evidence cannot be current when its catalog observation is not current.
Healthy superseded sources may be shown as updating, without changing their
strict current or partial flags.

Exact source membership authorizes About/configuration reads. Full available
About text has bounded continuation; short table/adoption previews are not a
substitute for that complete text. Source references and provenance identify
the observed field, provider maturity and observation time in the API. The agent
Overview automatically loads the complete description without a load-more control
or an inline provenance/byte-count strip.

Package detail reads reconstruct saved hosts, element types and categories from
child facts, preserving absent versus empty collections and the source reference
used for complete About text. Package-source pages also reconstruct hosts and
element types with their saved source reference; categories remain detail-only.
Detail enrichment preserves catalog-owned summary
text, including chunked text; incompatible detail reads also retain the prior
description and sharing collections while marking detail evidence invalidated.
Inventory and facet searches share Unicode
normalization and case folding; facet cursors bind the normalized search.
Package projection retains only own observation fields and copies provenance and
local annotations so caller mutations cannot alter the projected observation.
Exact inventory/usage IDs and export/control reference lists are captured before
asynchronous selection acquisition or batched resolution. Later caller changes
cannot replace submitted IDs or bypass the exact-request limits.

### Maker-controlled sharing and captured agent configuration

Power Platform's documented Preview
[`sharedWithViewers` and `sharedWithEditors`](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-agent-inventory)
are retained separately from Graph administrative availability/installation.

| Provider field | Saved native field | Meaning |
| --- | --- | --- |
| `sharedWithViewers` | `details.makerSharing.viewers` | Preview `entireTenant`, `userCount`, `groupCount` |
| `sharedWithEditors` | `details.makerSharing.editors` | Preview editor user/group counts |
| `isWebSearchEnabledForKnowledge` | `details.isWebSearchEnabledForKnowledge` | Exact provider spelling |
| `harness`, `titleId`, `instructionsCharactersCount` | Same names under `details` | Bounded observed metadata, not instruction text |
| `componentsCounts` | `details.componentsCounts` | Observed component counts and bounded knowledge-type counts |
| `capabilitiesCounts.distinctFlows` | `details.distinctFlows` | Observed nonnegative count |
| `flows`, `triggers` | `details.flowReferenceCount`, `details.triggerCount` | Array lengths, not unverified item definitions |
| ResourceItem `id` | `providerResourceId` | Resource path, separate from native `name` identity |

Sharing lives in `power_platform_record_rows.residual.details`; the generated
nullable `maker_org_wide_chat` column exposes reported true/false, with SQL NULL
for an absent/null tenant flag. Residual evidence retains finer missing,
empty-object and null distinctions. New observations replace earlier evidence,
including when a field is omitted. Malformed typed evidence rejects collection;
unknown object members are not retained as raw provider archives.

Graph separately retains observed `ownerId`, `agentIdentityId` and
`providerUsage` counters: `activeUsers`, `totalSessions`,
`totalRunTimeInHours`, `exceptionRate`, `lastUsedDateTime`. These do not establish
a reporting window or verified exception-rate unit. They never replace imported
report usage, associations or report metrics. New catalog observations take
precedence over reused older detail telemetry; omitted new values do not revive
old counters.

Maker sharing is read-only. It does not prove effective personal chat access,
which can depend on licensing, authentication, quarantine and administrative
restrictions. Manage edits supported administrative package/quarantine settings,
not maker sharing. Refresh Power Platform inventory to observe maker changes;
Graph package-detail enrichment alone does not update this evidence.
See [provider contracts](provider-contracts.md).

## Official reports and user evidence

The Agents, Users & agents and Users CSV exports are the authority for reported
agent usage. Defender, Purview, package telemetry and app activity are separate
evidence sources and cannot replace those reports.

Imports validate and stage content before atomic publication. Exact duplicates
reuse retained content; failed imports do not replace accepted reports.
The first complete accepted set is selected automatically. Later imports keep
the existing shared choice, including an intentionally empty choice. Selecting
or deleting a report requires the existing Admin preview/confirmation flow.

Directory identity, paid-license state, report association and responsibility
are independent facts. Unknown licenses are not unpaid licenses; report-only
identities are not guessed directory matches. Champions use the existing
top-three ranking from saved created-agent, response and association evidence.
Trends require comparable source windows and cohorts; overlapping snapshots
cannot be summed into activity totals.

Adoption search waits for 300 ms of settled input before capturing a selected
read. No-op report-history expiry checks do not take exclusive scope locks;
actual expiry is rechecked under the existing write locks before invalidation.

Implementation owners:
[imports](../backend/src/db/officialReportImports.ts),
[history](../backend/src/db/officialReportHistory.ts) and
[queries](../backend/src/db/officialReportQueries.ts).
See [import and report semantics](official-usage-import.md) and
[user/license semantics](copilot-license-usage.md).

## Jobs, controls and audit

Jobs own execution state and bounded item outcomes. Polling reads saved state;
it does not dispatch, resume or reconcile work. Expired ephemeral credentials
require fresh same-principal authorization. A sent-but-unknown mutation must be
reconciled read-only before any separately confirmed retry.

Package and Studio controls require exact current identity, real provider
permission, current prestate, confirmation and readback. Generic controls reuse
those same provider effects. Receipts bind the exact intent and source evidence;
they are not a separate business approval.

Package control readbacks compare identity with validated current saved membership
even after its observation expires; this comparison does not renew live provider
authority. Actor-private receipt conflicts survive consecutive controls before
asynchronous projection, until a newer identity-detail read supersedes them.
Recovery discovers both package and Studio pending receipts independently of the
last source publisher. Orphan cleanup retains the receipt's actor scope even when
another actor supplies current tenant authorization. A replacement Studio receipt
updates its queued actor as well as its observation. Canonical discovery, claims
and publication wait for all tenant control receipts to settle, with transactional
checks under the same tenant lock used by receipt writers.

Administrative audit separates the verified actor, `webapp|mcp|unknown` origin,
reported client/agent labels and provider source. Unknown historical Microsoft
events and unknown attribution remain explicit; neither is inferred into a
verified action. Audit is append-only application data, not cryptographic proof
against database administrators.
Only Admin can read/export local administrative audit history or see its
Audit tab/page. Viewer and Usage Report Uploader have no direct UI/API access;
recording is unchanged and remains separate from Microsoft Purview searches.

## Lifecycle and recovery

Only actual maintenance pauses dispatch. Normal installation, completed reset
or reviewed restore returns to normal authenticated operation. Initial read-only
synchronization starts automatically while signed in, visible and online.
Explicit hunts/searches run under current permissions and configured sharing,
without an earlier qualification query.

Retention invalidates affected references before bounded physical cleanup.
Inventory catalog, detail and control generation metadata remains retained while
stored records reference it, even after the original content is collected.
Indexed provenance checks preserve freshness and identity evidence until those
references are released.
Backup/restore checksums and table fingerprints establish the saved snapshot;
restore revokes recovered authority and compares current ownership before
reopening. Reset deliberately deletes saved reports, audit and jobs: provider
resync cannot recreate imported CSV history.
See [operations](operations.md) and [security](security-model.md).

### Local lifecycle fixture checks

Run `npm test --workspace backend -- scripts/savedReadBrowserFixture.unit.test.ts`
from the repository root for infrastructure-free fixture checks. Mocked server
and database boundaries cover overlapping setup, pending-work cleanup, startup
errors, required initial canonical publication, and propagation of unexpected
provider failures. Only the deliberately injected replacement failure is
accepted as the failed scenario. These checks do not replace the isolated
PostgreSQL-backed `savedBackendLifecycle.spec.ts` browser journey.
