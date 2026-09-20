import { ExternalLink } from "lucide-react";
import { supportsAutomaticCapabilityCheck } from "../../../backend/src/types/capability";
import type { CapabilityView } from "../api/client";
import { capabilityCheckGuidance, capabilityExplanation, capabilityModeEnabled, capabilityNextStep, operationAccessLabel, verificationLabel } from "../capabilityState";

export function PermissionDetails({ view, now }: { view: CapabilityView; now: number }) {
  const { definition, decision } = view;
  const evidence = decision.evidence;
  const nextStep = capabilityNextStep(view, now);
  return <>
    <div className="permission-detail-explanation">
      <p>{capabilityExplanation(view, now)}</p>
      {nextStep ? <p>{nextStep.text}</p> : null}
      {decision.remediation.length ? <ul>{decision.remediation.map(text => <li key={text}>{text}</li>)}</ul> : null}
    </div>
    <section className="permission-detail-section" aria-label="Access requirements">
      <h3>Access requirements</h3>
      <p>Documented requirements, not independently verified role or license assignments.</p>
      <dl className="permission-metadata">
        <Metadata name="Provider / mode" value={`${definition.provider} / ${definition.mode}`} />
        <Metadata name="App permission" value={definition.permissions.length ? `${definition.mode}: ${definition.permissions.join(" and ")}` : "No Microsoft API permission"} />
        <Metadata name="Resource audience" value={definition.audience} />
        <Metadata name="Microsoft roles" value={definition.providerRoles.join(" or ") || "No additional Microsoft role documented"} />
        <Metadata name="Internal role" value={definition.internalRoles.join(" or ")} />
        <Metadata name="License" value={definition.licenses.join("; ") || "No additional license documented"} />
        <Metadata name="Cloud / API" value={`${definition.cloud} / ${definition.maturity}`} />
        <Metadata name="Configuration / environment" value={definition.configuration.join("; ") || "No additional configuration"} />
        {definition.mode === "application" ? <Metadata name="Application mode" value={!capabilityModeEnabled(view) ? "Disabled"
          : view.configuration?.sharedDataScope ? "Enabled with approved shared scope" : "Enabled; shared scope not approved"} /> : null}
        {definition.acceptedPermissions?.length ? <Metadata name="Also accepted for this capability" value={definition.acceptedPermissions.join(" or ")} /> : null}
      </dl>
    </section>
    <section className="permission-detail-section" aria-label="Check evidence">
      <h3>Check evidence</h3>
      <p>{definition.probe.description}</p>
      <dl className="permission-metadata">
        <Metadata name="Verification" value={verificationLabel(view, now)} />
        <Metadata name="Operation access" value={operationAccessLabel(view, now)} />
        <Metadata name="Last check" value={formatTime(decision.checkedAt, definition.mode === "local" ? "Local policy; no provider check" : "Not checked")} />
        <Metadata name="Last recorded success (historical)" value={formatTime(decision.lastSuccessAt, "No successful check recorded")} />
        <Metadata name="Evidence expires" value={formatTime(decision.expiresAt, definition.mode === "local" ? "Not applicable; local policy" : "No expiry recorded")} />
        {evidence?.category ? <Metadata name="Probe category" value={evidence.category} /> : null}
        {evidence?.phase ? <Metadata name="Check stage" value={evidence.phase === "token_acquisition" ? "Microsoft token acquisition" : "Provider read"} /> : null}
        {evidence?.timeoutMs !== undefined ? <Metadata name="Stage timeout budget" value={`${evidence.timeoutMs / 1000} seconds`} /> : null}
        {evidence?.httpStatus !== undefined ? <Metadata name="Provider HTTP status" value={String(evidence.httpStatus)} /> : null}
        {evidence?.providerErrorCode ? <Metadata name="Provider error code" value={evidence.providerErrorCode} /> : null}
        {evidence?.correlationId ? <Metadata name="Provider request / correlation ID" value={evidence.correlationId} /> : null}
      </dl>
      {decision.lastSuccessAt ? <p>The last recorded success is historical and may refer to local policy, token acquisition, or a provider request. It does not establish current availability.</p> : null}
    </section>
    <section className="permission-detail-section" aria-label="Setup and documentation">
      <h3>Setup & documentation</h3>
      <p>Use the tenant's existing app registration and the documented resource permissions. Only an authorized administrator can assign roles, approve consent, or provide licenses. This app cannot grant itself access.</p>
      <p>Keep credentials in restricted local files or the administrator-prepared Key Vault. Never enter provider tokens here.</p>
      {definition.mode !== "local" ? <p>{capabilityCheckGuidance(view)}
        {supportsAutomaticCapabilityCheck(definition.id) ? " Bounded non-mutating delegated checks also run automatically while the signed-in UI is active." : ""}
        {definition.dataClass === "package_control" ? " Provider changes require review and confirmation of exact targets." : ""}
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

function formatTime(value: string | undefined, empty: string) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : empty;
}
