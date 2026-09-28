import { ExternalLink } from "lucide-react";

type RoleTask = {
  id: string;
  task: string;
  location: string;
  microsoftRole: string;
  detail: string;
  apiPermission?: string;
  sources: readonly { label: string; href: string }[];
};

const roleTasks: readonly RoleTask[] = [
  {
    id: "package-inventory", task: "Refresh Microsoft 365 agent inventory",
    location: "Agents / Sync",
    microsoftRole: "Entra role: not specified by the package API.",
    apiPermission: "CopilotPackages.Read.All",
    detail: "Requires a Microsoft Agent 365 license.",
    sources: [{ label: "Package API", href: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackages-list" }],
  },
  {
    id: "package-controls", task: "Block, unblock or change agent access",
    location: "Agents > Manage",
    microsoftRole: "Entra role: not specified by the package API.",
    apiPermission: "CopilotPackages.ReadWrite.All",
    detail: "Delegated access and a Microsoft Agent 365 license. Includes availability and installation assignments.",
    sources: [
      { label: "Block", href: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-block" },
      { label: "Unblock", href: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-unblock" },
      { label: "Access changes", href: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-update" },
    ],
  },
  {
    id: "platform-inventory", task: "Refresh Copilot Studio agents and environments",
    location: "Agents / Sync",
    microsoftRole: "AI Reader or Global Reader",
    detail: "Entra roles listed for the inventory feature; the REST API does not publish a separate role minimum.",
    sources: [{ label: "Inventory roles", href: "https://learn.microsoft.com/en-us/power-platform/admin/power-platform-inventory#access-requirements" }],
  },
  {
    id: "quarantine", task: "Check quarantine status, quarantine or restore Studio agents",
    location: "Agents > Manage",
    microsoftRole: "AI Administrator or Power Platform Administrator",
    detail: "Global Administrator also supports these actions. The same roles are needed to read quarantine status.",
    sources: [{ label: "Quarantine API", href: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine" }],
  },
  {
    id: "directory-lookup", task: "Look up people and assignment users/groups",
    location: "Agents > Overview / Manage",
    microsoftRole: "Entra member account with directory-read access",
    detail: "No additional admin role for basic lookups. Guests cannot list users.",
    sources: [{ label: "Directory access", href: "https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0" }],
  },
  {
    id: "agent-identity", task: "Resolve a Studio agent's log identity",
    location: "Agents > Activity",
    microsoftRole: "Agent ID Administrator",
    detail: "Not needed for identities associated with an Entra blueprint you own.",
    sources: [{ label: "Agent identity API", href: "https://learn.microsoft.com/en-us/graph/api/agentidentity-get?view=graph-rest-1.0" }],
  },
  {
    id: "user-sync", task: "Sync users and Copilot licenses",
    location: "Users / Sync",
    microsoftRole: "Directory Readers or Global Reader",
    detail: "Use an Entra member account. Covers reading the tenant license catalog.",
    sources: [{ label: "License catalog roles", href: "https://learn.microsoft.com/en-us/graph/api/subscribedsku-list?view=graph-rest-1.0" }],
  },
  {
    id: "office-usage", task: "Refresh Copilot activity in Office apps",
    location: "Users / Sync",
    microsoftRole: "Reports Reader or AI Administrator",
    detail: "Separate from user and license sync.",
    sources: [{ label: "Usage API roles", href: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/reports/copilotreportroot-getmicrosoft365copilotusageuserdetail" }],
  },
  {
    id: "download-reports", task: "Download usage CSVs for import",
    location: "Microsoft 365 admin center > Reports > Usage",
    microsoftRole: "Reports Reader or AI Administrator",
    detail: "Use user-level reports. Usage Summary Reports Reader does not include user details.",
    sources: [{ label: "Report roles", href: "https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/activity-reports?view=o365-worldwide" }],
  },
  {
    id: "purview-search", task: "Search Purview audit for a user",
    location: "Users > User details > Purview audit",
    microsoftRole: "Recommended: Security Reader + Purview Audit Reader",
    detail: "Security Reader is an Entra role; Audit Reader is a Purview role group with View-Only Audit Logs.",
    sources: [
      { label: "Purview roles", href: "https://learn.microsoft.com/en-us/purview/audit-get-started#step-2-assign-permissions-to-search-the-audit-log" },
      { label: "Graph Security roles", href: "https://learn.microsoft.com/en-us/graph/security-authorization" },
    ],
  },
  {
    id: "defender-hunting", task: "Run Defender and Agent 365 hunts",
    location: "Agents > Activity",
    microsoftRole: "Security Reader",
    detail: "Defender access must cover the queried data sources and device groups.",
    sources: [{ label: "Hunting access", href: "https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-overview#get-access" }],
  },
];

export function SignedInUserRoles() {
  return <section className="permission-user-roles" aria-labelledby="signed-in-user-roles-title">
    <h3 id="signed-in-user-roles-title">Signed-in user roles</h3>
    <p>Microsoft roles for actions you run with your signed-in account. <a href="#app-prerequisites-title">App API permissions</a> are configured separately.</p>
    <div className="permission-role-list">
      {roleTasks.map(task => <article key={task.id} aria-labelledby={`user-role-${task.id}`} className="permission-role-row">
        <div>
          <h4 id={`user-role-${task.id}`}>{task.task}</h4>
          <p className="permission-role-location">{task.location}</p>
        </div>
        <div className="permission-role-requirement">
          <p><strong>{task.microsoftRole}</strong></p>
          {task.apiPermission ? <p>API permission: <code>{task.apiPermission}</code></p> : null}
          <p>{task.detail}</p>
          <ul className="permission-role-sources" aria-label={`${task.task}: Microsoft references`}>{task.sources.map(source => <li key={source.href}>
            <a href={source.href} target="_blank" rel="noreferrer">{source.label}<ExternalLink size={12} aria-hidden="true" /></a>
          </li>)}</ul>
        </div>
      </article>)}
    </div>
    <p>Using PIM? <a href="https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-how-to-activate-role" target="_blank" rel="noreferrer">Activate your role<ExternalLink size={12} aria-hidden="true" /></a>, then sign in again.</p>
  </section>;
}
