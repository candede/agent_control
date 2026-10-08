# Microsoft 365 usage report import

Agent Control imports the three Microsoft 365 Copilot Agents usage reports:

- **Agents**
- **Users & agents**
- **Users**

Export all three files for the same reporting period.

## Required access

The Microsoft 365 account exporting the files needs a role that can download
user-level usage reports, such as **Reports Reader** or **AI Administrator**.

Importing and managing reports in Agent Control requires
`AgentControl.Admin`. `AgentControl.Viewer` can view accepted reports.

See [Microsoft roles and permissions](user-roles-and-permissions.md).

## Export the files

1. Open the Microsoft 365 admin center.
2. Go to **Reports > Usage > Microsoft Copilot > Agents**.
3. Select a 7-day or 30-day reporting period.
4. Export the **Agents**, **Users & agents**, and **Users** tables as CSV.
5. Keep the original files until Agent Control confirms the import.

If names are concealed, a Global Administrator can change the report privacy
setting under **Settings > Org settings > Services > Reports**. Export new files
after changing the setting.

## Import the files

1. In Agent Control, open **Sync**.
2. Select **Add CSV reports**.
3. Add all three CSV files.
4. Review the detected file types and row counts.
5. Select **Import reports**.
6. Review the saved-report summary, then select **Close** or **Add more reports**
   to start another upload.

The first complete report set imported for the tenant is selected automatically,
so its usage is available on Agents and Users immediately. Later imports save
reports without changing the selected report, including when no report is
selected. Deleting earlier reports does not reset this first-import behavior.
Closing the summary keeps you on Sync. To use a different saved report, select it
from the report dropdown on Agents or Users.

Invalid files show an actionable error and can be replaced without removing the
valid files already selected.

An exact duplicate reuses the accepted report set instead of creating another
copy.

## View and select reports

- Use **Agents** for agent usage and user drilldowns.
- Use **Users** for licensing and reported user activity.
- Use the report selector on Agents or Users to change the displayed report set.
- Use **Sync > Manage reports** to inspect or delete accepted report sets.

Deleting a report requires Admin confirmation. Importing a new report does not
delete earlier accepted reports.

## File requirements

Keep the original Microsoft CSV headers. Header matching ignores case and
surrounding whitespace.

| Export | Required headers |
| --- | --- |
| Agents | Agent ID; Agent name; Creator type; Active users (licensed); Active users (unlicensed); Responses sent to users; Last activity date (UTC) |
| Users & agents | Agent ID; Agent name; Creator type; Username; Responses sent to users; Last activity date (UTC) |
| Users | Username; Display name; Number of agents used; Agent responses received; Last activity date (UTC) |

Agent Control imports all rows and derives the available activity-date range.
The Microsoft files do not identify their reporting period, so the app cannot
verify that files exported at different times belong to the same period.

## Matching usage to inventory

Agent Control uses source identifiers and approved associations to connect report
rows to inventory agents. A report-only row remains visible when no inventory
agent can be matched.

Review suggested associations before accepting them. Report names alone do not
prove that two records represent the same agent.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| A file type is not recognized | Confirm the file is one of the three Microsoft Copilot Agents exports and still has its original headers. |
| The three files cannot be imported together | Export all three again from the same report page and reporting period. |
| Names are concealed | Change the Microsoft 365 report privacy setting and export fresh files. |
| Rows appear only in the report | Refresh inventory and review report-to-inventory associations. |
| Import is denied | Confirm the signed-in user has `AgentControl.Admin`. |
| A report is no longer needed | Delete it from **Sync > Manage reports**. |

Microsoft reference:
[Microsoft 365 Copilot Agents usage report](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide).
