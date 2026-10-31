import { ExternalLink } from "lucide-react";
import type { AppRole, SessionUser } from "../api/client";
import { hasRole } from "../authorization";

const appRoleRequirements: readonly {
  role: AppRole; title: string; summary: string; permissions: readonly string[]; note: string;
}[] = [
  {
    role: "AgentControl.Viewer", title: "Viewer", summary: "Read and refresh adoption data.",
    permissions: [
      "View shared agents, users, saved reports and sync results.",
      "Use automatic Graph read-only sync through the application identity.",
      "Sync Power Platform when your Microsoft account has the required access.",
    ],
    note: "No signed-in Microsoft directory or reporting reader role is required for Graph sync.",
  },
  {
    role: "AgentControl.UsageReportUploader", title: "Usage Report Uploader", summary: "Contribute new usage reports.",
    permissions: [
      "Includes all Viewer capabilities.",
      "Upload, validate and publish new CSV report sets.",
      "Discard your own unaccepted drafts.",
    ],
    note: "No Graph permission is needed to upload. Published-report corrections, selection and deletion require Admin.",
  },
  {
    role: "AgentControl.Admin", title: "Admin", summary: "Manage the app and administrative changes.",
    permissions: [
      "Includes all Viewer and Uploader capabilities.",
      "Block or unblock packages, change access, and quarantine or restore Studio agents.",
      "View and export local administrative audit logs.",
      "Manage published reports and application configuration.",
    ],
    note: "Provider changes also require the signed-in user's delegated permission, applicable Microsoft role and license.",
  },
];

export function SignedInUserRoles({ user }: { user?: SessionUser }) {
  return <section className="permission-section permission-user-roles" aria-labelledby="app-roles-title">
    <header className="permission-section-heading">
      <div><p className="permission-eyebrow">02 / Application access</p><h3 id="app-roles-title">App-defined roles</h3></div>
      <a className="permission-reference-link" href="https://entra.microsoft.com/" target="_blank" rel="noreferrer">
        Assign app roles<ExternalLink size={14} aria-hidden="true" />
      </a>
    </header>
    <p className="permission-section-intro">Assign these roles in Enterprise applications &gt; this app &gt; Users and groups. App roles control Agent Control access, not Microsoft provider permissions.</p>
    <div className="permission-role-list">
      {appRoleRequirements.map(requirement => {
        const assigned = user?.roles.includes(requirement.role) ?? false;
        return <article key={requirement.role} aria-label={requirement.title} className={`permission-role-card${assigned ? " is-assigned" : ""}`}>
          <div className="permission-role-card-heading">
            <h4>{requirement.title}</h4>
            {assigned ? <span className="permission-role-badge">Assigned to you</span>
              : hasRole(user, requirement.role) ? <span className="permission-role-badge is-inherited">Included</span> : null}
          </div>
          <code>{requirement.role}</code>
          <p className="permission-role-summary">{requirement.summary}</p>
          <ul>{requirement.permissions.map(permission => <li key={permission}>{permission}</li>)}</ul>
          <p className="permission-role-note">{requirement.note}</p>
        </article>;
      })}
    </div>
    <div className="permission-principle">
      <span className="permission-principle-mark" aria-hidden="true">i</span>
      <p><strong>App role and Microsoft access are separate.</strong> Admin does not grant Microsoft permissions. Application read permissions never authorize provider changes.</p>
    </div>
    <p className="permission-section-note">CSV downloads take place in the Microsoft 365 admin center and require Reports Reader or AI Administrator. Usage Summary Reports Reader does not include user details.</p>
  </section>;
}
