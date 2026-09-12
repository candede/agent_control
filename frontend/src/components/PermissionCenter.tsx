import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw, ShieldCheck, X } from "lucide-react";
import { appRoles } from "../../../backend/src/types/capability";
import { beginCapabilityConsent, type CapabilityView } from "../api/client";
import { hasRole } from "../authorization";
import { capabilityExplanation, capabilityModeEnabled, capabilityNextStep, capabilityStatusLabel, currentVerification, evidenceIsStale, operationAccessLabel, verificationLabel } from "../capabilityState";
import { useCapabilityContext } from "../capabilityContext";
import "./permissions.css";

export function PreviewBadge() {
  const text = "Preview APIs can change. Review the exact targets before confirming changes.";
  return <span className="preview-badge" tabIndex={0} aria-label={text}>Preview<span role="tooltip">{text}</span></span>;
}

export function CapabilityHealth() {
  const { views, loading, pending, error, now, openPermissions } = useCapabilityContext();
  const active = views.filter(view => view.definition.probe.adapterRegistered
    && (view.definition.mode !== "application" || applicationModeEnabled(view)));
  const counts = { provider: 0, local: 0, ready: 0, degraded: 0, blocked: 0 };
  for (const view of active) {
    const verification = currentVerification(view, now);
    if (verification === "token" || verification === "on_demand") counts.ready++;
    else if (verification) counts[verification]++;
    else if (["unknown", "provider_error", "available"].includes(view.decision.status)
      || (view.definition.mode === "application" && view.decision.status === "not_configured")) counts.degraded++;
    else counts.blocked++;
  }
  return <button className="capability-health secondary" type="button" onClick={openPermissions}>
    <ShieldCheck size={18} aria-hidden="true" />
    {loading || pending ? "Checking permissions" : error ? "Permission status unavailable" : `${counts.provider} provider-verified / ${counts.local} local / ${counts.ready} ready to try / ${counts.degraded} degraded / ${counts.blocked} blocked`}
  </button>;
}

export function PermissionCenter() {
  const { views, user, loading, error, pending, now, reload } = useCapabilityContext();
  const heading = useRef<HTMLHeadingElement>(null);
  const [consenting, setConsenting] = useState<string>();
  const [notice, setNotice] = useState(() => {
    const outcome = new URLSearchParams(window.location.search).get("authorization");
    return outcome === "cancelled" ? "Consent was cancelled or denied. Existing permissions are unchanged."
      : outcome === "interaction_required" ? "Microsoft Entra requires further interaction or Conditional Access. Complete the required sign-in steps or contact your administrator."
        : outcome === "failed" ? "Microsoft Entra did not complete authorization. Check sign-in and consent with your administrator." : undefined;
  });
  useEffect(() => { heading.current?.focus(); }, []);
  async function consent(view: CapabilityView) {
    setConsenting(view.definition.id);
    try {
      const result = await beginCapabilityConsent(view.definition.id, "/permissions");
      window.location.assign(result.authorizationUrl);
    } catch { setNotice("Consent could not start. Verify your internal role and sign-in, then retry. Only an authorized tenant administrator can approve restricted consent."); }
    finally { setConsenting(undefined); }
  }
  const applicationViews = views.filter(view => view.definition.probe.adapterRegistered && view.definition.mode === "application");
  const activeApplicationCount = applicationViews.filter(applicationModeEnabled).length;
  return <section className="permission-center" aria-labelledby="permissions-title" aria-busy={loading}>
    <header className="permission-heading">
      <div><p className="eyebrow">Current account</p><h2 id="permissions-title" ref={heading} tabIndex={-1}>Permissions</h2></div>
      <button type="button" className="secondary" disabled={loading || pending} onClick={() => void reload()}><RefreshCw size={16} aria-hidden="true" />{loading || pending ? "Checking..." : "Check status"}</button>
    </header>
    <div className="permission-notice" role="status">{notice ?? error ?? (loading ? "Loading capability decisions..." : pending ? "Running bounded automatic permission checks. No imports, writes, audit searches, or hunting jobs are started." : "Availability is scoped to the current account. Consent does not assign Microsoft roles or licenses.")}</div>
    <p>Check status retries failed delegated checks, reuses current successful checks, and respects provider throttling cooldowns. Ready to try means Microsoft validates permission when you request the operation. Changes require exact-target confirmation.</p>
    <p>Normal sign-in requests all implemented delegated permissions, including package changes. Request consent appears only when a check reports missing permission or required sign-in interaction, not merely because an operation has not been tried.</p>
    <section className="internal-roles" aria-labelledby="roles-title">
      <h3 id="roles-title">Internal app roles</h3>
      <p>Viewer provides observational access. Admin inherits every Viewer capability and adds supported write, configuration, and import actions.</p>
      <ul>{appRoles.map(role => <li key={role}><code>{role}</code><strong>{hasRole(user, role) ? role === "AgentControl.Viewer" && !user?.roles.includes(role) ? "Inherited" : "Assigned" : "Not assigned"}</strong></li>)}</ul>
      <a href="https://entra.microsoft.com/" target="_blank" rel="noreferrer">Entra admin center <ExternalLink size={14} aria-hidden="true" /></a>
    </section>
    <div className="permission-list">{renderCapabilityRows(views.filter(view => view.definition.probe.adapterRegistered && view.definition.mode !== "application"), user, now, consenting, consent)}</div>
    {applicationViews.length ? <details className="permission-optional-modes">
      <summary>Optional shared application modes ({activeApplicationCount} active, {applicationViews.length - activeApplicationCount} inactive)</summary>
      <p>These Admin-configured shared modes are not required for delegated installation and are excluded from the primary permission-health summary.</p>
      <div className="permission-list">{renderCapabilityRows(applicationViews, user, now, consenting, consent)}</div>
    </details> : null}
  </section>;
}

function renderCapabilityRows(
  views: CapabilityView[],
  user: ReturnType<typeof useCapabilityContext>["user"],
  now: number,
  consenting: string | undefined,
  consent: (view: CapabilityView) => Promise<void>,
) {
  return views.map(view => {
      const { definition, decision } = view;
      const nextStep = capabilityNextStep(view, now);
      const stale = evidenceIsStale(view, now) && decision.status !== "available";
      const interactionCategory = decision.evidence?.category;
      const canRequestConsent = definition.mode === "delegated"
        && (decision.status === "missing_permission" || interactionCategory === "interaction_required" || interactionCategory === "authorization_expired")
        && definition.internalRoles.some(role => hasRole(user, role));
      const consentLabel = interactionCategory === "authorization_expired" ? "Sign in again"
        : interactionCategory === "interaction_required" ? "Continue sign-in / consent" : "Request consent";
      return <article className="permission-row" key={definition.id} aria-labelledby={`${definition.id}-title`}>
        <header><div><span className="eyebrow">{definition.provider} / {definition.mode}</span><h3 id={`${definition.id}-title`}>{definition.displayName}</h3></div>
          <span className={`capability-status status-${decision.status}`}>{capabilityStatusLabel(view, now)}{stale ? " / stale evidence" : ""}</span>
          {definition.maturity === "preview" && <PreviewBadge />}
        </header>
        <p>{definition.purpose}</p>
        <p className="capability-reason">{capabilityExplanation(view, now)}</p>
        {nextStep && <p>{nextStep.text}</p>}
        <dl className="permission-metadata">
          <Metadata name="App permission" value={definition.permissions.length ? `${definition.mode}: ${definition.permissions.join(" and ")}` : "No Microsoft API permission"} />
          <Metadata name="Resource audience" value={definition.audience} />
          <Metadata name="Microsoft roles" value={definition.providerRoles.join(" or ") || "No additional Microsoft role documented"} />
          <Metadata name="Internal role" value={definition.internalRoles.join(" or ")} />
          <Metadata name="License" value={definition.licenses.join("; ") || "No additional license documented"} />
          <Metadata name="Cloud / API" value={`${definition.cloud} / ${definition.maturity}`} />
          <Metadata name="Configuration / environment" value={definition.configuration.join("; ") || "No additional configuration"} />
          {definition.mode === "application" ? <Metadata name="Application mode" value={applicationModeLabel(view)} /> : null}
          <Metadata name="Verification" value={verificationLabel(view, now)} />
          <Metadata name="Operation access" value={operationAccessLabel(view, now)} />
          <Metadata name="Last check" value={formatTime(decision.checkedAt, definition.mode === "local" ? "Local policy; no provider check" : "Not checked")} />
          <Metadata name="Last recorded success (historical)" value={formatTime(decision.lastSuccessAt, "No successful check recorded")} />
          <Metadata name="Evidence expires" value={formatTime(decision.expiresAt, definition.mode === "local" ? "Not applicable; local policy" : "No expiry recorded")} />
          {definition.acceptedPermissions?.length ? <Metadata name="Also accepted for this capability" value={definition.acceptedPermissions.join(" or ")} /> : null}
        </dl>
        <details className="permission-evidence"><summary>Evidence and remediation</summary>
          <p>{definition.probe.description}</p>
          {decision.lastSuccessAt && <p>The last recorded success is historical and may refer to local policy, token acquisition, or a provider request. It does not establish current availability.</p>}
          {decision.evidence?.category && <p>Probe category: <code>{decision.evidence.category}</code></p>}
          {decision.evidence?.phase && <p>Check stage: {decision.evidence.phase === "token_acquisition" ? "Microsoft token acquisition" : "Provider read"}</p>}
          {decision.evidence?.timeoutMs && <p>Stage timeout budget: {decision.evidence.timeoutMs / 1000} seconds</p>}
          {decision.evidence?.httpStatus !== undefined && <p>Provider HTTP status: <code>{decision.evidence.httpStatus}</code></p>}
          {decision.evidence?.providerErrorCode && <p>Provider error code: <code>{decision.evidence.providerErrorCode}</code></p>}
          {decision.evidence?.correlationId && <p>Provider request / correlation ID: <code>{decision.evidence.correlationId}</code></p>}
          <ul>{decision.remediation.map(text => <li key={text}>{text}</li>)}</ul>
        </details>
        <div className="permission-actions">
          {nextStep?.href && <a href={nextStep.href} {...(nextStep.href.startsWith("https://") ? { target: "_blank", rel: "noreferrer" } : {})}>{nextStep.label}</a>}
          {canRequestConsent && <button type="button" disabled={Boolean(consenting)} onClick={() => void consent(view)}>{consenting === definition.id ? "Starting consent..." : consentLabel}</button>}
          <SetupInstructions view={view} />
          <a href="https://admin.microsoft.com/" target="_blank" rel="noreferrer">Microsoft admin center <ExternalLink size={14} aria-hidden="true" /></a>
          {definition.sources.map((source, index) => <a key={source} href={source} target="_blank" rel="noreferrer">Microsoft documentation{definition.sources.length > 1 ? ` ${index + 1}` : ""} <ExternalLink size={14} aria-hidden="true" /></a>)}
        </div>
      </article>;
    });
}

function applicationModeEnabled(view: CapabilityView) {
  return view.definition.mode === "application" && capabilityModeEnabled(view);
}

function applicationModeLabel(view: CapabilityView) {
  if (!applicationModeEnabled(view)) return "Disabled";
  return view.configuration?.sharedDataScope ? "Enabled with approved shared scope" : "Enabled; shared scope not approved";
}

function Metadata({ name, value }: { name: string; value: string }) {
  return <div><dt>{name}</dt><dd>{value}</dd></div>;
}

function formatTime(value: string | undefined, empty: string) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : empty;
}

function SetupInstructions({ view }: { view: CapabilityView }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="secondary" onClick={() => dialog.current?.showModal()}>Setup instructions</button>
    <dialog ref={dialog} className="permission-dialog" aria-label={`${view.definition.displayName} setup`} onClose={() => trigger.current?.focus()} onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]');
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header><h2>Setup instructions</h2><button type="button" className="secondary icon-button" aria-label="Close setup instructions" onClick={() => dialog.current?.close()}><X size={18} aria-hidden="true" /></button></header>
      <p>{view.definition.displayName}</p>
      <ul>{view.definition.configuration.map(item => <li key={item}>{item}</li>)}<li>Required internal role: {view.definition.internalRoles.join(" or ")}.</li></ul>
      <p>Use the tenant's existing app registration and the documented resource permissions. Only an authorized administrator can assign roles, approve consent, or provide licenses. This app cannot grant itself access.</p>
      <p>Keep credentials in restricted local files or the administrator-prepared Key Vault. Never enter provider tokens here.</p>
      {view.definition.mode !== "local" && <p>After setup, return to Permissions. Bounded non-mutating checks run automatically while the signed-in UI is active. Provider changes run only after you review and confirm the exact targets.</p>}
      <a href="https://entra.microsoft.com/" target="_blank" rel="noreferrer">Entra admin center <ExternalLink size={14} aria-hidden="true" /></a>
    </dialog>
  </>;
}