# User roles and Microsoft permissions

Use this guide to assign Agent Control access and configure Microsoft permissions.
For registration steps, see [deployment setup](deployment-setup.md).

## App-defined roles

| App role | Allowed tasks |
| --- | --- |
| `AgentControl.Viewer` | Read shared tenant data; run read-only sync; select reports |
| `AgentControl.UsageReportUploader` | Viewer access; upload, validate and publish CSV reports; discard own drafts |
| `AgentControl.Admin` | Viewer/Uploader access; manage agents and settings; correct/delete published reports; read/export local Audit logs |

Assign access:

1. Open **Enterprise applications > Agent Control > Users and groups**.
2. Set **Assignment required?** to **Yes**.
3. Assign one role to each user or group. Uploader includes Viewer; Admin includes both.
4. Sign out and sign in after assignment changes.

App roles do not grant Microsoft API access. All three roles share saved tenant
data, even without permission to collect it. Only Admin can access **Manage**,
settings and local **Audit** reads/exports.

## App registration permissions

Add these permissions under **App registrations > Agent Control > API
permissions**, then **Grant admin consent**. Configure application credentials
as described in [setup](deployment-setup.md).

The Permissions page lists the following 11 entries in four groups. Sign-in does
not request these grants.

### Microsoft Graph / Application

These grants support automatic Graph collection. The signed-in user does not
need Microsoft directory or reporting roles.

| Permission | Application use |
| --- | --- |
| `CopilotPackages.Read.All` | Retrieve published agents, package metadata and sharing details. Requires applicable Microsoft Agent 365 licensing. |
| `User.Read.All` | Retrieve users and Copilot license assignments; resolve agent creators/owners; find and validate users for access changes. |
| `LicenseAssignment.Read.All` | Retrieve product and service-plan catalog entries to identify Copilot entitlement. |
| `Reports.Read.All` | Retrieve per-user Copilot usage in Office apps for the Office adoption dashboard and Users view, using the last 28 days. |

### Microsoft Graph / Delegated

| Permission | Application use |
| --- | --- |
| `CopilotPackages.ReadWrite.All` | Block/unblock packages, change availability and installation assignments, and verify changes in **Agents > Manage**. |
| `Group.Read.All` | Find and validate groups for package availability and installation assignments. |

Package changes require a **Microsoft Agent 365 license** and **delegated work
or school accounts only**. Configure the write permission under **Delegated
permissions**, not Application.

Microsoft defines both application and delegated forms of the permission, but
the application form does not authorize these writes.

#### Package-management administrator roles

**Recommended signed-in administrator role: AI Administrator.** Global
Administrator is a broader alternative; do not assign it solely for this task.
This follows Microsoft's Microsoft 365 admin center
[agent-management guidance](https://learn.microsoft.com/en-us/microsoft-agent-365/admin/agent-roles-perms).
The package API does not publish an explicit minimum user role.

To assign the recommended role, a **Privileged Role Administrator** opens
**Identity > Roles & admins > AI Administrator > Add assignments** in the Entra
admin center. If PIM-eligible, activate the role before signing in again.

### Power Platform / Delegated

| Permission | Application use | Signed-in user's Microsoft role |
| --- | --- | --- |
| `ResourceQuery.Resources.Read` | Retrieve Copilot Studio agents and environments. | Recommend **AI Reader** for read-only sync. |
| `CopilotStudio.AdminActions.Invoke` | Read quarantine status; quarantine or restore supported Studio agents. | **AI Administrator**, **Power Platform Administrator** or **Global Administrator**, including for status reads. |

#### Power Platform sync roles

**AI Reader** is the least-privileged supported inventory role for this app's
agents and environments. Inventory authentication is delegated-only: there is
no application-permission equivalent, service-principal or managed-identity flow.

Already-assigned **Global Reader**, **AI Administrator**, **Power Platform
Administrator**, **Dynamics 365 Administrator** and **Global Administrator**
also work. AI roles cover AI-scoped resources; broader roles are unnecessary
for this sync. These are Microsoft's inventory-feature roles, not a separately
published REST API minimum.

##### Assign AI Reader to a viewer

1. Sign in to the [Entra admin center](https://entra.microsoft.com/) as a
   **Privileged Role Administrator**.
2. Open **Identity > Roles & admins > AI Reader > Add assignments**.
3. Select the viewer, then **Add**.
4. If PIM-eligible, activate the role; then sign out and sign in again.

Role assignment does not replace delegated API consent. Inventory access does
not grant quarantine status or changes.

### Sign-in / OpenID Connect

These scopes support sign-in and token renewal, not inventory or management
access. `User.Read` is not used.

| Scope | Purpose |
| --- | --- |
| `openid` | Sign in using an ID token |
| `profile` | Display the account's name and username |
| `offline_access` | Renew delegated tokens when Microsoft policy allows |

## CSV downloads and report import

| Task | Required access |
| --- | --- |
| Export user-level reports from Microsoft 365 | **Reports Reader** or **AI Administrator**; **Usage Summary Reports Reader** does not include user details |
| Import new report sets | `AgentControl.UsageReportUploader` or `AgentControl.Admin`; no Microsoft token |
| Correct or delete published reports | `AgentControl.Admin` |
| Select and read saved reports | Any Viewer-capable role |

The imported **Agents**, **Users & agents** and **Users** CSVs measure agent
usage. They are separate from Graph's Office-app activity report.
See [report import](official-usage-import.md) and [Office adoption](copilot-license-usage.md).

## Issues

Read-only sync starts automatically after sign-in while the app is visible and
online. Visiting **Permissions** or running **Check status** is not required.

| Problem | Action |
| --- | --- |
| Application Graph authorization fails | Administrator checks application credentials, API grants and admin consent; user sign-in does not repair app-only authorization |
| Delegated authorization expires or requires interaction | Sign in again for MFA or Conditional Access; administrator configures any missing grants separately |
| Power Platform inventory is denied | Check delegated inventory consent and the signed-in user's supported Entra role |
| Provider returns a licensing, cloud or resource restriction | Check that specific provider requirement; a successful login is not proof of API access |
| Saved data is visible but sync fails | Saved reads and provider collection have different permissions; existing data remains readable |

**Check status** reports bounded diagnostics, not proof of complete provider
visibility or approval for later changes.

## Backend-only investigation reference

Purview, Defender and investigation-only identity setup are hidden from the
current UI and are not ordinary deployment prerequisites. Their permissions and
scope rules are listed in [provider contracts](provider-contracts.md#retained-backend-investigations).
They are separate from Agent Control's Admin-only local Audit logs.

## Microsoft references

- Package API: [list](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackages-list), [details](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-get), [block](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-block), [unblock](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-unblock), [update access](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-update).
- Power Platform: [inventory roles](https://learn.microsoft.com/en-us/power-platform/admin/power-platform-inventory#access-requirements), [inventory API](https://learn.microsoft.com/en-us/power-platform/admin/inventory-api), [quarantine API](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine).
- Entra: [role assignment](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/manage-roles-portal#assign-roles-with-tenant-scope), [Reports Reader](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference#reports-reader).
