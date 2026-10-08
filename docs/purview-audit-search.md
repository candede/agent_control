# Microsoft Purview Audit Search

Agent Control uses Microsoft Graph Audit Search for explicit, bounded Purview
queries. Purview records are investigation evidence, not Microsoft 365 Copilot
usage totals.

## Where to use it

- **Users > user details > Logs > Purview audit** runs a search for the selected
  directory user.
- **Agents > agent details > Activity > Purview audit** searches records for the
  selected agent.
- **Agents > agent details > Users > user name** opens Logs for that user on
  that agent. The report user must resolve to a verified directory identity.
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

## Run a search

1. Open **Logs** for a user, or **Activity** for an agent, and select Purview.
2. Select a preset and date range.
3. Select **Run Audit Search**.
4. Monitor the saved job and review its result pages.

### Exact subject binding

The server creates `/v1.0/security/auditLog/queries`, polls its status, and reads
its records. User searches use `userPrincipalNameFilters` for the person
performing the operation, not an arbitrary mention of the user.

For an agent, the server resolves the selected saved inventory record. Studio
administration uses its exact `BotId`; interactions require a verified Studio
application ID matching `AppIdentity = Copilot.Studio.<applicationId>`. The
appropriate ID is passed as `keywordFilter`, then returned records are checked
against the exact identity before saving. Keyword hits alone are not evidence
of an association. A reported conflicting environment is rejected; optional
environment metadata need not be present.

User-on-agent searches intersect both filters. Bot IDs are not sent as
`objectIdFilters`, and `AgentId` suffixes are never guessed to be bot IDs.
Unsupported log types remain unavailable rather than running broader searches.
Current authorized inventory remains usable while a replacement sync is running.

Searches are limited to 168 hours, 20 result pages, and 5,000 stored rows.
Provider limits can produce partial coverage, which remains visible with the
saved job.
Provider `isRecordCountLimitExceeded` and records lacking a matchable agent
identity also produce partial results, not a misleading complete empty search.
Approximate provider counts do not establish completeness.

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

- [Create an audit query](https://learn.microsoft.com/en-us/graph/api/security-auditcoreroot-post-auditlogqueries?view=graph-rest-1.0)
- [Audit log query resource](https://learn.microsoft.com/en-us/graph/api/resources/security-auditlogquery?view=graph-rest-1.0)
- [Copilot audit identities](https://learn.microsoft.com/en-us/purview/audit-copilot)
- [Copilot Studio audit schema](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-logging-copilot-studio)

The provider contracts and local scope/lifecycle behavior are fixture-tested.
End-to-end collection still needs validation in a tenant with the required
Purview licensing, roles, and audit data; token readiness alone is not that proof.
