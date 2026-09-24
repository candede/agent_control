import { ExternalLink } from "lucide-react";
import type { CapabilityView } from "../api/client";
import { permissionIssue } from "../permissionIssues";

export function PermissionDetails({ view, now }: { view: CapabilityView; now: number }) {
  const issue = permissionIssue(view, now);
  const { definition } = view;
  const decision = issue?.decision ?? view.decision;
  const evidence = decision.evidence;
  return <>
    {issue ? <p className="permission-detail-explanation">{issue.message}</p> : null}
    <section className="permission-detail-section" aria-label="Required setup">
      <h3>Required setup</h3>
      <dl className="permission-metadata">
        {definition.permissions.length ? <Metadata name="API permissions" value={`${definition.provider} / ${definition.mode}: ${definition.permissions.join(" and ")}`} /> : null}
        {definition.providerRoles.length ? <Metadata name="Microsoft roles" value={definition.providerRoles.join(" or ")} /> : null}
        {definition.licenses.length ? <Metadata name="Licenses" value={definition.licenses.join("; ")} /> : null}
      </dl>
    </section>
    <details className="permission-technical">
      <summary>Technical details</summary>
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
    </details>
    <section className="permission-detail-section" aria-label="Setup and documentation">
      <h3>Setup links</h3>
      <p>Administrator: App registrations &gt; this app &gt; API permissions &gt; Grant admin consent. Then sign in again.</p>
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
