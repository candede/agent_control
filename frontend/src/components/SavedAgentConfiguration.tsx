import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { InventoryConnectorOperation, PowerPlatformResource } from "../../../backend/src/types/powerPlatformInventory";
import { formatPackageFacetLabel } from "../../../backend/src/types/copilotPackage";
import { ApiError, getInventoryChildren } from "../api/client";
import { useSavedQueryClient } from "../savedQueries";
import { useReportPrincipalScope } from "../useReportPage";

type Props = {
  selectionId: string; recordId: string; source: NonNullable<PowerPlatformResource["savedSource"]>; onInvalidated?: () => void;
};
type Page = Awaited<ReturnType<typeof getInventoryChildren>>;
type Fact = Page["value"][number];
function selectionInvalidated(error: Error | null) {
  return error instanceof ApiError && error.code === "selection_invalidated";
}
function useConfigurationPage({ selectionId, recordId, source, onInvalidated }: Props, kind: string, value?: string) {
  const principal = useReportPrincipalScope();
  const client = useSavedQueryClient();
  const owner = JSON.stringify([principal, selectionId, recordId, source.scopeId, source.identity, kind, value]);
  const [navigation, setNavigation] = useState<{ owner: string; cursors: (string | undefined)[]; paged?: boolean }>({ owner, cursors: [undefined] });
  const cursors = navigation.owner === owner ? navigation.cursors : [undefined];
  if (navigation.owner !== owner) setNavigation({ owner, cursors });
  const cursor = cursors.at(-1);
  const queryKey = ["saved", "agent-configuration", principal, selectionId, recordId, source, kind, value, cursor];
  const pageKey = JSON.stringify([owner, cursor]);
  const actions = useRef<{ key: string; moved: boolean } | undefined>(undefined);
  useLayoutEffect(() => {
    actions.current = { key: pageKey, moved: false };
    return () => { actions.current = undefined; };
  }, [client, pageKey]);
  const read = useQuery<Page>({
    // A selection pins immutable rows; share them while observed, but do not retain abandoned pages.
    queryKey, staleTime: Infinity, gcTime: 0,
    enabled: query => !selectionInvalidated(query.state.error),
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
  }, client);
  const invalidated = selectionInvalidated(read.error);
  const notifyInvalidated = useEffectEvent(() => onInvalidated?.());
  useEffect(() => {
    if (!selectionInvalidated(read.error)) return;
    // A child rejection retires the same selection's parent and sibling reads too.
    for (const cached of client.getQueryCache().findAll({
      queryKey: ["saved", "agent-configuration", principal, selectionId],
    })) {
      if (selectionInvalidated(cached.state.error)) continue;
      void client.cancelQueries({ queryKey: cached.queryKey, exact: true });
      cached.setState({ error: read.error, errorUpdatedAt: Date.now(),
        errorUpdateCount: cached.state.errorUpdateCount + 1, status: "error", isInvalidated: true });
    }
    notifyInvalidated();
  }, [client, principal, read.error, selectionId]);
  const page = !read.isError && !read.isFetching ? read.data : undefined;
  if (page?.nextCursor && (navigation.owner !== owner || !navigation.paged)) setNavigation({ owner, cursors, paged: true });
  const canPrevious = !invalidated && !read.isFetching && cursors.length > 1;
  const canNext = !read.isFetching && Boolean(page?.nextCursor);
  function currentState() {
    if (actions.current?.key !== pageKey || actions.current.moved) return;
    const state = client.getQueryState<Page>(queryKey);
    // Cache notifications can arrive after an already-queued click.
    if (state?.fetchStatus === "idle" && !selectionInvalidated(state.error)) return state;
  }
  return { ...read, client, page, invalidated, paged: navigation.owner === owner && navigation.paged,
    canPrevious, previous: () => {
      if (canPrevious && currentState() && actions.current) {
        actions.current.moved = true;
        setNavigation({ owner, cursors: cursors.slice(0, -1), paged: true });
      }
    },
    canNext, next: () => {
      const state = currentState();
      if (canNext && page?.nextCursor && state?.status === "success" && state.data === page && !state.isInvalidated && actions.current) {
        actions.current.moved = true;
        setNavigation({ owner, cursors: [...cursors, page.nextCursor], paged: true });
      }
    },
    retry: () => {
      if (currentState()?.status === "error") void read.refetch({ cancelRefetch: false });
    },
  };
}
type Read = ReturnType<typeof useConfigurationPage>;
function ConfigurationStatus({ read }: { read: Read }) {
  return <>{read.error && !read.isFetching ? <p className="error-banner" role="alert">{read.invalidated
    ? "This saved inventory selection changed or expired. Reload saved inventory." : <>{read.error.message}{" "}
      <button type="button" className="secondary"
        onClick={read.retry}>Retry configuration</button></>}</p> : null}
    {read.isFetching ? <p role="status">Loading saved configuration...</p> : null}</>;
}
function ConfigurationPages({ read, label }: { read: Read; label: string }) {
  if (read.invalidated || !read.paged && !read.page?.nextCursor) return null;
  return <div className="agent-insight-pagination" aria-label={`${label} detail pages`}>
    {read.page ? <span>{read.page.value.length} shown of {read.page.total.toLocaleString()} saved {label}</span> : null}
    <button type="button" className="secondary" aria-disabled={!read.canPrevious} onClick={read.previous}>Previous {label}</button>
    <button type="button" className="secondary" aria-disabled={!read.canNext} onClick={read.next}>Next {label}</button>
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
function SavedOperations({ connector, partial, ...props }: Props & { connector: Fact; partial: boolean }) {
  const read = useConfigurationPage({ ...props, onInvalidated: undefined }, "connectorOperation", connector.value);
  const rows = read.page?.value;
  return <><ConfigurationStatus read={read} />
    {rows?.length ? <AgentConnectorOperations operations={rows.map(row => {
      if (!isOperation(row.payload)) throw new Error("Invalid saved connector operation.");
      return row.payload;
    })} /> : rows ? <span>{partial ? "Operation details are incomplete." : "No operations reported."}</span> : null}
    <ConfigurationPages read={read} label="operations" /></>;
}
export function SavedAgentConnectors({ partial = false, ...props }: Props & { partial?: boolean }) {
  const read = useConfigurationPage(props, "detail:connectors");
  const rows = read.page?.value;
  return <QueryClientProvider client={read.client}><ConfigurationStatus read={read} />
    {rows?.length ? <ul className="agent-service-list" aria-label="Configured connector details">
      {rows.map(row => <li key={row.ordinal}><strong>{String(row.payload.connectorId)}</strong>
        {Array.isArray(row.payload.operations) ? <SavedOperations key={row.ordinal} {...props} connector={row} partial={partial} /> : <span>Operation details not supplied.</span>}
      </li>)}</ul> : rows ? <p>{partial ? "Configured connector details are unavailable. Refresh inventory in Sync." : "No configured connectors were reported."}</p> : null}
    <ConfigurationPages read={read} label="connectors" /></QueryClientProvider>;
}
export function SavedAgentChannels(props: Props) {
  const read = useConfigurationPage(props, "detail:channels");
  return <><ConfigurationStatus read={read} />{read.page
    ? <>{read.page.value.map(row => formatPackageFacetLabel(row.value)).join(", ") || "Not reported"}</> : null}
    <ConfigurationPages read={read} label="channels" /></>;
}
