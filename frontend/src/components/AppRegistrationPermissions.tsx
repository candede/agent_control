import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { isDeferredSecurityCapability } from "../deferredSecurityUi";

type PermissionGuidance = { feature: string; usage: string; requirement?: ReactNode; setup?: ReactNode; alternatives?: string };
const guidance: Readonly<Record<string, PermissionGuidance>> = {
  "CopilotPackages.Read.All": {
    feature: "Agent catalog and package details",
    usage: "Automatically collect the published Copilot package inventory, matching metadata and sharing details shown in Agents and Sync.",
    requirement: "Applicable Microsoft Agent 365 licensing, application credentials and tenant admin consent.",
  },
  "User.Read.All": {
    feature: "Users, license assignments and management user search",
    usage: "Read directory users and their Copilot license/service-plan assignments. Resolve exact agent creators and owners, search management recipients, and validate user IDs before an access change.",
  },
  "LicenseAssignment.Read.All": {
    feature: "Tenant license catalog",
    usage: "Read product SKUs and service plans so Users can identify Microsoft 365 Copilot entitlement.",
  },
  "Reports.Read.All": {
    feature: "Microsoft 365 Copilot app activity",
    usage: "Refresh 28-day per-user Copilot activity in Office apps. This does not replace the three imported agent-usage CSV reports.",
  },
  "CopilotPackages.ReadWrite.All": {
    feature: "Package blocking, access changes and control readback",
    usage: "Block or unblock packages, change availability and installation assignments, and verify an administrator's change in Agents > Manage.",
    requirement: <>Recommended signed-in administrator role: <strong>AI Administrator</strong>. <strong>Global Administrator</strong> is a broader alternative. Delegated tenant admin consent and a Microsoft Agent 365 license are also required.</>,
    setup: <section className="permission-map-setup" aria-label="Configure delegated package access">
      <h5>Administrator: configure delegated package access</h5>
      <p>In the app registration, select <strong>Microsoft Graph &gt; Delegated permissions</strong>, add this permission and <strong>Grant admin consent</strong>.</p>
      <p>Microsoft documents these roles for agent management in the Microsoft 365 admin center. The package API does not publish an explicit role minimum; this recommendation is not a confirmed exclusive API role requirement.</p>
      <p>Microsoft defines both application and delegated forms, but block/unblock and access-update APIs support <strong>delegated work or school accounts only</strong>. The application form does not authorize these writes.</p>
      <div className="permission-actions">
        <a href="https://learn.microsoft.com/en-us/graph/permissions-reference#copilotpackagesreadwriteall" target="_blank" rel="noreferrer">Permission definition<ExternalLink size={13} aria-hidden="true" /></a>
        <a href="https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-update" target="_blank" rel="noreferrer">Package write API requirements<ExternalLink size={13} aria-hidden="true" /></a>
        <a href="https://learn.microsoft.com/en-us/microsoft-agent-365/admin/agent-roles-perms" target="_blank" rel="noreferrer">Agent-management roles<ExternalLink size={13} aria-hidden="true" /></a>
      </div>
    </section>,
  },
  "Group.Read.All": {
    feature: "Management group search",
    usage: "Search and resolve groups for package availability and installation assignments in Agents > Manage.",
    requirement: "The signed-in user's delegated directory access.",
  },
  "ResourceQuery.Resources.Read": {
    feature: "Power Platform inventory sync",
    usage: "Collect Copilot Studio agents and environment metadata in Agents and Sync. There is no application permission equivalent; saved tenant data remains readable without sync access.",
    requirement: <>Recommended for read-only sync: <strong>AI Reader</strong>. AI Reader is the least-privileged supported Microsoft Entra inventory role for this app&apos;s agents and environments.</>,
    setup: <section className="permission-map-setup" aria-label="Assign AI Reader to a viewer">
      <h5>Administrator: assign AI Reader</h5>
      <ol>
        <li>Sign in to the <a href="https://entra.microsoft.com/" target="_blank" rel="noreferrer">Microsoft Entra admin center</a> as a <strong>Privileged Role Administrator</strong>. Go to <strong>Identity &gt; Roles &amp; admins &gt; AI Reader</strong>.</li>
        <li>Select <strong>Add assignments</strong>, select the viewer&apos;s account, then <strong>Add</strong>. AI Reader provides read-only inventory access; no administrator role is needed for the viewer.</li>
        <li>Ask the viewer to sign out and sign in again. If AI Reader is PIM-eligible, they must activate it first.</li>
      </ol>
      <p>This is the app&apos;s delegated API permission, not a user role; the app registration also needs admin consent. This inventory permission does not grant quarantine status or changes.</p>
      <a href="https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/manage-roles-portal#assign-roles-with-tenant-scope" target="_blank" rel="noreferrer">Role assignment instructions<ExternalLink size={13} aria-hidden="true" /></a>
    </section>,
    alternatives: "Global Reader, AI Administrator, Power Platform Administrator, Dynamics 365 Administrator and Global Administrator also work if already assigned. AI roles cover AI-scoped resources; broader roles are not needed for this sync.",
  },
  "CopilotStudio.AdminActions.Invoke": {
    feature: "Studio quarantine status and changes",
    usage: "Check quarantine status or quarantine and restore supported Studio agents in Agents > Manage.",
    requirement: <>Both status checks and changes require <strong>AI Administrator</strong>, <strong>Power Platform Administrator</strong> or <strong>Global Administrator</strong>.</>,
  },
  openid: { feature: "Account sign-in", usage: "Authenticate the signed-in account using an ID token. Does not grant Microsoft provider-data access." },
  profile: { feature: "Account display", usage: "Read the name and username used to identify the signed-in account." },
  offline_access: { feature: "Session renewal", usage: "Renew delegated tokens without repeated sign-in when Microsoft policy allows. Does not add API permissions." },
};

const definitions = capabilityDefinitions.filter(definition => !isDeferredSecurityCapability(definition.id)
  && definition.probe.adapterRegistered && definition.mode !== "local");
const groups = [
  {
    label: "Microsoft Graph / Application", title: "Microsoft Graph", mode: "Application",
    description: "Application identity. Required for automatic Graph reads. An administrator grants tenant consent; no signed-in Microsoft reader role is required.",
    permissions: [...new Set(definitions.filter(definition => definition.provider === "Microsoft Graph" && definition.mode === "application").flatMap(definition => definition.permissions))],
  },
  {
    label: "Microsoft Graph / Delegated", title: "Microsoft Graph", mode: "Delegated",
    description: "Signed-in user identity. Used for management group lookups and administrative changes. User lookups use application User.Read.All.",
    permissions: [...new Set(definitions.filter(definition => definition.provider === "Microsoft Graph" && definition.mode === "delegated").flatMap(definition => definition.permissions))],
  },
  {
    label: "Power Platform / Delegated", title: "Power Platform", mode: "Delegated",
    description: "Power Platform is separate from Graph. Sync and administrative actions depend on the signed-in user's Microsoft privileges.",
    permissions: [...new Set(definitions.filter(definition => definition.provider === "Power Platform").flatMap(definition => definition.permissions))],
  },
  {
    label: "Sign-in / OpenID Connect", title: "Sign-in", mode: "OpenID Connect",
    description: "Common account sign-in scopes. These do not authorize inventory reads or administrative changes.",
    permissions: ["openid", "profile", "offline_access"],
  },
];

export function AppRegistrationPermissions() {
  return <section className="permission-section permission-registration" aria-labelledby="app-registration-title">
    <header className="permission-section-heading">
      <div><p className="permission-eyebrow">03 / API access</p><h3 id="app-registration-title">App registration permissions</h3></div>
      <a className="permission-reference-link" href="https://entra.microsoft.com/" target="_blank" rel="noreferrer">
        Open app registration<ExternalLink size={14} aria-hidden="true" />
      </a>
    </header>
    <p className="permission-section-intro">Administrator: App registrations &gt; this app &gt; API permissions. Add the permissions below and <strong>Grant admin consent</strong>.</p>
    <p className="permission-section-note">This is the required configuration, not a claim that every permission has been granted. Use Issues above for current failures.</p>
    <div className="permission-registration-groups">{groups.map(group => <section key={group.label} className="permission-reference-group" aria-label={group.label}>
      <header className="permission-reference-heading"><h4>{group.title}</h4><span className="permission-mode">{group.mode}</span><span className="permission-reference-count">{group.permissions.length} permissions</span></header>
      <p>{group.description}</p>
      <dl className="permission-map">{group.permissions.map(permission => {
        const explanation = guidance[permission];
        if (!explanation) throw new Error(`Missing app-registration permission guidance: ${permission}`);
        return <div key={permission} className="permission-map-row">
          <dt><code>{permission}</code></dt>
          <dd><strong>{explanation.feature}</strong><p>{explanation.usage}</p>
            {explanation.requirement ? <p className="permission-map-requirement"><span>Required access</span>{explanation.requirement}</p> : null}
            {explanation.setup}
            {explanation.alternatives ? <p className="permission-map-alternatives"><span>Other supported roles</span>{explanation.alternatives}</p> : null}
          </dd>
        </div>;
      })}</dl>
    </section>)}</div>
    <div className="permission-registration-footer">
      <p>Graph read sync uses application permissions and starts automatically while signed in, visible and online. No administrator session is needed.</p>
      <p><code>User.Read</code> is not used. For delegated Microsoft roles managed through PIM, activate the assigned role and sign in again.</p>
      <div className="permission-actions">
        <a href="https://learn.microsoft.com/en-us/graph/permissions-reference" target="_blank" rel="noreferrer">Graph permission reference<ExternalLink size={13} aria-hidden="true" /></a>
        <a href="https://learn.microsoft.com/en-us/power-platform/admin/power-platform-inventory#access-requirements" target="_blank" rel="noreferrer">Power Platform roles<ExternalLink size={13} aria-hidden="true" /></a>
        <a href="https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-how-to-activate-role" target="_blank" rel="noreferrer">Activate a Microsoft role<ExternalLink size={13} aria-hidden="true" /></a>
      </div>
    </div>
  </section>;
}
