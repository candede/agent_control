# Signed-in user roles and permissions

This guide answers **"What access must the person using Agent Control have?"** It is separate from the [registered application's API permissions](deployment-setup.md#api-permissions-administrator-prerequisite). The task reference is also available in **Permissions > Signed-in user roles**.

**Microsoft documentation reviewed: 27 September 2026.** No live tenant role, license or permission audit was performed.

## Three independent kinds of access

| Access | Assigned to | Purpose |
| --- | --- | --- |
| Agent Control app role | User or approved group through the Enterprise application | `AgentControl.Viewer` allows authorized reads and delegated read workflows. `AgentControl.Admin` includes Viewer and permits supported changes, imports and configuration. |
| Microsoft human access | User through Entra roles, Purview role groups or Defender RBAC | Authorizes the person's Microsoft-side tasks. A Purview role is not an Entra directory role, and a Defender data-scope assignment is not an API grant. |
| API permission and consent | Agent Control's app registration | Allows the application to call the appropriate API. It does not assign the user an administrator role. See the separate API-permission checklist. |

Having one does not supply the other two. A Global Administrator still needs an Agent Control app-role assignment to use protected app features. Conversely, `AgentControl.Admin` does not make someone an Entra, Power Platform, Purview or Defender administrator.

**Use task-specific roles for routine work, not Global Administrator as a universal prerequisite.** A role's scope matters: a role limited to an administrative unit, environment, device group or data source does not automatically cover a tenant-wide request.

## Saved data versus a Microsoft request

Opening an authorized saved list, filtering it, inspecting an accepted report or exporting saved rows does not itself require a new Microsoft administrator role. Microsoft-source refreshes and directory lookups have their own requirements. Opening a page can trigger eligible automatic refresh, so seeing saved data does not prove refresh will succeed.

`AgentControl.Viewer` includes access to accepted **user-level** usage reports, not just aggregate charts. Assign it only to people allowed to see the tenant's imported user names and usage. Delegated inventories and investigations remain account-scoped; Admin does not gain another account's private saved results simply by being Admin.

### Local task matrix

| Task | Agent Control role | Additional Microsoft human role for the local action |
| --- | --- | --- |
| View/filter Agents and Users, accepted reports, saved responsibility, saved investigation results and this app's administrative Audit page | Viewer or Admin | None for the local read itself; the saved scope must be authorized. Detail lookups or automatic/explicit refresh use the source requirements below. |
| Export saved inventory, users, report snapshots, authorized audit/hunting results or the app's administrative audit | Viewer or Admin | None for exporting already authorized saved data. This is not a download from Microsoft 365 admin center. |
| Start/retry Sync or a delegated read/search; resume or cancel your own read job; delete your own local investigation results | Viewer or Admin | Required source access when the workflow contacts Microsoft. Local cancellation/deletion does not claim to cancel/delete Microsoft's original data. |
| Validate/import the three usage CSV files; select/delete retained reports; add/remove reviewed agent-to-report associations | Admin | None to process files already obtained. The person downloading the original files needs Microsoft reporting access separately. |
| Confirm supported package or quarantine changes; operate their mutation-job controls | Admin | The corresponding source requirements apply when dispatching or retrying a Microsoft operation. Cancelling unsent local work needs Admin but does not itself call Microsoft. |
| Configure optional app-only access and approve/qualify a shared application scope | Admin | Local configuration does not assign a human Microsoft role or grant API consent. Microsoft-side setup remains a separate administrator task. |
| Use an already enabled and qualified application read mode | Viewer or Admin | Microsoft authorizes the application identity instead of a delegated human role. Approved scope, result ownership and app permissions still apply; there is no automatic fallback from denied delegated access. |

Viewer includes permission to run read workflows; it is not restricted to viewing static pages. Admin includes Viewer, so assigning both is unnecessary. There is no supported owner-reassignment workflow and no license-assignment editing feature to authorize.

## Agents and agent controls

The Agents page combines two sources. A role that authorizes one source does not automatically authorize the other.

| Task | Agent Control role | Signed-in person's Microsoft access | Scope and official documentation |
| --- | --- | --- | --- |
| Refresh/list Microsoft 365 agent packages and refresh package details | Viewer or Admin | **No additional human Entra role is named by the package operation documentation.** | The Graph package API still requires the registered-app grant, delegated authorization and Microsoft Agent 365 prerequisites. This is not a claim that an arbitrary signed-in user has access. [List packages](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackages-list), [get details](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-get). |
| Block or unblock a published Microsoft 365 agent package | **Admin** | **No additional human Entra role is named by the block/unblock operation documentation.** | Exact package selection, confirmation and Microsoft-side authorization are required. These package actions differ from Studio quarantine. [Block](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-block), [unblock](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-unblock). |
| Change package availability and installation assignments | **Admin** | **No additional human Entra role is named by the package update documentation.** | Selecting people/groups also uses directory lookup. This does not assign Entra roles, edit licenses or transfer Studio ownership. [Update package](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-update). |
| Refresh Copilot Studio agent and environment inventory | Viewer or Admin | **Feature guidance:** **AI Reader** covers agents/environments; **Global Reader** covers all inventory. **AI Administrator** covers the AI-related subset; **Power Platform Administrator**, **Dynamics 365 Administrator** and **Global Administrator** cover all resources. | The role matrix describes the **Power Platform admin-center inventory feature**, not an independent REST authorization contract. The REST API article does not publish a human-role minimum. Environment Admin alone is not an established substitute; new built-in Power Platform RBAC roles are not supported by the documented inventory feature. [Feature access requirements](https://learn.microsoft.com/en-us/power-platform/admin/power-platform-inventory#access-requirements), [inventory API](https://learn.microsoft.com/en-us/power-platform/admin/inventory-api). |
| Read Copilot Studio quarantine status | Viewer or Admin | **AI Administrator**, **Power Platform Administrator** or **Global Administrator**. | A read-only app role does not remove the administrative requirement on Microsoft's status endpoint. Global Reader alone is not listed. [Quarantine API](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine). |
| Quarantine or restore a Copilot Studio agent | **Admin** | **AI Administrator**, **Power Platform Administrator** or **Global Administrator**. | Tenant-level administrative access, a supported exact environment/bot and confirmation are required. Bot ownership, Environment Maker or Environment Admin alone do not satisfy the documented tenant-role requirement. Classic bots are unsupported. [Quarantine API](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine). |
| Resolve agent people; search users/groups for assignments | Viewer or Admin | Ordinary member-account directory-read access; the basic lookup operations do not name an additional Entra administrator role. | **Guests cannot call the user-list API.** Hidden membership and restricted properties are not included in this basic-lookup conclusion. This is not complete Users/license sync. [Member defaults](https://learn.microsoft.com/en-us/entra/fundamentals/users-default-permissions), [list users](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0), [list groups](https://learn.microsoft.com/en-us/graph/api/group-list?view=graph-rest-1.0). |
| Resolve the Entra agent identity used for log matching | Viewer or Admin | **Agent ID Administrator** is the named least-privileged role for a nonowner. Microsoft documents an owner exception for identities associated with an owned blueprint. | Copilot Studio bot ownership is not the same as that Entra ownership exception, and AI Administrator is not the named substitute. The app resolves only an exact source-declared identity. Identity access does not grant hunting access. [Get agent identity](https://learn.microsoft.com/en-us/graph/api/agentidentity-get?view=graph-rest-1.0). |

**Package API versus Microsoft portal:** do not copy a role requirement from Microsoft 365 Agent Registry, Integrated apps or Teams administration and present it as a documented Graph API requirement. Where the API pages do not name a human role, this guide deliberately records that limitation. It does not recommend elevating every operator to Global Administrator.

For comparison, Microsoft's [Agent Registry portal role matrix](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-roles-perms) identifies **AI Reader** for focused read-only visibility and **AI Administrator** for governance. **Global Administrator** is the broad governance alternative. Global Reader, Security Administrator, Security Reader, Reports Reader and User Experience Success Manager also have registry visibility. That portal matrix identifies AI Administrator and Global Administrator for installing, modifying, approving and managing agent configurations; it does not establish a package API's minimum human role.

## Users, licensing and usage reports

### Source refresh versus user listing

| Task | Agent Control role | Signed-in person's Microsoft access | Details |
| --- | --- | --- | --- |
| View/filter the saved Users list and open user details | Viewer or Admin | No extra Microsoft administrator role for the saved read itself. | The list is saved licensing/report data, not an unrestricted live Entra directory browser. Automatic or explicit refresh has the requirements below. |
| Refresh directory users and Copilot license/service-plan data | Viewer or Admin | **Directory Readers** is a suitable catalog-reader role; **Global Reader** is a broader read-only alternative. The catalog also supports **Dynamics 365 Business Central Administrator** for standard properties, or an appropriate custom role. | Use a member account: guests cannot call `/users`. Complete Users sync also calls `/subscribedSkus`, so being able to list users does not prove catalog access. User Administrator or License Administrator is not required merely to perform these reads. [Users](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0), [subscribed SKUs and roles](https://learn.microsoft.com/en-us/graph/api/subscribedsku-list?view=graph-rest-1.0). |
| Refresh last reported Copilot activity in Office apps | Viewer or Admin | **Reports Reader** or **AI Administrator**, or another role supported by this specific report endpoint. | Directory/license refresh and report refresh are independent. Directory Readers alone does not authorize this report. [Copilot per-user usage API and supported roles](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/reports/copilotreportroot-getmicrosoft365copilotusageuserdetail). |

The current `/copilot/reports/getMicrosoft365CopilotUsageUserDetail` page also lists these literal administrator names: **Company Administrator**, **Exchange Administrator**, **SharePoint Administrator**, **Lync Administrator**, **Teams Service Administrator**, and **Teams Communications Administrator**. Reports Reader is the focused reporting choice. Do not copy the role list from the older `/reports/...` endpoint: its role list differs, and generic [Graph report authorization](https://learn.microsoft.com/en-us/graph/reportroot-authorization) restricts Global Reader and Usage Summary Reports Reader to tenant-level data without detailed metrics.

### Download the three original CSVs from Microsoft 365

**Reports Reader** is the task-focused choice for a person exporting user-level usage reports; **AI Administrator** is an alternative. This happens in Microsoft's portal and does not require any Agent Control app role. **Usage Summary Reports Reader** and **User Experience Success Manager** are explicitly described as having **no user details**, so they are not sufficient for the user-level files.

1. Open **Microsoft 365 admin center > Reports > Usage > Microsoft Copilot > Agents**.
2. Choose the same supported period for all three exports.
3. Download **Agents**, **Users & agents**, and **Users** using each table's **Export CSV** action.
4. An **AgentControl.Admin** can then upload the files in **Sync > Import reports**. The exporter and importer can be different authorized people.

This is distinct from **Export users CSV**, agent exports and snapshot exports inside Agent Control: exporting those already authorized saved records needs Viewer or Admin, not a new Microsoft portal role.

Microsoft documents report-access roles, not a separate CSV-download role. The current Agents report refers to the general report-access requirements; it does not publish a separate export permission or expressly detail the replacement report's CSV mechanics. The steps above describe Agent Control's supported three-file import workflow, not an additional Microsoft role.

Microsoft references: [Copilot Agents usage report](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide) and [who can view Microsoft 365 usage reports](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/activity-reports?view=o365-worldwide). File formats and import steps are in [Official usage import](official-usage-import.md).

### Identifiable names versus concealed report identities

Report access and report privacy are separate. Microsoft says the Agents report anonymizes **username and display name** by default. Assigning a report-reading role does not turn concealed exported identifiers into directory identities. The report defines an agent's name separately from its app manifest; do not assume the user-name privacy switch controls agent names.

An authorized **Global Administrator** can review **Microsoft 365 admin center > Settings > Org settings > Services > Reports** and the setting to display concealed user, group and site names. Follow the organization's privacy policy before changing it. Reports Reader does not need Global Administrator just to read names once the organizational setting permits them. Export fresh files after an approved change; Agent Control does not reverse concealed names or guess users from display names. See [Microsoft's report privacy guidance](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/activity-reports?view=o365-worldwide#show-user-group-or-site-details-in-usage-reports).

## Purview, Defender and Agent 365 logs

These services have their own role systems. An Entra **Reports Reader** role is not Purview Audit Reader, and Agent Control's Admin role is neither of them.

| Task | Agent Control role | Signed-in person's Microsoft access | Scope and prerequisites |
| --- | --- | --- | --- |
| Run an explicit Purview audit search from a user's details | Viewer or Admin | Workload minimum: **Purview Audit Reader**, which includes **View-Only Audit Logs**. **Audit Manager** is broader and includes both audit roles; an appropriate custom role group can supply them. For delegated Graph, **Security Reader + Purview Audit Reader** is the conservative combination described below, not a proven endpoint-specific minimum. | These are separate Entra and Purview assignments. Security Reader alone is not Purview audit access. Applicable auditing, license/retention and role scope still apply. [Audit roles](https://learn.microsoft.com/en-us/purview/audit-get-started#step-2-assign-permissions-to-search-the-audit-log), [Graph Security authorization](https://learn.microsoft.com/en-us/graph/security-authorization), [query API](https://learn.microsoft.com/en-us/graph/api/security-auditcoreroot-post-auditlogqueries?view=graph-rest-1.0). |
| Run Defender/Agent 365 advanced-hunting searches | Viewer or Admin | **Security Reader** is the conservative read-only Graph choice. **Defender Unified RBAC** supports scoped hunting access; its sufficiency for this exact POST operation must be verified rather than inferred from another API. | Role/data scope must cover the queried sources and device groups. Defender/Agent 365 licensing and collected telemetry are separate requirements. [Advanced hunting](https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-overview#get-access), [custom permissions](https://learn.microsoft.com/en-us/defender-xdr/custom-permissions-details), [Graph hunting API](https://learn.microsoft.com/en-us/graph/api/security-security-runhuntingquery?view=graph-rest-1.0). |
| Read already authorized saved Purview/Defender results; search saved agent-scoped audit records | Viewer or Admin | No new Microsoft human role for a local saved read itself. | Saved scope and authorizing-account rules remain enforced. Agent-level Purview is saved-only; the user's Purview tab supports explicit provider searches. |
| Configure Defender Security for AI / Microsoft 365 collection | Performed outside Agent Control | **Security Administrator**. | A setup role is different from a read/search role. [Security for AI setup](https://learn.microsoft.com/en-us/defender-xdr/security-for-ai/get-started-defender-security-for-ai). |
| Connect Copilot Studio runtime protection | Performed outside Agent Control | **Security Administrator** for Defender and **Power Platform Administrator** for the Power Platform connection. | This connector is not a prerequisite for every possible audit/hunting record. [Integration setup](https://learn.microsoft.com/en-us/defender-xdr/security-for-ai/get-started-defender-security-for-ai). |
| Enable tenant audit recording | Performed outside Agent Control | **Audit Logs role in Exchange Online**. | View-Only Audit Logs is not enough to change recording. Do not confuse the Exchange Online role with merely reading Purview records. [Enable/disable auditing](https://learn.microsoft.com/en-us/purview/audit-log-enable-disable). |

### Graph Security and workload RBAC

Microsoft's [general delegated Graph Security guidance](https://learn.microsoft.com/en-us/graph/security-authorization) requires **Security Reader or Security Administrator**. Purview documents its separate audit roles. **Security Reader + Purview Audit Reader** covers both published requirements without granting Security Administrator, but Microsoft does not reconcile those pages into an exact Audit Search minimum. The broader **Security Administrator** has a documented [inherited mapping to both audit roles](https://learn.microsoft.com/en-us/defender-office-365/scc-permissions).

Do not recommend **Global Reader** as an unconditional Purview replacement: [Purview's mapping page](https://learn.microsoft.com/en-us/purview/purview-permissions#microsoft-entra-roles-in-the-microsoft-purview-portal) and the [Entra Global Reader reference](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference#global-reader) conflict; the latter says Purview does not support it.

For Defender custom RBAC, **Security data basics (read)** covers general security hunting; email tables additionally require **Email & collaboration metadata (read)**, and vulnerability data requires **Vulnerability management (read)**. Assign the applicable data sources and device groups and activate Unified RBAC for the workload. The [beta GET hunting companion](https://learn.microsoft.com/en-us/graph/api/security-security-getrunhuntingquery?view=graph-rest-beta#permissions) explicitly lists custom RBAC or Security Reader, Global Reader, Security Operator and Security Administrator; the app's **v1.0 POST** page does not enumerate human roles. The companion's list is context, not proof of the POST operation's minimum.

See [Purview search](purview-audit-search.md) and [Defender/Agent 365 hunting](defender-agent365-hunting.md) for supported events, source setup, query scope and limitations. Granting a role does not create historical records, enable every connector or make an unsupported identity join valid.

## Task-focused assignment examples

These are combinations for particular jobs, not a requirement to grant every role to everyone:

| Person's duties | Suggested starting assignments |
| --- | --- |
| Read and export already saved/imported data only | `AgentControl.Viewer`; grant access only if the person may see the saved user-level data. |
| Refresh user/license data and Office-app usage | `AgentControl.Viewer` + **Directory Readers** + **Reports Reader**. |
| Refresh Power Platform inventory as well | **Global Reader** is the full-inventory read-only feature role and also a catalog-reader alternative; **AI Reader** is the focused agents/environments feature role. Keep **Reports Reader** for reporting. The inventory REST minimum is not separately documented, and Microsoft 365 package API prerequisites remain separate. |
| Export original Microsoft usage CSVs | **Reports Reader**; add `AgentControl.Admin` only if this person also imports/manages reports in this app. |
| Perform supported agent controls | `AgentControl.Admin`; add **AI Administrator** or **Power Platform Administrator** for Studio quarantine. Package controls retain the API-documentation distinction above. |
| Investigate user audit and agent hunting data | `AgentControl.Viewer` + **Security Reader + Purview Audit Reader** is the conservative delegated Graph combination, with applicable Defender data scope. Use narrower custom workload roles only with exact-operation validation; the combination is not a claimed endpoint-specific minimum. |

## Assigning roles and recovering access

1. **Assign the app role:** in the tenant's Entra Enterprise application, open **Users and groups** and assign `AgentControl.Viewer` or `AgentControl.Admin`.
2. **Assign human Microsoft access:** a **Privileged Role Administrator** can assign the required Entra directory role under **Identity > Roles & admins > role > Add assignments** in the same tenant. Assign Purview role groups and Defender permissions/data scope in those services. Do not look for those service permissions in the app registration's API list.
3. **Activate eligible access:** if the role is eligible through Privileged Identity Management, open **ID Governance > Privileged Identity Management > My roles > Microsoft Entra roles**, select the role and activate it, completing MFA/approval if required. An eligible-but-inactive role is not an active assignment. You do not need Privileged Role Administrator to activate your own eligible role.
4. **Renew the session:** allow propagation, then sign out of Agent Control and sign back in after app-role or Microsoft-role changes.
5. **Check and retry the exact task:** use **Permissions > Check status**, then retry the failed action. A successful sign-in or token check does not test every operation. Users/license/report refresh and write operations must be tested by their respective explicit workflows.
6. **Review scope and prerequisites:** if an operation is still denied, check role scope, tenant, delegated versus application mode, consent, Conditional Access and the feature's licensing. For empty logs, check collection and the selected dates rather than automatically granting a broader administrator role.

Agent Control displays its own current app-role claims and operation results. It does not enumerate or certify the user's complete Entra, Purview or Defender role membership, and this guide does not grant anything.

Microsoft references: [Assign Entra roles](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/manage-roles-portal) and [Activate an eligible role in PIM](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-how-to-activate-role).

## Maintenance and verification

The app-side requirements follow the enforced [route policies](../backend/src/routes), [workbench action definitions](../backend/src/services/workbenchMetadata.ts) and [capability registry](../backend/src/services/capabilityRegistry.ts). The visible task reference is maintained in [SignedInUserRoles.tsx](../frontend/src/components/SignedInUserRoles.tsx).

This is a role reference, not verification of a particular tenant's assignments, licenses, consent or telemetry. Review the linked Microsoft documentation when those products change.
