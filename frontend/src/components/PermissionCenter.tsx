import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { hasRole } from "../authorization";
import { useCapabilityContext } from "../capabilityContext";
import { permissionIssues, type PermissionIssue } from "../permissionIssues";
import { AppRegistrationPermissions } from "./AppRegistrationPermissions";
import { PermissionDetails } from "./PermissionDetails";
import { PermissionCheckProgress } from "./PermissionCheckProgress";
import { SignedInUserRoles } from "./SignedInUserRoles";
import "./permissions.css";

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
  return <section className="permission-center" aria-labelledby="permissions-title" aria-busy={loading || pending}>
    <header className="permission-heading">
      <div className="permission-page-icon"><ShieldCheck size={24} aria-hidden="true" /></div>
      <div className="permission-heading-copy">
        <p className="permission-eyebrow">Access &amp; configuration</p>
        <h2 id="permissions-title" ref={heading} tabIndex={-1}>Permissions</h2>
        <p>Resolve access issues, understand app roles, and configure API permissions.</p>
      </div>
      <div className="permission-actions">
        <button type="button" className="secondary" disabled={!canCheckPermissions || loading || pending} onClick={() => void reload()}>
          {loading || pending ? <LoaderCircle className="permission-spinner" size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
          {loading || pending ? "Checking..." : "Check status"}
        </button>
      </div>
    </header>
    <div className="permission-body">
      <section className="permission-section permission-issues" aria-labelledby="permission-issues-title">
        <header className="permission-section-heading">
          <div><p className="permission-eyebrow">01 / Current access</p><h3 id="permission-issues-title">Issues</h3></div>
          {issues.length > 0 ? <span className="permission-section-count">{issues.length} {issues.length === 1 ? "issue" : "issues"}</span> : null}
        </header>
        <p className="permission-section-intro">Only current failures appear here. Registration requirements remain visible below, even when a check is unavailable.</p>
        {notice ? <div className="permission-notice" role="status">{notice}</div> : null}
        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        {canCheckPermissions && (loading || pending) ? <PermissionCheckProgress loading={loading} activeCheck={activeCheck} views={views} /> : null}
        {!canCheckPermissions ? <div className="permission-role-required">
          <AlertCircle size={20} aria-hidden="true" />
          <p>Ask an administrator to assign <code>AgentControl.Viewer</code>, <code>AgentControl.UsageReportUploader</code> or <code>AgentControl.Admin</code>.</p>
        </div> : issues.length ? <ul className="permission-issue-list">{issues.map(issue => <li key={issue.view.definition.id}>
          <article className="permission-issue" aria-labelledby={`issue-${issue.view.definition.id}`}>
            <header className="permission-issue-heading">
              <AlertCircle size={19} aria-hidden="true" />
              <h4 id={`issue-${issue.view.definition.id}`}>{issue.name}</h4>
              <div className="permission-actions"><IssueAction issue={issue} /></div>
            </header>
            <PermissionDetails view={issue.view} now={now} />
          </article>
        </li>)}</ul> : !error && !loading && !pending && !awaitingInitialCheck ? <div className="permission-quiet" role="status">
          <CheckCircle2 size={20} aria-hidden="true" /><p>No issues reported.</p>
        </div> : null}
      </section>
      <SignedInUserRoles user={user} />
      <AppRegistrationPermissions />
    </div>
  </section>;
}

function IssueAction({ issue }: { issue: PermissionIssue }) {
  const action = issue.action;
  return action ? <a href={action.href} {...(action.href.startsWith("https://") ? { target: "_blank", rel: "noreferrer" } : {})}>
    {action.label}
  </a> : null;
}
