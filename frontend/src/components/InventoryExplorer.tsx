import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Eye, RefreshCw, RotateCw, X } from "lucide-react";
import {
  downloadInventoryCsv, getInventoryQuarantineSelection, getInventoryRefreshJob, getInventoryRefreshJobs, getInventoryResources, getInventorySnapshots, getInventorySourceAwareDetail, refreshInventory, resumeInventoryRefresh,
  type InventoryListQuery, type InventoryRefreshJob, type InventoryRefreshJobList, type InventoryResourcePage, type InventorySnapshot, type InventorySourceAwareDetail, type PowerPlatformResource, type PowerPlatformResourceType,
} from "../api/client";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { quarantineTargetReason } from "../quarantineTarget";
import { CopilotStudioQuarantineControls } from "./CopilotStudioQuarantineControls";
import { parsePowerPlatformRoute, powerPlatformRouteSearch, workbenchUrl } from "../workbenchRouting";

const pageSize = 50;
const noQuarantineTargets = new Map<string, PowerPlatformResource>();

export function InventoryExplorer({ canManageQuarantine = true }: { canManageQuarantine?: boolean; packages?: unknown[] }) {
  const [initialRoute] = useState(() => parsePowerPlatformRoute(window.location.search));
  const [page, setPage] = useState<InventoryResourcePage>();
  const [pageIndex, setPageIndex] = useState(initialRoute.page);
  const [search, setSearch] = useState(initialRoute.search);
  const [type, setType] = useState<"all" | PowerPlatformResourceType>(initialRoute.type as "all" | PowerPlatformResourceType);
  const [environmentId, setEnvironmentId] = useState(initialRoute.environmentId);
  const [sortBy, setSortBy] = useState<InventoryListQuery["sortBy"]>(initialRoute.sortBy);
  const [sortDirection, setSortDirection] = useState<InventoryListQuery["sortDirection"]>(initialRoute.sortDirection);
  const [snapshotId, setSnapshotId] = useState(initialRoute.snapshotId);
  const [snapshots, setSnapshots] = useState<InventorySnapshot[]>([]);
  const [jobHistory, setJobHistory] = useState<InventoryRefreshJobList>({ value: [], lastAttemptAt: null, lastSuccessAt: null });
  const [refreshType, setRefreshType] = useState<"all" | PowerPlatformResourceType>("all");
  const [refreshEnvironment, setRefreshEnvironment] = useState("");
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();
  const [jobError, setJobError] = useState<string>();
  const [job, setJob] = useState<InventoryRefreshJob>();
  const [detail, setDetail] = useState<PowerPlatformResource>();
  const [detailTab, setDetailTab] = useState(initialRoute.detailTab ?? "identity");
  const [routeDetailId, setRouteDetailId] = useState(initialRoute.detailId);
  const [routeDetailType, setRouteDetailType] = useState(initialRoute.detailType);
  const [routeDetailEnvironmentId, setRouteDetailEnvironmentId] = useState(initialRoute.detailEnvironmentId);
  const [routeSelectedIds, setRouteSelectedIds] = useState(() => new Set(initialRoute.selectedIds));
  const [routeRefreshJobId, setRouteRefreshJobId] = useState(initialRoute.refreshJobId);
  const [routeQuarantineJobId, setRouteQuarantineJobId] = useState(initialRoute.quarantineJobId);
  const [quarantineSelection, setQuarantineSelection] = useState<{ snapshotId: string; targets: Map<string, PowerPlatformResource> }>();
  const [displayTime, setDisplayTime] = useState(Date.now);
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const active = useRef(true);
  const listGeneration = useRef(0);
  const deferredSearch = useDeferredValue(search);
  const deferredEnvironment = useDeferredValue(environmentId);
  const quarantineTargets = quarantineSelection && quarantineSelection.snapshotId === page?.snapshot?.id ? quarantineSelection.targets : noQuarantineTargets;
  const query = useMemo<InventoryListQuery>(() => ({
    snapshotId: snapshotId || undefined,
    type: type === "all" ? undefined : type, environmentId: deferredEnvironment.trim() || undefined, search: deferredSearch.trim() || undefined,
    sortBy, sortDirection, limit: pageSize, offset: pageIndex * pageSize,
  }), [deferredEnvironment, deferredSearch, pageIndex, snapshotId, sortBy, sortDirection, type]);

  useEffect(() => {
    active.current = true;
    const timer = window.setInterval(() => setDisplayTime(Date.now()), 60_000);
    return () => { active.current = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    function restoreRoute() {
      const route = parsePowerPlatformRoute(window.location.search);
      setSearch(route.search);
      setType(route.type as typeof type);
      setEnvironmentId(route.environmentId);
      setSortBy(route.sortBy);
      setSortDirection(route.sortDirection);
      setPageIndex(route.page);
      setSnapshotId(route.snapshotId);
      setRouteDetailId(route.detailId);
      setRouteDetailType(route.detailType);
      setRouteDetailEnvironmentId(route.detailEnvironmentId);
      setDetailTab(route.detailTab ?? "identity");
      setRouteSelectedIds(new Set(route.selectedIds));
      setRouteRefreshJobId(route.refreshJobId);
      setRouteQuarantineJobId(route.quarantineJobId);
      setDetail(current => !current ? undefined : current.nativeId === route.detailId
        && (!route.detailType || current.type === route.detailType)
        && (route.detailEnvironmentId === undefined || (current.environmentId ?? "") === route.detailEnvironmentId) ? current : undefined);
    }
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, []);

  useEffect(() => {
    const next = workbenchUrl("power-platform", powerPlatformRouteSearch({
      search, type, environmentId, sortBy: sortBy ?? "displayName", sortDirection: sortDirection ?? "asc",
      page: pageIndex, snapshotId, detailId: detail?.nativeId ?? routeDetailId, detailTab,
      detailType: detail?.type ?? routeDetailType,
      detailEnvironmentId: detail?.environmentId ?? routeDetailEnvironmentId,
      selectedIds: [...routeSelectedIds],
      refreshJobId: routeRefreshJobId,
      quarantineJobId: routeQuarantineJobId,
    }));
    if (`${window.location.pathname}${window.location.search}` !== next) window.history.replaceState({ view: "power-platform" }, "", next);
  }, [detail?.environmentId, detail?.nativeId, detail?.type, detailTab, environmentId, pageIndex, routeDetailEnvironmentId, routeDetailId, routeDetailType, routeQuarantineJobId, routeRefreshJobId, routeSelectedIds, search, snapshotId, sortBy, sortDirection, type]);

  useEffect(() => {
    const owner = ++listGeneration.current;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      setLoading(true);
      setError(undefined);
      return getInventoryResources(query, { signal: controller.signal });
    }).then(result => {
      if (!result) return;
      if (controller.signal.aborted || owner !== listGeneration.current) return;
      const lastPage = Math.max(Math.ceil(result.count / pageSize) - 1, 0);
      if (pageIndex > lastPage) setPageIndex(lastPage);
      setPage(result);
      if (!snapshotId && result.snapshot) setSnapshotId(result.snapshot.id);
    }).catch(requestError => { if (!controller.signal.aborted && owner === listGeneration.current) setError(errorMessage(requestError)); })
      .finally(() => { if (!controller.signal.aborted && owner === listGeneration.current) setLoading(false); });
    return () => { controller.abort(); };
  }, [pageIndex, query, reload, snapshotId]);

  useEffect(() => {
    if (!page?.snapshot) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setQuarantineSelection(current => {
        const targets = new Map(current && current.snapshotId === page.snapshot!.id ? current.targets : []);
        for (const resource of page.value) if (routeSelectedIds.has(resource.nativeId)) targets.set(resource.nativeId, resource);
        return { snapshotId: page.snapshot!.id, targets };
      });
      if (routeDetailId) {
        const exact = page.value.find(resource => resource.nativeId === routeDetailId
          && (!routeDetailType || resource.type === routeDetailType)
          && (routeDetailEnvironmentId === undefined || (resource.environmentId ?? "") === routeDetailEnvironmentId));
        if (exact) setDetail(current => current?.nativeId === exact.nativeId ? current : exact);
      }
    });
    return () => { cancelled = true; };
  }, [page, routeDetailEnvironmentId, routeDetailId, routeDetailType, routeSelectedIds]);

  useEffect(() => {
    if (!snapshotId || routeSelectedIds.size === 0) return;
    const controller = new AbortController();
    getInventoryQuarantineSelection(snapshotId, [...routeSelectedIds], { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setQuarantineSelection({ snapshotId: result.snapshot.id, targets: new Map(result.value.map(resource => [resource.nativeId, resource])) });
    }).catch(reason => {
      if (!controller.signal.aborted) setError(`Selected target resolution failed: ${errorMessage(reason)}`);
    });
    return () => controller.abort();
  }, [routeSelectedIds, snapshotId]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([getInventorySnapshots({ signal: controller.signal }), getInventoryRefreshJobs({ signal: controller.signal })]).then(([snapshotResult, jobResult]) => {
      if (controller.signal.aborted) return;
      setSnapshots(snapshotResult.value);
      setJobHistory(jobResult);
      if (!routeRefreshJobId) {
        setJob(current => current ?? jobResult.value.find(candidate => candidate.status === "running" || candidate.status === "waiting_authorization") ?? jobResult.value[0]);
      }
    }).catch(requestError => { if (!controller.signal.aborted) setError(errorMessage(requestError)); });
    return () => { controller.abort(); };
  }, [reload, routeRefreshJobId]);

  useEffect(() => {
    if (!routeRefreshJobId) {
      void Promise.resolve().then(() => setJobError(undefined));
      return;
    }
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return undefined;
      setJob(undefined);
      setJobError(undefined);
      return getInventoryRefreshJob(routeRefreshJobId, { signal: controller.signal });
    })
      .then(result => { if (!controller.signal.aborted) setJob(result); })
      .catch(requestError => {
        if (!controller.signal.aborted) setJobError(`The exact inventory refresh job is unavailable to this account: ${errorMessage(requestError)}`);
      });
    return () => controller.abort();
  }, [routeRefreshJobId]);

  const pollingJobId = job?.status === "running" ? job.id : undefined;
  useEffect(() => {
    if (!pollingJobId) return;
    const controller = new AbortController();
    const deadline = Date.now() + 5 * 60_000;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await getInventoryRefreshJob(pollingJobId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setJob(next);
        if (next.status !== "running") setReload(value => value + 1);
        else if (Date.now() < deadline) timer = window.setTimeout(() => void poll(), 1_000);
        else setError("Inventory job polling reached its five-minute bound. Use Jobs for explicit status.");
      } catch (requestError) {
        if (!controller.signal.aborted) setError(errorMessage(requestError));
      }
    };
    timer = window.setTimeout(() => void poll(), 1_000);
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [pollingJobId]);

  const totalPages = Math.max(Math.ceil((page?.count ?? 0) / pageSize), 1);
  const covered = page?.typeCounts.filter(item => item.status === "covered").length ?? 0;
  const restricted = page?.typeCounts.filter(item => item.status === "not_authorized_scope").length ?? 0;

  async function handleRefresh() {
    setError(undefined);
    try {
      const next = await refreshInventory({
        ...(refreshType === "all" ? {} : { types: [refreshType] }),
        ...(refreshEnvironment.trim() ? { environmentId: refreshEnvironment.trim() } : {}),
      });
      if (!active.current) return;
      setJob(next);
      setReload(value => value + 1);
    } catch (requestError) { if (active.current) setError(errorMessage(requestError)); }
  }

  async function handleResume() {
    if (!job) return;
    setError(undefined);
    try { const next = await resumeInventoryRefresh(job.id); if (active.current) setJob(next); } catch (requestError) { if (active.current) setError(errorMessage(requestError)); }
  }

  async function handleExport() {
    setExporting(true);
    setError(undefined);
    try {
      if (!page?.snapshot) throw new Error("The exact inventory snapshot is no longer available.");
      const blob = await downloadInventoryCsv({ ...query, snapshotId: page.snapshot.id, limit: undefined, offset: undefined });
      if (!active.current) return;
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "power-platform-inventory.csv"; anchor.click(); URL.revokeObjectURL(url);
    } catch (requestError) { if (active.current) setError(errorMessage(requestError)); }
    finally { if (active.current) setExporting(false); }
  }

  function closeDetails() {
    setDetail(undefined);
    setRouteDetailId(undefined);
    setRouteDetailType(undefined);
    setRouteDetailEnvironmentId(undefined);
    window.requestAnimationFrame(() => detailTrigger.current?.focus());
  }

  function toggleQuarantineTarget(resource: PowerPlatformResource) {
    const currentSnapshotId = page?.snapshot?.id;
    if (!currentSnapshotId) return;
    const next = new Map(quarantineTargets);
    if (next.has(resource.nativeId)) next.delete(resource.nativeId);
    else if (next.size < 25) next.set(resource.nativeId, resource);
    setRouteSelectedIds(new Set(next.keys()));
    setQuarantineSelection({ snapshotId: currentSnapshotId, targets: next });
  }

  function clearQuarantineTargets() {
    if (page?.snapshot) setQuarantineSelection({ snapshotId: page.snapshot.id, targets: new Map() });
    setRouteSelectedIds(new Set());
  }

  return <section className="inventory-view" aria-label="Power Platform inventory explorer">
    <div className="inventory-heading">
      <div><p className="eyebrow">Saved delegated inventory</p><h2>Inventory Explorer</h2></div>
      <div className="inventory-actions">
        <button type="button" className="secondary icon-button" title="Export filtered inventory CSV" aria-label="Export filtered inventory CSV" disabled={exporting || !page?.snapshot} onClick={() => void handleExport()}><Download aria-hidden="true" /></button>
        <WorkbenchActionGate actionId="power-platform.refresh">
          <button type="button" className="primary-link inventory-refresh" disabled={job?.status === "running"} onClick={() => void handleRefresh()}><RefreshCw aria-hidden="true" /> Refresh selected scope</button>
        </WorkbenchActionGate>
      </div>
    </div>

    {error || jobError ? <div className="error-banner" role="alert">{error ?? jobError}</div> : null}
    {routeSelectedIds.size > quarantineTargets.size ? <div className="notice" role="status">{routeSelectedIds.size - quarantineTargets.size} selected exact target{routeSelectedIds.size - quarantineTargets.size === 1 ? " is" : "s are"} still resolving; confirmation remains disabled until all are visible.</div> : null}
    {job ? <RefreshStatus job={job} onResume={handleResume} /> : null}

    <section className="summary-grid inventory-summary" aria-label="Inventory summary">
      <Metric label="Resources" value={page?.snapshot ? page.count : "Unknown"} />
      <Metric label="Covered types" value={covered} />
      <Metric label="Role-restricted types" value={restricted} />
      <Metric label="Observed" value={page?.snapshot ? formatRelativeDate(page.snapshot.observedAt) : "No snapshot"} />
      <Metric label="Last attempt" value={formatDateTime(jobHistory.lastAttemptAt, "None")} />
      <Metric label="Last success" value={formatDateTime(jobHistory.lastSuccessAt, "None")} />
    </section>

    {page?.snapshot ? <div className="inventory-source-note"><strong>{displayTime - Date.parse(page.snapshot.observedAt) > 20 * 60_000 ? "Stale saved source observation" : "Saved source observation"}</strong><span>{formatDateTime(page.snapshot.observedAt, "Unknown")} · {scopeText(page.snapshot)} · {title(page.snapshot.roleScope)} role coverage · Unknown fields omitted: {page.snapshot.unknownFieldCount}.</span><span>Power Platform changes typically appear within 20 minutes. Draft inventory reflects published configuration fields where documented. Authorized saved data remains available during provider outages.</span></div> : null}

    {page?.snapshot ? <div className="coverage-strip" aria-label="Resource type coverage" tabIndex={0}>
      {page.typeCounts.map(item => <span key={item.type} className={`coverage-item ${item.status}`} title={item.type}>{shortType(item.type)} <strong>{coverageValue(item.status, item.count)}</strong></span>)}
    </div> : null}

    <section className="controls inventory-controls" aria-label="Inventory filters">
      <label><span>Saved scope</span><select value={snapshotId} onChange={event => { setSnapshotId(event.target.value); setPageIndex(0); setRouteSelectedIds(new Set()); setQuarantineSelection(undefined); setDetail(undefined); setRouteDetailId(undefined); }}><option value="">Preferred broad or latest</option>{snapshots.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{scopeText(snapshot)} · {formatRelativeDate(snapshot.observedAt)}</option>)}</select></label>
      <label className="filter-search"><span>Search</span><input type="search" value={search} placeholder="Name or native ID" onChange={event => { setSearch(event.target.value); setPageIndex(0); }} /></label>
      <label><span>Resource type</span><select value={type} onChange={event => { setType(event.target.value as typeof type); setPageIndex(0); }}><option value="all">All resource types</option>{page?.typeCounts.map(item => <option key={item.type} value={item.type}>{shortType(item.type)}</option>)}</select></label>
      <label><span>Environment ID</span><input value={environmentId} placeholder="All environments" onChange={event => { setEnvironmentId(event.target.value); setPageIndex(0); }} /></label>
      <label><span>Sort</span><select value={sortBy} onChange={event => setSortBy(event.target.value as typeof sortBy)}><option value="displayName">Name</option><option value="type">Type</option><option value="environmentId">Environment</option><option value="createdAt">Created</option><option value="lastPublishedAt">Published</option></select></label>
      <label><span>Direction</span><select value={sortDirection} onChange={event => setSortDirection(event.target.value as typeof sortDirection)}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
      <label><span>Refresh resource scope</span><select value={refreshType} onChange={event => setRefreshType(event.target.value as typeof refreshType)}><option value="all">All supported types</option>{page?.typeCounts.map(item => <option key={item.type} value={item.type}>{shortType(item.type)}</option>)}</select></label>
      <label><span>Refresh environment scope</span><input value={refreshEnvironment} placeholder="All environments" onChange={event => setRefreshEnvironment(event.target.value)} /></label>
    </section>

    {canManageQuarantine && routeSelectedIds.size === quarantineTargets.size ? <CopilotStudioQuarantineControls snapshot={page?.snapshot ?? null} targets={[...quarantineTargets.values()]} variant="bulk" canManage={canManageQuarantine} onClear={clearQuarantineTargets} initialJobId={routeQuarantineJobId} /> : null}

    {loading && !page ? <div className="screen-state">Loading saved inventory...</div> : !page?.snapshot ? <div className="empty-state"><h2>No saved inventory</h2><p>Run an explicit refresh after Power Platform inventory access is available.</p></div> : page.value.length === 0 ? <div className="empty-state"><h2>No matching resources</h2><p>The saved snapshot has no resources for these filters. Role-restricted types are not counted as zero.</p></div> : <>
      <div className="inventory-pagination"><span>{page.count ? `${pageIndex * pageSize + 1}-${Math.min((pageIndex + 1) * pageSize, page.count)} of ${page.count}` : "0 resources"}</span><div><button type="button" className="icon-button" aria-label="Previous inventory page" disabled={pageIndex === 0 || loading} onClick={() => setPageIndex(value => value - 1)}><ChevronLeft aria-hidden="true" /></button><span>Page {pageIndex + 1} of {totalPages}</span><button type="button" className="icon-button" aria-label="Next inventory page" disabled={pageIndex >= totalPages - 1 || loading} onClick={() => setPageIndex(value => value + 1)}><ChevronRight aria-hidden="true" /></button></div></div>
      <div className="table-shell inventory-table"><table><thead><tr>{canManageQuarantine ? <th className="inventory-select"><span className="sr-only">Select quarantine targets</span></th> : null}<th>Name</th><th>Type</th><th>Environment</th><th>Built with</th><th>Lifecycle</th><th>Published</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{page.value.map(resource => { const reason=quarantineTargetReason(resource,page.snapshot,displayTime); const selected=quarantineTargets.has(resource.nativeId); return <tr key={`${resource.type}:${resource.environmentId}:${resource.nativeId}`}>{canManageQuarantine ? <td className="inventory-select">{resource.type === "microsoft.copilotstudio/agents" ? <input type="checkbox" aria-label={`Select ${resource.displayName ?? resource.nativeId} for quarantine control`} title={reason} checked={selected} disabled={Boolean(reason) || (!selected && quarantineTargets.size >= 25)} onChange={() => toggleQuarantineTarget(resource)} /> : <span aria-hidden="true">-</span>}</td> : null}<td><strong>{resource.displayName ?? "Not supplied"}</strong><small>{resource.nativeId}</small></td><td>{shortType(resource.type)}</td><td>{resource.environmentId ?? "Not supplied"}</td><td>{resource.authoringTool ?? "Not supplied"}</td><td>{title(resource.lifecycle)}</td><td>{formatDate(resource.lastPublishedAt)}</td><td><button type="button" className="icon-button" title="View inventory details" aria-label={`View details for ${resource.displayName ?? resource.nativeId}`} onClick={event => { detailTrigger.current=event.currentTarget; setDetail(resource); }}><Eye aria-hidden="true" /></button></td></tr>; })}</tbody></table></div>
    </>}
    {detail ? <InventoryDetails resource={detail} snapshot={page?.snapshot ?? null} activeTab={detailTab} onTabChange={setDetailTab} canManageQuarantine={canManageQuarantine} onClose={closeDetails} /> : null}
  </section>;
}

function RefreshStatus({ job, onResume }: { job: InventoryRefreshJob; onResume: () => Promise<void> }) {
  return <div className={`inventory-job ${job.status}`} role="status" aria-live="polite"><div><strong>{job.status === "running" ? "Refreshing inventory" : title(job.status)}</strong><span>{job.pageCount} pages, {job.observedCount}{job.totalRecords === null ? "" : ` of ${job.totalRecords}`} resources observed</span>{job.message ? <span>{job.message}</span> : null}</div>{job.status === "waiting_authorization" ? <WorkbenchActionGate actionId="power-platform.resume"><button type="button" className="secondary" onClick={() => void onResume()}><RotateCw aria-hidden="true" /> Resume with current authorization</button></WorkbenchActionGate> : null}</div>;
}

const inventoryDetailTabs = ["identity", "power-platform", "package", "reports", "audit", "security", "controls"] as const;
type InventoryDetailTab = typeof inventoryDetailTabs[number];

function InventoryDetails({ resource, snapshot, activeTab, onTabChange, canManageQuarantine, onClose }: {
  resource: PowerPlatformResource; snapshot: InventorySnapshot | null; activeTab: string;
  onTabChange: (tab: InventoryDetailTab) => void; canManageQuarantine: boolean; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [related, setRelated] = useState<InventorySourceAwareDetail>();
  const [relatedError, setRelatedError] = useState("");
  const selectedTab: InventoryDetailTab = inventoryDetailTabs.includes(activeTab as InventoryDetailTab) ? activeTab as InventoryDetailTab : "identity";
  function closeDialog() {
    if (typeof dialog.current?.close === "function") dialog.current.close();
    else { dialog.current?.removeAttribute("open"); onClose(); }
  }
  useEffect(() => {
    const element = dialog.current;
    if (typeof element?.showModal === "function") element.showModal();
    else element?.setAttribute("open", "");
    return () => { if (element?.open && typeof element.close === "function") element.close(); };
  }, []);
  useEffect(() => {
    window.requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>(`#inventory-tab-${selectedTab}`)?.focus());
  }, [selectedTab]);
  useEffect(() => {
    const exactSnapshotId = snapshot?.id;
    if (!exactSnapshotId) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      setRelated(undefined);
      setRelatedError("");
      return getInventorySourceAwareDetail({
        snapshotId: exactSnapshotId, nativeId: resource.nativeId, type: resource.type, environmentId: resource.environmentId,
      }, { signal: controller.signal });
    }).then(result => {
      if (result && !controller.signal.aborted) setRelated(result);
    }).catch(reason => {
      if (!controller.signal.aborted) setRelatedError(errorMessage(reason));
    });
    return () => controller.abort();
  }, [resource.environmentId, resource.nativeId, resource.type, snapshot?.id]);
  const approvedFields = detailFields(resource.type);
  return <dialog ref={dialog} className="inventory-detail-modal" aria-labelledby="inventory-detail-title" onClose={onClose} onMouseDown={event => { if (event.target === event.currentTarget) closeDialog(); }} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); closeDialog(); return; }
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) && (event.target as HTMLElement).getAttribute("role") === "tab") {
      event.preventDefault();
      const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
      const current = tabs.indexOf(event.target as HTMLElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next]?.focus();
      tabs[next]?.click();
      return;
    }
    if (event.key !== "Tab") return;
    const controls=event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],[tabindex="0"]');
    const first=controls[0];const last=controls[controls.length-1];
    if (event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }}><header><div><p className="eyebrow">{shortType(resource.type)}</p><h2 id="inventory-detail-title">{resource.displayName ?? resource.nativeId}</h2></div><button type="button" className="icon-button" aria-label="Close inventory details" onClick={closeDialog}><X aria-hidden="true" /></button></header>
    <div className="detail-tabs" role="tablist" aria-label="Source-aware details">{inventoryDetailTabs.map(tab => <button key={tab} id={`inventory-tab-${tab}`} type="button" role="tab" aria-selected={selectedTab === tab} aria-controls={`inventory-panel-${tab}`} tabIndex={selectedTab === tab ? 0 : -1} onClick={() => onTabChange(tab)}>{title(tab)}</button>)}</div>
    {relatedError ? <div className="error-banner" role="alert">{relatedError} <button type="button" onClick={() => {
      if (!snapshot) return;
      setRelatedError("");
      getInventorySourceAwareDetail({ snapshotId: snapshot.id, nativeId: resource.nativeId, type: resource.type, environmentId: resource.environmentId }).then(setRelated).catch(reason => setRelatedError(errorMessage(reason)));
    }}>Retry authorized lookup</button></div> : null}
    {!related && !relatedError ? <div className="screen-state" role="status">Loading authorized source associations…</div> : null}
    <section id={`inventory-panel-${selectedTab}`} role="tabpanel" aria-labelledby={`inventory-tab-${selectedTab}`} tabIndex={0} className="inventory-detail-section">
      {selectedTab === "identity" ? <><h3>Exact identities</h3><div className="inventory-detail-grid"><Detail label="Native ID" value={resource.nativeId} /><Detail label="Source" value="Power Platform inventory" /><Detail label="Identity confidence" value={title(resource.identityConfidence)} /><Detail label="Environment" value={resource.environmentId} /><Detail label="Snapshot observed" value={related?.observedAt ?? snapshot?.observedAt} /><Detail label="Snapshot ID" value={snapshot?.id} /></div><p className="association-status">{associationText(resource.association)}</p><dl className="inventory-identifiers">{resource.identifiers.map(identifier => <div key={`${identifier.kind}:${identifier.value}`}><dt>{title(identifier.kind)}</dt><dd>{identifier.value}</dd></div>)}</dl></> : null}
      {selectedTab === "power-platform" ? <><h3>Power Platform data</h3><div className="inventory-detail-grid embedded"><Detail label="Creator type" value={title(resource.creatorType)} /><Detail label="Authoring tool" value={resource.authoringTool} maturity={resource.provenance.authoringTool?.maturity} /><Detail label="Agent kind" value={title(resource.agentKind)} /><Detail label="Lifecycle" value={title(resource.lifecycle)} />{approvedFields.map(field => <Detail key={field.key} label={field.label} value={fieldValue(resource, field.key)} maturity={resource.provenance[field.key]?.maturity} />)}</div>
        {resource.details.capabilityDetailsTruncated ? <p>Capability details are partial; the source response reached its bounded projection limit.</p> : null}
        {resource.details.connectors?.length ? <><h4>Connector capability details</h4><dl className="inventory-identifiers">{resource.details.connectors.map(connector => <div key={connector.connectorId}><dt>{connector.connectorId}</dt><dd>{connector.operations?.length ? <ul>{connector.operations.map(operation => <li key={operation.operationId}><strong>{operation.displayName ?? operation.operationId}</strong> · {[operation.method, operation.usedAs].filter(Boolean).join(" · ") || "Operation metadata not supplied"}</li>)}</ul> : "No allowlisted operation metadata supplied"}</dd></div>)}</dl></> : null}
        <p>{resource.unknownFieldCount} unknown or malformed fields were omitted without retaining their values.</p></> : null}
      {selectedTab === "package" ? <SourceState title="Package source" source={related?.package} /> : null}
      {selectedTab === "reports" ? <SourceState title="Official reports" source={related?.reports} /> : null}
      {selectedTab === "audit" ? <><SourceState title="Purview audit" source={related?.audit} />{related?.audit.status === "available" ? <dl className="inventory-identifiers">{related.audit.value.map(record => <div key={`${record.jobId}:${record.wrapperId}`}><dt>{record.operation} · {formatDate(record.observedAt)}</dt><dd>Exact {title(record.matchedKind)} · event {record.nativeEventId ?? record.wrapperId} · job {record.jobId} · correlation {record.correlationId ?? "Not supplied"}</dd></div>)}</dl> : null}</> : null}
      {selectedTab === "security" ? <><SourceState title="Defender security" source={related?.security} />{related?.security.status === "available" ? <dl className="inventory-identifiers">{related.security.value.map(record => <div key={`${record.snapshotId}:${record.nativeRecordId}`}><dt>{record.nativeRecordId} · {formatDate(record.observedAt)}</dt><dd>Exact {title(record.matchedKind)} · snapshot {record.snapshotId} · job {record.jobId} · {record.lifecycleStatus ?? "Lifecycle not supplied"}</dd></div>)}</dl> : null}</> : null}
      {selectedTab === "controls" ? <><h3>Native controls</h3>{related?.controls.quarantineTarget && resource.type === "microsoft.copilotstudio/agents" && canManageQuarantine ? <CopilotStudioQuarantineControls snapshot={snapshot} targets={[resource]} variant="detail" canManage={canManageQuarantine} /> : <p>Quarantine is unavailable without one exact environment/CDS bot target and Operator authorization.</p>}<p>Package block/access controls are unavailable: no package native ID is associated. Power Platform native IDs are never substituted.</p></> : null}
    </section>
  </dialog>;
}

function SourceState({ title: heading, source }: { title: string; source: InventorySourceAwareDetail["audit"] | InventorySourceAwareDetail["security"] | InventorySourceAwareDetail["package"] | undefined }) {
  if (!source) return <><h3>{heading}</h3><p>Loading source authorization and exact associations…</p></>;
  if (source.status !== "available") return <><h3>{heading}</h3><p className="association-status">{title(source.status)}: {source.reason}</p></>;
  return <><h3>{heading}</h3><p className="association-status">{source.count === 0 ? "Authorized and queried; no exact associated records." : `${source.count} exact associated record${source.count === 1 ? "" : "s"}; showing ${source.value.length}.`}</p></>;
}

function Detail({ label, value, maturity }: { label: string; value: unknown; maturity?: "ga" | "preview" }) { return <div><span>{label}{maturity === "preview" ? <em>Preview</em> : null}</span><strong>{formatValue(value)}</strong></div>; }
function Metric({ label, value }: { label: string; value: string | number }) { return <article className="metric"><span>{label}</span><strong>{value}</strong></article>; }
function formatValue(value: unknown) { if (value === null || value === undefined || value === "") return "Not supplied"; if (typeof value === "boolean") return value ? "Yes" : "No"; return String(value); }
function formatDate(value: string | null) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not supplied"; }
function formatDateTime(value: string | null, empty: string) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : empty; }
function formatRelativeDate(value: string) { const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000)); return hours < 1 ? "Less than 1h ago" : hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`; }
function title(value: string) { return value.replace(/^microsoft\./, "").replace(/[_.-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()); }
function shortType(value: PowerPlatformResourceType) { return title(value.split("/").at(-1) ?? value); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Inventory request failed."; }
function coverageValue(status: string, count: number | null) { return status === "not_authorized_scope" ? "Not authorized" : status === "unknown" ? count === null ? "Unknown" : `Observed ${count}; coverage unknown` : String(count ?? 0); }
function associationText(association: PowerPlatformResource["association"]) {
  if (!association) return "Not supplied.";
  if (association.status === "resolved") return `Resolved by exact ${title(association.matchedKind)}: ${association.candidate.nativeId} (${association.candidate.resourceType}, ${association.candidate.environmentId ?? "environment not supplied"}).`;
  if (association.status === "ambiguous") return `Ambiguous: ${association.candidateCount ?? association.candidates.length} exact candidates remain separate.`;
  return association.reason === "blueprint_is_parent_not_equivalence" ? "Unresolved: a shared blueprint is parentage, not equivalence." : "Unresolved: no documented exact identifier matches another record in this saved scope.";
}
function scopeText(snapshot: InventorySnapshot) { const types=snapshot.requestedTypes.length===11?"All supported types":snapshot.requestedTypes.map(shortType).join(", ");return `${snapshot.environmentScope??"All environments"} · ${types}`; }
type DetailKey = keyof PowerPlatformResource["details"] | "createdAt" | "createdBy" | "lastPublishedAt" | "location";
const commonOwnedFields: {key:DetailKey;label:string}[]=[{key:"location",label:"Location"},{key:"createdAt",label:"Created"},{key:"createdBy",label:"Created by"},{key:"ownerId",label:"Owner"},{key:"lastModifiedAt",label:"Last modified"},{key:"lastModifiedBy",label:"Last modified by"}];
function detailFields(type: PowerPlatformResourceType): {key:DetailKey;label:string}[] {
  if(type==="microsoft.copilotstudio/agents")return [...commonOwnedFields,{key:"lastPublishedAt",label:"Last published"},{key:"isQuarantined",label:"Quarantined"},{key:"quarantinedAt",label:"Quarantined at"},{key:"isManaged",label:"Managed solution"},{key:"schemaName",label:"Schema name"},{key:"orchestration",label:"Orchestration"},{key:"model",label:"Model"},{key:"authentication",label:"Authentication"},{key:"isWebSearchEnabledForKnowledge",label:"Web search for knowledge"}];
  if(type==="microsoft.powerplatformconnector/connectors")return [{key:"description",label:"Description"},{key:"connectorId",label:"Connector ID"},{key:"publisher",label:"Publisher"},{key:"tier",label:"Tier"},{key:"releaseTag",label:"Release tag"},{key:"isDeprecated",label:"Deprecated"}];
  if(type==="microsoft.powerplatform/environments")return [{key:"location",label:"Location"},{key:"createdAt",label:"Created"},{key:"createdBy",label:"Created by"},{key:"lastModifiedAt",label:"Last modified"},{key:"environmentType",label:"Environment type"},{key:"isManaged",label:"Managed environment"},{key:"environmentGroup",label:"Environment group"},{key:"environmentGroupId",label:"Environment group ID"}];
  if(type==="microsoft.powerplatform/environmentgroups")return [{key:"location",label:"Location"},{key:"createdAt",label:"Created"},{key:"createdBy",label:"Created by"},{key:"lastModifiedAt",label:"Last modified"},{key:"description",label:"Description"}];
  const fields=[...commonOwnedFields,{key:"isQuarantined" as const,label:"Quarantined"}];
  if(type==="microsoft.powerapps/modeldrivenapps")return fields.filter(field=>field.key!=="ownerId").concat([{key:"appModuleId",label:"App module ID"},{key:"logicalName",label:"Logical name"}]);
  if(type==="microsoft.powerapps/codeapps"||type==="microsoft.powerapps/apps")return fields.concat([{key:"subType",label:"Subtype"}]);
  if(type.startsWith("microsoft.powerautomate/"))return commonOwnedFields.concat([{key:"workflowEntityId",label:"Workflow entity ID"},{key:"trigger",label:"Trigger connector"},{key:"triggerOperation",label:"Trigger operation"}]);
  return fields;
}
function fieldValue(resource:PowerPlatformResource,key:DetailKey){const value=key in resource?resource[key as keyof PowerPlatformResource]:resource.details[key as keyof PowerPlatformResource["details"]];return key.endsWith("At")&&typeof value==="string"?formatDate(value):value;}