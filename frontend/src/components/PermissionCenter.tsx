import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { type CapabilityId, type CapabilityView } from "../api/client";
import { hasRole } from "../authorization";
import { useCapabilityContext } from "../capabilityContext";
import { permissionIssues, type PermissionIssue } from "../permissionIssues";
import { PermissionDetails } from "./PermissionDetails";
import { PermissionCheckProgress } from "./PermissionCheckProgress";
import { WorkbenchDialog } from "./WorkbenchDialog";
import { SignedInUserRoles } from "./SignedInUserRoles";
import "./permissions.css";

const permissionFeatureUses: Partial<Record<CapabilityId, Readonly<Record<string, string>>>> = {
  "graph.package.read.delegated": {
    "CopilotPackages.Read.All": "Agents / Sync: load package inventory and package details.",
  },
  "graph.package.read.application": {
    "CopilotPackages.Read.All": "Agents / Sync: read package inventory using approved app-only access.",
  },
  "graph.package.access.manage": {
    "CopilotPackages.ReadWrite.All": "Agents > Manage: change package availability and installation assignments.",
  },
  "graph.package.block.manage": {
    "CopilotPackages.ReadWrite.All": "Agents > Manage: block or unblock published packages.",
  },
  "graph.directory.read": {
    "User.ReadBasic.All": "Agents > Overview / Manage: resolve people and search users for access assignments.",
    "Group.Read.All": "Agents > Overview / Manage: resolve groups and search groups for access assignments.",
  },
  "graph.agentIdentity.read": {
    "AgentIdentity.Read.All": "Agents > Activity: verify a Studio agent's Entra identity for log matching.",
  },
  "graph.licenses.read": {
    "User.Read.All": "Users / Sync: read users and their Copilot license and service-plan assignments.",
    "LicenseAssignment.Read.All": "Users / Sync: read the tenant product and service-plan catalog.",
  },
  "reports.copilotUsage.read": {
    "Reports.Read.All": "Users / Sync: refresh 30-day Microsoft 365 Copilot app activity.",
  },
  "powerPlatform.inventory.read": {
    "ResourceQuery.Resources.Read": "Agents / Sync: refresh Power Platform agent and environment inventory.",
  },
  "powerPlatform.quarantine.read": {
    "CopilotStudio.AdminActions.Invoke": "Agents > Manage: check a Studio agent's quarantine status.",
  },
  "powerPlatform.quarantine.manage": {
    "CopilotStudio.AdminActions.Invoke": "Agents > Manage: quarantine or restore a Studio agent.",
  },
  "purview.audit.search.delegated": {
    "AuditLogsQuery.Read.All": "User details > Purview audit: run user-scoped searches. Agent details > Activity: search saved records.",
  },
  "purview.audit.search.application": {
    "AuditLogsQuery.Read.All": "Users > user details > Purview audit: run user-scoped searches using approved app-only access.",
  },
  "defender.hunting.delegated": {
    "ThreatHunting.Read.All": "Agents > Activity: run Defender / Agent 365 log hunts.",
  },
  "defender.hunting.application": {
    "ThreatHunting.Read.All": "Agents > Activity: run log hunts using approved app-only access.",
  },
};

export function PreviewBadge() {
  const text = "Preview APIs can change. Review the exact targets before confirming changes.";
  return <span className="preview-badge" tabIndex={0} aria-label={text}>Preview<span role="tooltip">{text}</span></span>;
}

export function CapabilityHealth({ current = false }: { current?: boolean }) {
  const { views, user, loading, pending, error, now, openPermissions, awaitingInitialCheck } = useCapabilityContext();
  const canCheckPermissions = hasRole(user, "AgentControl.Viewer");
  const count = permissionIssues(views, now, awaitingInitialCheck).length;
  const label = !canCheckPermissions ? "Permissions: app role required"
    : error ? "Permissions: check failed" : count ? `Permissions: ${count} ${count === 1 ? "issue" : "issues"}` : "Permissions and setup";
  return <button className={`capability-health view-button${current ? " active" : ""}`} type="button" onClick={openPermissions}
    aria-label="Permissions" aria-description={label} aria-current={current ? "page" : undefined}
    aria-busy={loading || pending} title={loading || pending ? "Checking permissions" : label}>
    {loading || pending ? <LoaderCircle className="permission-spinner" size={18} aria-hidden="true" /> : <ShieldCheck size={18} aria-hidden="true" />}
    Permissions
    {canCheckPermissions && !error && count > 0 ? <span className="permission-issue-count" aria-hidden="true">{count}</span> : null}
    {error || !canCheckPermissions ? <span className="permission-issue-count" aria-hidden="true">!</span> : null}
  </button>;
}

export function PermissionCenter() {
  const { user } = useCapabilityContext();
  const sessionKey = JSON.stringify([user?.tenantId, user?.homeAccountId, [...(user?.roles ?? [])].sort()]);
  return <PermissionCenterContent key={sessionKey} />;
}

function PermissionCenterContent() {
  const { views, user, loading, error, pending, now, reload, awaitingInitialCheck, activeCheck } = useCapabilityContext();
  const canCheckPermissions = hasRole(user, "AgentControl.Viewer");
  const heading = useRef<HTMLHeadingElement>(null);
  const [selectedId, setSelectedId] = useState<CapabilityId>();
  const [notice] = useState(() => {
    const outcome = new URLSearchParams(window.location.search).get("authorization");
    return outcome === "cancelled" ? "Sign-in was cancelled."
      : outcome === "interaction_required" ? "Complete Microsoft sign-in or contact your administrator."
        : outcome === "failed" ? "Sign-in failed. Ask your administrator to review the sign-in policy." : undefined;
  });
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const issues = permissionIssues(views, now, awaitingInitialCheck);
  const selected = issues.find(issue => issue.view.definition.id === selectedId);
  if (selectedId && !selected) setSelectedId(undefined);
  const role = hasRole(user, "AgentControl.Admin") ? "App administrator" : canCheckPermissions ? "App viewer" : "App role required";

  return <section className="permission-center" aria-labelledby="permissions-title" aria-busy={loading || pending}>
    <header className="permission-heading">
      <div className="permission-page-icon"><ShieldCheck size={24} aria-hidden="true" /></div>
      <div className="permission-heading-copy">
        <h2 id="permissions-title" ref={heading} tabIndex={-1}>Permissions</h2>
        <p>Setup and troubleshooting for {user?.displayName || "your account"}.</p>
      </div>
      <div className="permission-actions">
        <span className="permission-setup-tag">{role}</span>
        <button type="button" className="secondary" disabled={!canCheckPermissions || loading || pending} onClick={() => void reload()}>
          {loading || pending ? <LoaderCircle className="permission-spinner" size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
          {loading || pending ? "Checking..." : "Check status"}
        </button>
      </div>
    </header>
    <div className="permission-body">
      <nav className="permission-role-topics" aria-label="Permissions sections">
        <a href="#signed-in-user-roles-title">Signed-in user roles</a>
        <a href="#app-prerequisites-title">App API permissions</a>
        <a href="#permission-log-setup">Log setup</a>
      </nav>
      {!selected && notice ? <div className="permission-notice" role="status">{notice}</div> : null}
      {canCheckPermissions && (loading || pending) ? <PermissionCheckProgress loading={loading} activeCheck={activeCheck} views={views} /> : null}
      <section className="permission-issues" aria-labelledby="permission-issues-title">
        <h3 id="permission-issues-title">Issues</h3>
        {!selected && error ? <div className="error-banner" role="alert">{error}</div> : null}
        {!canCheckPermissions ? <p>Ask an administrator to assign <code>AgentControl.Viewer</code> or <code>AgentControl.Admin</code>.</p>
          : issues.length ? <ul className="permission-issue-list">{issues.map(issue => <li key={issue.view.definition.id}>
            <div><strong>{issue.name}</strong><p>{issue.message}</p></div>
            <div className="permission-actions"><IssueAction issue={issue} />
              <button type="button" className="permission-text-button" aria-label={`Details: ${issue.name}`}
                onClick={() => setSelectedId(issue.view.definition.id)}>Details</button>
            </div>
          </li>)}</ul> : !error && !loading && !pending && !awaitingInitialCheck ? <p className="permission-quiet" role="status">No issues reported.</p> : null}
      </section>
      <AppPrerequisites views={views} />
      <InvestigationSetup />
      <SignedInUserRoles />
    </div>
    <WorkbenchDialog open={Boolean(selected)} title={selected?.name ?? "Permission details"}
      className="permission-details" fallbackFocusRef={heading} onClose={() => setSelectedId(undefined)}>
      {selected ? <>
        {notice ? <div className="permission-notice" role="status">{notice}</div> : null}
        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        <PermissionDetails view={selected.view} now={now} />
        <div className="permission-actions"><IssueAction issue={selected} /></div>
      </> : null}
    </WorkbenchDialog>
  </section>;
}

function AppPrerequisites({ views }: { views: CapabilityView[] }) {
  const definitions = views.map(view => view.definition).filter(definition => definition.probe.adapterRegistered && definition.mode !== "local");
  const groups = new Map<string, { label: string; permissions: Map<string, Set<string>> }>([
    ["sign-in", { label: "Sign-in / OpenID Connect", permissions: new Map([
      ["openid", new Set(["Sign-in: authenticate your account using an ID token."])],
      ["profile", new Set(["Sign-in: identify your account and display its name and username."])],
      ["offline_access", new Set(["Session renewal: refresh delegated access tokens without repeated sign-in."])],
    ]) }],
  ]);
  for (const definition of definitions) {
    const key = `${definition.provider}:${definition.mode}`;
    const group = groups.get(key) ?? {
      label: `${definition.provider} / ${definition.mode === "delegated" ? "Delegated" : "Application"}`,
      permissions: new Map<string, Set<string>>(),
    };
    for (const permission of definition.permissions) {
      const uses = group.permissions.get(permission) ?? new Set<string>();
      uses.add(permissionFeatureUses[definition.id]?.[permission] ?? `${definition.displayName}: ${definition.purpose}`);
      group.permissions.set(permission, uses);
    }
    groups.set(key, group);
  }
  return <section className="permission-log-setup permission-prerequisites" aria-labelledby="app-prerequisites-title">
    <header><h3 id="app-prerequisites-title">App prerequisites</h3>
      <a href="https://entra.microsoft.com/" target="_blank" rel="noreferrer">Open Entra admin center <ExternalLink size={14} aria-hidden="true" /></a></header>
    <p className="permission-setup-note">Administrator: add the API permissions in Entra, then <strong>Grant admin consent</strong>.</p>
    <details><summary>Required API permissions</summary>
      <p className="permission-setup-note">App registrations &gt; this app &gt; API permissions. After setup, sign in again. This app does not request or grant permissions.</p>
      {!definitions.length ? <p className="permission-setup-note">The feature permission list is unavailable. Consult the deployment setup guide; this is not an empty requirements list.</p> : null}
      <div className="permission-requirements">{[...groups.entries()].filter(([key]) => !key.endsWith(":application"))
        .map(([key, group]) => <PermissionReference key={key} {...group} />)}</div>
      {[...groups.keys()].some(key => key.endsWith(":application")) ? <details className="permission-optional">
        <summary>Optional application permissions</summary>
        <p className="permission-setup-note">Only for administrator-configured app-only access, using the app's identity instead of a user's token.</p>
        <div className="permission-requirements">{[...groups.entries()].filter(([key]) => key.endsWith(":application"))
          .map(([key, group]) => <PermissionReference key={key} {...group} />)}</div>
      </details> : null}
      <p className="permission-setup-note"><strong>Not used by this app:</strong> <code>User.Read</code>. Sign-in uses the OpenID Connect scopes above.</p>
      <p className="permission-setup-note">Keep <code>CopilotPackages.Read.All</code> and <code>User.ReadBasic.All</code> even with broader grants: the current app requests these read scopes separately.</p>
    </details>
  </section>;
}

function PermissionReference({ label, permissions }: { label: string; permissions: Map<string, Set<string>> }) {
  return <section aria-label={label}>
    <h4>{label}</h4>
    <dl className="permission-feature-list">{[...permissions.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([permission, uses]) => <div key={permission}>
      <dt><code>{permission}</code></dt>
      <dd><ul>{[...uses].map(use => <li key={use}>{use}</li>)}</ul></dd>
    </div>)}</dl>
  </section>;
}

function InvestigationSetup() {
  const defenderSetup = "https://security.microsoft.com/securitysettings/security_for_ai";
  const defenderDocs = "https://learn.microsoft.com/en-us/defender-xdr/security-for-ai/get-started-defender-security-for-ai";
  return <section id="permission-log-setup" className="permission-log-setup permission-collection-setup" aria-label="Log setup">
    <details><summary>Log collection setup</summary>
    <p className="permission-setup-note">Configure connectors and auditing in Microsoft portals.</p>
    <ul className="permission-setup-list">
      <li>
        <div className="permission-setup-heading"><strong>Microsoft 365 connector</strong><span className="permission-setup-tag">For hunting</span>
          <a href={defenderSetup} target="_blank" rel="noreferrer">Open Defender <ExternalLink size={14} aria-hidden="true" /></a></div>
        <p>Connect Entra ID management events and Microsoft 365 activities.</p>
        <details><summary>Steps &amp; permissions</summary>
          <ol><li>Defender: Settings &gt; Security for AI &gt; Get started. Keep agent security Enabled.</li>
            <li>Open Microsoft 365 connector. Select both feeds above; keep Users and groups selected. Verify Connected.</li></ol>
          <dl><div><dt>Setup admin</dt><dd>Security Administrator or higher</dd></div>
            <div><dt>Query access</dt><dd>Defender role and data-source access + <code>ThreatHunting.Read.All</code></dd></div>
            <div><dt>New Studio identity lookup</dt><dd>Prerequisite: delegated <code>AgentIdentity.Read.All</code> with admin consent in the app registration</dd></div>
            <div><dt>License</dt><dd>Agent 365 entitlement and applicable Defender licensing</dd></div></dl>
          <a href={defenderDocs} target="_blank" rel="noreferrer">Microsoft setup guide</a>
        </details>
      </li>
      <li>
        <div className="permission-setup-heading"><strong>Copilot Studio connection</strong><span className="permission-setup-tag">For runtime protection</span>
          <a href={defenderSetup} target="_blank" rel="noreferrer">Connect Copilot Studio <ExternalLink size={14} aria-hidden="true" /></a></div>
        <p>Connect Defender and Power Platform for runtime detection and blocking.</p>
        <details><summary>Steps &amp; permissions</summary>
          <ol><li>On Defender's Get started page, open Copilot Studio and enable Real-time protection.</li>
            <li>Complete the Power Platform connection using the integration URL and matching application ID from the setup guide.</li></ol>
          <dl><div><dt>Setup admins</dt><dd>Security Administrator and Power Platform Administrator</dd></div>
            <div><dt>Purpose</dt><dd>Runtime detection and blocking; not a prerequisite for every audit or hunting record.</dd></div></dl>
          <a href={defenderDocs} target="_blank" rel="noreferrer">Microsoft integration guide</a>
        </details>
      </li>
      <li>
        <div className="permission-setup-heading"><strong>Purview auditing</strong><span className="permission-setup-tag">For audit records</span>
          <a href="https://purview.microsoft.com/audit/auditsearch" target="_blank" rel="noreferrer">Open Audit Search <ExternalLink size={14} aria-hidden="true" /></a></div>
        <p>Check the recording banner, or verify status with Exchange Online PowerShell below.</p>
        <details><summary>Steps &amp; permissions</summary>
          <ol>
            <li>Audit Search: if <strong>Start recording user and admin activity</strong> appears, an Audit Logs administrator can select it to enable auditing.</li>
            <li>No banner? Check below. <strong>No search history</strong> counts searches, not collected audit events; it does not confirm whether auditing is enabled.</li>
            <li>Use <a href="https://learn.microsoft.com/en-us/powershell/exchange/connect-to-exchange-online-powershell" target="_blank" rel="noreferrer">Exchange Online PowerShell</a>, not Security &amp; Compliance PowerShell:</li>
          </ol>
          <pre><code>{"Connect-ExchangeOnline\nGet-AdminAuditLogConfig | Format-List UnifiedAuditLogIngestionEnabled"}</code></pre>
          <p><strong>True</strong> = enabled. <strong>False</strong> = disabled. A command error means status is unknown.</p>
          <p>If False, an Audit Logs administrator can enable it:</p>
          <pre><code>Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $true</code></pre>
          <p>Allow up to 60 minutes, then check again. New events can take several hours to appear.</p>
          <dl><div><dt>Enable auditing</dt><dd>Audit Logs role in Exchange Online</dd></div>
            <div><dt>Read access</dt><dd>Audit Logs or View-Only Audit Logs + <code>AuditLogsQuery.Read.All</code></dd></div>
            <div><dt>Collection</dt><dd>Copilot Studio admin events are collected by default; tenant auditing and licensing still apply.</dd></div></dl>
          <p>Agent view reads saved records only. Portal searches do not populate this app.</p>
          <a href="https://learn.microsoft.com/en-us/purview/audit-log-enable-disable" target="_blank" rel="noreferrer">Microsoft auditing guide</a>
        </details>
      </li>
    </ul>
    </details>
  </section>;
}

function IssueAction({ issue }: { issue: PermissionIssue }) {
  const action = issue.action;
  return action ? <a href={action.href} {...(action.href.startsWith("https://") ? { target: "_blank", rel: "noreferrer" } : {})}>
    {action.label}
  </a> : null;
}