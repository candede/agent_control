import { useEffect, useRef, useState } from "react";
import { CircleHelp, RefreshCw, ShieldCheck } from "lucide-react";
import { appRoles } from "../../../backend/src/types/capability";
import { beginCapabilityConsent, type CapabilityId, type CapabilityView, type SessionUser } from "../api/client";
import { hasRole } from "../authorization";
import { capabilityExplanation, capabilityModeEnabled, capabilityNextStep, capabilityStatusLabel, currentVerification, evidenceIsStale } from "../capabilityState";
import { useCapabilityContext } from "../capabilityContext";
import { PermissionDetails } from "./PermissionDetails";
import { WorkbenchDialog } from "./WorkbenchDialog";
import "./permissions.css";

const permissionGroups = ["Inventory & people", "Agent controls", "Reports & investigations"] as const;

export function PreviewBadge() {
  const text = "Preview APIs can change. Review the exact targets before confirming changes.";
  return <span className="preview-badge" tabIndex={0} aria-label={text}>Preview<span role="tooltip">{text}</span></span>;
}

export function CapabilityHealth() {
  const { views, user, loading, pending, error, now, openPermissions } = useCapabilityContext();
  const canCheckPermissions = hasRole(user, "AgentControl.Viewer");
  const counts = permissionCounts(views, now);
  const description = !canCheckPermissions ? "An internal app role is required to check permissions"
    : loading || pending ? "Checking permissions" : error ? "Permission status unavailable" : `${counts.provider} provider-verified / ${counts.local} local / ${counts.ready} ready to try / ${counts.degraded} degraded / ${counts.blocked} blocked`;
  const attentionCount = counts.degraded + counts.blocked;
  return <button className="capability-health secondary" type="button" onClick={openPermissions} aria-label={description} title={description}>
    <ShieldCheck size={18} aria-hidden="true" />
    {!canCheckPermissions ? "Permissions: role required" : loading || pending ? "Checking permissions" : error ? "Check permissions" : attentionCount ? `Permissions: ${attentionCount} need attention` : "Permissions"}
  </button>;
}

export function PermissionCenter() {
  const { user } = useCapabilityContext();
  const sessionKey = JSON.stringify([user?.tenantId, user?.homeAccountId, [...(user?.roles ?? [])].sort()]);
  return <PermissionCenterContent key={sessionKey} />;
}

function PermissionCenterContent() {
  const { views, user, loading, error, pending, now, reload } = useCapabilityContext();
  const canCheckPermissions = hasRole(user, "AgentControl.Viewer");
  const heading = useRef<HTMLHeadingElement>(null);
  const consentRequest = useRef<AbortController | undefined>(undefined);
  const [consenting, setConsenting] = useState<CapabilityId>();
  const [scope, setScope] = useState<"account" | "application">("account");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<CapabilityId>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [notice, setNotice] = useState(() => {
    const outcome = new URLSearchParams(window.location.search).get("authorization");
    return outcome === "cancelled" ? "Consent was cancelled or denied. Existing permissions are unchanged."
      : outcome === "interaction_required" ? "Microsoft Entra requires further interaction or Conditional Access. Complete the required sign-in steps or contact your administrator."
        : outcome === "failed" ? "Microsoft Entra did not complete authorization. Check sign-in and consent with your administrator." : undefined;
  });
  useEffect(() => {
    heading.current?.focus();
    return () => { consentRequest.current?.abort(); };
  }, []);
  async function consent(view: CapabilityView) {
    if (consentRequest.current) return;
    const controller = new AbortController();
    consentRequest.current = controller;
    setConsenting(view.definition.id);
    setNotice(undefined);
    try {
      const result = await beginCapabilityConsent(view.definition.id, "/permissions", { signal: controller.signal });
      if (!controller.signal.aborted) window.location.assign(result.authorizationUrl);
    } catch {
      if (!controller.signal.aborted) setNotice("Consent could not start. Verify your internal role and sign-in, then retry. Only an authorized tenant administrator can approve restricted consent.");
    } finally {
      if (!controller.signal.aborted) {
        consentRequest.current = undefined;
        setConsenting(undefined);
      }
    }
  }
  const applicationViews = views.filter(view => view.definition.probe.adapterRegistered && view.definition.mode === "application");
  const accountViews = views.filter(view => view.definition.probe.adapterRegistered && view.definition.mode !== "application");
  const activeApplicationCount = applicationViews.filter(capabilityModeEnabled).length;
  const scopedViews = scope === "account" ? accountViews : applicationViews;
  const shownViews = scopedViews.filter(view => !attentionOnly || needsAttention(view, now));
  const counts = permissionCounts(scopedViews, now);
  const selected = views.find(view => view.definition.id === selectedId && view.definition.probe.adapterRegistered);
  if (selectedId && !selected) setSelectedId(undefined);

  return <section className="permission-center" aria-labelledby="permissions-title" aria-busy={loading || pending}>
    <header className="permission-heading">
      <div className="permission-page-icon"><ShieldCheck size={24} aria-hidden="true" /></div>
      <div className="permission-heading-copy">
        <h2 id="permissions-title" ref={heading} tabIndex={-1}>Permissions</h2>
        <p>What {user?.displayName || "your account"} can access, and what to do when access needs attention.</p>
      </div>
      <div className="permission-actions">
        <button type="button" className="permission-text-button" onClick={() => setHelpOpen(true)}><CircleHelp size={16} aria-hidden="true" />How access works</button>
        <button type="button" className="secondary" disabled={!canCheckPermissions || loading || pending} onClick={() => void reload()}><RefreshCw size={16} aria-hidden="true" />{loading || pending ? "Checking..." : "Check status"}</button>
      </div>
    </header>
    <div className="permission-body">
      {!selected && notice ? <div className="permission-notice" role="status">{notice}</div> : null}
      {!selected && error ? <div className="error-banner" role="alert">{error}</div> : null}
      {loading || pending ? <p className="permission-checking" role="status">{loading ? "Loading permission status..." : "Running bounded automatic permission checks. No imports, writes, audit searches, or hunting jobs are started."}</p> : null}
      <section className="permission-account" aria-labelledby="roles-title">
        <h3 id="roles-title">Internal app roles</h3>
        <ul>{appRoles.map(role => <li key={role}><code>{role}</code><strong>{hasRole(user, role) ? role === "AgentControl.Viewer" && !user?.roles.includes(role) ? "Inherited" : "Assigned" : "Not assigned"}</strong></li>)}</ul>
        <p>App roles control local access. Microsoft permissions and licenses are separate.</p>
      </section>
      <div className="permission-controls">
        <div className="permission-scope" role="group" aria-label="Permission scope">
          <button type="button" aria-pressed={scope === "account"} onClick={() => { setScope("account"); setAttentionOnly(false); }}>Account access ({accountViews.length})</button>
          {applicationViews.length ? <button type="button" aria-pressed={scope === "application"} onClick={() => { setScope("application"); setAttentionOnly(false); }}>Shared application modes ({applicationViews.length})</button> : null}
        </div>
        <label className="permission-filter">Show
          <select value={attentionOnly ? "attention" : "all"} onChange={event => setAttentionOnly(event.target.value === "attention")}>
            <option value="all">All capabilities</option>
            <option value="attention">Needs attention</option>
          </select>
        </label>
      </div>
      <section className="permission-access" aria-labelledby="permission-access-title">
        <div className="permission-access-heading">
          <h3 id="permission-access-title">{scope === "account" ? "Account access" : "Shared application access"}</h3>
          <p>{scope === "account" ? "Current account only. Ready to try means Microsoft checks access when you use the feature."
            : `${activeApplicationCount} active, ${applicationViews.length - activeApplicationCount} inactive. These optional Admin-configured modes are not required for account access. Only enabled modes count toward permission health.`}</p>
        </div>
        {scopedViews.length ? <dl className="permission-counts" aria-label={`${scope === "account" ? "Account" : "Enabled application"} access summary`}>
          <div><dt>Provider verified</dt><dd>{counts.provider}</dd></div>
          <div><dt>Ready to try</dt><dd>{counts.ready}</dd></div>
          <div><dt>Local access</dt><dd>{counts.local}</dd></div>
          <div className={counts.degraded + counts.blocked ? "permission-count-attention" : ""}><dt>Needs attention</dt><dd>{counts.degraded + counts.blocked}</dd></div>
        </dl> : null}
        {shownViews.length ? <div className="permission-table-scroll" role="region" aria-label="Permission capabilities" tabIndex={0}>
          <table className="permission-table" aria-label={scope === "account" ? "Account permissions" : "Shared application permissions"}>
            <thead><tr><th scope="col">Capability</th><th scope="col">Access</th><th scope="col">Actions</th></tr></thead>
            {permissionGroups.map(group => {
              const groupViews = shownViews.filter(view => permissionGroup(view) === group);
              return groupViews.length ? <tbody key={group}>
                <tr className="permission-group"><th scope="rowgroup" colSpan={3}>{group}</th></tr>
                {groupViews.map(view => <tr key={view.definition.id} aria-labelledby={`${view.definition.id}-title`}>
                  <th scope="row">
                    <div className="permission-capability-name"><span id={`${view.definition.id}-title`}>{view.definition.displayName}</span>{view.definition.maturity === "preview" ? <PreviewBadge /> : null}</div>
                    <p>{view.definition.purpose}</p>
                    {needsAttention(view, now) ? <p className="permission-row-reason">{capabilityExplanation(view, now)}</p> : null}
                  </th>
                  <td><PermissionStatus view={view} now={now} />
                    <span className="permission-status-context">{verificationSummary(view, now)}</span>
                  </td>
                  <td><PermissionActions view={view} user={user} now={now} consenting={consenting} onConsent={consent} onDetails={() => setSelectedId(view.definition.id)} /></td>
                </tr>)}
              </tbody> : null;
            })}
          </table>
        </div> : !loading && !pending ? <div className="permission-empty">
          <p>{!canCheckPermissions ? "Permission checks require an internal app role. Ask an administrator to assign AgentControl.Viewer or AgentControl.Admin."
            : attentionOnly ? "No capabilities in this view need attention." : "No permission information is available. Use Check status to try again."}</p>
          {attentionOnly ? <button type="button" className="permission-text-button" onClick={() => setAttentionOnly(false)}>Show all capabilities</button> : null}
        </div> : null}
      </section>
    </div>
    <WorkbenchDialog open={Boolean(selected)} title={selected?.definition.displayName ?? "Permission details"} description={selected?.definition.purpose}
      className="permission-details" fallbackFocusRef={heading} onClose={() => setSelectedId(undefined)}>
      {selected ? <>
        {notice ? <div className="permission-notice" role="status">{notice}</div> : null}
        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        <div className="permission-detail-status">
          <PermissionStatus view={selected} now={now} />
          {selected.definition.maturity === "preview" ? <PreviewBadge /> : null}
          <PermissionActions view={selected} user={user} now={now} consenting={consenting} onConsent={consent} />
        </div>
        <PermissionDetails view={selected} now={now} />
      </> : null}
    </WorkbenchDialog>
    <WorkbenchDialog open={helpOpen} title="How access works" className="permission-details" onClose={() => setHelpOpen(false)}>
      <section className="permission-detail-section">
        <h3>Your account and app roles</h3>
        <p>Availability is scoped to the current account. Consent does not assign Microsoft roles or licenses.</p>
        <p>Viewer provides observational access. Admin inherits every Viewer capability and adds supported write, configuration, and import actions.</p>
        <a href="https://entra.microsoft.com/" target="_blank" rel="noreferrer">Manage app roles in Entra admin center</a>
      </section>
      <section className="permission-detail-section">
        <h3>What the statuses mean</h3>
        <p><strong>Provider verified:</strong> a bounded provider request succeeded. Documented roles and licenses are not independently verified.</p>
        <p><strong>Ready to try:</strong> Microsoft validates access when you request the operation. It is not a failure or proof of provider access. Changes require exact-target confirmation.</p>
        <p><strong>Local access:</strong> authorized by this app's policy, without a Microsoft provider check.</p>
        <p><strong>Needs attention:</strong> access is blocked or current verification is unavailable. Open the capability's details for requirements and diagnostics.</p>
      </section>
      <section className="permission-detail-section">
        <h3>Checks and consent</h3>
        <p>Check status retries failed delegated checks, reuses current successful checks, and respects provider throttling cooldowns. Safe checks also run automatically while the signed-in UI is active.</p>
        <p>Checks do not start imports, writes, audit searches, hunting jobs, or shared application operations. Authorized saved data remains readable when provider checks fail.</p>
        <p>Normal sign-in requests all implemented delegated permissions, including package changes. Request consent appears only when a check reports missing permission or required sign-in interaction, not merely because an operation has not been tried.</p>
      </section>
    </WorkbenchDialog>
  </section>;
}

function PermissionActions({ view, user, now, consenting, onConsent, onDetails }: {
  view: CapabilityView;
  user: SessionUser | undefined;
  now: number;
  consenting: CapabilityId | undefined;
  onConsent: (view: CapabilityView) => Promise<void>;
  onDetails?: () => void;
}) {
  const { definition, decision } = view;
  const nextStep = capabilityNextStep(view, now);
  const interactionCategory = decision.evidence?.category;
  const canRequestConsent = definition.mode === "delegated"
    && (decision.status === "missing_permission" || interactionCategory === "interaction_required" || interactionCategory === "authorization_expired")
    && definition.internalRoles.some(role => hasRole(user, role));
  const consentLabel = interactionCategory === "authorization_expired" ? "Sign in again"
    : interactionCategory === "interaction_required" ? "Continue sign-in / consent" : "Request consent";
  return <div className="permission-actions">
    {canRequestConsent ? <button type="button" disabled={Boolean(consenting)} onClick={() => void onConsent(view)}>{consenting === definition.id ? "Starting consent..." : consentLabel}</button> : null}
    {nextStep?.href ? <a href={nextStep.href} {...(nextStep.href.startsWith("https://") ? { target: "_blank", rel: "noreferrer" } : {})}>{nextStep.label}</a> : null}
    {onDetails ? <button type="button" className="permission-text-button" aria-label={`View details for ${definition.displayName}`} onClick={onDetails}>View details</button> : null}
  </div>;
}

function PermissionStatus({ view, now }: { view: CapabilityView; now: number }) {
  const verification = currentVerification(view, now);
  const status = !capabilityModeEnabled(view) ? "disabled"
    : verification === "token" || verification === "on_demand" ? "ready"
      : view.decision.status === "available" && !verification ? "unknown" : view.decision.status;
  const stale = evidenceIsStale(view, now) && view.decision.status !== "available" && capabilityModeEnabled(view);
  return <span className={`capability-status status-${status}`}>{capabilityStatusLabel(view, now)}{stale ? " / stale evidence" : ""}</span>;
}

function verificationSummary(view: CapabilityView, now: number) {
  switch (currentVerification(view, now)) {
    case "provider": return "Provider check succeeded";
    case "local": return "Local app policy";
    case "token":
    case "on_demand": return "Microsoft checks access when used";
    default: return !capabilityModeEnabled(view) ? "Optional mode is off" : "See requirements and check evidence";
  }
}

function permissionGroup({ definition }: CapabilityView): typeof permissionGroups[number] {
  if (definition.dataClass === "package_control" || definition.id === "powerPlatform.quarantine.read") return "Agent controls";
  if (["provider_audit", "hunting", "report_import"].includes(definition.dataClass) || definition.id === "reports.copilotUsage.read") return "Reports & investigations";
  return "Inventory & people";
}

function needsAttention(view: CapabilityView, now: number) {
  return capabilityModeEnabled(view) && !currentVerification(view, now);
}

function permissionCounts(views: CapabilityView[], now: number) {
  const counts = { provider: 0, local: 0, ready: 0, degraded: 0, blocked: 0 };
  for (const view of views.filter(view => view.definition.probe.adapterRegistered && capabilityModeEnabled(view))) {
    const verification = currentVerification(view, now);
    if (verification === "token" || verification === "on_demand") counts.ready++;
    else if (verification) counts[verification]++;
    else if (["unknown", "provider_error", "available"].includes(view.decision.status)
      || (view.definition.mode === "application" && view.decision.status === "not_configured")) counts.degraded++;
    else counts.blocked++;
  }
  return counts;
}