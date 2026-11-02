# Microsoft 365 usage report import

Import the **Agents**, **Users & agents**, and **Users** CSV exports from the
Microsoft 365 admin center to see reported agent activity in Agent Control.
Export all three for the same reporting period.

Automatic inventory, license and Office-app synchronization is separate. Missing
agent CSVs do not prevent those sources from syncing or saved data from opening.

## Required access

Viewers can read saved reports. Usage Report Uploaders and Admins can import new
sets; only Admins can correct or delete published sets. Uploaders can discard
their own unaccepted drafts. Importing uses no Microsoft token.

Downloading the original user-level reports requires **Reports Reader** or
**AI Administrator** on the exporting Microsoft account. Agent Control app roles
do not grant that access. See the canonical
[roles and permissions reference](user-roles-and-permissions.md#csv-downloads-and-report-import).

## Export the files

1. Open the Microsoft 365 admin center.
2. Go to **Reports > Usage > Microsoft Copilot > Agents**.
3. Select a 7-day or 30-day reporting period.
4. Export the **Agents**, **Users & agents**, and **Users** tables as CSV.
5. Keep the original files until Agent Control confirms the import.

If names are concealed, a Global Administrator can change the report privacy
setting under **Settings > Org settings > Services > Reports**. Export fresh
files afterward. Concealed identifiers are not guessed back to people.

Microsoft documents this source in the
[Copilot Agents usage report](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide).

## Import the files

1. Open **Sync > Add CSV reports**.
2. Drop the three original files into the dialog or choose them with
   **Choose CSV files**. Companions can be added in separate picker operations.
3. Check each file's detected type and row count. Replace rejected or missing
   companions without removing valid files.
4. When all three types validate, select **Import reports**.
5. Review **Reports imported**, then select **Close** to return to Sync or
   **Add more reports** for a fresh upload.

No dates or source metadata need to be entered. The server identifies report
types from their headers, not filenames. A second file of an already selected
type is rejected; cancel and reopen the dialog to replace the whole draft.

All three companions publish together. An exact duplicate reuses the saved set
without changing its acceptance time. Changed content normally creates an
independent set, even for an already imported period; an explicit correction
instead supersedes its target.

The success summary describes the exact saved set. **Agents** and **Users** count
their CSV records, including zero-response records; **Responses** uses the Agents
CSV only. These are not inventory, licensed-user or active-user counts.

If saving succeeds but the confirming read fails, use **Verify saved import**.
If acceptance is uncertain, use **Verify acceptance**, not another upload.
**Close saved import** keeps the saved result without claiming verification
succeeded. Cancelling an unaccepted draft asks for confirmation; published
reports are not undone by closing the dialog.

## View and select reports

| Workspace | Use it for |
| --- | --- |
| **Agents** | Inventory-linked usage, agent trends and reported-user drilldowns |
| **Users** | Paid entitlement, reported user activity and adoption |
| **Dashboard** | Adoption changes across retained reports |
| **Sync > Manage reports** | Saved report sets, exact snapshot inspection and deletion |

### Choose the report set shown in Agents and Users

The **Report set** dropdown is available to every Viewer-capable role. A choice
is personal and carries between Agents and Users, including Adoption. It does
not change the tenant default, other readers' choices or collection permissions.
Bookmarks and browser Back/Forward preserve the `snapshot` choice.

**Latest report** follows the newest complete, available content by reporting end
date, then start date; acceptance time and report ID break ties. Uploading an
older backfill does not replace newer content. Deletion or expiry falls back to
the next eligible set. Superseded corrections do not revive automatically.

Returning to **Latest report** removes the personal pin. A deleted or expired
personal report returns to Latest with a notice; permission or service failures
remain errors, not evidence that the report was deleted.

### Manage retained reports

Open **Sync > Manage reports** to page through saved sets by activity dates and
status. **Current** identifies the automatic default. Select **View report** to
inspect an exact snapshot, then search and sort its **Agent comparison** table.
**Report quality & sources** contains provenance, warnings and source differences.

Manage reports is not a cross-import agent search. For an inventory agent's
retained comparisons, open its **Usage** tab. Its **Users** tab starts with the
newest retained report, independently of the table's personal choice; when an
older report contains that agent, **View this period** changes only that dialog.

Deleting a published set requires Admin confirmation. It does not prevent a fresh
import of those files later. Importing does not delete earlier accepted sets.
In-app **Reset saved data** clears saved users and inventory, not accepted
reports; an operator database reset is different and deletes imported history.

## File requirements

Keep the original headers. Matching ignores case and surrounding whitespace;
missing, duplicate or additional columns are rejected.

| Export | Required headers |
| --- | --- |
| Agents | Agent ID; Agent name; Creator type; Active users (licensed); Active users (unlicensed); Responses sent to users; Last activity date (UTC) |
| Users & agents | Agent ID; Agent name; Creator type; Username; Responses sent to users; Last activity date (UTC) |
| Users | Username; Display name; Number of agents used; Agent responses received; Last activity date (UTC) |

| Value | Accepted meaning and format |
| --- | --- |
| Encoding | Valid UTF-8, with or without a BOM; quoted CSV fields are supported |
| Identifiers | Nonblank, case-sensitive Agent ID/Username; no embedded control characters, including tabs or line breaks |
| Names and creator types | May be blank; quoted display text may contain tabs and line breaks |
| Counts | Non-negative safe integers; comma-separated groups of three digits are accepted; blank and `null` are not zero |
| Activity dates | Real UTC calendar dates, using English month names or year-first `YYYY-MM-DD` / `YYYY/MM/DD`; blank means unknown |

Text is trimmed, not case-folded or compatibility-normalized into a different
report identity. Unsupported controls, invalid Unicode, impossible dates and
mixed date separators are rejected. Validation errors identify logical CSV rows
(header is row 1); a quoted multiline field is still one row.

### Reporting dates and freshness

These CSVs do not contain reporting-period or source-refresh metadata.
Agent Control imports every row and derives the available last-activity range,
labelled `activity_range`. It is **observed activity coverage**, not a verified
reporting window or proof of continuous daily coverage.

Different companion files can have different activity ranges. Undated reports
remain importable with unknown coverage. Without source period metadata, the
app cannot prove that unrelated exports came from the same reporting selection.
Always export all three together.

Import time is provenance, not a usage date. Source refresh remains unknown;
neither filenames nor upload times establish freshness. API clients can supply
explicit period/source metadata, labelled separately as `operator_asserted`;
the import dialog does not ask for it.

## Interpret reported usage

| Measure | Interpretation |
| --- | --- |
| Licensed / unlicensed active users | Independent Microsoft source categories. A license change can put one person in both; do not add them. |
| Per-agent distinct active users / **Users with responses** | Exact distinct Users & agents identities with positive responses. No companion rows for that agent means Unknown; explicit zero-response rows yield zero active users. |
| Tenant active users | Distinct positive-response usernames from Users and Users & agents within one report set |
| Active agents | Distinct positive-response Agent IDs from Agents and Users & agents, not an inventory count |
| Responses | Agents, Users & agents and Users retain separate totals. Headline report responses use Agents only, not a sum of the three. |
| Number of agents used | Users-report source total, compared with distinct positive-response relationships; zero-response relationships remain visible |
| User last activity | Comes from Users. The date on a Users & agents row describes the agent's last use by anyone, not that named user's recency. |
| Missing metrics | Unknown, not zero activity, no license, or blocked access |

Source differences remain visible rather than overwriting one report with
another. Bridge-only users and report-only agents are still evidence, but missing
Users/Agents totals are not replaced with relationship sums. Report identifiers
are dataset-scoped; names and anonymized usernames do not establish identity
across reports.

The Agents **last 30 days** usage measure requires positive responses and an
agent activity date from UTC today minus 29 days through today in the selected
report. It does not use import time; missing or stale exports can understate use.

These reports measure **Copilot Agents**, not all paid Copilot use. Low or zero
agent responses do not prove an unused license. Review effective paid entitlement,
Office activity and business need before any license decision.

### Adoption dashboard

**Dashboard > Agent adoption** compares complete retained report sets independently
of the report selected on Agents or Users. Its default baseline is the earliest
dated observation. Choose another baseline for a personal comparison.

Charts show reported snapshots, not daily events. Overlapping exports cannot be
added or subtracted to obtain exact interval usage. A zero baseline permits an
absolute change, not an infinite percentage; unequal explicit window lengths or
identical end dates do not receive a directional comparison.

Undated reports retain their counts but establish no chronological direction.
Deleted, superseded, expired or damaged reports do not contribute. Missing
reports are not zero-use periods, and today's licenses are not historical
adoption denominators.

### Matching usage to inventory

Automatic matching compares the complete, case-sensitive report Agent ID with a
saved Graph package ID, including any `T_` or `P_` prefix, then uses that package's
existing canonical inventory membership. It does not guess by name, strip
prefixes or treat a native Power Platform GUID as a package ID.

No per-agent approval is needed for an exact match. Admin-reviewed associations
are explicit overrides for one report set and native source; they are not
inherited by a later report. Unmatched report rows remain browsable. Matching
usage never grants management access or creates a native agent.

### CSV exports

CSV downloads use the verified displayed report and filters, across all matching
results—not just the visible page. Filtering, sorting and pagination are
server-side saved-data operations, without provider calls.

A report-user download includes **all relationships of matching users**, even
when an agent or creator filter selected those people. Users without
relationships retain a row with empty agent fields. User-level totals repeat
on relationship rows: do not sum them as per-agent counts.

## Limits and retention

| Boundary | Limit |
| --- | --- |
| Each file | 256 MiB |
| Users | 100,000 rows |
| Agents | 200,000 rows |
| Users & agents | 1,000,000 rows |
| Each field | 4 KiB, with additional field-specific validation |
| Unaccepted staging | 30 minutes |
| Accepted reports | Retained until explicit deletion; importing is not a replacement policy |

Empty lines are ignored. A file exceeding its limit is rejected, not truncated.
Abandoned drafts expire; deleting accepted reports remains a separate operation.
For storage quotas, publication and operator cleanup, see
[saved-data architecture](data-architecture.md#official-reports-and-user-evidence)
and [retention operations](operations.md#run-retention).

## Troubleshooting

| Problem | Action |
| --- | --- |
| Export is unavailable in Microsoft 365 | Check the exporting account's [report access](user-roles-and-permissions.md#csv-downloads-and-report-import), not its Agent Control app role. |
| Names are concealed | Have a Global Administrator review the Microsoft report privacy setting, then export fresh files. |
| File type is not recognized | Use an original export with exactly the supported headers. |
| A companion fails validation | Replace that missing/rejected kind; valid companions stay selected. A duplicate kind requires cancelling and reopening to replace the whole draft. |
| Import is denied | Check the signed-in Agent Control app role. Correction drafts require Admin, including when content is reused. |
| Usage appears only in reports | Refresh inventory if needed; check the exact package identity or an explicit reviewed association, not name similarity. |
| Saved data is stale or unknown | Inspect report dates and source details. Rereading an unchanged CSV cannot supply missing provider activity. |

### Failure recovery

- **Uncertain acceptance:** replay **Verify acceptance** for the original intent.
  Do not create another import just to find out whether the first saved.
- **Saved result could not be read:** use **Verify saved import**, or close while
  retaining the saved result. A failed verification is not a failed publication.
- **Definite stale validation:** refresh bundle validation before importing again.
- **Expired draft:** stage the original files again; re-export if fresher evidence
  is needed.
- **Cancellation/cleanup failed:** retry cleanup for that draft. Leaving the page
  does not undo a mutation already submitted.

For license and Office-app interpretation, see
[Copilot licenses and usage](copilot-license-usage.md). API consumers should use
the [canonical report contracts](mcp-integration.md#users-licensing-official-reports-cohorts-and-retained-history).
