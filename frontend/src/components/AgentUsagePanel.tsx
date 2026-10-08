import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { skipToken, useMutationState, useQuery, type QueryClient } from "@tanstack/react-query";
import type { CandidateAgentUsageSummary, CandidateAgentUsageHistory, CandidateAgentUsageAssociations, CandidateAgentUsageMutation, CandidateAgentUsageUsers, AgentUsageUser } from "../../../backend/src/types/officialReportApi";
import type { InventoryReportContext, UnifiedAgentRecord } from "../../../backend/src/types/unifiedAgents";
import { readAgentReportSummary, readAgentReportHistory, readAgentReportAssociations, mutateAgentReportAssociation } from "../api/reportData";
import { ApiError } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { hasRole } from "../authorization";
import { useSavedQueryClient } from "../savedQueries";
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
type RecoverySource = "history" | "users";
type RemovalEvidence = { revision: number; uncertain: boolean };

function uncertainRemoval(cause: unknown) {
  return !(cause instanceof ApiError) || cause.status === 0 || cause.status >= 500 || cause.code === "invalid_response";
}

export function AgentUsagePanel(props: Props) {
  const capability = useContext(CapabilityContext), user = capability?.user;
  const principalScope = JSON.stringify([user?.tenantId, user?.homeAccountId, [...(user?.roles ?? [])].sort()]);
  const client = useSavedQueryClient();
  const [mutationOwner, setMutationOwner] = useState({ client, principalScope });
  if (mutationOwner.client !== client || mutationOwner.principalScope !== principalScope) setMutationOwner({ client, principalScope });
  const committedOwner = useRef(mutationOwner);
  useLayoutEffect(() => { committedOwner.current = mutationOwner; }, [mutationOwner]);
  const removalKey = ["saved", "agent-usage-removal", principalScope, props.record.id];
  const pendingRemovals = useMutationState({
    filters: { mutationKey: ["saved", "agent-usage-removal"], status: "pending" },
    select: mutation => mutation.options.mutationKey,
  }, client);
  const busy = pendingRemovals.some(key => key?.[2] === principalScope && key[3] === props.record.id);
  const notifyChanged = () => {
    if (props.onChanged) props.onChanged();
    else if (props.inventorySelectionId) props.onReloadInventory?.();
  };
  const removalRevision = useQuery({
    queryKey: removalKey, queryFn: skipToken, initialData: { revision: 0, uncertain: false }, gcTime: 0,
    meta: { notifyAgentUsageChanged: notifyChanged },
  }, client);
  async function submitRemoval(input: CandidateAgentUsageMutation, uiSignal: AbortSignal) {
    if (client.isMutating({ mutationKey: removalKey, exact: true })) return;
    const cache = client.getMutationCache();
    let submitted = false, published = false;
    const ownsMutation = () => cache.getAll().some(cached => cached.mutationId === mutation.mutationId)
      && committedOwner.current === mutationOwner;
    function invalidateUsage(uncertain: boolean) {
      // Clearing the session cache retires completions, including same-account sign-ins.
      if (published || !ownsMutation()) return;
      published = true;
      const current = client.getQueryCache().find({ queryKey: removalKey, exact: true });
      const notify = current?.getObserversCount() ? current.meta?.notifyAgentUsageChanged : notifyChanged;
      client.setQueryData<RemovalEvidence>(removalKey, previous => ({ revision: (previous?.revision ?? 0) + 1, uncertain }));
      if (typeof notify === "function") notify();
    }
    const mutation = cache.build(client, {
      mutationKey: removalKey, gcTime: Infinity, retry: false, networkMode: "always",
      mutationFn: () => {
        if (uiSignal.aborted || !ownsMutation()) throw new ApiError(0, "request_aborted", "The request was cancelled.", { kind: "aborted" });
        // A submitted write can commit after its confirmation/tab has retired.
        const signal = new AbortController().signal;
        submitted = true;
        client.setQueryData<RemovalEvidence>(removalKey, previous => previous ? { ...previous, uncertain: false } : previous);
        return props.inventorySelectionId
          ? mutateAgentReportAssociation(props.record.id, input, "remove", signal, props.inventorySelectionId.toLowerCase())
          : mutateAgentReportAssociation(props.record.id, input, "remove", signal);
      },
      onSuccess: () => invalidateUsage(false),
      onError: cause => { if (submitted && uncertainRemoval(cause)) invalidateUsage(true); },
    });
    try { await mutation.execute(undefined); }
    finally { cache.remove(mutation); }
  }
  const recovery = useRef<RecoverySource | undefined>(undefined);
  useLayoutEffect(() => { recovery.current = undefined; }, [principalScope, props.record.id]);
  const { onReloadInventory, disabled } = props;
  const inventorySelectionId = props.inventorySelectionId?.toLowerCase();
  const context = props.context ? { ...props.context, reports: { ...props.context.reports,
    setId: props.context.reports.setId?.toLowerCase() ?? null } } : undefined;
  const recoverInventory = useCallback((source: RecoverySource = "users") => {
    if (!inventorySelectionId || !onReloadInventory || disabled || recovery.current) return;
    recovery.current = source;
    onReloadInventory();
  }, [disabled, inventorySelectionId, onReloadInventory]);
  const usageReady = useCallback((source: RecoverySource = "users") => {
    if (recovery.current === source) recovery.current = undefined;
  }, []);
  if (capability && !hasRole(user, "AgentControl.Viewer")) return <p role="alert">Current Viewer access is required to read agent usage.</p>;
  const readScope = JSON.stringify([principalScope, props.record.id, context?.revision, context?.reports.setId, props.inventoryRevision, inventorySelectionId, removalRevision.data?.revision ?? 0]);
  return <AgentUsageSession key={readScope} principalScope={readScope} recoverInventory={recoverInventory} usageReady={usageReady} {...props}
    client={client} busy={busy} submitRemoval={submitRemoval} removalUncertain={removalRevision.data?.uncertain ?? false}
    context={context} inventorySelectionId={inventorySelectionId}
    canRemoveReviewedAssociations={props.canRemoveReviewedAssociations && (!capability || hasRole(user, "AgentControl.Admin"))} />;
}

function AgentUsageSession({ record, view, context: inventoryContext, dataRevision = 0, canRemoveReviewedAssociations: canManage,
  disabled, principalScope, inventorySelectionId, onReloadInventory, recoverInventory, usageReady, client, busy, submitRemoval, removalUncertain }: Props & {
    principalScope: string; recoverInventory: (source?: RecoverySource) => void; usageReady: (source?: RecoverySource) => void;
    client: QueryClient; busy: boolean; removalUncertain: boolean; submitRemoval: (input: CandidateAgentUsageMutation, uiSignal: AbortSignal) => Promise<void>;
  }) {
  const owner = useId();
  const [reload, setReload] = useState(0), [cursor, setCursor] = useState<string>();
  const [capturedSelection, setCapturedSelection] = useState<string>();
  const [usersRequested, setUsersRequested] = useState(view === "users");
  const [validatedUsersContext, setValidatedUsersContext] = useState<string>();
  const [historyMetadata, setHistoryMetadata] = useState<Pick<CandidateAgentUsageHistory, "context" | "latestReportSetId">>();
  if (view === "users" && !usersRequested) setUsersRequested(true);
  const [viewedSetId, setViewedSetId] = useState<string>(), [historyCursor, setHistoryCursor] = useState<string>();
  const [remove, setRemove] = useState<{ row: CandidateAgentUsageAssociations["value"][number]; context: CandidateAgentUsageSummary["context"] }>();
  const [confirmed, setConfirmed] = useState(false), [error, setError] = useState<{ message: string; invalidated: boolean }>();
  const selectionId = capturedSelection ?? inventorySelectionId;
  const historyKey = ["saved", "exact-inventory-history", principalScope, record.id, selectionId, historyCursor, dataRevision, reload, owner];
  const history = useQuery<CandidateAgentUsageHistory>({
    queryKey: historyKey,
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
  }, client);
  if (history.isSuccess && !history.isPlaceholderData
    && (historyMetadata?.context !== history.data.context || historyMetadata.latestReportSetId !== history.data.latestReportSetId)) {
    setHistoryMetadata({ context: history.data.context, latestReportSetId: history.data.latestReportSetId });
  }
  // A failed page must not replace the report identity owning hidden Users state.
  const historyIdentity = history.data ?? (historyMetadata?.context.selectionId === selectionId ? historyMetadata : undefined);
  const latestSetId = historyIdentity?.latestReportSetId;
  const requestedSetId = viewedSetId ?? latestSetId;
  const sharedSetId = inventoryContext?.reports.setId ?? historyIdentity?.context.reportSetId;
  const reportOverride = requestedSetId && requestedSetId !== sharedSetId ? requestedSetId : undefined;
  const historyRevision = inventorySelectionId && historyIdentity
    ? JSON.stringify([historyIdentity.context.usageRevision, historyIdentity.context.inventoryRevision]) : undefined;
  const canReadSummary = (usersRequested || !inventorySelectionId) && !history.isError
    && !history.isPlaceholderData
    && (Boolean(history.data?.latestReportSetId) || !inventorySelectionId && latestSetId === undefined);
  const canManageViewedReport = canManage && !viewedSetId && !reportOverride;
  const [confirmationVersion, setConfirmationVersion] = useState({ revision: dataRevision, disabled: Boolean(disabled), view, requestedSetId, historyRevision, canManageViewedReport });
  const removalTrigger = useRef<HTMLButtonElement>(null), confirmationHeading = useRef<HTMLHeadingElement>(null);
  const restoreRemovalFocus = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const removing = useRef<AbortSignal | undefined>(undefined);
  useLayoutEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => controller.abort();
  }, [dataRevision, disabled, view, requestedSetId, canManageViewedReport, reload]);
  useEffect(() => { if (remove) confirmationHeading.current?.focus(); }, [remove]);
  useLayoutEffect(() => {
    if (remove) restoreRemovalFocus.current = true;
    else if (!disabled && restoreRemovalFocus.current) {
      removalTrigger.current?.focus(); restoreRemovalFocus.current = false;
    }
  }, [disabled, remove]);
  const confirmationChanged = confirmationVersion.revision !== dataRevision || confirmationVersion.disabled !== Boolean(disabled)
    || confirmationVersion.view !== view || confirmationVersion.requestedSetId !== requestedSetId
    || confirmationVersion.canManageViewedReport !== canManageViewedReport;
  if (confirmationChanged || confirmationVersion.historyRevision !== historyRevision) {
    if (confirmationVersion.requestedSetId !== requestedSetId || confirmationVersion.historyRevision !== historyRevision) setCursor(undefined);
    setConfirmationVersion({ revision: dataRevision, disabled: Boolean(disabled), view, requestedSetId, historyRevision, canManageViewedReport });
    setRemove(undefined); setConfirmed(false);
    if (!error?.invalidated) setError(undefined);
  }
  const summaryKey = ["saved", "exact-inventory-report", principalScope, record.id, reload, dataRevision, reportOverride, historyRevision, owner];
  const summary = useQuery<CandidateAgentUsageSummary>({
    queryKey: summaryKey, gcTime: 0, staleTime: Infinity,
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
  }, client);
  if (summary.data && !summary.isError && capturedSelection !== summary.data.context.selectionId) setCapturedSelection(summary.data.context.selectionId);
  const context = summary.data?.context;
  const periodReady = Boolean(history.data) && !history.isError && context?.reportSetId === requestedSetId;
  const canReadAssociations = usersRequested && Boolean(context) && periodReady && !summary.isError && !history.isPlaceholderData;
  const associationsKey = ["saved", "exact-inventory-associations", principalScope, record.id, selectionId, cursor, dataRevision, reload, reportOverride, historyRevision, owner];
  const associations = useQuery<CandidateAgentUsageAssociations>({
    queryKey: associationsKey,
    gcTime: 0, staleTime: Infinity, enabled: canReadAssociations,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === principalScope
      && previousQuery.queryKey[4] === selectionId
      && previousQuery.queryKey[7] === reload && previousQuery.queryKey[8] === reportOverride ? previous : undefined,
    queryFn: ({ signal }) => readAgentReportAssociations(record.id, { selectionId: selectionId!, cursor, limit: 50,
      ...(inventorySelectionId ? { inventorySelectionId } : {}), ...(reportOverride ? { setId: reportOverride } : {}) }, signal),
  }, client);
  const refetchSummary = summary.refetch, refetchAssociations = associations.refetch, refetchHistory = history.refetch;
  useEffect(() => {
    const revalidate = () => {
      // Pinned history validates the revisions used by the dependent reads.
      if (canReadSummary && !inventorySelectionId) void refetchSummary({ cancelRefetch: false });
      if (canReadAssociations && !inventorySelectionId) void refetchAssociations({ cancelRefetch: false });
      if (selectionId) void refetchHistory({ cancelRefetch: false });
    };
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [refetchSummary, refetchAssociations, refetchHistory, selectionId, inventorySelectionId, canReadSummary, canReadAssociations]);
  const revalidating = summary.isFetching || associations.isFetching || history.isFetching;
  const mismatched = Boolean(context && (associations.data && contextFields.some(field => context[field] !== associations.data!.context[field])
    || history.data && (context.inventoryRevision !== history.data.context.inventoryRevision
      || context.reportSetId === history.data.context.reportSetId && context.usageRevision !== history.data.context.usageRevision)));
  const changed = mismatched && !revalidating;
  const historyInvalidated = history.error instanceof ApiError && [401, 403, 409].includes(history.error.status);
  const usesSummary = view === "users" || !selectionId;
  const unavailable = historyInvalidated || usesSummary && (summary.isError || associations.isError || changed || error?.invalidated);
  const usersInvalidated = historyInvalidated || error?.invalidated
    || [summary.error, associations.error].some(cause => cause instanceof ApiError && [401, 403, 409].includes(cause.status));
  const retryAssociationCursor = Boolean(cursor) && associations.error instanceof ApiError && associations.error.code === "invalid_cursor"
    && !history.isError && !summary.isError && !changed && !error?.invalidated;
  // A later links-page failure does not retire the users page's validated context.
  const usersContextKey = context ? JSON.stringify([reload, ...contextFields.map(field => context[field])]) : undefined;
  if (usersContextKey !== validatedUsersContext && !mismatched && periodReady && associations.data && !associations.isPlaceholderData
    && !associations.isError && !summary.isError) setValidatedUsersContext(usersContextKey);
  if (unavailable && remove) { setRemove(undefined); setConfirmed(false); }
  const usage = !unavailable && !mismatched && periodReady && summary.data?.status === "linked" ? summary.data : undefined;
  const reports = !unavailable && periodReady ? context?.reports : undefined;
  const period = reports?.reportingPeriod;
  const reviewed = associations.data?.value.filter(row => row.basis === "reviewed") ?? [];
  const linksOwner = JSON.stringify([selectionId, requestedSetId, reload]);
  const hasLinkPages = Boolean(associations.data?.page.nextCursor || associations.data?.page.previousCursor);
  const [linkPagination, setLinkPagination] = useState({ owner: linksOwner, visible: false });
  if (linkPagination.owner !== linksOwner || hasLinkPages && !linkPagination.visible) {
    setLinkPagination({ owner: linksOwner, visible: hasLinkPages });
  }
  const showLinkPages = linkPagination.owner === linksOwner && linkPagination.visible;
  const linksData = usage && !associations.isError && !associations.isPlaceholderData ? associations.data : undefined;
  const linkOwner = {};
  const committedLinkAction = useRef<{ owner: object; moved: boolean } | undefined>(undefined);
  useLayoutEffect(() => {
    committedLinkAction.current = { owner: linkOwner, moved: false };
    return () => { committedLinkAction.current = undefined; };
  });
  function moveLinks(nextCursor: string | null | undefined) {
    const action = committedLinkAction.current;
    if (!action || action.owner !== linkOwner || action.moved || !nextCursor || nextCursor === cursor
      || view !== "users" || disabled || busy || revalidating || !canManageViewedReport || !canReadAssociations || !linksData) return;
    // Revalidation and failures reach the cache before the pager's disabled state renders.
    if ([{ key: historyKey, data: history.data }, { key: summaryKey, data: summary.data }, { key: associationsKey, data: associations.data }]
      .some(({ key, data }) => {
        const cached = client.getQueryState(key);
        return !cached || cached.status !== "success" || cached.fetchStatus !== "idle" || cached.data !== data;
      })) return;
    action.moved = true;
    setCursor(nextCursor);
  }
  const selectionInvalidated = [history.error, ...(usesSummary ? [summary.error, associations.error] : [])].some(cause =>
    cause instanceof ApiError && ["selection_invalidated", "inventory_changed"].includes(cause.code));
  const historySelectionInvalidated = history.error instanceof ApiError && ["selection_invalidated", "inventory_changed"].includes(history.error.code);
  useEffect(() => {
    if (selectionInvalidated || usesSummary && changed) recoverInventory(historySelectionInvalidated ? "history" : "users");
  }, [selectionInvalidated, usesSummary, changed, historySelectionInvalidated, recoverInventory]);
  useEffect(() => {
    if (history.isSuccess && !history.isFetching) {
      usageReady("history");
      if (latestSetId === null) usageReady();
    }
  }, [latestSetId, history.isSuccess, history.isFetching, usageReady]);
  useEffect(() => {
    if (view === "users" && !unavailable && !mismatched && periodReady && summary.data && summary.data.status !== "linked" && associations.data
      && !revalidating) usageReady();
  }, [view, unavailable, mismatched, periodReady, summary.data, associations.data, revalidating, usageReady]);
  function resetUsage() {
    setCursor(undefined); setRemove(undefined); setError(undefined); setConfirmed(false);
    setCapturedSelection(undefined); setHistoryMetadata(undefined); setReload(value => value + 1);
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
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || removing.current === signal || !remove || !confirmed
      || unavailable || !periodReady || !canManageViewedReport || disabled || busy) return;
    removing.current = signal;
    setError(undefined);
    try {
      const input: CandidateAgentUsageMutation = { selectionId: remove.context.selectionId, reportSetId: remove.context.reportSetId,
        usageRevision: remove.context.usageRevision, inventoryRevision: remove.context.inventoryRevision, reportAgentId: remove.row.reportAgentId, confirmed: true };
      await submitRemoval(input, signal);
    } catch (cause) {
      if (!signal?.aborted && !uncertainRemoval(cause)) setError({ message: cause instanceof Error ? cause.message : "Association removal failed.",
        invalidated: cause instanceof ApiError && [401, 403, 409].includes(cause.status) });
    } finally {
      if (removing.current === signal) removing.current = undefined;
    }
  }
  const title = view === "usage" ? "Usage" : "Users";
  return <section className="agent-usage-insights" aria-label={`${title} for ${record.displayName}`}>
    <h3>{title}</h3>
    {busy && !remove ? <p role="status">Removing association...</p> : null}
    {removalUncertain ? <p role="alert">The removal result could not be verified. Review the saved usage below before trying again.</p> : null}
    {history.isFetching ? <p role="status" className={history.data ? "sr-only" : undefined}>Checking saved report history...</p> : null}
    {history.isError && !unavailable ? <div className="error-banner" role="alert"><span>Usage history could not be loaded: {history.error.message}</span>
      <button type="button" className="secondary" disabled={disabled || history.isFetching} onClick={() => {
        if (historyCursor && history.error instanceof ApiError && history.error.code === "invalid_cursor") setHistoryCursor(undefined);
        else if (selectionInvalidated) restartUsage(); else void history.refetch();
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
    {usesSummary && summary.isFetching ? <p role="status" className={usage ? "sr-only" : undefined}>Loading saved agent usage...</p> : null}
    {view === "users" && associations.isFetching ? <p role="status" className={usage ? "sr-only" : undefined}>Loading saved report links...</p> : null}
    {usage && view === "users" ?
      <dl className="agent-usage-metrics" aria-label="Selected agent report metrics">
        <UsageMetric label="Responses" value={usageCount(usage.responses)} />
        <UsageMetric label="Active users" value={usageCount(usage.activeUsers)} />
        <UsageMetric label="Last reported activity" value={usageDate(usage.lastActivityDateUtc)} />
      </dl> : null}
      {usersRequested && !usersInvalidated && !mismatched && summary.data?.status === "linked" && context
        && context.reportSetId === requestedSetId && usersContextKey === validatedUsersContext
        ? <AgentUsers key={usersContextKey}
        recordId={record.id} context={context} revision={dataRevision} inventorySelectionId={inventorySelectionId}
        setId={reportOverride} revalidating={revalidating} active={view === "users" && Boolean(usage)}
        onReady={usageReady} onInvalidated={recoverInventory} onRestartSelection={restartUsage} /> : null}
      {view === "users" && canManageViewedReport && !usersInvalidated && !changed
        && (showLinkPages || linksData && reviewed.length > 0) ? <details className="agent-insight-provenance">
        <summary>Reviewed report links</summary>
        <ul className="agent-usage-association-list">{linksData ? reviewed.map(row => <li key={row.reportAgentId}>
          <div><strong>{row.agentName}</strong><code>{row.reportAgentId}</code><span>{targetLabel(row.target)}</span></div>
          <div className="agent-insight-actions"><WorkbenchActionGate actionId="agentUsage.remove" compact>
            <button type="button" className="secondary" disabled={disabled || busy}
              aria-label={`Remove association for ${row.agentName} (${row.reportAgentId})`}
              onClick={event => { removalTrigger.current = event.currentTarget; if (context) setRemove({ row, context }); setConfirmed(false); setError(undefined); }}>Remove reviewed association</button>
          </WorkbenchActionGate></div>
        </li>) : null}</ul>
        {showLinkPages ? <ReportPageControls data={linksData} loading={revalidating} disabled={disabled || busy || !canReadAssociations} label="report links"
          previous={() => moveLinks(linksData?.page.previousCursor)} next={() => moveLinks(linksData?.page.nextCursor)} /> : null}
      </details> : null}
    {!usage && (unavailable || view === "users" && history.data && !history.isError
      && (!latestSetId || periodReady && summary.data && summary.data.status !== "linked")) ? <div className="agent-insight-empty">
      <h4>{unavailable ? "Usage unavailable" : reports?.setId ? "Usage not reported" : "No CSV reports available"}</h4>
      <p>{!reports?.setId && !unavailable ? "Import a complete CSV report in Sync to see usage."
        : summary.data?.status === "unlinked" && !unavailable ? `This agent is not included in ${viewedSetId ? "this historical" : "the latest"} CSV report.`
          : unavailable ? "Usage could not be loaded for this agent. Reload usage to try again."
            : "Usage is unavailable in the selected CSV report."}</p>
    </div> : null}
    {unavailable ? <div className="error-banner" role="alert">
      <span>{usesSummary && changed ? "Exact source references or reviewed associations changed. Reload usage before reviewing this evidence."
        : (usesSummary ? summary.error?.message ?? associations.error?.message : undefined) ?? history.error?.message ?? error?.message}</span>
      <button type="button" className="secondary" disabled={disabled || busy}
        onClick={retryAssociationCursor ? () => setCursor(undefined) : restartUsage}>
        {retryAssociationCursor ? "Retry report links" : "Reload usage"}</button>
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
      </WorkbenchActionGate><button type="button" className="secondary" disabled={busy}
        onClick={() => {
          if (removing.current && !removing.current.aborted) return;
          setRemove(undefined); setError(undefined);
        }}>Cancel association change</button></div>
    </section> : null}
    {view === "users" && error && !error.invalidated ? <p className="error-banner" role="alert">{error.message}</p> : null}
  </section>;
}

function targetLabel(target: CandidateAgentUsageAssociations["value"][number]["target"]) {
  return target.source === "graph_packages" ? `Graph package: ${target.packageId}`
    : `Power Platform: ${target.nativeId} - Environment: ${target.environmentId ?? "not reported"}`;
}
function UsageMetric({ label, value }: { label: string; value: string }) {
  return <div className="agent-usage-metric"><dt>{label}</dt><dd><strong>{value}</strong></dd></div>;
}
function AgentUsers({ recordId, context, revision, onRestartSelection, inventorySelectionId, setId, onInvalidated, onReady, revalidating, active }: {
  recordId: string; context: CandidateAgentUsageSummary["context"]; revision: number; onRestartSelection: () => void;
  inventorySelectionId?: string; setId?: string; onInvalidated: () => void; onReady: () => void; revalidating: boolean; active: boolean;
}) {
  const [search, setSearch] = useState("");
  const [requested, setRequested] = useState(active);
  const [readRevision, setReadRevision] = useState(revision);
  if (active && !requested) setRequested(true);
  if (active && readRevision !== revision) setReadRevision(revision);
  const normalizedSearch = search.trim().toLowerCase();
  const read = useReportPage<AgentUsageUser, CandidateAgentUsageUsers>(`agent-inventory/${encodeURIComponent(recordId)}/usage-users`,
    { selectionId: context.selectionId, ...(inventorySelectionId ? { inventorySelectionId } : {}),
      ...(setId ? { setId } : {}), search: normalizedSearch || undefined, limit: 25 }, readRevision, requested, onRestartSelection,
    active && !inventorySelectionId);
  const changed = read.data && contextFields.some(field => read.data?.context?.[field] !== context[field]);
  useEffect(() => { if (active && (read.invalidated || changed && !revalidating)) onInvalidated(); }, [active, read.invalidated, changed, revalidating, onInvalidated]);
  const data = changed ? undefined : read.data;
  useEffect(() => { if (active && data && !read.loading && !read.error && !revalidating) onReady(); }, [active, data, read.loading, read.error, revalidating, onReady]);
  if (!active) return null;
  return <section className="agent-usage-users" aria-label="Agent users" aria-busy={read.loading || revalidating}>
    <div className="agent-insight-toolbar"><h4>Users{data ? ` (${data.counts.filtered.toLocaleString()})` : ""}</h4>
      <input type="search" aria-label="Search agent users" placeholder="Search by name or email" maxLength={256} value={search}
        onChange={event => setSearch(event.target.value)} /></div>
    <ReportReadStatus read={read} />
    {changed && !revalidating ? <div className="error-banner" role="alert">The report or inventory changed. Reload agent usage.
      <button type="button" className="secondary" onClick={onRestartSelection}>Reload usage</button></div> : null}
    {data?.value.length ? <div className="table-shell"><table className="agent-insight-table">
      <caption className="sr-only">Users of this agent in this CSV report</caption>
      <thead><tr><th scope="col">User</th><th scope="col">Responses</th></tr></thead>
      <tbody>{data.value.map(user => <tr key={user.username}><th scope="row">{user.displayName !== user.username
        ? <><span>{user.displayName}</span><small>{user.username}</small></> : user.username}</th><td>{usageCount(user.responses)}</td></tr>)}</tbody>
    </table></div> : data ? <p>{data.counts.filtered > 0 ? "No users on this page. Use the page controls to continue."
      : normalizedSearch ? "No users match your search." : "No users listed in this report."}</p> : null}
    <ReportPageControls {...read} data={data} loading={read.loading || revalidating} disabled={Boolean(changed)} label="users" />
  </section>;
}
