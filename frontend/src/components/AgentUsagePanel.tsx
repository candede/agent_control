import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CandidateAgentUsageSummary, CandidateAgentUsageHistory, CandidateAgentUsageAssociations, CandidateAgentUsageMutation, CandidateAgentUsageUsers, AgentUsageUser } from "../../../backend/src/types/officialReportApi";
import type { InventoryReportContext, UnifiedAgentRecord } from "../../../backend/src/types/unifiedAgents";
import { readAgentReportSummary, readAgentReportHistory, readAgentReportAssociations, mutateAgentReportAssociation } from "../api/reportData";
import { ApiError } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { hasRole } from "../authorization";
import { useSavedQuery } from "../savedQueries";
import { useReportPage } from "../useReportPage";
import { usageCount, usageDate } from "../usageInsights";
import { ReportPageControls, ReportReadStatus } from "./ReportPageControls";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { AgentUsageTrend } from "./AgentUsageTrend";
import { usagePeriodLabel } from "../agentUsageTrends";
import "./agentInsights.css";

type Props = { record: UnifiedAgentRecord; view: "usage" | "users"; context?: InventoryReportContext; inventoryRevision?: string; dataRevision?: number;
  inventorySelectionId?: string; onReloadInventory?: () => void;
  canRemoveReviewedAssociations: boolean; disabled?: boolean; onChanged?: () => void };
const contextFields = ["selectionId", "reportSetId", "usageRevision", "inventoryRevision"] as const;

export function AgentUsagePanel(props: Props) {
  const capability = useContext(CapabilityContext), user = capability?.user;
  const principalScope = JSON.stringify([user?.tenantId, user?.homeAccountId, [...(user?.roles ?? [])].sort()]);
  const recovery = useRef(false);
  useLayoutEffect(() => { recovery.current = false; }, [principalScope, props.record.id]);
  const { inventorySelectionId, onReloadInventory, disabled } = props;
  const recoverInventory = useCallback(() => {
    if (!inventorySelectionId || !onReloadInventory || disabled || recovery.current) return;
    recovery.current = true;
    onReloadInventory();
  }, [disabled, inventorySelectionId, onReloadInventory]);
  const usageReady = useCallback(() => { recovery.current = false; }, []);
  if (capability && !hasRole(user, "AgentControl.Viewer")) return <p role="alert">Current Viewer access is required to read agent usage.</p>;
  const readScope = JSON.stringify([principalScope, props.record.id, props.context?.revision, props.context?.reports.setId, props.inventoryRevision, props.inventorySelectionId]);
  return <AgentUsageSession key={readScope} principalScope={readScope} recoverInventory={recoverInventory} usageReady={usageReady} {...props}
    canRemoveReviewedAssociations={props.canRemoveReviewedAssociations && (!capability || hasRole(user, "AgentControl.Admin"))} />;
}

function AgentUsageSession({ record, view, context: inventoryContext, dataRevision = 0, canRemoveReviewedAssociations: canManage,
  disabled, onChanged, principalScope, inventorySelectionId, onReloadInventory, recoverInventory, usageReady }: Props & {
    principalScope: string; recoverInventory: () => void; usageReady: () => void;
  }) {
  const [reload, setReload] = useState(0), [cursor, setCursor] = useState<string>();
  const [capturedSelection, setCapturedSelection] = useState<string>();
  const [viewedSetId, setViewedSetId] = useState<string>(), [historyCursor, setHistoryCursor] = useState<string>();
  const [remove, setRemove] = useState<{ row: CandidateAgentUsageAssociations["value"][number]; context: CandidateAgentUsageSummary["context"] }>();
  const [confirmed, setConfirmed] = useState(false), [error, setError] = useState<{ message: string; invalidated: boolean }>(), [busy, setBusy] = useState(false);
  const selectionId = capturedSelection ?? inventorySelectionId;
  const history = useSavedQuery<CandidateAgentUsageHistory>({
    queryKey: ["saved", "exact-inventory-history", principalScope, record.id, selectionId, historyCursor, dataRevision, reload],
    enabled: Boolean(selectionId), gcTime: 0, staleTime: 300_000,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === principalScope
      && previousQuery.queryKey[4] === selectionId && previousQuery.queryKey[7] === reload ? previous : undefined,
    queryFn: async ({ signal }) => {
      const value = await readAgentReportHistory(record.id, { selectionId: selectionId!, cursor: historyCursor, limit: 50,
        ...(inventorySelectionId ? { inventorySelectionId } : {}) }, signal);
      if (value.recordId !== record.id || value.context.selectionId !== selectionId
        || value.context.reportSetId !== value.context.reports.setId
        || inventoryContext !== undefined && value.context.reportSetId !== inventoryContext.reports.setId) {
        throw new ApiError(409, "selection_invalidated", "Historical usage does not match the saved inventory selection.");
      }
      if (typeof value.latestReportSetId !== "string" && value.latestReportSetId !== null) {
        throw new ApiError(502, "invalid_response", "The latest saved usage report could not be determined.");
      }
      return value;
    },
  });
  const latestSetId = history.data?.latestReportSetId;
  const requestedSetId = viewedSetId ?? latestSetId;
  const sharedSetId = inventoryContext?.reports.setId ?? history.data?.context.reportSetId;
  const reportOverride = requestedSetId && requestedSetId !== sharedSetId ? requestedSetId : undefined;
  const canReadSummary = !history.isError && (Boolean(latestSetId) || !inventorySelectionId && latestSetId === undefined);
  const canManageViewedReport = canManage && !viewedSetId && !reportOverride;
  const [confirmationVersion, setConfirmationVersion] = useState({ revision: dataRevision, disabled: Boolean(disabled), view, requestedSetId });
  const removalTrigger = useRef<HTMLButtonElement>(null), confirmationHeading = useRef<HTMLHeadingElement>(null);
  const restoreRemovalFocus = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  useLayoutEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => controller.abort();
  }, [dataRevision, disabled, view, requestedSetId]);
  useEffect(() => { if (remove) confirmationHeading.current?.focus(); }, [remove]);
  useLayoutEffect(() => {
    if (remove) restoreRemovalFocus.current = true;
    else if (!disabled && restoreRemovalFocus.current) {
      removalTrigger.current?.focus(); restoreRemovalFocus.current = false;
    }
  }, [disabled, remove]);
  if (confirmationVersion.revision !== dataRevision || confirmationVersion.disabled !== Boolean(disabled)
    || confirmationVersion.view !== view || confirmationVersion.requestedSetId !== requestedSetId) {
    if (confirmationVersion.requestedSetId !== requestedSetId) setCursor(undefined);
    setConfirmationVersion({ revision: dataRevision, disabled: Boolean(disabled), view, requestedSetId });
    setRemove(undefined); setConfirmed(false); setBusy(false);
  }
  const summary = useSavedQuery<CandidateAgentUsageSummary>({
    queryKey: ["saved", "exact-inventory-report", principalScope, record.id, reload, dataRevision, reportOverride], gcTime: 0,
    enabled: canReadSummary,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === principalScope
      && previousQuery.queryKey[4] === reload && previousQuery.queryKey[6] === reportOverride ? previous : undefined,
    queryFn: async ({ signal }) => {
      const setId = reportOverride ?? inventoryContext?.reports.setId ?? undefined;
      const value = await readAgentReportSummary(record.id, inventorySelectionId
        ? { inventorySelectionId, selectionId, ...(reportOverride ? { setId: reportOverride } : {}) }
        : { selectionId: capturedSelection, setId }, signal);
      const expectedSetId = requestedSetId ?? inventoryContext?.reports.setId;
      if (value.recordId !== record.id || value.context.reportSetId !== value.context.reports.setId
        || expectedSetId !== undefined && value.context.reportSetId !== expectedSetId
        || inventorySelectionId !== undefined && value.context.selectionId !== inventorySelectionId
        || capturedSelection !== undefined && value.context.selectionId !== capturedSelection) {
        throw new ApiError(409, "selection_invalidated", "Exact agent evidence does not match the requested report selection.");
      }
      return value;
    },
  });
  if (summary.data && !summary.isError && capturedSelection !== summary.data.context.selectionId) setCapturedSelection(summary.data.context.selectionId);
  const context = summary.data?.context;
  const periodReady = Boolean(history.data) && !history.isError && context?.reportSetId === requestedSetId;
  const canReadAssociations = Boolean(context) && periodReady && !summary.isError;
  const associations = useSavedQuery<CandidateAgentUsageAssociations>({
    queryKey: ["saved", "exact-inventory-associations", principalScope, record.id, selectionId, cursor, dataRevision, reload, reportOverride], gcTime: 0, enabled: canReadAssociations,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === principalScope
      && previousQuery.queryKey[4] === selectionId && previousQuery.queryKey[5] === cursor
      && previousQuery.queryKey[7] === reload && previousQuery.queryKey[8] === reportOverride ? previous : undefined,
    queryFn: ({ signal }) => readAgentReportAssociations(record.id, { selectionId: selectionId!, cursor, limit: 50,
      ...(inventorySelectionId ? { inventorySelectionId } : {}), ...(reportOverride ? { setId: reportOverride } : {}) }, signal),
  });
  const refetchSummary = summary.refetch, refetchAssociations = associations.refetch, refetchHistory = history.refetch;
  useEffect(() => {
    const revalidate = () => {
      if (canReadSummary) void refetchSummary({ cancelRefetch: false });
      if (canReadAssociations) void refetchAssociations({ cancelRefetch: false });
      if (selectionId) void refetchHistory({ cancelRefetch: false });
    };
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [refetchSummary, refetchAssociations, refetchHistory, selectionId, canReadSummary, canReadAssociations]);
  const changed = Boolean(context && (associations.data && contextFields.some(field => context[field] !== associations.data!.context[field])
    || history.data && context.inventoryRevision !== history.data.context.inventoryRevision));
  const historyInvalidated = history.error instanceof ApiError && [401, 403, 409].includes(history.error.status);
  const unavailable = summary.isError || associations.isError || changed || error?.invalidated || historyInvalidated;
  if (unavailable && remove) { setRemove(undefined); setConfirmed(false); }
  const usage = !unavailable && periodReady && summary.data?.status === "linked" ? summary.data : undefined;
  const reports = !unavailable && periodReady ? context?.reports : undefined;
  const period = reports?.reportingPeriod;
  const reviewed = associations.data?.value.filter(row => row.basis === "reviewed") ?? [];
  const selectionInvalidated = [summary.error, associations.error, history.error].some(cause =>
    cause instanceof ApiError && ["selection_invalidated", "inventory_changed"].includes(cause.code));
  useEffect(() => { if (selectionInvalidated || changed) recoverInventory(); }, [selectionInvalidated, changed, recoverInventory]);
  useEffect(() => {
    if (!unavailable && periodReady && summary.data && summary.data.status !== "linked" && associations.data
      && !summary.isFetching && !associations.isFetching) usageReady();
  }, [unavailable, periodReady, summary.data, summary.isFetching, associations.data, associations.isFetching, usageReady]);
  function resetUsage() {
    setCursor(undefined); setRemove(undefined); setError(undefined); setConfirmed(false);
    setCapturedSelection(undefined); setReload(value => value + 1);
    setHistoryCursor(undefined);
  }
  function selectPeriod(setId?: string) {
    setViewedSetId(setId === latestSetId ? undefined : setId);
    setCursor(undefined); setRemove(undefined); setConfirmed(false); setError(undefined);
  }
  function restartUsage() {
    resetUsage();
    if (inventorySelectionId) onReloadInventory?.();
  }
  async function saveRemoval() {
    if (!remove || !confirmed || unavailable || !periodReady || !canManageViewedReport || disabled || busy) return;
    setBusy(true); setError(undefined);
    const signal = lifetime.current?.signal;
    try {
      const input: CandidateAgentUsageMutation = { selectionId: remove.context.selectionId, reportSetId: remove.context.reportSetId,
        usageRevision: remove.context.usageRevision, inventoryRevision: remove.context.inventoryRevision, reportAgentId: remove.row.reportAgentId, confirmed: true };
      if (inventorySelectionId) await mutateAgentReportAssociation(record.id, input, "remove", signal, inventorySelectionId);
      else await mutateAgentReportAssociation(record.id, input, "remove", signal);
      if (!signal?.aborted) {
        resetUsage();
        if (onChanged) onChanged();
        else if (inventorySelectionId) onReloadInventory?.();
      }
    } catch (cause) {
      if (!signal?.aborted) setError({ message: cause instanceof Error ? cause.message : "Association removal failed.",
        invalidated: cause instanceof ApiError && [401, 403, 409].includes(cause.status) });
    } finally { if (!signal?.aborted) setBusy(false); }
  }
  const title = view === "usage" ? "Usage" : "Users";
  return <section className="agent-usage-insights" aria-label={`${title} for ${record.displayName}`}>
    <h3>{title}</h3>
    {history.isFetching ? <p role="status" className={history.data ? "sr-only" : undefined}>Checking saved report history...</p> : null}
    {history.isError && !unavailable ? <div className="error-banner" role="alert"><span>Usage history could not be loaded: {history.error.message}</span>
      <button type="button" className="secondary" disabled={disabled || history.isFetching} onClick={() => {
        if (selectionInvalidated) restartUsage(); else void history.refetch();
      }}>Retry usage history</button></div> : null}
    {!history.isError && history.data && !unavailable ? <>
      {view === "usage" ? <AgentUsageTrend data={history.data}
        sharedSetId={inventoryContext?.reports.setId ?? history.data.context.reportSetId}
        onPage={setHistoryCursor} loading={history.isFetching} disabled={disabled} /> : null}
      {view === "users" && periodReady && summary.data?.status !== "linked" && history.data.latestReported && history.data.latestReported.setId !== reports?.setId
        ? <div className="agent-history-discovery"><p>Usage is reported in another saved report: <strong>{usagePeriodLabel(history.data.latestReported)}</strong>
          {" "}({usageCount(history.data.latestReported.responses)} responses).</p>
          <button type="button" className="secondary" disabled={disabled} onClick={() => selectPeriod(history.data!.latestReported!.setId)}>View this period</button></div> : null}
    </> : null}
    {view === "users" && viewedSetId ? <div className="agent-history-local"><span>Viewing a historical period instead of the latest report.</span>
      <button type="button" className="secondary" disabled={disabled} onClick={() => selectPeriod()}>Return to latest report</button></div> : null}
    {view === "users" && reports?.setId ? <div className="agent-usage-date-range" aria-label="CSV report dates"><span>{viewedSetId ? "Historical report dates" : "Latest report dates"}</span>
      <strong>{period?.startDate && period.endDate ? <><time dateTime={period.startDate}>{usageDate(period.startDate)}</time>{" - "}
        <time dateTime={period.endDate}>{usageDate(period.endDate)}</time></> : "Dates not supplied"}</strong>
      {reports.availability === "stale" ? <small>Saved report is out of date. Refresh reports in Sync.</small> : null}
    </div> : null}
    {summary.isFetching ? <p role="status" className={usage ? "sr-only" : undefined}>Loading saved agent usage...</p> : null}
    {usage ? view === "users" ? <>
      <dl className="agent-usage-metrics" aria-label="Selected agent report metrics">
        <UsageMetric label="Responses" value={usageCount(usage.responses)} />
        <UsageMetric label="Active users" value={usageCount(usage.activeUsers)} />
        <UsageMetric label="Last reported activity" value={usageDate(usage.lastActivityDateUtc)} />
      </dl>
      {context && associations.data ? <AgentUsers key={JSON.stringify([reload, ...contextFields.map(field => context[field])])}
        recordId={record.id} context={context} revision={dataRevision} inventorySelectionId={inventorySelectionId}
        setId={reportOverride}
        onReady={usageReady} onInvalidated={recoverInventory} onRestartSelection={restartUsage} /> : null}
      {canManageViewedReport && associations.data && (reviewed.length > 0 || associations.data.page.nextCursor || associations.data.page.previousCursor) ? <details className="agent-insight-provenance">
        <summary>Reviewed report links</summary>
        <ul className="agent-usage-association-list">{reviewed.map(row => <li key={row.reportAgentId}>
          <div><strong>{row.agentName}</strong><code>{row.reportAgentId}</code><span>{targetLabel(row.target)}</span></div>
          <div className="agent-insight-actions"><WorkbenchActionGate actionId="agentUsage.remove" compact>
            <button type="button" className="secondary" disabled={disabled || busy}
              aria-label={`Remove association for ${row.agentName} (${row.reportAgentId})`}
              onClick={event => { removalTrigger.current = event.currentTarget; if (context) setRemove({ row, context }); setConfirmed(false); }}>Remove reviewed association</button>
          </WorkbenchActionGate></div>
        </li>)}</ul>
        {associations.data.page.nextCursor || associations.data.page.previousCursor ? <ReportPageControls data={associations.data} loading={associations.isFetching} label="report links"
          previous={() => setCursor(associations.data?.page.previousCursor ?? undefined)} next={() => setCursor(associations.data?.page.nextCursor ?? undefined)} /> : null}
      </details> : null}
    </> : null : unavailable || view === "users" && history.data && !history.isError && (!latestSetId || !summary.isPending) ? <div className="agent-insight-empty">
      <h4>{unavailable ? "Usage unavailable" : reports?.setId ? "Usage not reported" : "No CSV reports available"}</h4>
      <p>{!reports?.setId && !unavailable ? "Import a complete CSV report in Sync to see usage."
        : summary.data?.status === "unlinked" && !unavailable ? `This agent is not included in ${viewedSetId ? "this historical" : "the latest"} CSV report.`
          : unavailable ? "Usage could not be loaded for this agent. Reload usage to try again."
            : "Usage is unavailable in the selected CSV report."}</p>
    </div> : null}
    {unavailable ? <div className="error-banner" role="alert">
      <span>{changed ? "Exact source references or reviewed associations changed. Reload usage before reviewing this evidence."
        : summary.error?.message ?? associations.error?.message ?? history.error?.message ?? error?.message}</span>
      <button type="button" className="secondary" disabled={disabled || busy} onClick={restartUsage}>Reload usage</button>
    </div> : null}
    {remove && !unavailable ? <section className="agent-usage-confirmation" aria-label="Confirm reviewed association removal">
      <h4 ref={confirmationHeading} tabIndex={-1}>Remove reviewed association</h4>
      <dl><dt>Inventory agent</dt><dd>{record.displayName}<code>{record.id}</code></dd>
        <dt>Report set</dt><dd><code>{remove.context.reportSetId}</code></dd>
        <dt>Report identity</dt><dd>{remove.row.agentName}<code>{remove.row.reportAgentId}</code></dd></dl>
      <p>{targetLabel(remove.row.target)}</p>
      <p>Removing this reviewed override does not remove report data. An exact saved-package ID match may still apply automatically.</p>
      <label className="agent-usage-confirm-checkbox"><input type="checkbox" checked={confirmed} disabled={disabled || busy}
        onChange={event => setConfirmed(event.target.checked)} /><span>I confirm this reporting association should be removed.</span></label>
      <div className="agent-insight-actions"><WorkbenchActionGate actionId="agentUsage.remove" compact>
        <button type="button" disabled={!confirmed || busy || disabled} onClick={() => void saveRemoval()}>{busy ? "Removing association..." : "Confirm removal"}</button>
      </WorkbenchActionGate><button type="button" className="secondary" disabled={busy} onClick={() => setRemove(undefined)}>Cancel association change</button></div>
    </section> : null}
    {error && !error.invalidated ? <p className="error-banner" role="alert">{error.message}</p> : null}
  </section>;
}

function targetLabel(target: CandidateAgentUsageAssociations["value"][number]["target"]) {
  return target.source === "graph_packages" ? `Graph package: ${target.packageId}`
    : `Power Platform: ${target.nativeId} - Environment: ${target.environmentId ?? "not reported"}`;
}
function UsageMetric({ label, value }: { label: string; value: string }) {
  return <div className="agent-usage-metric"><dt>{label}</dt><dd><strong>{value}</strong></dd></div>;
}
function AgentUsers({ recordId, context, revision, onRestartSelection, inventorySelectionId, setId, onInvalidated, onReady }: {
  recordId: string; context: CandidateAgentUsageSummary["context"]; revision: number; onRestartSelection: () => void;
  inventorySelectionId?: string; setId?: string; onInvalidated: () => void; onReady: () => void;
}) {
  const [search, setSearch] = useState("");
  const read = useReportPage<AgentUsageUser, CandidateAgentUsageUsers>(`agent-inventory/${encodeURIComponent(recordId)}/usage-users`,
    { selectionId: context.selectionId, ...(inventorySelectionId ? { inventorySelectionId } : {}),
      ...(setId ? { setId } : {}), search: search || undefined, limit: 25 }, revision, true, onRestartSelection);
  const changed = read.data && contextFields.some(field => read.data?.context?.[field] !== context[field]);
  useEffect(() => { if (read.invalidated || changed) onInvalidated(); }, [read.invalidated, changed, onInvalidated]);
  const data = changed ? undefined : read.data;
  useEffect(() => { if (data && !read.loading && !read.error) onReady(); }, [data, read.loading, read.error, onReady]);
  return <section className="agent-usage-users" aria-label="Agent users" aria-busy={read.loading && !data}>
    <div className="agent-insight-toolbar"><h4>Users{data ? ` (${data.counts.filtered.toLocaleString()})` : ""}</h4>
      <input type="search" aria-label="Search agent users" placeholder="Search by name or email" maxLength={256} value={search}
        onChange={event => setSearch(event.target.value)} /></div>
    <ReportReadStatus read={read} />
    {changed ? <div className="error-banner" role="alert">The report or inventory changed. Reload agent usage.
      <button type="button" className="secondary" onClick={onRestartSelection}>Reload usage</button></div> : null}
    {data?.value.length ? <div className="table-shell"><table className="agent-insight-table">
      <caption className="sr-only">Users of this agent in this CSV report</caption>
      <thead><tr><th scope="col">User</th><th scope="col">Responses</th></tr></thead>
      <tbody>{data.value.map(user => <tr key={user.username}><th scope="row">{user.displayName !== user.username
        ? <><span>{user.displayName}</span><small>{user.username}</small></> : user.username}</th><td>{usageCount(user.responses)}</td></tr>)}</tbody>
    </table></div> : data ? <p>{search ? "No users match your search." : "No users listed in this report."}</p> : null}
    {data ? <ReportPageControls {...read} data={data} label="users" /> : null}
  </section>;
}
