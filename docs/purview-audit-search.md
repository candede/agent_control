# Microsoft Purview Audit Search

Agent Control uses Microsoft Graph Audit Search for explicit, bounded Purview
queries. Purview records are investigation evidence, not Microsoft 365 Copilot
usage totals.

## Where to use it

- **Users > user details > Purview audit** runs a search for the selected
  directory user.
- **Agents > agent details > Activity > Purview audit** displays saved
  Copilot Studio administrative records associated with the selected agent.
- **Audit** contains only administrative actions performed through Agent
  Control.

Opening a tab does not start a Microsoft query. Select the filters and run the
search explicitly.

## Requirements

- Microsoft Graph delegated `AuditLogsQuery.Read.All`
- Tenant-wide admin consent
- Purview Audit enabled for the tenant
- Purview **Audit Logs** or **View-Only Audit Logs** access
- `AgentControl.Viewer` or `AgentControl.Admin`

Recommended user access is **Security Reader** in Entra ID plus **Audit Reader**
in Purview. See [Microsoft roles](user-roles-and-permissions.md).

## Available searches

| Preset | Coverage |
| --- | --- |
| Copilot interactions | Copilot interaction metadata supplied by Purview |
| Copilot Studio administration | Supported bot, component, plugin, publishing, sharing, and environment-variable administration events |

Results can include actor, operation, time, result, target, and correlation
metadata when Microsoft supplies those values. Agent Control does not collect
prompt text, response text, or conversation transcripts.

## Run a user search

1. Open the selected user's **Purview audit** tab.
2. Select a preset and date range.
3. Review the access and coverage summary.
4. Select **Run Audit Search**.
5. Monitor the saved job and review its result pages.

Searches are limited to 168 hours, 20 result pages, and 5,000 stored rows.
Provider limits can produce partial coverage, which remains visible with the
saved job.

## Authorization

Delegated searches belong to the authorizing account. Optional application mode
requires separate application permission, Agent Control Admin enablement, and an
approved shared data scope.

**Permissions > Check status** verifies token readiness. It does not run a
Purview query or prove that a query will return records.

## Jobs and retention

Search jobs support status, paging, export, cancellation, and local deletion.
Closing the browser does not cancel an accepted Microsoft query.

Run the supported [retention workflow](operations.md#run-retention) to remove
expired saved jobs and results.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Search is unavailable | Confirm app role, Graph consent, Purview role, and tenant Audit availability. |
| Search returns no records | Confirm the user, preset, date range, and Microsoft source coverage. |
| Search is partial | Review the stored page and row limits and any provider error. |
| Agent records are unavailable | Refresh inventory and confirm the exact bot and environment association. |
| A saved job disappeared | Confirm it was not deleted, expired, or removed by a scope change. |

Microsoft reference:
[Audit log query resource](https://learn.microsoft.com/en-us/graph/api/resources/security-auditlogquery?view=graph-rest-1.0).
