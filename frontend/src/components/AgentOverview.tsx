import { useMemo, useState, type ReactNode } from "react";
import type { CopilotPackage, CopilotPackageDetail, UnifiedAgentRecord } from "../api/client";
import { agentAccessSummary } from "../../../backend/src/types/agentPresentation";
import { formatPackageFacetLabel } from "../../../backend/src/types/copilotPackage";
import { extractConnectedServices, getAgentDescription, getSanitizedDescriptionHtml } from "../agentDetails";
import { usageDate } from "../usageInsights";
import { AgentAuthoringTools, AgentAvailability, AgentStatus } from "./UnifiedAgentTable";

const referencePageSize = 20;

export function AgentOverview({ record, selectedPackage, packageDetail, environmentNames }: {
  record: UnifiedAgentRecord;
  selectedPackage?: CopilotPackage;
  packageDetail?: CopilotPackageDetail;
  environmentNames: Record<string, string>;
}) {
  const [referenceOffset, setReferenceOffset] = useState(0);
  const resource = record.powerPlatformResource;
  const metadata = packageDetail ?? selectedPackage;
  const observedRecord = packageDetail ? {
    ...record,
    packages: record.packages.map(item => item.id === packageDetail.id ? packageDetail : item),
  } : record;
  const description = getAgentDescription(metadata ?? {}, resource?.details.description);
  const descriptionHtml = useMemo(() => getSanitizedDescriptionHtml(description), [description]);
  const references = useMemo(() => extractConnectedServices(packageDetail?.elementDetails), [packageDetail?.elementDetails]);
  const connectors = resource?.details.connectors;
  const connectorCount = resource?.details.distinctPowerPlatformConnectors;
  const operationCount = resource?.details.distinctPowerPlatformConnectorsOperations;
  const hasCapabilityCounts = connectorCount !== undefined || operationCount !== undefined;
  const partialConnectors = resource?.details.capabilityDetailsTruncated || resource?.details.connectorDetailsStatus === "partial";
  const hasReferences = packageDetail?.elementDetails !== undefined;
  const serviceSummary = [
    connectorCount !== undefined ? `${connectorCount.toLocaleString()} configured`
      : connectors !== undefined ? `${connectors.length.toLocaleString()} ${partialConnectors ? "listed (partial)" : "configured"}` : "",
    hasReferences ? `${references.length.toLocaleString()} ${references.length === 1 ? "reference" : "references"}` : "",
  ].filter(Boolean).join(" / ") || "Not reported";
  const offset = Math.min(referenceOffset, Math.max(0, Math.ceil(references.length / referencePageSize) - 1) * referencePageSize);
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
    { label: "Environment", value: record.environmentId ? environmentNames[record.environmentId.toLowerCase()] || record.environmentId : undefined },
    { label: "Type", value: metadata?.type ? formatPackageFacetLabel(metadata.type) : undefined },
    { label: "Owner", value: resource?.details.ownerId },
    { label: "Created by", value: resource?.createdBy },
    { label: "Created", value: dateValue(resource?.createdAt ?? metadata?.createdDateTime) },
    { label: "Last modified", value: dateValue(resource?.details.lastModifiedAt ?? metadata?.lastModifiedDateTime) },
    { label: "Last modified by", value: resource?.details.lastModifiedBy },
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
    { label: "Location", value: resource?.location },
    { label: "Configured connector operations", value: operationCount },
    { label: "Inventory observed", value: dateValue(observedAt) },
  ].filter(item => item.value !== null && item.value !== undefined && item.value !== "");

  return <div className="agent-overview">
    <div className="inventory-detail-grid agent-overview-facts">
      <OverviewFact label="Status" value={<AgentStatus record={observedRecord} />} />
      <OverviewFact label="Available to" value={<AgentAvailability record={observedRecord} />} />
      <OverviewFact label="Installed for" value={installationSummary ?? (observedRecord.packages.length ? "Unknown" : "Not reported")} />
      <OverviewFact label="Connected services" value={serviceSummary} />
    </div>
    {record.packages.length > 1 ? <p className="agent-insight-note">Status, availability and installation cover all {record.packages.length} published versions. Description and service references are for the selected version.</p> : null}
    {descriptionHtml ? <div className="agent-overview-description rich-description" aria-label="Agent description" dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
      : <p className="agent-overview-description">{description}</p>}
    <section className="agent-overview-section" aria-label="Agent information">
      <h3>Agent information</h3>
      <dl className="agent-property-grid">
        {information.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{typeof item.value === "boolean" ? item.value ? "Yes" : "No" : item.value}</dd></div>)}
      </dl>
    </section>
    <section className="agent-overview-section" aria-label="Connected services">
      <h3>Connected services</h3>
      {connectors !== undefined || hasCapabilityCounts ? <>
        <h4>Configured connectors</h4>
        {connectors?.length ? <ul className="agent-service-list">
          {connectors.map(connector => <li key={connector.connectorId}>
            <strong>{connector.connectorId}</strong>
            {connector.operations?.length ? <ul>{connector.operations.map(operation => <li key={operation.operationId}>
              {operation.displayName ?? operation.operationId}
              {[operation.method, operation.usedAs].filter(Boolean).length ? <small>{[operation.method, operation.usedAs].filter(Boolean).join(" / ")}</small> : null}
            </li>)}</ul> : <span>Operation metadata not reported.</span>}
          </li>)}
        </ul> : <p>{connectorCount === 0 || connectorCount === undefined && connectors !== undefined && !partialConnectors
          ? "No configured connectors were reported."
          : "Configured connector details are not available in the saved observation; the reported count is retained."}</p>}
      </> : null}
      {partialConnectors ? <p className="agent-insight-note">Capability details are partial; the saved observation does not contain complete connector and operation details.</p> : null}
      {references.length ? <>
        <h4>Detected service references</h4>
        <p>References found in saved agent metadata do not prove a live connection. They are not added to the configured connector count.</p>
        <ul className="agent-service-list" aria-label="Detected service references">
          {references.slice(offset, offset + referencePageSize).map(reference => <li key={`${reference.source}:${reference.value}`}>
            <strong>{reference.value}</strong><small>{reference.source}</small>
          </li>)}
        </ul>
        {references.length > referencePageSize ? <div className="agent-insight-pagination" aria-label="Service reference pages">
          <span>{offset + 1}-{Math.min(offset + referencePageSize, references.length)} of {references.length.toLocaleString()} references</span>
          <button type="button" className="secondary" disabled={offset === 0} onClick={() => setReferenceOffset(offset - referencePageSize)}>Previous references</button>
          <button type="button" className="secondary" disabled={offset + referencePageSize >= references.length} onClick={() => setReferenceOffset(offset + referencePageSize)}>Next references</button>
        </div> : null}
      </> : connectors === undefined && !hasCapabilityCounts ? <p>{selectedPackage && !packageDetail
        ? "Service references will be shown when saved agent details are available."
        : hasReferences || connectors !== undefined ? "No connected-service metadata was reported for this agent." : "Connected-service metadata was not supplied for this agent."}</p> : null}
    </section>
  </div>;
}

function OverviewFact({ label, value }: { label: string; value: ReactNode }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function dateValue(value: string | null | undefined) {
  return value ? <time dateTime={value}>{usageDate(value)}</time> : undefined;
}
