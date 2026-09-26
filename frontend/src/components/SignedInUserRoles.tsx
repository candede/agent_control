import { ExternalLink } from "lucide-react";

type RoleTask = {
  id: string;
  task: string;
  appRole: string;
  microsoftRole: string;
  scope: string;
  sources?: readonly { label: string; href: string }[];
};
type RoleGroup = { id: string; title: string; tasks: readonly RoleTask[] };

const roleGroups: readonly RoleGroup[] = [
  {
    id: "agents", title: "Agents and agent controls", tasks: [
      {
        id: "package-inventory", task: "Refresh Microsoft 365 agent inventory",
        appRole: "AgentControl.Viewer or AgentControl.Admin",
        microsoftRole: "The package list/detail API documentation does not name an additional Entra role.",
        scope: "This is the Graph package catalog used by Agents and Sync. Do not read an unspecified role as a guarantee of access: Microsoft still checks the delegated request and Agent 365 prerequisites. Viewing an existing saved list is separate from refreshing it.",
        sources: [
          { label: "Package list", href: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackages-list" },
          { label: "Package details", href: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-get" },
        ],
      },
      {
        id: "package-block", task: "Block or unblock Microsoft 365 agents",
        appRole: "AgentControl.Admin",
        microsoftRole: "The block/unblock API documentation does not name an additional Entra role.",
        scope: "Applies to published Graph packages, not Studio quarantine. AI Administrator is documented for Microsoft 365 Agent Registry governance, but that portal role is not a documented API prerequisite. Exact-target confirmation, consent and Microsoft-side authorization still apply.",
        sources: [
          { label: "Block", href: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-block" },
          { label: "Unblock", href: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-unblock" },
          { label: "Agent Registry portal roles", href: "https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-roles-perms" },
        ],
      },
      {
        id: "package-access", task: "Change agent availability and installation assignments",
        appRole: "AgentControl.Admin",
        microsoftRole: "The package update API documentation does not name an additional Entra role.",
        scope: "Uses the package access controls in Agents > Manage. User/group selection also needs directory lookup access. This does not change Entra roles, Microsoft licenses or a Studio agent's owner.",
        sources: [{ label: "Package update", href: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-update" }],
      },
      {
        id: "platform-inventory", task: "Refresh Copilot Studio agents and environments",
        appRole: "AgentControl.Viewer or AgentControl.Admin",
        microsoftRole: "Inventory feature guidance: AI Reader for agents/environments; Global Reader for all inventory.",
        scope: "AI Administrator covers the AI-related subset; Power Platform Administrator, Dynamics 365 Administrator and Global Administrator cover all inventory. This role matrix describes the admin-center feature: the REST API does not publish a separate human-role minimum. Environment Admin alone is not an established substitute.",
        sources: [
          { label: "Inventory feature roles", href: "https://learn.microsoft.com/en-us/power-platform/admin/power-platform-inventory#access-requirements" },
          { label: "Inventory API", href: "https://learn.microsoft.com/en-us/power-platform/admin/inventory-api" },
        ],
      },
      {
        id: "quarantine-status", task: "Read Copilot Studio quarantine status",
        appRole: "AgentControl.Viewer or AgentControl.Admin",
        microsoftRole: "AI Administrator, Power Platform Administrator or Global Administrator.",
        scope: "Even this status read uses a Studio administrative API. Global Reader or Agent Control Viewer alone is not sufficient Microsoft-side access. The exact environment/bot must be supported; classic bots are excluded.",
        sources: [{ label: "Studio quarantine requirements", href: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine" }],
      },
      {
        id: "quarantine-change", task: "Quarantine or restore Copilot Studio agents",
        appRole: "AgentControl.Admin",
        microsoftRole: "AI Administrator, Power Platform Administrator or Global Administrator.",
        scope: "This is separate from package block/unblock. Owning the bot, being an Environment Maker or holding an Environment Admin role alone does not satisfy the documented tenant-role requirement.",
        sources: [{ label: "Studio quarantine requirements", href: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine" }],
      },
      {
        id: "directory-lookup", task: "Look up agent people and assignment users/groups",
        appRole: "AgentControl.Viewer or AgentControl.Admin",
        microsoftRole: "Tenant member directory-read access; no additional Entra administrator role is named for the basic lookup operations.",
        scope: "Used for people labels and access-assignment search. Guests cannot call the user-list API; restricted-directory rules also apply. This is not full user/license sync, which additionally reads the tenant product catalog.",
        sources: [
          { label: "List users", href: "https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0" },
          { label: "List groups", href: "https://learn.microsoft.com/en-us/graph/api/group-list?view=graph-rest-1.0" },
        ],
      },
      {
        id: "agent-identity", task: "Resolve a Studio agent's log identity",
        appRole: "AgentControl.Viewer or AgentControl.Admin",
        microsoftRole: "Agent ID Administrator for a nonowner; Microsoft documents an owner exception for identities associated with an owned blueprint.",
        scope: "Copilot Studio bot ownership is not the same as the documented Entra ownership exception. This verifies a source-declared identity; it does not grant access to Defender logs or create missing telemetry.",
        sources: [{ label: "Get agent identity", href: "https://learn.microsoft.com/en-us/graph/api/agentidentity-get?view=graph-rest-1.0" }],
      },
    ],
  },
  {
    id: "users-reports", title: "Users and usage reports", tasks: [
      {
        id: "user-sync", task: "Sync users and Copilot licenses",
        appRole: "AgentControl.Viewer or AgentControl.Admin",
        microsoftRole: "Directory Readers; Global Reader is a broader read-only alternative.",
        scope: "Use a member account: guests cannot call the user-list API. Complete Users sync also reads the tenant product/service-plan catalog, so basic directory access alone is insufficient. The app reads assignments; it does not edit licenses.",
        sources: [
          { label: "Tenant catalog roles", href: "https://learn.microsoft.com/en-us/graph/api/subscribedsku-list?view=graph-rest-1.0" },
          { label: "List users", href: "https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0" },
        ],
      },
      {
        id: "office-usage", task: "Refresh Copilot activity in Office apps",
        appRole: "AgentControl.Viewer or AgentControl.Admin",
        microsoftRole: "Reports Reader or AI Administrator; Microsoft lists additional supported service-administrator roles.",
        scope: "This per-user Graph report is a separate part of Users sync. Directory Readers alone does not grant report access. Concealed report identities can prevent exact user matching.",
        sources: [{ label: "Copilot usage API roles", href: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/reports/copilotreportroot-getmicrosoft365copilotusageuserdetail" }],
      },
      {
        id: "download-reports", task: "Download usage CSVs from Microsoft 365",
        appRole: "No Agent Control role is needed to use Microsoft's portal.",
        microsoftRole: "Reports Reader for user-level usage reports; AI Administrator is an alternative.",
        scope: "Open Reports > Usage > Microsoft Copilot > Agents. Export Agents, Users & agents, and Users for the same period. A summary-only reporting role is not sufficient: Usage Summary Reports Reader and User Experience Success Manager have no user details. No separate CSV-download role is documented; importing here requires AgentControl.Admin.",
        sources: [
          { label: "Copilot Agents report", href: "https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide" },
          { label: "Microsoft 365 report roles", href: "https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/activity-reports?view=o365-worldwide" },
        ],
      },
      {
        id: "report-names", task: "Show real names in Microsoft usage reports",
        appRole: "Configured outside Agent Control.",
        microsoftRole: "Global Administrator to change the report privacy setting.",
        scope: "In Microsoft 365 admin center, go to Settings > Org settings > Services > Reports and review the concealed-name setting under your organization's privacy policy. Report-reading access alone does not turn concealed names into identities. Export fresh files after an approved change; this app does not reverse concealed identities.",
        sources: [{ label: "Report names and privacy", href: "https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/activity-reports?view=o365-worldwide#show-user-group-or-site-details-in-usage-reports" }],
      },
    ],
  },
  {
    id: "logs", title: "Audit and hunting", tasks: [
      {
        id: "purview-search", task: "Search Purview audit for a user",
        appRole: "AgentControl.Viewer or AgentControl.Admin",
        microsoftRole: "Purview Audit Reader (View-Only Audit Logs), or broader Audit Manager. These are Purview roles, not Entra directory roles.",
        scope: "For delegated Graph access, Security Reader + Purview Audit Reader is a conservative combination covering both Microsoft role guides, not a proven endpoint-specific minimum. Security Reader alone is not Purview audit access. User details runs explicit searches; agent details reads saved audit records.",
        sources: [
          { label: "Purview Audit permissions", href: "https://learn.microsoft.com/en-us/purview/audit-get-started#step-2-assign-permissions-to-search-the-audit-log" },
          { label: "Graph Security user roles", href: "https://learn.microsoft.com/en-us/graph/security-authorization" },
          { label: "Audit Search API", href: "https://learn.microsoft.com/en-us/graph/api/security-auditcoreroot-post-auditlogqueries?view=graph-rest-1.0" },
        ],
      },
      {
        id: "defender-hunting", task: "Run Defender and Agent 365 hunts",
        appRole: "AgentControl.Viewer or AgentControl.Admin",
        microsoftRole: "Security Reader is the conservative read-only Graph choice. Defender Unified RBAC supports scoped hunting access.",
        scope: "Custom RBAC uses Security data basics (read); email and vulnerability tables need their corresponding read permissions. Access must cover the queried data sources and device groups. The v1.0 POST API does not enumerate human roles, so custom-role sufficiency must not be inferred from a different operation. Licensing and collected telemetry still apply.",
        sources: [
          { label: "Advanced hunting access", href: "https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-overview" },
          { label: "Defender custom permissions", href: "https://learn.microsoft.com/en-us/defender-xdr/custom-permissions-details" },
          { label: "Graph Security user roles", href: "https://learn.microsoft.com/en-us/graph/security-authorization" },
          { label: "Hunting API", href: "https://learn.microsoft.com/en-us/graph/api/security-security-runhuntingquery?view=graph-rest-1.0" },
        ],
      },
      {
        id: "log-setup", task: "Set up log collection",
        appRole: "Performed in Microsoft's administration tools, not granted by Agent Control.",
        microsoftRole: "Security Administrator for Defender setup; Power Platform Administrator for the Studio connection; Exchange Online Audit Logs role to enable Purview auditing.",
        scope: "Setup permissions differ from search permissions. See Log setup for the connector and auditing steps. Granting read access does not enable collection or backfill missing events.",
        sources: [
          { label: "Defender Security for AI setup", href: "https://learn.microsoft.com/en-us/defender-xdr/security-for-ai/get-started-defender-security-for-ai" },
          { label: "Enable Purview auditing", href: "https://learn.microsoft.com/en-us/purview/audit-log-enable-disable" },
        ],
      },
    ],
  },
  {
    id: "saved-data", title: "Saved data and app administration", tasks: [
      {
        id: "view-saved", task: "View, filter and export saved data",
        appRole: "AgentControl.Viewer or AgentControl.Admin",
        microsoftRole: "No additional Microsoft administrator role for the local read itself.",
        scope: "Includes Agents, Users, agent responsibility, accepted usage reports, saved investigation results and this app's Audit page. You still need access to the saved tenant/account scope. Refreshing a Microsoft source is a separate task below.",
      },
      {
        id: "manage-reports", task: "Import and manage usage reports",
        appRole: "AgentControl.Admin",
        microsoftRole: "No additional Microsoft administrator role to upload files already obtained.",
        scope: "Includes validating/importing CSVs, selecting or deleting retained reports, and adding or removing reviewed agent-to-report associations. Downloading the original CSVs from Microsoft 365 requires report access separately.",
      },
      {
        id: "app-configuration", task: "Configure application access and shared scopes",
        appRole: "AgentControl.Admin",
        microsoftRole: "No additional human directory role for Agent Control's local configuration.",
        scope: "Admin approval is required to enable and qualify optional app-only modes and shared scopes. Viewer or Admin can then use approved read workflows. Microsoft authorizes app-only requests as the application, not as the signed-in user; this does not bypass the app's sharing rules.",
      },
      {
        id: "read-jobs", task: "Run and manage delegated read jobs",
        appRole: "AgentControl.Viewer or AgentControl.Admin",
        microsoftRole: "The source-specific role below when Microsoft is contacted.",
        scope: "Includes Sync, retries, permission checks, and your own search/hunting refresh, resume, cancellation and local deletion controls. Provider-changing actions and mutation-job controls require AgentControl.Admin.",
      },
    ],
  },
];

export function SignedInUserRoles() {
  return <section className="permission-user-roles" aria-labelledby="signed-in-user-roles-title">
    <header>
      <h3 id="signed-in-user-roles-title">Signed-in user roles</h3>
      <span className="permission-setup-tag">Task-based reference</span>
    </header>
    <p>These requirements apply to the person using Agent Control, not the API permissions on the app registration.</p>
    <nav className="permission-role-topics" aria-label="User role topics">
      {roleGroups.map(group => <a key={group.id} href={`#user-roles-${group.id}`}>{group.title}</a>)}
    </nav>
    <div className="permission-role-layers">
      <div><strong>Agent Control access</strong><p>Assign Viewer or Admin in the Enterprise application. Admin includes Viewer; neither grants a Microsoft administrator role.</p></div>
      <div><strong>Microsoft user access</strong><p>Entra directory roles, Purview roles and Defender permissions are separate assignments. Grant only those needed for the person's tasks.</p></div>
      <div><strong>API access</strong><p>The app registration still needs its consented API permissions. See App prerequisites; a user's role does not replace those grants.</p></div>
    </div>
    {roleGroups.map(group => <section key={group.id} id={`user-roles-${group.id}`} className="permission-role-group" aria-labelledby={`user-roles-${group.id}-title`}>
      <h4 id={`user-roles-${group.id}-title`}>{group.title}</h4>
      <div className="permission-role-cards">{group.tasks.map(task => <article key={task.id} aria-labelledby={`user-role-${task.id}`} className="permission-role-card">
        <h5 id={`user-role-${task.id}`}>{task.task}</h5>
        <dl>
          <div><dt>In Agent Control</dt><dd>{task.appRole}</dd></div>
          <div><dt>Microsoft user role</dt><dd>{task.microsoftRole}</dd></div>
        </dl>
        <p>{task.scope}</p>
        {task.sources?.length ? <ul className="permission-role-sources" aria-label={`${task.task}: Microsoft references`}>{task.sources.map(source => <li key={source.href}>
          <a href={source.href} target="_blank" rel="noreferrer">{source.label}<ExternalLink size={12} aria-hidden="true" /></a>
        </li>)}</ul> : null}
      </article>)}</div>
    </section>)}
    <section className="permission-role-activation" aria-labelledby="user-role-activation-title">
      <h4 id="user-role-activation-title">Assign and activate the right roles</h4>
      <ol>
        <li>Assign AgentControl.Viewer or AgentControl.Admin through Enterprise applications &gt; Agent Control &gt; Users and groups.</li>
        <li>A Privileged Role Administrator can assign the required Entra roles in the same tenant through Roles &amp; admins. Assign Purview role groups and Defender data access in their respective services.</li>
        <li>If a role is eligible through Privileged Identity Management, activate it in My roles before the task. Allow assignment changes to propagate, then sign out and back in.</li>
        <li>Use Check status, then retry the specific task. The app displays its own access role; it does not enumerate or certify all of your Microsoft role assignments.</li>
      </ol>
      <p>Use task-specific roles rather than Global Administrator for routine work. Roles do not supply missing licenses, collected logs or consent.</p>
      <p className="permission-setup-note">Microsoft documentation reviewed September 27, 2026. This reference does not verify your tenant's assignments.</p>
      <ul className="permission-role-sources" aria-label="Role assignment references">
        <li><a href="https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/manage-roles-portal" target="_blank" rel="noreferrer">Assign Entra roles<ExternalLink size={12} aria-hidden="true" /></a></li>
        <li><a href="https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-how-to-activate-role" target="_blank" rel="noreferrer">Activate an eligible role<ExternalLink size={12} aria-hidden="true" /></a></li>
      </ul>
    </section>
  </section>;
}
