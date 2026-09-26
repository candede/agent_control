import { useContext, useMemo, useState, type ReactNode } from "react";
import type { CopilotPackage, CopilotPackageDetail, UnifiedAgentRecord } from "../api/client";
import { agentAccessSummary, agentColumnValue } from "../../../backend/src/types/agentPresentation";
import { formatPackageFacetLabel, formatPackageType } from "../../../backend/src/types/copilotPackage";
import { powerPlatformAuthoringTool } from "../../../backend/src/types/powerPlatformInventory";
import { getAgentDescription, getSanitizedDescriptionHtml } from "../agentDetails";
import { usageDate } from "../usageInsights";
import { AgentAvailability, AgentStatus } from "./UnifiedAgentTable";
import type { useAgentPeople, AgentPerson } from "../useAgentPeople";
import { CapabilityContext } from "../capabilityContext";

const connectorPageSize = 10;
type Property = { label: string; value: ReactNode; wide?: boolean };

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
  const description = packageDetail?.longDescription?.trim() || metadata?.shortDescription?.trim()
    ? getAgentDescription(metadata ?? {}) : "";
  const descriptionHtml = useMemo(() => getSanitizedDescriptionHtml(description), [description]);
  const connectors = resource?.details.connectors;
  const connectorCount = resource?.details.distinctPowerPlatformConnectors;
  const operationCount = resource?.details.distinctPowerPlatformConnectorsOperations;
  const partialConnectors = resource?.details.capabilityDetailsTruncated || resource?.details.connectorDetailsStatus === "partial";
  const offset = Math.min(connectorOffset, Math.max(0, Math.ceil((connectors?.length ?? 0) / connectorPageSize) - 1) * connectorPageSize);
  const environment = record.environment?.id.toLowerCase() === record.environmentId?.toLowerCase() ? record.environment : undefined;
  const installationSummary = agentAccessSummary(observedRecord, "deployedTo");
  const information = properties([
    { label: "Publisher", value: metadata?.publisher },
    { label: "Built with", value: agentColumnValue(observedRecord, "builtWith") },
    { label: "Agent type", value: metadata?.type ? formatPackageType(metadata.type) : undefined },
    { label: "Version", value: metadata?.version },
    { label: "Hosts", value: metadata?.supportedHosts?.map(formatPackageFacetLabel).join(", ") },
    { label: "Categories", value: packageDetail?.categories?.map(formatPackageFacetLabel).join(", ") },
    { label: "Sensitivity", value: packageDetail?.sensitivity ? formatPackageFacetLabel(packageDetail.sensitivity) : undefined },
  ]);
  const dates = properties([
    { label: "Created", value: dateValue(resource?.createdAt ?? metadata?.createdDateTime) },
    { label: "Last modified", value: dateValue(resource?.details.lastModifiedAt ?? metadata?.lastModifiedDateTime) },
    { label: "Last published", value: dateValue(resource?.lastPublishedAt) },
    { label: "Last quarantined", value: dateValue(resource?.details.quarantinedAt) },
  ]);
  const responsibility = properties([
    { label: "Owner", value: people.owner && <Person value={people.owner} onOpen={onOpenPerson} /> },
    { label: "Created by", value: people.createdBy && <Person value={people.createdBy} onOpen={onOpenPerson} /> },
    { label: "Last modified by", value: people.lastModifiedBy && <Person value={people.lastModifiedBy} onOpen={onOpenPerson} /> },
  ]);
  const configuration = properties([
    { label: "Model", value: resource?.details.model },
    { label: "Authentication", value: resource?.details.authentication },
    { label: "Orchestration", value: resource?.details.orchestration },
    { label: "Web search for knowledge", value: resource?.details.isWebSearchEnabledForKnowledge },
    { label: "Channels", value: resource?.details.channels === undefined ? undefined
      : resource.details.channels.map(formatPackageFacetLabel).join(", ") || "None reported" },
    { label: "Managed solution", value: resource?.details.isManaged },
    { label: "Agent region", value: resource?.location?.toLowerCase() !== environment?.region?.toLowerCase() ? resource?.location : undefined },
    { label: "Authoring source", value: resource && !powerPlatformAuthoringTool(resource) ? resource.details.createdIn : undefined },
  ]);
  const nativeBotId = resource?.identifiers.find(item => item.kind === "cds_bot_id")?.value;
  const identifiers = properties([
    { label: "Agent ID", value: resource?.nativeId },
    { label: "Schema name", value: resource?.details.schemaName },
    { label: "Bot ID", value: nativeBotId?.toLowerCase() !== resource?.nativeId.toLowerCase() ? nativeBotId : undefined },
    { label: "Entra agent ID", value: resource?.identifiers.find(item => item.kind === "entra_agent_id")?.value },
    { label: "Package ID", value: metadata?.id },
    { label: "Package app ID", value: metadata?.appId },
  ]);

  return <div className="agent-overview">
    <div className="inventory-detail-grid agent-overview-facts">
      <OverviewFact label="Status" value={<AgentStatus record={observedRecord} />} />
      <OverviewFact label="End-user access" value={<AgentAvailability record={observedRecord} />} />
      <OverviewFact label="Installed for" value={installationSummary ?? (observedRecord.packages.length ? "Unknown" : "Not reported")} />
    </div>
    {record.packages.length > 1 ? <p className="agent-insight-note">Status and access summarize all {record.packages.length} published versions.</p> : null}
    {missingName ? <p className="agent-insight-note">Agent name not reported; showing its resource ID.</p> : null}
    <section className="agent-overview-information" aria-label="Agent information">
      {description || information.length || dates.length ? <section className="agent-overview-section" aria-label="About">
        <h3>About</h3>
        {descriptionHtml ? <div className="agent-overview-description rich-description" aria-label="Agent description" dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
          : description ? <p className="agent-overview-description">{description}</p> : null}
        <Properties values={information} />
        {dates.length ? <div className="agent-overview-dates"><Properties values={dates} /></div> : null}
      </section> : null}
      <div className="agent-overview-columns">
        {responsibility.length || loadingPeople || peopleUnavailable || peopleError || canRetry ? <section className="agent-overview-section" aria-label="Responsibility">
          <h3>Responsibility</h3>
          <Properties values={responsibility} />
          {loadingPeople ? <p role="status">Resolving agent people...</p> : null}
          {peopleUnavailable ? <p className="agent-insight-note">{peopleUnavailable}</p> : null}
          {peopleError ? <p className="error-banner" role="alert">{peopleError}</p> : null}
          {canRetry ? <button type="button" className="secondary" onClick={retryPeople}>Look up people</button> : null}
        </section> : null}
        {record.environmentId ? <section className="agent-overview-section" aria-label="Environment">
          <h3>Environment</h3>
          <Properties values={properties([
            { label: "Environment name", value: environment?.displayName },
            { label: "Region", value: environment?.region },
            { label: "Environment type", value: environment?.environmentType },
            { label: "Managed environment", value: environment?.isManaged },
            { label: "Environment group", value: environment?.groupName },
            { label: "Environment ID", value: record.environmentId, wide: true },
          ])} />
          {environment ? !(Date.parse(environment.observation.expiresAt) > now)
            ? <p className="notice">Environment details are out of date. Refresh them in Sync.</p> : null
            : <p>Environment details are unavailable. Check inventory coverage in Sync.</p>}
        </section> : null}
      </div>
      {configuration.length ? <section className="agent-overview-section" aria-label="Configuration">
        <h3>Configuration</h3>
        <Properties values={configuration} />
      </section> : null}
    </section>
    {resource ? <section className="agent-overview-section" aria-label="Configured connectors and operations">
      <h3>Configured connectors and operations</h3>
      <Properties values={properties([
        { label: "Connectors", value: connectorCount },
        { label: "Operations", value: operationCount },
      ])} />
      {record.observations.powerPlatform && !(Date.parse(record.observations.powerPlatform.expiresAt) > now)
        ? <p className="notice">Configuration details have expired. Refresh them in Sync.</p> : null}
      {connectors?.length ? <>
        <ul className="agent-service-list" aria-label="Configured connector details">
          {connectors.slice(offset, offset + connectorPageSize).map((connector, index) => <li key={`${offset + index}:${connector.connectorId}`}>
            <strong>{connector.connectorId}</strong>
            {connector.operations?.length ? <ul>{connector.operations.map((operation, operationIndex) => <li key={operationIndex}>
              <strong>{operation.operationId}</strong>
              <Properties values={properties([
                { label: "Used as", value: operation.usedAs },
                { label: "Enabled", value: operation.isEnabled },
                { label: "End-user consent required", value: operation.requiresEndUserConsent },
                { label: "Connection provided by", value: operation.connectionProvider },
                { label: "When available", value: operation.whenCanBeUsed
                  ? formatPackageFacetLabel(operation.whenCanBeUsed) : undefined },
                { label: "Operation configured by (ID)", value: operation.createdBy, wide: true },
              ])} />
            </li>)}</ul> : <span>{connector.operations
              ? partialConnectors ? "Operation details are incomplete." : "No operations reported."
              : "Operation details not supplied."}</span>}
          </li>)}
        </ul>
        {connectors.length > connectorPageSize ? <div className="agent-insight-pagination" aria-label="Connector detail pages">
          <span>{offset + 1}-{Math.min(offset + connectorPageSize, connectors.length)} of {connectors.length} saved connectors</span>
          <button type="button" className="secondary" disabled={offset === 0} onClick={() => setConnectorOffset(offset - connectorPageSize)}>Previous connectors</button>
          <button type="button" className="secondary" disabled={offset + connectorPageSize >= connectors.length} onClick={() => setConnectorOffset(offset + connectorPageSize)}>Next connectors</button>
        </div> : null}
      </> : <p>{connectorCount === 0 && !partialConnectors || connectorCount === undefined && connectors !== undefined && !partialConnectors
          ? "No configured connectors were reported."
          : "Configured connector details are unavailable. Refresh inventory in Sync."}</p>}
      {partialConnectors ? <p className="agent-insight-note">Some connector or operation details are unavailable.</p> : null}
    </section> : null}
    {identifiers.length ? <section className="agent-overview-section agent-overview-identifiers" aria-label="Identifiers">
      <h3>Identifiers</h3>
      <Properties values={identifiers} />
    </section> : null}
  </div>;
}

function properties(values: Property[]) {
  return values.filter(item => item.value !== null && item.value !== undefined
    && !(typeof item.value === "string" && !item.value.trim()));
}

function Properties({ values }: { values: Property[] }) {
  if (!values.length) return null;
  return <dl className="agent-property-grid">{values.map(item => <div key={item.label} className={item.wide ? "agent-property-wide" : undefined}><dt>{item.label}</dt>
    <dd>{typeof item.value === "boolean" ? item.value ? "Yes" : "No" : item.value}</dd></div>)}</dl>;
}

function Person({ value, onOpen }: { value: AgentPerson; onOpen?: (id: string) => void }) {
  const navigable = !value.invalidId && !value.expired && value.status === "resolved";
  const name = value.displayName || value.address || value.id;
  return <div className="agent-person">
    {navigable && onOpen ? <button type="button" className="agent-person-link" aria-label={`View responsibility for ${name}`}
      onClick={() => onOpen(value.id.toLowerCase())}>{name}</button> : <span>{name}</span>}
    {value.displayName && value.address ? <small>{value.address}</small> : null}
    {value.status === "not_found" ? <small>User not found at the last directory lookup.</small> : null}
    {value.status === "lookup_failed" ? <small>Directory lookup failed.{value.displayName || value.address ? " Last known identity shown." : ""}</small> : null}
    {value.expired ? <small>Saved lookup expired.</small> : null}
    {value.invalidId ? <small>Invalid Entra user ID.</small>
      : value.status === "unverified" ? <small>Unverified directory identity.</small> : null}
  </div>;
}

function OverviewFact({ label, value }: { label: string; value: ReactNode }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function dateValue(value: string | null | undefined) {
  return value ? <time dateTime={value}>{usageDate(value)}</time> : undefined;
}
