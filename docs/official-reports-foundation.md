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

- one file of each required type;
- required headers;
- CSV structure and row limits;
- tenant and Admin authorization;
- complete storage before acceptance.

An exact duplicate selects the accepted report set without storing another copy.
Failed imports do not replace accepted data.

## Selection

Agents and Users read one selected report set at a time. Selection is scoped to
the tenant and authorized user.

Changing the selected set changes the displayed report data but does not delete
another set or trigger provider collection.

## Associations

Report agents and users are connected to inventory and directory records through
verified identifiers and reviewed associations.

- Unmatched report records remain visible.
- Names alone do not establish identity.
- Concealed identities remain unresolved.
- A changed source revision revalidates affected associations.

## Reads and exports

Report lists, details, filters, and exports use bounded database queries with
stable ordering and opaque cursors. Exports are created from the same authorized
selection as the displayed data.

## Deletion and retention

An Agent Control Admin can delete an accepted report set from
**Sync > Manage reports** after confirmation.

Deletion removes the selected set from use and retention removes unreferenced
content in bounded batches. Other accepted report sets remain available.

See [operations](operations.md#run-retention).
