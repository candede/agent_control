# Microsoft 365 usage report import

Import reports to see agent responses, reported users and adoption trends in
**Agents**, **Users** and **Dashboard**. You need the Microsoft 365 **Agents**,
**Users & agents** and **Users** CSVs for the same **7-day or 30-day** selection.

## Required access

| Task | Required access |
| --- | --- |
| Export from Microsoft 365 | **Reports Reader** or **AI Administrator**; **Usage Summary Reports Reader** lacks user details |
| Import into Agent Control | `AgentControl.UsageReportUploader` or `AgentControl.Admin`; no Microsoft token or separate Admin approval |
| Read saved reports | Any Viewer-capable app role |
| Correct or delete published reports | `AgentControl.Admin` |

App roles do not grant Microsoft report access.
[Role details](user-roles-and-permissions.md#csv-downloads-and-report-import).

**Office-app activity is separate:** automatic collection uses Microsoft Graph's
**application** permission `Reports.Read.All`, not these CSVs. Read-only sync
starts after sign-in; missing agent reports do not block Office, inventory or
license sync. See [Copilot licenses and usage](copilot-license-usage.md).

## 1. Export the files

1. In the Microsoft 365 admin center, open
   **Reports > Usage > Microsoft Copilot > Agents**.
2. Select **7 days** or **30 days**, then export the **Agents**,
   **Users & agents** and **Users** tables for that same selection.
3. Keep the original `.csv` files until Agent Control confirms the import.

If names are concealed, ask a Global Administrator to review
**Settings > Org settings > Services > Reports**, then re-export.
Concealed identifiers are not guessed back to people.
[Microsoft's export guide](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide).

## 2. Import the files

1. Open **Sync > Add CSV reports**.
2. Drop the files into the dialog or select **Choose CSV files**.
   You can add companions in separate picker operations.
3. Check each detected type and row count. Add missing or rejected files;
   valid companions stay selected.
4. When all three types validate, select **Import reports**.
5. Wait for **Reports imported**, review the summary, then select **Close**.
   **Add more reports** starts a fresh upload.

All three save together; no dates need to be entered. Types are detected from
headers, but files must end in `.csv`. To replace a valid file, cancel and reopen
the dialog; duplicate types are rejected. Cancelling uploaded drafts asks for
confirmation. Closing does not undo a saved import.

## 3. Use the reports

| Workspace | Use it for |
| --- | --- |
| **Agents** | Inventory-linked usage; **Usage** for retained comparisons, **Users** for reported users |
| **Users** | Reported activity alongside paid entitlement and adoption |
| **Dashboard > Agent adoption** | Trends across saved reports; choose a comparison baseline |
| **Sync > Manage reports** | **View report** opens the saved **Agent activity** report, including per-agent comparisons |

### Choose the report set shown in Agents and Users

**Report set** is a personal choice shared between Agents and Users, including
Adoption. It does not change other readers or the tenant default.
**Latest report** follows the newest complete, available content by end date,
then start date, with import time and report ID breaking ties. Older backfills
do not displace newer reports. Select Latest to clear a pin; a deleted or expired
choice returns to Latest with a notice.

An agent's **Users** tab starts with the newest retained report, independently
of the table choice; **View this period** changes only that dialog.

## 4. Verify the import

1. In **Reports imported**, check **Agents** and **Users**: these count CSV rows,
   including zero-response rows, not inventory or active users.
   **Responses** totals the Agents CSV only.
2. Open **Sync > Manage reports > View report** for the saved set. Check activity
   dates and warnings, then expand **Report sources** for source details.
3. Select that **Report set** in Agents or Users to check activity.
   Unmatched agents remain browsable in the report.

**Observed activity** dates come from last-activity values, not a verified
reporting window. Companions can have different ranges; undated reports have
unknown coverage. The CSVs contain no period or source-refresh metadata:
filenames and import time prove neither freshness nor that the exports share
a reporting selection.

## File requirements

Keep the original headers; their order may vary. Header matching ignores case
and surrounding whitespace, but missing, duplicate or extra columns are rejected.

| Export | Required headers | Row limit |
| --- | --- | --- |
| Agents | Agent ID; Agent name; Creator type; Active users (licensed); Active users (unlicensed); Responses sent to users; Last activity date (UTC) | 200,000 |
| Users & agents | Agent ID; Agent name; Creator type; Username; Responses sent to users; Last activity date (UTC) | 1,000,000 |
| Users | Username; Display name; Number of agents used; Agent responses received; Last activity date (UTC) | 100,000 |

| Value | Requirement |
| --- | --- |
| Encoding | Valid UTF-8, with or without a BOM; quoted CSV fields supported |
| Identifiers | Nonblank, case-sensitive Agent ID/Username; no embedded controls, tabs or line breaks |
| Names and creator types | May be blank; quoted display text may contain tabs and line breaks |
| Counts | Non-negative safe integers; quoted thousands such as `"1,000"` accepted; blank and `null` are not zero |
| Activity dates | Real UTC dates: English month names, `YYYY-MM-DD` or `YYYY/MM/DD`; blank means unknown |

Maximum **256 MiB per file**, **4 KiB per field**, with tighter field-specific
limits. Text is trimmed; identifiers retain their case. Empty lines are ignored.
Invalid values or exceeded limits reject the file, not truncate it. Error rows
count CSV records (header is row 1), not physical lines within quoted fields.

## Interpret reported usage

| Measure | Interpretation |
| --- | --- |
| Licensed / unlicensed active users | Overlapping Microsoft categories; a license change can put one person in both. Do not add them. |
| Per-agent **Active users** | Distinct Users & agents identities with positive responses. No relationships means Unknown; explicit zero-response rows mean zero. |
| Tenant active users | Distinct positive-response usernames from Users and Users & agents within one set |
| Active agents | Distinct positive-response Agent IDs from Agents and Users & agents, not inventory totals |
| Responses | Separate CSV totals. Headlines use Agents only; do not add totals or substitute relationship sums for missing source totals. |
| Number of agents used | Users-report total, compared with distinct positive-response relationships; zero-response relationships remain visible |
| User last activity | From Users. A Users & agents date describes the agent's last use by anyone, not that named user's recency. |
| Missing metrics | Unknown—not zero use, no license or blocked access |

Agents **Reported active · 30 days** requires positive responses and an activity
date from UTC today minus 29 days through today, not a recent import. Activity
date filters select agents by last activity; responses remain full-report totals.
Stale exports can understate use. Low agent responses do not prove an unused
Copilot license: review paid entitlement, Office-app activity and business need.

### Matching usage to inventory

Matching compares the complete, case-sensitive **Agent ID** (including `T_`/`P_`)
with a saved Graph package ID and its inventory membership—not a name or native
Power Platform GUID. Exact matches need no approval; Admin-reviewed overrides
apply to one report set only. Matching never creates agents or grants management
access. Names and anonymized usernames do not establish cross-report identity.

### CSV exports

Downloads cover all filtered results, not just the visible page. User downloads
include **all relationships of matching users**, even with an agent filter;
users without relationships have empty agent fields. Repeated user totals are
not per-agent counts—do not sum them.

## Limits and retention

Drafts expire after **30 minutes**. Saved reports remain until explicit deletion;
new imports keep earlier sets. Identical content reuses a set without changing
its import time; changed content normally adds a set, even for the same period.
Explicit Admin corrections supersede their targets. Deletion requires Admin
confirmation; those files can be imported again.

The adoption dashboard uses retained sets independently of Agents/Users, with
the earliest dated observation as its default baseline. Snapshots are not daily
events: do not add or subtract overlapping exports for interval use. Undated
reports show counts without direction; unavailable or superseded sets do not
contribute. Missing reports are not zero use; today's licenses are not historical
adoption denominators.

## Troubleshooting

| Problem | Action |
| --- | --- |
| Cannot export / import denied | Check the exporting Microsoft role / signed-in Agent Control app role respectively. |
| File rejected | Check UTF-8 encoding, exact headers, row values and limits above; retry the rejected kind. Valid companions stay selected. |
| Duplicate report type | Cancel and reopen to replace the whole draft. |
| Import outcome uncertain | Select **Verify acceptance**, not another upload. |
| Reports saved, verification failed | Use **Verify saved import**. **Close saved import** keeps the saved result without claiming successful verification. |
| Validation changed / draft expired | Use **Refresh bundle validation** when offered; cancel expired drafts and add all three files again. |
| Cancellation failed | Retry **Discard staged import**. Leaving does not undo a submitted import. |
| Usage appears only in reports | Refresh inventory if needed; check the exact package identity, not name similarity. |
| Stale or unknown activity | Check report dates and sources; export fresh reports. Reimporting unchanged files cannot supply missing activity. |

Technical references: [saved report details](data-architecture.md#official-reports-and-user-evidence),
[retention operations](operations.md#run-retention) and
[API contracts](mcp-reference.md#users-licensing-official-reports-cohorts-and-retained-history).
