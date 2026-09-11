import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw, ShieldCheck, X } from "lucide-react";
import { appRoles } from "../../../backend/src/types/capability";
import { beginCapabilityConsent, type CapabilityView } from "../api/client";
import { capabilityExplanation, evidenceIsFresh, providerActionAllowed, statusLabels } from "../capabilityState";
import { useCapabilityContext } from "../capabilityContext";
import "./permissions.css";

export function PreviewBadge() {
  const text = "Preview APIs can change and may be disabled by configuration. Writes require separate qualification.";
  return <span className="preview-badge" tabIndex={0} aria-label={text}>Preview<span role="tooltip">{text}</span></span>;
}

export function CapabilityHealth() {
  const { views, loading, error, now, openPermissions } = useCapabilityContext();
  const active = views.filter(view => view.definition.probe.adapterRegistered);
  const available = active.filter(view => providerActionAllowed(view, view.definition.probe.kind === "qualification_only", now)).length;
  const degraded = active.filter(view => ["unknown", "provider_error"].includes(view.decision.status) || (view.decision.status === "available" && !evidenceIsFresh(view, now))).length;
  return <button className="capability-health secondary" type="button" onClick={openPermissions}>
    <ShieldCheck size={18} aria-hidden="true" />
    {loading ? "Checking permissions" : error ? "Permission status unavailable" : `${available} available / ${degraded} degraded / ${active.length - available - degraded} blocked`}
  </button>;
}

export function PermissionCenter() {
  const { views, user, loading, error, pending, now, refresh, reload } = useCapabilityContext();
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
  return <section className="permission-center" aria-labelledby="permissions-title" aria-busy={loading}>
    <header className="permission-heading">
      <div><p className="eyebrow">Current account</p><h2 id="permissions-title" ref={heading} tabIndex={-1}>Permissions</h2></div>
      <button type="button" className="secondary" disabled={loading} onClick={() => void reload()}><RefreshCw size={16} aria-hidden="true" /> Reload status</button>
    </header>
    <div className="permission-notice" role="status">{notice ?? error ?? (loading ? "Loading capability decisions..." : "Availability is scoped to the current account. Consent does not assign Microsoft roles or licenses.")}</div>
    <section className="internal-roles" aria-labelledby="roles-title">
      <h3 id="roles-title">Internal app roles</h3>
      <p>Independent assignments. Administrator does not inherit Reader, Operator, or SecurityReader.</p>
      <ul>{appRoles.map(role => <li key={role}><code>{role}</code><strong>{user?.roles.includes(role) ? "Assigned" : "Not assigned"}</strong></li>)}</ul>
      <a href="https://entra.microsoft.com/" target="_blank" rel="noreferrer">Entra admin center <ExternalLink size={14} aria-hidden="true" /></a>
    </section>
    <div className="permission-list">{views.filter(view => view.definition.probe.adapterRegistered).map(view => {
      const { definition, decision } = view;
      const stale = definition.mode !== "local" && Boolean(decision.checkedAt) && !evidenceIsFresh(view, now);
      return <article className="permission-row" key={definition.id} aria-labelledby={`${definition.id}-title`}>
        <header><div><span className="eyebrow">{definition.provider} / {definition.mode}</span><h3 id={`${definition.id}-title`}>{definition.displayName}</h3></div>
          <span className={`capability-status status-${decision.status}`}>{statusLabels[decision.status]}{stale ? " / stale evidence" : ""}</span>
          {definition.maturity === "preview" && <PreviewBadge />}
        </header>
        <p>{definition.purpose}</p>
        <p className="capability-reason">{capabilityExplanation(view, now)}</p>
        <dl className="permission-metadata">
          <Metadata name="App permission" value={definition.permissions.length ? `${definition.mode}: ${definition.permissions.join(" and ")}` : "No Microsoft API permission"} />
          <Metadata name="Resource audience" value={definition.audience} />
          <Metadata name="Microsoft roles" value={definition.providerRoles.join(" or ") || "No additional Microsoft role documented"} />
          <Metadata name="Internal role" value={definition.internalRoles.join(" or ")} />
          <Metadata name="License" value={definition.licenses.join("; ") || "No additional license documented"} />
          <Metadata name="Cloud / API" value={`${definition.cloud} / ${definition.maturity}`} />
          <Metadata name="Configuration / environment" value={definition.configuration.join("; ") || "No additional configuration"} />
          <Metadata name="Write qualification" value={decision.previewQualification.replaceAll("_", " ")} />
          <Metadata name="Last probe" value={formatTime(decision.checkedAt, definition.mode === "local" ? "Local policy; no provider probe" : "Not probed")} />
          <Metadata name="Last success" value={formatTime(decision.lastSuccessAt, "No provider success recorded")} />
          <Metadata name="Evidence expires" value={formatTime(decision.expiresAt, "Not applicable")} />
          {definition.acceptedPermissions?.length ? <Metadata name="Also accepted, not requested" value={definition.acceptedPermissions.join(" or ")} /> : null}
        </dl>
        <details className="permission-evidence"><summary>Evidence and remediation</summary>
          <p>{definition.probe.description}</p>
          {decision.evidence?.category && <p>Probe category: <code>{decision.evidence.category}</code></p>}
          {decision.evidence?.correlationId && <p>Correlation: <code>{decision.evidence.correlationId}</code></p>}
          <ul>{decision.remediation.map(text => <li key={text}>{text}</li>)}</ul>
        </details>
        <div className="permission-actions">
          {definition.mode === "delegated" && <button type="button" disabled={Boolean(consenting) || !definition.internalRoles.some(role => user?.roles.includes(role))} onClick={() => void consent(view)}>{consenting === definition.id ? "Starting consent..." : "Request consent"}</button>}
          {definition.probe.kind === "provider_read" && <button type="button" className="secondary" disabled={Boolean(pending) || !user?.roles.length} onClick={() => void refresh(definition.id)}><RefreshCw size={16} aria-hidden="true" />{pending === definition.id ? "Probing..." : "Retry probe"}</button>}
          <SetupInstructions view={view} />
          <a href="https://admin.microsoft.com/" target="_blank" rel="noreferrer">Microsoft admin center <ExternalLink size={14} aria-hidden="true" /></a>
          {definition.sources.map((source, index) => <a key={source} href={source} target="_blank" rel="noreferrer">Microsoft documentation{definition.sources.length > 1 ? ` ${index + 1}` : ""} <ExternalLink size={14} aria-hidden="true" /></a>)}
        </div>
      </article>;
    })}</div>
  </section>;
}

function Metadata({ name, value }: { name: string; value: string }) {
  return <div><dt>{name}</dt><dd>{value}</dd></div>;
}

function formatTime(value: string | undefined, empty: string) {
  return value ? new Date(value).toLocaleString() : empty;
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
      {view.definition.mode !== "local" && <p>After setup, return to Permissions and explicitly retry the read probe. Preview writes require separate qualification.</p>}
      <a href="https://entra.microsoft.com/" target="_blank" rel="noreferrer">Entra admin center <ExternalLink size={14} aria-hidden="true" /></a>
    </dialog>
  </>;
}