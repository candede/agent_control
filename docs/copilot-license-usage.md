# Microsoft 365 Copilot licenses and usage

The **Users** page combines saved Microsoft 365 directory, license, app-activity,
and imported Copilot Agents report data.

## What the page shows

- Users with an active paid Microsoft 365 Copilot entitlement
- Users with reported agent activity
- Licensed users who may need attention
- Licensed users with no activity in the selected reports
- Company and department when Entra ID supplies them
- Agent relationships found in inventory and reports

Microsoft 365 Copilot Chat without a paid Microsoft 365 Copilot license is a
separate experience and is not measured as a paid entitlement.

## Required access

| Data | App permission | Signed-in user requirement |
| --- | --- | --- |
| Directory users | `User.Read.All` | Directory Readers or Global Reader |
| License catalog | `LicenseAssignment.Read.All` | Directory Readers or Global Reader |
| Microsoft 365 Copilot app activity | `Reports.Read.All` | Reports Reader or AI Administrator |
| Imported Copilot Agents reports | No additional Microsoft API permission | Agent Control Admin to import; Viewer or Admin to read |

Configure permissions and grant admin consent before collecting data. See
[deployment setup](deployment-setup.md) and
[Microsoft roles](user-roles-and-permissions.md).

## Refresh user data

1. Open **Sync**.
2. Refresh the Users and Microsoft 365 Copilot activity sources.
3. Review each source status and count.
4. Open **Users** after the refresh completes.

A failed refresh keeps the last successful saved data and displays the source
error. A successful refresh with no matching users is shown as an empty result,
not a failure.

## Add agent usage reports

Microsoft Graph activity and Microsoft 365 Copilot Agents usage reports are
different sources.

To add per-agent and per-user activity:

1. Export **Agents**, **Users & agents**, and **Users** for the same period from
   the Microsoft 365 admin center.
2. Import them through **Sync > Add CSV reports**.
3. Select the report set on the Agents or Users page.

See [Microsoft 365 usage report import](official-usage-import.md).

## How users are classified

Paid-license status requires current saved product and service-plan evidence.
Activity alone does not prove a paid license.

- **Using agents** means the selected report set contains positive response
  evidence for that user.
- **No reported agent activity** means the selected reports support that
  conclusion for a matched licensed user.
- **Needs attention** includes licensed users with no activity or low reported
  usage.
- Missing or concealed identities remain unknown until they can be matched.

The app keeps unavailable values unknown instead of converting them to zero.

## Troubleshooting small or unexpected counts

Check:

1. The Users source completed successfully in **Sync**.
2. The signed-in account can read the directory, license catalog, and reports.
3. `User.Read.All`, `LicenseAssignment.Read.All`, and `Reports.Read.All` have
   admin consent.
4. The expected products and service plans are assigned and enabled.
5. The selected imported report set is current and uses identifiable names.
6. The report identities match current Entra users.

Users referenced only as agent owners or creators can appear in agent details
without being included in paid-license counts.

## Data boundaries

- Sync is read-only and does not change users or license assignments.
- Company and department come from Entra ID and are not inferred.
- Imported report activity is kept separate from Microsoft 365 app activity.
- One account's delegated snapshots are not exposed to another account.
