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
current. A failed refresh keeps the last successful result available and records
the new failure separately.

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

Retention removes expired sessions, evidence, jobs, snapshots, uploads, exports,
and audit data in bounded batches. Accepted usage reports remain until an Admin
deletes them.

See [operations](operations.md#run-retention).

## Backup and recovery

Backups include a checksum and schema fingerprint. Restore creates an isolated
review database, clears active session and provider authority, and requires
operator review before reopening.

See [operations](operations.md#back-up-a-local-installation).
