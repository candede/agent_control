# Saved-data architecture

The API owns provider collection, durable jobs, saved selections, report
calculations, exports and administrative audit. The browser reads these API
contracts; the future MCP service must use the same contracts rather than
querying PostgreSQL or Microsoft providers itself.

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
- Current directory, app activity, Graph package and Power Platform sources
  publish independently. Canonical inventory reconciles exact supported source
  identities, never display-name guesses.
- A saved selection binds its principal, authorization, source roots, revisions
  and expiry. Cursors continue that selection, not a newly captured dataset.
  Unrelated publication does not invalidate every selected view.
- Safe replacement keeps valid pinned reads until their own fences close.
  Revocation, privacy deletion, invalidated source scope and selection expiry
  deny affected reads. Readable retained history never grants mutation authority.
- Collection, reconciliation, retention and exports use bounded batches and
  existing resource limits. No provider wait owns a database transaction.

Implementation owners:
[generations](../backend/src/db/dataGenerations.ts),
[inventory generations](../backend/src/db/inventoryGenerations.ts),
[inventory queries](../backend/src/db/inventoryQueries.ts),
[user sources](../backend/src/db/userSources.ts) and
[sync coordination](../backend/src/services/dataSync.ts).

## Inventory and provider evidence

The catalog, additional Power Platform and combined inventory views share the
same canonical source model. Package records and logical agents are distinct
counts. Source absence, unavailable metadata, explicit null, zero and false
must remain distinguishable.

Exact source membership authorizes About/configuration reads. Full available
About text has bounded continuation; short table/adoption previews are not a
substitute for that complete text. Source references and provenance identify
the observed field, provider maturity and observation time in the API. The agent
Overview automatically loads the complete description without a load-more control
or an inline provenance/byte-count strip.

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

Administrative audit separates the verified actor, `webapp|mcp|unknown` origin,
reported client/agent labels and provider source. Unknown historical Microsoft
events and unknown attribution remain explicit; neither is inferred into a
verified action. Audit is append-only application data, not cryptographic proof
against database administrators.

## Lifecycle and recovery

Only actual maintenance pauses dispatch. Normal installation, completed reset
or reviewed restore returns to normal authenticated operation. Initial read-only
synchronization starts automatically while signed in, visible and online.
Explicit hunts/searches run under current permissions and configured sharing,
without an earlier qualification query.

Retention invalidates affected references before bounded physical cleanup.
Backup/restore checksums and table fingerprints establish the saved snapshot;
restore revokes recovered authority and compares current ownership before
reopening. Reset deliberately deletes saved reports, audit and jobs: provider
resync cannot recreate imported CSV history.
See [operations](operations.md) and [security](security-model.md).
