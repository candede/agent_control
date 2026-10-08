# Signed-in user roles and permissions

Microsoft access for actions performed with your signed-in account. The same reference appears in **Permissions > Signed-in user roles**. [App API permissions](deployment-setup.md#5-add-api-permissions) are configured separately.

## Agents and agent controls

| Action in Agent Control | Microsoft role or access |
| --- | --- |
| Refresh Microsoft 365 agent inventory and package details | The package API does not specify an Entra role. Requires **CopilotPackages.Read.All** (or **CopilotPackages.ReadWrite.All**) and a **Microsoft Agent 365 license**. |
| Block/unblock packages; change availability and installation assignments | The package API does not specify an Entra role. Requires delegated **CopilotPackages.ReadWrite.All** and a **Microsoft Agent 365 license**. |
| Refresh Copilot Studio agents and environments | **AI Reader** or **Global Reader**, based on Microsoft's inventory feature roles. The REST API does not publish a separate role minimum. |
| Check quarantine status, quarantine or restore Studio agents | **AI Administrator**, **Power Platform Administrator** or **Global Administrator**. The role requirement includes status reads. |
| Look up people and assignment users/groups | **Entra member account with directory-read access**. No additional admin role for basic lookups; guests cannot list users. |
| Resolve a Studio agent's Entra identity for log matching | **Agent ID Administrator**. Not needed for identities associated with an Entra blueprint you own. |

Package reads support delegated and application permissions; package changes support delegated permissions only. Microsoft's Agent Registry **portal** roles are not published as package **API** prerequisites.

For Studio inventory, **AI Administrator** also covers agents and environments. **Power Platform Administrator**, **Dynamics 365 Administrator** and **Global Administrator** cover all inventory. Studio bot ownership is different from Entra blueprint ownership.

Microsoft references:

- Package API: [list](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackages-list), [details](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-get), [block](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-block), [unblock](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-unblock), [update access](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-update).
- Power Platform: [inventory roles](https://learn.microsoft.com/en-us/power-platform/admin/power-platform-inventory#access-requirements), [inventory API](https://learn.microsoft.com/en-us/power-platform/admin/inventory-api), [quarantine API](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine).
- Entra: [user lookup](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0), [group lookup](https://learn.microsoft.com/en-us/graph/api/group-list?view=graph-rest-1.0), [agent identity](https://learn.microsoft.com/en-us/graph/api/agentidentity-get?view=graph-rest-1.0).

## Users, licensing and usage reports

| Action | Microsoft role |
| --- | --- |
| Sync users and Copilot license assignments | **Directory Readers** or **Global Reader**, using an Entra member account. These roles cover the tenant license catalog. |
| Refresh Copilot activity in Office apps | **Reports Reader** or **AI Administrator**. Reporting access is separate from directory/license access. |
| Download Microsoft 365 usage CSVs for import | **Reports Reader** or **AI Administrator** for user-level reports. **Usage Summary Reports Reader** and **User Experience Success Manager** do not include user details. |

Microsoft references: [license catalog roles](https://learn.microsoft.com/en-us/graph/api/subscribedsku-list?view=graph-rest-1.0), [Copilot usage API roles](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/reports/copilotreportroot-getmicrosoft365copilotusageuserdetail), [Microsoft 365 report roles](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/activity-reports?view=o365-worldwide).

### Download the three original CSVs from Microsoft 365

Open **Microsoft 365 admin center > Reports > Usage > Microsoft Copilot > Agents**. Export **Agents**, **Users & agents**, and **Users** for the same period, then upload them through **Sync > Import reports**. See [Official usage import](official-usage-import.md) for file formats.

### Identifiable names versus concealed report identities

**Global Administrator** is required to change the concealed-name setting under **Microsoft 365 admin center > Settings > Org settings > Services > Reports**. **Reports Reader** can read names once the setting permits them. Export fresh files after changing it. See [report privacy settings](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/activity-reports?view=o365-worldwide#show-user-group-or-site-details-in-usage-reports).

## Purview, Defender and Agent 365 logs

| Action in Agent Control | Microsoft role or access |
| --- | --- |
| Search Purview audit from user details | Recommended: **Security Reader** in Entra + **Audit Reader** in Purview. Audit Reader supplies **View-Only Audit Logs**; **Audit Manager** is a broader alternative. |
| Run Defender/Agent 365 hunts from agent Activity | **Security Reader** in Entra, with Defender access covering the queried data sources and device groups. |

The Purview recommendation combines Microsoft's general delegated Graph Security requirement with Purview's audit role requirement. It is a recommended combination, not an endpoint-specific minimum published by Microsoft.

Defender Unified RBAC supports scoped hunting access through **Security data basics (read)**, with separate permissions for email and vulnerability data. The guide uses **Security Reader** for delegated Graph hunting.

Microsoft references: [Purview audit roles](https://learn.microsoft.com/en-us/purview/audit-get-started#step-2-assign-permissions-to-search-the-audit-log), [Graph Security roles](https://learn.microsoft.com/en-us/graph/security-authorization), [advanced hunting access](https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-overview#get-access), [Defender custom permissions](https://learn.microsoft.com/en-us/defender-xdr/custom-permissions-details).

Connector and auditing setup roles are listed separately in **Permissions > Log setup**. See [Purview search](purview-audit-search.md) and [Defender/Agent 365 hunting](defender-agent365-hunting.md) for collection setup.

## Assigning and activating roles

A **Privileged Role Administrator** can [assign Entra roles](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/manage-roles-portal). Assign Purview role groups and Defender data access in their respective services.

Using PIM? [Activate the eligible role](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-how-to-activate-role), sign in again, then use **Permissions > Check status** and retry the action.
