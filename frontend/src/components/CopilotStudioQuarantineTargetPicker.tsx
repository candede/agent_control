import { useDeferredValue, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Eye, RefreshCw, X } from "lucide-react";
import { getQuarantineTargets, type QuarantineTargetCandidate, type QuarantineTargetPage } from "../api/client";
import { CopilotStudioQuarantineControls } from "./CopilotStudioQuarantineControls";
import { parsePowerPlatformRoute } from "../workbenchRouting";

const pageSize = 50;
const noTargets = new Map<string, QuarantineTargetCandidate>();

export function CopilotStudioQuarantineTargetPicker({ initialJobId }: { initialJobId?: string }) {
  const [routeJobId, setRouteJobId] = useState(initialJobId);
  const [page, setPage] = useState<QuarantineTargetPage>();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [selection, setSelection] = useState<{ snapshotId: string; targets: Map<string, QuarantineTargetCandidate> }>();
  const [detailSelection, setDetailSelection] = useState<{ snapshotId: string; target: QuarantineTargetCandidate }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const deferredSearch = useDeferredValue(search.trim());
  const requestId = useRef(0);
  const selected = selection && selection.snapshotId === page?.snapshot?.id ? selection.targets : noTargets;
  const detail = detailSelection && detailSelection.snapshotId === page?.snapshot?.id ? detailSelection.target : undefined;

  useEffect(() => {
    const restore = () => setRouteJobId(parsePowerPlatformRoute(window.location.search).quarantineJobId);
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    void Promise.resolve().then(() => {
      if (requestId.current !== currentRequest) return;
      setLoading(true);
      setError(undefined);
      return getQuarantineTargets({ ...(deferredSearch ? { search: deferredSearch } : {}), limit: pageSize, offset });
    }).then(result => {
      if (!result) return;
      if (requestId.current !== currentRequest) return;
      const lastOffset = Math.max(Math.ceil(result.count / pageSize) - 1, 0) * pageSize;
      if (offset > lastOffset) setOffset(lastOffset);
      setPage(result);
    }).catch(requestError => {
      if (requestId.current === currentRequest) setError(errorMessage(requestError));
    }).finally(() => {
      if (requestId.current === currentRequest) setLoading(false);
    });
    return () => { if (requestId.current === currentRequest) requestId.current += 1; };
  }, [deferredSearch, offset, reload]);

  function toggle(target: QuarantineTargetCandidate) {
    const currentSnapshotId = page?.snapshot?.id;
    if (!currentSnapshotId) return;
    setSelection(current => {
      const next = new Map(current?.snapshotId === currentSnapshotId ? current.targets : []);
      if (next.has(target.nativeId)) next.delete(target.nativeId);
      else if (next.size < 25) next.set(target.nativeId, target);
      return { snapshotId: currentSnapshotId, targets: next };
    });
  }

  function clearSelection() {
    if (page?.snapshot) setSelection({ snapshotId: page.snapshot.id, targets: new Map() });
  }

  function inspect(target: QuarantineTargetCandidate) {
    if (page?.snapshot) setDetailSelection({ snapshotId: page.snapshot.id, target });
  }

  const pageNumber = Math.floor(offset / pageSize) + 1;
  const pageCount = Math.max(Math.ceil((page?.count ?? 0) / pageSize), 1);
  return <section className="inventory-view quarantine-target-view" aria-label="Copilot Studio quarantine target picker">
    <div className="inventory-heading">
      <div><p className="eyebrow">Saved exact control targets</p><h2>Copilot Studio controls</h2></div>
      <button type="button" className="secondary" disabled={loading} onClick={() => setReload(value => value + 1)}><RefreshCw aria-hidden="true" /> Refresh saved target list</button>
    </div>
    <p className="quarantine-target-boundary">This Operator view exposes only current principal-scoped Copilot Studio control targets. A Reader performs any explicit provider inventory refresh.</p>
    <section className="controls quarantine-target-filters" aria-label="Quarantine target filters">
      <label><span>Search saved targets</span><input type="search" value={search} placeholder="Name or native ID" onChange={event => { setSearch(event.target.value); setOffset(0); }} /></label>
    </section>
    {error ? <p className="error-banner" role="alert">{error}</p> : null}
    {page?.snapshot ? <div className="inventory-source-note"><strong>Saved target source</strong><span>Observed {formatDate(page.snapshot.observedAt)}. Direct status is checked separately and never overwrites this inventory observation.</span></div> : null}
    <CopilotStudioQuarantineControls snapshot={page?.snapshot ?? null} targets={[...selected.values()]} variant="bulk" canManage onClear={clearSelection} initialJobId={routeJobId} />
    {loading && !page ? <div className="screen-state">Loading saved quarantine targets...</div> : !page?.snapshot ? <div className="empty-state"><h2>No current saved targets</h2><p>A Reader must run an explicit Copilot Studio inventory refresh for this same account before control targets are available.</p></div> : page.value.length === 0 ? <div className="empty-state"><h2>No matching targets</h2><p>The current saved snapshot contains no matching Copilot Studio control targets.</p></div> : <>
      <div className="inventory-pagination"><span>{page.count ? `${offset + 1}-${Math.min(offset + pageSize, page.count)} of ${page.count}` : "0 targets"}</span><div><button type="button" className="icon-button" aria-label="Previous quarantine target page" disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - pageSize))}><ChevronLeft aria-hidden="true" /></button><span>Page {pageNumber} of {pageCount}</span><button type="button" className="icon-button" aria-label="Next quarantine target page" disabled={offset + pageSize >= page.count || loading} onClick={() => setOffset(value => value + pageSize)}><ChevronRight aria-hidden="true" /></button></div></div>
      <div className="table-shell inventory-table quarantine-target-table"><table><thead><tr><th className="inventory-select"><span className="sr-only">Select targets</span></th><th>Agent</th><th>Native environment</th><th>Native CDS bot</th><th>Saved state</th><th>Package control</th><th>Eligibility</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{page.value.map(target => { const chosen = selected.has(target.nativeId); return <tr key={target.nativeId}><td className="inventory-select"><input type="checkbox" aria-label={`Select ${target.displayName} for quarantine control`} checked={chosen} disabled={!target.quarantineEligibility.eligible || (!chosen && selected.size >= 25)} title={target.quarantineEligibility.reason} onChange={() => toggle(target)} /></td><td><strong>{target.displayName}</strong><small>{target.nativeId}</small></td><td>{target.environmentId ?? "Unavailable"}</td><td>{target.botId ?? "Unavailable"}</td><td>{savedState(target)}</td><td>Not linked; independent</td><td>{target.quarantineEligibility.eligible ? "Exact target" : target.quarantineEligibility.reason ?? "Unavailable"}</td><td><button type="button" className="icon-button" aria-label={`Inspect direct status for ${target.displayName}`} title="Inspect direct quarantine status" disabled={!target.quarantineEligibility.eligible} onClick={() => inspect(target)}><Eye aria-hidden="true" /></button></td></tr>; })}</tbody></table></div>
    </>}
    {detail ? <section className="quarantine-target-detail" aria-label={`Direct quarantine control for ${detail.displayName}`}><header><div><p className="eyebrow">Exact native target</p><h3>{detail.displayName}</h3></div><button type="button" className="icon-button" aria-label="Close direct quarantine control" onClick={() => setDetailSelection(undefined)}><X aria-hidden="true" /></button></header><CopilotStudioQuarantineControls snapshot={page?.snapshot ?? null} targets={[detail]} variant="detail" canManage /></section> : null}
  </section>;
}

function savedState(target: QuarantineTargetCandidate) {
  return typeof target.details.isQuarantined !== "boolean" ? "Unknown" : target.details.isQuarantined ? "Quarantined" : "Not quarantined";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Saved quarantine targets are unavailable.";
}