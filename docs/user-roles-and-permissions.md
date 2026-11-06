# User roles and Microsoft permissions

Administrator: assign an app role, grant the API permissions, and assign
Microsoft roles where required below. Registration and credentials:
[deployment setup](deployment-setup.md).

## App-defined roles

| App role | Allowed tasks |
| --- | --- |
| `AgentControl.Viewer` | Read shared tenant data; run read-only sync; choose reports for their own view |
| `AgentControl.UsageReportUploader` | Viewer access; upload, validate and publish new CSV report sets; discard own drafts |
| `AgentControl.Admin` | Viewer/Uploader access; manage agents and settings; correct/delete published reports; read/export local Audit logs |

Assign access:

1. Create the roles from the [manifest](../infra/entra-app-manifest.json) under
   **App registrations > Agent Control > App roles**, enabled for **Users/Groups**.
2. Open **Enterprise applications > Agent Control > Properties** and set
   **Assignment required?** to **No** after hardened API/MCP deployment.
3. Under **Users and groups > Add user/group**, select the user/group, select
   one role, then **Assign**. Uploader includes Viewer; Admin includes both.
4. Sign out and sign in after assignment changes.

App roles do not grant Microsoft API access. All three roles can read
tenant-shared saved data without permission to collect it.
Group assignment requires applicable Entra licensing; nested groups do not inherit assignments.

No EndUser role exists. Valid roleless active tenant members receive discovery-only
access and a browser conversational handoff; they cannot read adoption, enumerate
people, inspect jobs or run manual sync/controls. Exact member verification uses
the actual tenant-local `oid`, not licensing, email affiliation or guessed workplace
fields. Application-only reads bootstrap automatically at authenticated entry.
Viewer/Uploader/Admin remain the actual authorization actors for read-only employee
preview; a selected subject never supplies roles, tokens or permissions.

Discovery's safe profile, organization-wide goal search/detail and workplace
reads use saved data without collecting from providers on each question.
Company/department come only from the saved account; an unlicensed employee
absent from that source can still search the catalog. Champions are dated
report-based suggestions, not appointments; popularity never exposes counts.
Missing or anonymized report linkage means unavailable, not not-a-champion.
Viewer/Uploader/Admin preview the exact saved active member through these same
reads; normal self-service returns to their own account on the next request.
The deployment's independent employee/champion privacy settings apply to both
routes, including Admin previews and ordinary staff discovery. They do not
remove authorized existing adoption/admin reads or change collection/ranking.
Identity-bearing saved workplace labels are redacted for display without changing
the saved company/department scope used for these answers.

Read-only sync starts automatically after sign-in while the app is visible and
online, including on first use. No **Permissions** visit or **Check status** is required.
Fresh same-user sign-in resumes application reads cancelled for shutdown
authorization without the ordinary failed-source retry delay; provider failures
and explicit user cancellations retain their existing backoff.

## App registration permissions

Open **App registrations > Agent Control > API permissions > Add a permission**:

1. Select **Microsoft Graph**, then **Application permissions** or **Delegated
   permissions** as listed below.
2. For **Power Platform**, select **APIs my organization uses**, search for
   application ID `8578e004-a5c6-46e7-913e-12f58912df43`, then **Delegated permissions**.
3. Select **Grant admin consent** for the tenant; confirm **Granted for \<tenant\>**.

The Permissions page's 11 entries in four groups follow the
[capability registry](../backend/src/services/capabilityRegistry.ts).
Sign-in does not request these grants. Application tokens use the app identity;
delegated tokens use the signed-in user's Microsoft authority.

### Microsoft Graph / Application

These grants and application credentials support automatic Graph collection.
The signed-in user does not need Microsoft directory or reporting roles.

| Permission | Application use |
| --- | --- |
| `CopilotPackages.Read.All` | Read published agents, package metadata and sharing details. Requires applicable Microsoft Agent 365 licensing. |
| `User.Read.All` | Read users and Copilot license assignments; resolve creators/owners; find and validate access-change recipients. |
| `LicenseAssignment.Read.All` | Retrieve product and service-plan catalog entries to identify Copilot entitlement. |
| `Reports.Read.All` | Fetch per-user Copilot activity in Office apps for the Office adoption dashboard and Users view (last 28 days); not the imported agent-usage CSVs. |

### Microsoft Graph / Delegated

| Permission | Application use |
| --- | --- |
| `CopilotPackages.ReadWrite.All` | Block/unblock packages, change availability and installation assignments, and verify changes in **Agents > Manage**. |
| `Group.Read.All` | Find and validate access-assignment groups using the signed-in user's delegated directory access. |

Package changes require a **Microsoft Agent 365 license** and support
**delegated work or school accounts only**. Microsoft defines both application
and delegated forms of the permission, but the application form does not authorize
these writes.

#### Package-management administrator roles

**Recommended signed-in administrator role: AI Administrator.**
Global Administrator is a broader alternative. This follows Microsoft's
[agent-management guidance](https://learn.microsoft.com/en-us/microsoft-agent-365/admin/agent-roles-perms)
for the Microsoft 365 admin center.
The package API does not publish an explicit minimum user role.

In the Entra admin center, a **Privileged Role Administrator** opens
**Identity > Roles & admins > AI Administrator > Add assignments**,
selects the account, then **Add**. Activate a PIM-eligible role
before signing in again.

### Power Platform / Delegated

| Permission | Application use | Signed-in user's Microsoft role |
| --- | --- | --- |
| `ResourceQuery.Resources.Read` | Retrieve Copilot Studio agents and environments. | Recommend **AI Reader** for read-only sync. |
| `CopilotStudio.AdminActions.Invoke` | Quarantine status, quarantine/restore for supported Studio agents. | Both reads and changes: **AI Administrator**, **Power Platform Administrator** or **Global Administrator**. |

#### Power Platform sync roles

**AI Reader** is the least-privileged supported inventory-feature role for this
app's AI-scoped agents and environments, not a separately published REST API minimum.
Inventory is delegated-only: no application-permission equivalent,
service-principal or managed-identity flow.

Already-assigned **Global Reader**, **AI Administrator**, **Power Platform
Administrator**, **Dynamics 365 Administrator** and **Global Administrator**
also work.

##### Assign AI Reader to a viewer

1. Sign in to the [Entra admin center](https://entra.microsoft.com/) as a
   **Privileged Role Administrator**.
2. Open **Identity > Roles & admins > AI Reader > Add assignments**.
3. Select the viewer, then **Add**.
4. If PIM-eligible, activate the role; then sign out and sign in again.

For quarantine, use **Roles & admins > \<role\> > Add assignments** for one of
the table's administrator roles. Inventory access alone does not grant quarantine
status or changes; role assignment does not replace API consent.

### Sign-in / OpenID Connect

Sign-in and renewal only, not provider-data access. `User.Read` is not used.

| Scope | Purpose |
| --- | --- |
| `openid` | Sign in using an ID token |
| `profile` | Display the account's name and username |
| `offline_access` | Renew delegated tokens when Microsoft policy allows |

## CSV downloads and report import

| Task | Required access |
| --- | --- |
| Export user-level reports from Microsoft 365 | **Reports Reader** or **AI Administrator**; **Usage Summary Reports Reader** does not include user details |
| Import new report sets | `AgentControl.UsageReportUploader` or `AgentControl.Admin`; local, no Microsoft token |
| Correct or delete published reports | `AgentControl.Admin` |
| Select and read saved reports | Any Viewer-capable role |

The imported **Agents**, **Users & agents** and **Users** CSVs measure agent usage,
not Graph's Office-app activity. See [report import](official-usage-import.md)
and [Office adoption](copilot-license-usage.md).

## Issues

| Problem | Action |
| --- | --- |
| Application Graph authorization fails | Administrator checks credentials, grants and admin consent; user sign-in cannot repair app-only access |
| Delegated access fails | Check consent and Microsoft role; sign in again for MFA or Conditional Access when required |
| Provider returns a license, RBAC, cloud or resource restriction | Resolve that specific requirement; saved tenant data remains readable |

**Check status** is diagnostic; it neither grants access nor proves complete visibility.

## Backend-only investigation reference

Purview, Defender and investigation-only identity features have
[backend-only requirements](provider-contracts.md#retained-backend-investigations),
not UI paths or ordinary setup prerequisites. They are separate from Admin-only
local Audit logs.

## Microsoft references

- [Power Platform inventory roles](https://learn.microsoft.com/en-us/power-platform/admin/power-platform-inventory#access-requirements)
- [Entra role assignment](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/manage-roles-portal#assign-roles-with-tenant-scope)
- [Reports Reader](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference#reports-reader)
