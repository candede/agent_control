import { ExternalLink } from "lucide-react";
import type { CapabilityView } from "../api/client";
import { permissionIssue } from "../permissionIssues";

export function PermissionDetails({ view, now }: { view: CapabilityView; now: number }) {
  const issue = permissionIssue(view, now);
  const { definition } = view;
  const decision = issue?.decision ?? view.decision;
  const evidence = decision.evidence;
  const applicationAuthorizationFailure = definition.mode === "application"
    && ["interaction_required", "authorization_expired"].includes(evidence?.category ?? "");
  return <>
    {issue ? <p className="permission-detail-explanation">{issue.message}</p> : null}
    <section className="permission-detail-section" aria-label="Required setup">
      <h5>Required setup</h5>
      <dl className="permission-metadata">
        {definition.permissions.length ? <Metadata name="API permissions" value={`${definition.provider} / ${definition.mode}: ${definition.permissions.join(" and ")}`} /> : null}
        {definition.providerRoles.length ? <Metadata name="Microsoft roles" value={definition.providerRoles.join(" or ")} /> : null}
        {definition.licenses.length ? <Metadata name="Licenses" value={definition.licenses.join("; ")} /> : null}
      </dl>
    </section>
    <section className="permission-technical" aria-label="Technical details">
      <h5>Check details</h5>
      <dl className="permission-metadata">
        <Metadata name="Resource audience" value={definition.audience} />
        <Metadata name="Cloud / API" value={`${definition.cloud} / ${definition.maturity}`} />
        {decision.checkedAt && Number.isFinite(Date.parse(decision.checkedAt)) ? <Metadata name="Reported at" value={new Date(decision.checkedAt).toLocaleString()} /> : null}
        {evidence?.category ? <Metadata name="Error category" value={evidence.category} /> : null}
        {evidence?.phase ? <Metadata name="Check stage" value={evidence.phase === "token_acquisition" ? "Microsoft token acquisition" : "Provider read"} /> : null}
        {evidence?.httpStatus !== undefined ? <Metadata name="Provider HTTP status" value={String(evidence.httpStatus)} /> : null}
        {evidence?.providerErrorCode ? <Metadata name="Provider error code" value={evidence.providerErrorCode} /> : null}
        {evidence?.correlationId ? <Metadata name="Provider request / correlation ID" value={evidence.correlationId} /> : null}
      </dl>
      {issue && decision.remediation.length ? <ul>{decision.remediation.map(text => <li key={text}>{text}</li>)}</ul> : null}
    </section>
    <section className="permission-detail-section" aria-label="Setup and documentation">
      <h5>Setup links</h5>
      {issue && (decision.status === "missing_permission" || applicationAuthorizationFailure) ? <p>
        Administrator: {applicationAuthorizationFailure
          ? "Review the existing application grants in App registrations > this app > API permissions."
          : "App registrations > this app > API permissions > Grant admin consent."} {definition.mode === "application"
          ? "Verify the application's credentials, then retry the application read. User sign-in does not repair app-only authorization."
          : "Then sign in again."}
      </p> : null}
      <div className="permission-actions">
        <a href="https://entra.microsoft.com/" target="_blank" rel="noreferrer">Entra admin center <ExternalLink size={14} aria-hidden="true" /></a>
        <a href="https://admin.microsoft.com/" target="_blank" rel="noreferrer">Microsoft admin center <ExternalLink size={14} aria-hidden="true" /></a>
        {definition.sources.map((source, index) => <a key={source} href={source} target="_blank" rel="noreferrer">Microsoft documentation{definition.sources.length > 1 ? ` ${index + 1}` : ""} <ExternalLink size={14} aria-hidden="true" /></a>)}
      </div>
    </section>
  </>;
}

function Metadata({ name, value }: { name: string; value: string }) {
  return <div><dt>{name}</dt><dd>{value}</dd></div>;
}
