import { useState } from "react";
import type { InventoryConnectorOperation, PowerPlatformResource } from "../../../backend/src/types/powerPlatformInventory";
import { formatPackageFacetLabel } from "../../../backend/src/types/copilotPackage";
import { getInventoryChildren } from "../api/client";
import { useSavedQuery } from "../savedQueries";
import { useReportPrincipalScope } from "../useReportPage";

type Props = { selectionId: string; recordId: string; source: NonNullable<PowerPlatformResource["savedSource"]> };
type Fact = Awaited<ReturnType<typeof getInventoryChildren>>["value"][number];
function useConfigurationPage({ selectionId, recordId, source }: Props, kind: string, value?: string) {
  const principal = useReportPrincipalScope();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);
  const read = useSavedQuery({
    queryKey: ["saved", "agent-configuration", principal, selectionId, recordId, source, kind, value, cursor], gcTime: 0,
    queryFn: async ({ signal }) => {
      const page = await getInventoryChildren(selectionId, recordId,
        { source_scope_id: source.scopeId, source_identity: source.identity }, kind, cursor, { signal, value, limit: 10 });
      for (const row of page.value) {
        if (kind === "detail:connectors" && typeof row.payload.connectorId !== "string"
          || kind === "connectorOperation" && !isOperation(row.payload)
          || kind === "detail:channels" && typeof row.value !== "string") throw new Error("Saved agent configuration is invalid. Refresh inventory in Sync.");
      }
      return page;
    },
  });
  return { ...read, previous: () => setCursors(values => values.slice(0, -1)), canPrevious: cursors.length > 1,
    next: () => { if (read.data?.nextCursor) setCursors(values => [...values, read.data!.nextCursor!]); } };
}
type Read = ReturnType<typeof useConfigurationPage>;
function ConfigurationStatus({ read }: { read: Read }) {
  return read.error ? <p className="error-banner" role="alert">{read.error.message}{" "}
    <button type="button" className="secondary" onClick={() => { void read.refetch(); }}>Retry configuration</button></p>
    : read.isPending ? <p role="status">Loading saved configuration...</p> : null;
}
function ConfigurationPages({ read, label }: { read: Read; label: string }) {
  if (!read.data || read.isError || !read.canPrevious && !read.data.nextCursor) return null;
  return <div className="agent-insight-pagination" aria-label={`${label} detail pages`}>
    <span>{read.data.value.length} shown of {read.data.total.toLocaleString()} saved {label}</span>
    <button type="button" className="secondary" disabled={!read.canPrevious || read.isFetching} onClick={read.previous}>Previous {label}</button>
    <button type="button" className="secondary" disabled={!read.data.nextCursor || read.isFetching} onClick={read.next}>Next {label}</button>
  </div>;
}
function isOperation(value: Record<string, unknown>): value is Record<string, unknown> & InventoryConnectorOperation {
  return typeof value.operationId === "string"
    && ["createdBy", "usedAs", "whenCanBeUsed", "connectionProvider"].every(key => value[key] === undefined || typeof value[key] === "string")
    && ["isEnabled", "requiresEndUserConsent"].every(key => value[key] === undefined || typeof value[key] === "boolean");
}
export function AgentConnectorOperations({ operations }: { operations: InventoryConnectorOperation[] }) {
  return <ul>{operations.map((operation, index) => <li key={index}><strong>{operation.operationId}</strong>
    <dl className="agent-property-grid">{([
      ["Used as", operation.usedAs], ["Enabled", operation.isEnabled], ["End-user consent required", operation.requiresEndUserConsent],
      ["Connection provided by", operation.connectionProvider], ["When available", operation.whenCanBeUsed ? formatPackageFacetLabel(operation.whenCanBeUsed) : undefined],
      ["Operation configured by (ID)", operation.createdBy],
    ] as const).filter(([, value]) => value !== undefined && value !== "").map(([label, value]) => <div key={label} className={label === "Operation configured by (ID)" ? "agent-property-wide" : undefined}>
      <dt>{label}</dt><dd>{typeof value === "boolean" ? value ? "Yes" : "No" : value}</dd>
    </div>)}</dl>
  </li>)}</ul>;
}
function SavedOperations({ connector, ...props }: Props & { connector: Fact }) {
  const read = useConfigurationPage(props, "connectorOperation", connector.value);
  const rows = read.isError ? undefined : read.data?.value;
  return <><ConfigurationStatus read={read} />
    {rows?.length ? <AgentConnectorOperations operations={rows.map(row => {
      if (!isOperation(row.payload)) throw new Error("Invalid saved connector operation.");
      return row.payload;
    })} /> : rows ? <span>No operations reported.</span> : null}
    <ConfigurationPages read={read} label="operations" /></>;
}
export function SavedAgentConnectors(props: Props) {
  const read = useConfigurationPage(props, "detail:connectors");
  const rows = read.isError ? undefined : read.data?.value;
  return <><ConfigurationStatus read={read} />
    {rows?.length ? <ul className="agent-service-list" aria-label="Configured connector details">
      {rows.map(row => <li key={row.ordinal}><strong>{String(row.payload.connectorId)}</strong>
        {Array.isArray(row.payload.operations) ? <SavedOperations key={row.ordinal} {...props} connector={row} /> : <span>Operation details not supplied.</span>}
      </li>)}</ul> : rows ? <p>No configured connectors were reported.</p> : null}
    <ConfigurationPages read={read} label="connectors" /></>;
}
export function SavedAgentChannels(props: Props) {
  const read = useConfigurationPage(props, "detail:channels");
  return <><ConfigurationStatus read={read} />{!read.isError && read.data
    ? <>{read.data.value.map(row => formatPackageFacetLabel(row.value)).join(", ") || "Not reported"}</> : null}
    <ConfigurationPages read={read} label="channels" /></>;
}
