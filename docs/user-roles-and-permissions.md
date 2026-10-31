# Signed-in user roles and permissions

Application permissions authorize the app. App roles authorize Agent Control
users. Delegated permissions use the signed-in user's Microsoft access.

The **Permissions** page shows three always-visible sections: **Issues**,
**App-defined roles**, and **App registration permissions**. There is no
section-shortcut bar.

## Issues

Issues show current permission failures and inline evidence. **Check status**
refreshes bounded readiness diagnostics. Token readiness is not proof of complete
provider access, consent, licensing or data visibility; actual operations report
their own failures. The static permission reference describes required setup,
not verified grants.

Read-only sync starts automatically after sign-in while the browser is visible
and online. Visiting Permissions, checking status, an administrator staying
signed in, or an approval/enable step is not required.

## App-defined roles

| App role | Allowed tasks |
| --- | --- |
| `AgentControl.Viewer` | Read shared agents, users, reports and saved sync results; choose a personal report context; run read-only sync. |
| `AgentControl.UsageReportUploader` | Viewer access; upload, validate and publish new CSV sets; discard own unaccepted drafts. |
| `AgentControl.Admin` | Viewer/Uploader access; provider changes, published-report corrections/deletion, configuration and local Audit read/export. |

Assign roles through **Enterprise applications > Agent Control > Users and
groups**. Enable **Assignment required?** on the enterprise application. Each
approved user or group needs only one role: Uploader includes Viewer; Admin
includes both. Sign out/in after assignment changes.

Direct assignments use a purple card and **Assigned to you** badge. Inherited
**Included** roles keep neutral styling.

Only Admin can see the **Audit** tab/page or read/export local administrative
audit logs. Viewer and Usage Report Uploader cannot access them through direct
URLs or API requests either. Audit recording is unchanged. This local Audit
history is distinct from Microsoft Purview Audit Search.

Only Admin can see the **Manage** tab in agent details. Viewer and Usage Report
Uploader see **Overview**, **Usage**, and **Users**; a direct Manage link opens
Overview instead. Provider permission checks still apply to Admin changes.

Graph read sync uses the configured application grants, not the signed-in user's
Microsoft reader roles. Power Platform sync additionally needs that user's
Microsoft inventory access. Saved tenant data is shared across these app roles
and remains readable without permission to collect it from Microsoft.

Provider changes require the current Admin app role, delegated API permission
and applicable Microsoft role/license. The Admin app role does not grant
Microsoft access, and application read grants never authorize changes.

## App registration permissions

The current page lists exactly **11 entries in four groups** below. This section
covers Microsoft access only; Agent Control role requirements are defined above.
Configure permissions and grant tenant admin consent in
**App registrations > Agent Control > API permissions**. Sign-in does not request
these additional API grants.

### Microsoft Graph / Application

Application identity supports automatic Graph reads. An administrator configures
application credentials and grants tenant consent. No signed-in Microsoft
directory or reporting role is required.

| Permission | Feature and required Microsoft access |
| --- | --- |
| `CopilotPackages.Read.All` | Published Copilot agent/package inventory, metadata and sharing details in Agents and Sync. Requires applicable Microsoft Agent 365 licensing, application credentials and tenant admin consent. |
| `User.Read.All` | Directory users and Copilot license/service-plan assignments; exact creator/owner resolution; management user search and user-ID validation before access changes. |
| `LicenseAssignment.Read.All` | Tenant product SKUs and service-plan catalog used to identify Microsoft 365 Copilot entitlement. |
| `Reports.Read.All` | 28-day per-user Copilot activity in Office apps. Does not replace the three imported agent-usage CSV reports. |

For app-only `interaction_required` or `authorization_expired` errors, an
administrator reviews the existing application credentials and API grants, then
retries the application read. User sign-in does not repair app-only authorization.
These errors alone do not establish missing admin consent; grant-consent guidance
is reserved for a reported missing API permission.

### Microsoft Graph / Delegated

Signed-in user identity supports management group lookups and package changes.
User lookups use application access.

| Permission | Feature and required Microsoft access |
| --- | --- |
| `CopilotPackages.ReadWrite.All` | Block/unblock packages, change availability and installation assignments, and verify changes in Agents > Manage. Requires delegated tenant admin consent and a Microsoft Agent 365 license. Recommended signed-in administrator role: **AI Administrator**; **Global Administrator** is a broader alternative. Package writes support delegated work or school accounts only. |
| `Group.Read.All` | Search/resolve groups for management assignments using the signed-in user's delegated directory visibility. |

#### Package-management administrator roles

Recommend **AI Administrator** for the signed-in person performing package
changes. **Global Administrator** also has tenant-wide Copilot agent-management
authority, but is a broader alternative; do not assign it solely for this task.
Role assignment is separate from adding the delegated Graph permission and
granting tenant admin consent.

Microsoft's [agent-management role matrix](https://learn.microsoft.com/en-us/microsoft-agent-365/admin/agent-roles-perms)
documents these roles for installing, modifying, approving and managing agents
in the Microsoft 365 admin center. The
[**AI Administrator** role definition](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference#ai-administrator)
also includes managing all Microsoft Copilot settings. The package API does not
publish an explicit role minimum; this is not a confirmed exclusive API role
requirement. Missing API-specific documentation does not establish that an
ordinary user's consented token is sufficient.

To assign the recommended role, a **Privileged Role Administrator** opens
**Microsoft Entra admin center > Identity > Roles & admins > AI Administrator >
Add assignments**, selects the operator and selects **Add**. If PIM-eligible,
the operator activates **AI Administrator** before signing out/in again.

The [Graph permission reference](https://learn.microsoft.com/en-us/graph/permissions-reference#copilotpackagesreadwriteall)
defines **both application and delegated forms**, both requiring admin consent.
However, the [block](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-block),
[unblock](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-unblock)
and [access-update](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-update)
endpoints currently support **delegated work or school accounts only** and list
application permissions as unavailable. The application form does not authorize
these writes. The existence of a Graph permission does not imply support on
every endpoint.

For Agent Control package controls, select **App registrations > Agent Control >
API permissions > Microsoft Graph > Delegated permissions**, add the permission
and **Grant admin consent**. Retain the Microsoft Agent 365 licensing requirement.
Automatic read-only inventory continues to use the separate, least-privileged
application read grant; do not replace it with a write grant.

### Power Platform / Delegated

Power Platform is separate from Graph. Sync and administrative actions depend
on the signed-in user's Microsoft privileges.

| Permission | Feature and required Microsoft access |
| --- | --- |
| `ResourceQuery.Resources.Read` | Collect Copilot Studio agents and environment metadata in Agents and Sync. Recommend **AI Reader**, the least-privileged supported Entra inventory role for this sync. There is **no application permission equivalent**; saved tenant data remains readable without sync access. |
| `CopilotStudio.AdminActions.Invoke` | Check quarantine status or quarantine/restore supported Studio agents in Agents > Manage. Both status and changes require **AI Administrator**, **Power Platform Administrator** or **Global Administrator**. |

#### Power Platform sync roles

**Recommend AI Reader for read-only sync.** No administrator role is needed for
the viewer. AI roles cover AI-scoped resources; broader roles are unnecessary
for this app's agent/environment sync.

##### Assign AI Reader to a viewer

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com/)
   as a **Privileged Role Administrator**.
2. Go to **Identity > Roles & admins > AI Reader**.
3. Select **Add assignments**, select the viewer's account, then **Add**.
4. Ask the viewer to sign out and sign in again. If AI Reader is PIM-eligible,
   activate the role first.

The app registration also needs admin consent for its delegated inventory
permission. That API permission is not a user role and does not grant quarantine
status or changes.

**Other supported roles, if already assigned:** **Global Reader**, **AI
Administrator**, **Power Platform Administrator**, **Dynamics 365 Administrator**
and **Global Administrator**. Do not assign broader roles solely for sync.
These are Microsoft's inventory-feature roles; the REST API does not publish a
separate minimum. Inventory API authentication is delegated-only; service
principals and managed identities are not supported.

### Sign-in / OpenID Connect

These common sign-in scopes do not authorize inventory reads or administrative
changes. They are a separate group, not Graph data permissions. `User.Read` is
not used.

| Scope | Purpose |
| --- | --- |
| `openid` | Authenticate the account using an ID token; no provider-data access. |
| `profile` | Display the signed-in account's name and username. |
| `offline_access` | Renew delegated tokens when Microsoft policy allows; no additional API permissions. |

## CSV downloads and report import

Local import uses no Microsoft token. New imports require Usage Report Uploader
or Admin; published-report corrections and deletion require Admin. All three roles can choose a personal report; the tenant default automatically follows the latest report content.

Downloading the original user-level CSV reports from Microsoft 365 requires
**Reports Reader** or **AI Administrator**. **Usage Summary Reports Reader** does
not include user details. An app role does not grant this Microsoft access.
The three **Agents**, **Users & agents**, and **Users** exports are separate from
the Graph Office-app activity source.

See [usage import](official-usage-import.md) and [licenses and usage](copilot-license-usage.md).

## Backend-only investigation reference

Purview, Defender and investigation-only identity setup are hidden from the
current UI and are not part of its permission checklist or deployment
prerequisites. Retained backend contracts and their separate permissions are
documented in [provider contracts](provider-contracts.md#retained-backend-investigations),
[Purview](purview-audit-search.md) and [Defender](defender-agent365-hunting.md).
They do not grant access to Agent Control's Admin-only local Audit history.

## Microsoft references

- Package API: [list](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackages-list), [details](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-get), [block](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-block), [unblock](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-unblock), [update access](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-update).
- Power Platform: [inventory roles](https://learn.microsoft.com/en-us/power-platform/admin/power-platform-inventory#access-requirements), [inventory API](https://learn.microsoft.com/en-us/power-platform/admin/inventory-api), [quarantine API](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine).
- Entra: [assign roles](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/manage-roles-portal#assign-roles-with-tenant-scope), [user lookup](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0), [group lookup](https://learn.microsoft.com/en-us/graph/api/group-list?view=graph-rest-1.0).
- Reports: [Reports Reader](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference#reports-reader), [AI Administrator](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference#ai-administrator).
