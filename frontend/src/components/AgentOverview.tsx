import { useContext, useMemo, useState, type ReactNode } from "react";
import type { CopilotPackage, CopilotPackageDetail, UnifiedAgentRecord } from "../api/client";
import { agentAccessSummary } from "../../../backend/src/types/agentPresentation";
import { formatPackageFacetLabel } from "../../../backend/src/types/copilotPackage";
import { agentContextConsoles, invokedFlowLimitation } from "../../../backend/src/types/agentContext";
import { getAgentDescription, getSanitizedDescriptionHtml } from "../agentDetails";
import { usageDate } from "../usageInsights";
import { AgentAuthoringTools, AgentAvailability, AgentStatus } from "./UnifiedAgentTable";
import type { useAgentPeople, AgentPerson } from "../useAgentPeople";
import { CapabilityContext } from "../capabilityContext";
import { PackageDetailFreshnessStatus } from "./PackageDetailFreshnessStatus";

const connectorPageSize = 10;

export function AgentOverview({ record, selectedPackage, packageDetail, peopleState, onOpenPerson }: {
  record: UnifiedAgentRecord;
  selectedPackage?: CopilotPackage;
  packageDetail?: CopilotPackageDetail;
  peopleState: ReturnType<typeof useAgentPeople>;
  onOpenPerson?: (id: string) => void;
}) {
  const [connectorOffset, setConnectorOffset] = useState(0);
  const [initialNow] = useState(Date.now);
  const now = useContext(CapabilityContext)?.now ?? initialNow;
  const resource = record.powerPlatformResource;
  const { people, loading: loadingPeople, error: peopleError, unavailable: peopleUnavailable, canRetry, retry: retryPeople } = peopleState;
  const missingName = resource && !resource.displayName?.trim() && record.displayName === resource.nativeId;
  const metadata = packageDetail ?? selectedPackage;
  const observedRecord = packageDetail ? {
    ...record,
    packages: record.packages.map(item => item.id === packageDetail.id ? packageDetail : item),
  } : record;
  const description = getAgentDescription(metadata ?? {});
  const descriptionHtml = useMemo(() => getSanitizedDescriptionHtml(description), [description]);
  const connectors = resource?.details.connectors;
  const connectorCount = resource?.details.distinctPowerPlatformConnectors;
  const operationCount = resource?.details.distinctPowerPlatformConnectorsOperations;
  const partialConnectors = resource?.details.capabilityDetailsTruncated || resource?.details.connectorDetailsStatus === "partial";
  const offset = Math.min(connectorOffset, Math.max(0, Math.ceil((connectors?.length ?? 0) / connectorPageSize) - 1) * connectorPageSize);
  const environment = record.environment?.id.toLowerCase() === record.environmentId?.toLowerCase() ? record.environment : undefined;
  const installationSummary = agentAccessSummary(observedRecord, "deployedTo");
  const observedAt = [
    packageDetail?.observation?.observedAt,
    record.observations.graphPackages?.observedAt,
    record.observations.powerPlatform?.observedAt,
    ...Object.values(record.observations.packageSnapshots).map(observation => observation.observedAt),
  ].filter((value): value is string => Boolean(value)).sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const information: { label: string; value: ReactNode }[] = [
    { label: "Publisher", value: metadata?.publisher },
    { label: "Version", value: metadata?.version },
    { label: "Built with", value: <AgentAuthoringTools record={observedRecord} /> },
    { label: "Type", value: metadata?.type ? formatPackageFacetLabel(metadata.type) : undefined },
    { label: "Created", value: dateValue(resource?.createdAt ?? metadata?.createdDateTime) },
    { label: "Last modified", value: dateValue(resource?.details.lastModifiedAt ?? metadata?.lastModifiedDateTime) },
    { label: "Last published", value: dateValue(resource?.lastPublishedAt) },
    { label: "Last quarantined", value: dateValue(resource?.details.quarantinedAt) },
    { label: "Hosts", value: metadata?.supportedHosts?.map(formatPackageFacetLabel).join(", ") },
    { label: "Channels", value: resource?.details.channels === undefined ? undefined
      : resource.details.channels.map(formatPackageFacetLabel).join(", ") || "None reported" },
    { label: "Categories", value: packageDetail?.categories?.map(formatPackageFacetLabel).join(", ") },
    { label: "Sensitivity", value: packageDetail?.sensitivity ? formatPackageFacetLabel(packageDetail.sensitivity) : undefined },
    { label: "Model", value: resource?.details.model },
    { label: "Authentication", value: resource?.details.authentication },
    { label: "Orchestration", value: resource?.details.orchestration },
    { label: "Web search for knowledge", value: resource?.details.isWebSearchEnabledForKnowledge },
    { label: "Managed solution", value: resource?.details.isManaged },
    { label: "Agent source region", value: resource?.location },
    { label: "Inventory observed", value: dateValue(observedAt) },
  ].filter(item => item.value !== null && item.value !== undefined && item.value !== "");

  return <div className="agent-overview">
    <div className="inventory-detail-grid agent-overview-facts">
      <OverviewFact label="Status" value={<AgentStatus record={observedRecord} />} />
      <OverviewFact label="End-user access" value={<AgentAvailability record={observedRecord} />} />
      <OverviewFact label="Installed for" value={installationSummary ?? (observedRecord.packages.length ? "Unknown" : "Not reported")} />
    </div>
    {record.packages.length > 1 ? <p className="agent-insight-note">Status, end-user access and installation cover all {record.packages.length} published versions. Package description and version are for the selected package; native configuration has its own Power Platform observation.</p> : null}
    {descriptionHtml ? <div className="agent-overview-description rich-description" aria-label="Agent description" dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
      : <p className="agent-overview-description">{description}</p>}
    <PackageDetailFreshnessStatus freshness={packageDetail?.detailFreshness ?? selectedPackage?.detailFreshness} now={now} />
    {missingName ? <p className="agent-insight-note">The saved inventory did not supply an agent name, so its resource ID is shown. This does not establish whether the agent was deleted.</p> : null}
    <section className="agent-overview-section" aria-label="Agent information">
      <h3>Responsibility</h3>
      <Properties values={[
        { label: "Owner", value: people.owner ? <Person value={people.owner} onOpen={onOpenPerson} /> : "Not reported" },
        { label: "Created by", value: people.createdBy ? <Person value={people.createdBy} onOpen={onOpenPerson} /> : "Not reported" },
        { label: "Last modified by", value: people.lastModifiedBy ? <Person value={people.lastModifiedBy} onOpen={onOpenPerson} /> : "Not reported" },
      ]} />
      <p className="agent-insight-note">Ownership, creation and last modification are distinct source relationships, not access assignments or reported usage. A last modifier is not necessarily the current maintainer.</p>
      {loadingPeople ? <p role="status">Resolving agent people...</p> : null}
      {peopleUnavailable ? <p className="agent-insight-note">{peopleUnavailable}</p> : null}
      {peopleError ? <p className="error-banner" role="alert">{peopleError}</p> : null}
      {canRetry ? <button type="button" className="secondary" onClick={retryPeople}>Look up people</button> : null}
      <h3>Environment</h3>
      {environment ? <>
        <Properties values={[
          { label: "Environment name", value: environment.displayName ?? "Not reported" },
          { label: "Region", value: environment.region ?? "Not reported" },
          { label: "Environment type", value: environment.environmentType ?? "Not reported" },
          { label: "Managed environment", value: environment.isManaged ?? "Not reported" },
          ...(environment.groupName ? [{ label: "Environment group", value: environment.groupName }] : []),
          { label: "Environment observed", value: dateValue(environment.observation.observedAt) },
        ]} />
        <p className="agent-insight-note">Saved environment observation, separate from the agent configuration observation.</p>
        {!(Date.parse(environment.observation.expiresAt) > now) ? <p className="notice">The saved environment observation has expired. Refresh Sync before treating it as current.</p> : null}
      </> : <p>{record.environmentId ? "No current authorized saved environment metadata is available for this exact environment."
        : "The saved sources did not establish an environment identity for this agent."}</p>}
      <p><a href={agentContextConsoles.powerPlatform} target="_blank" rel="noreferrer">Power Platform admin center (console landing page)</a></p>
      <h3>Configuration</h3>
      <Properties values={information} />
    </section>
    <section className="agent-overview-section" aria-label="Configured connectors and operations">
      <h3>Configured connectors and operations</h3>
      <p className="agent-insight-note">Source-declared configuration, not observed executions or live connections. Connector details are preview data and reflect the published agent structure, not unpublished changes or the selected Graph package version.</p>
      <Properties values={[
        { label: "Reported connector total", value: connectorCount ?? "Unknown" },
        { label: "Reported operation total", value: operationCount ?? "Unknown" },
        { label: "Configuration observed", value: dateValue(record.observations.powerPlatform?.observedAt) ?? "Not available" },
      ]} />
      {record.observations.powerPlatform && !(Date.parse(record.observations.powerPlatform.expiresAt) > now)
        ? <p className="notice">The saved agent configuration observation has expired. Refresh Sync before treating it as current.</p> : null}
      {connectors !== undefined ? <p>{connectors.length.toLocaleString()} saved connector details; {connectors.reduce((count, connector) => count + (connector.operations?.length ?? 0), 0).toLocaleString()} saved operation details{partialConnectors ? " (partial)" : ""}. These bounded details are separate from reported totals.</p> : null}
      {connectors?.length ? <>
        <ul className="agent-service-list" aria-label="Configured connector details">
          {connectors.slice(offset, offset + connectorPageSize).map((connector, index) => <li key={`${offset + index}:${connector.connectorId}`}>
            <strong>{connector.connectorId}</strong>
            {connector.operations?.length ? <ul>{connector.operations.map((operation, operationIndex) => <li key={operationIndex}>
              <strong>{operation.operationId}</strong>
              <Properties values={[
                { label: "Used as", value: operation.usedAs ?? "Not reported" },
                { label: "Enabled", value: operation.isEnabled ?? "Unknown" },
                { label: "End-user consent required", value: operation.requiresEndUserConsent ?? "Unknown" },
                { label: "Connection provided by", value: operation.connectionProvider ?? "Not reported" },
                { label: "When available", value: operation.whenCanBeUsed
                  ? <span title={operation.whenCanBeUsed}>{formatPackageFacetLabel(operation.whenCanBeUsed)}</span> : "Not reported" },
                { label: "Operation configured by (ID)", value: operation.createdBy ?? "Not reported" },
              ]} />
            </li>)}</ul> : <span>{connector.operations ? "No operations reported in the supplied list." : "Operation details not supplied."}</span>}
          </li>)}
        </ul>
        {connectors.length > connectorPageSize ? <div className="agent-insight-pagination" aria-label="Connector detail pages">
          <span>{offset + 1}-{Math.min(offset + connectorPageSize, connectors.length)} of {connectors.length} saved connectors</span>
          <button type="button" className="secondary" disabled={offset === 0} onClick={() => setConnectorOffset(offset - connectorPageSize)}>Previous connectors</button>
          <button type="button" className="secondary" disabled={offset + connectorPageSize >= connectors.length} onClick={() => setConnectorOffset(offset + connectorPageSize)}>Next connectors</button>
        </div> : null}
      </> : <p>{connectorCount === 0 && !partialConnectors || connectorCount === undefined && connectors !== undefined && !partialConnectors
          ? "No configured connectors were reported."
          : "Configured connector details are not available in the saved observation. Missing details do not mean no configured connectors."}</p>}
      {partialConnectors ? <p className="agent-insight-note">Capability details are partial: fields may be missing, malformed, or limited by the provider or saved projection. Reported totals are retained independently.</p> : null}
      <p className="agent-insight-note">Operation creators configured individual operations; they are not necessarily the agent owner or creator. Names, URLs and plugin metadata do not establish native connector or flow relationships.</p>
      <h4>Invoked flows</h4>
      <p>{invokedFlowLimitation}</p>
      {resource ? <p><a href={agentContextConsoles.copilotStudio} target="_blank" rel="noreferrer">Copilot Studio (console landing page)</a> — for agents authored there, choose the agent and review its tools and flows. Console access uses your Microsoft permissions, not this saved view.</p>
        : <p><a href={agentContextConsoles.microsoft365} target="_blank" rel="noreferrer">Microsoft 365 admin center (console landing page)</a> — review the package in its official console. A Graph package alone does not establish a native flow or Copilot Studio target.</p>}
      <details className="agent-insight-provenance">
        <summary>Configuration and environment source evidence</summary>
        <Properties values={[
          { label: "Environment ID", value: record.environmentId ?? "Not reported" },
          { label: "Environment snapshot", value: environment?.observation.snapshotId ?? "Not available" },
          { label: "Environment snapshot expires", value: dateValue(environment?.observation.expiresAt) ?? "Not available" },
          { label: "Environment group ID", value: environment?.groupId ?? "Not reported" },
          { label: "Configuration snapshot", value: record.observations.powerPlatform?.snapshotId ?? "Not available" },
          { label: "Connector details status", value: resource?.details.connectorDetailsStatus ?? "not_supplied" },
          { label: "Connector source", value: resource?.provenance.connectors?.path ?? "Not supplied" },
        ]} />
        {environment ? <Properties values={Object.entries(environment.provenance).map(([field, source]) => ({
          label: `Environment ${field} source`, value: `${source.sourceSystem}: ${source.path} (${source.maturity})`,
        }))} /> : null}
      </details>
    </section>
  </div>;
}

function Properties({ values }: { values: { label: string; value: ReactNode }[] }) {
  return <dl className="agent-property-grid">{values.map(item => <div key={item.label}><dt>{item.label}</dt>
    <dd>{typeof item.value === "boolean" ? item.value ? "Yes" : "No" : item.value}</dd></div>)}</dl>;
}

function Person({ value, onOpen }: { value: AgentPerson; onOpen?: (id: string) => void }) {
  const navigable = !value.invalidId && !value.expired && value.status === "resolved";
  return <span className="agent-person">
    <span>{value.displayName || value.address || value.id}</span>
    {value.address ? <small>Sign-in: {value.address}</small> : null}
    {value.displayName || value.address ? <small>ID: {value.id}</small> : null}
    {value.observedAt ? <small>Saved directory: {usageDate(value.observedAt)}</small> : null}
    {value.checkedAt && value.checkedAt !== value.observedAt ? <small>Last lookup attempt: {usageDate(value.checkedAt)}</small> : null}
    {value.status === "not_found" ? <small>User not found at the last directory lookup.</small> : null}
    {value.status === "lookup_failed" ? <small>Directory lookup failed.{value.displayName || value.address ? " Last known identity shown." : ""}</small> : null}
    {value.expired ? <small>Saved lookup expired.</small> : null}
    {value.invalidId ? <small>The saved identifier is not a resolvable Entra user ID.</small>
      : value.status === "unverified" ? <small>Unverified directory identity.</small> : null}
    {navigable && onOpen ? <button type="button" className="secondary" onClick={() => onOpen(value.id.toLowerCase())}>View responsibility for {value.displayName || value.address || value.id}</button>
      : !navigable ? <small>User navigation unavailable until this exact identity is resolved.</small> : null}
  </span>;
}

function OverviewFact({ label, value }: { label: string; value: ReactNode }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function dateValue(value: string | null | undefined) {
  return value ? <time dateTime={value}>{usageDate(value)}</time> : undefined;
}
