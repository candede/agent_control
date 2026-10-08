import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { cancelInventoryRefresh, getInventoryRefreshJob, refreshInventory, resumeInventoryRefresh, type InventoryRefreshJob } from "../api/client";
import { useSavedRead } from "../savedQueries";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { useBrowserAvailability } from "../useBrowserAvailability";

export function PowerPlatformSourceJob({ jobId, initialJob, onSelect, onObserved, onCancelRequested, paused = false }: {
  jobId: string;
  initialJob?: InventoryRefreshJob;
  onSelect: (id: string | undefined, initialJob?: InventoryRefreshJob) => void;
  onObserved: (job: InventoryRefreshJob, previous?: InventoryRefreshJob) => void;
  onCancelRequested?: () => void;
  paused?: boolean;
}) {
  const [initial] = useState(() => initialJob?.id === jobId ? initialJob : undefined);
  const available = useBrowserAvailability();
  const [job, setJob] = useState(initial);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const lifetime = useRef({ active: false });
  const actionRequest = useRef<AbortController | undefined>(undefined);
  const readRequest = useRef<AbortController | undefined>(undefined);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previousJob = useRef(initial);
  const lastReadRevision = useRef<number | undefined>(undefined);
  const commandRevision = useRef(0);
  const readOwner = useId();
  const observed = useEffectEvent(onObserved);
  const readSaved = useSavedRead();
  const selected = job?.id === jobId ? job : undefined;
  const jobUrl = `/sync?${new URLSearchParams({ powerPlatformJob: jobId })}`;

  useEffect(() => {
    const owner = { active: true };
    lifetime.current = owner;
    return () => { owner.active = false; actionRequest.current?.abort(); clearTimeout(pollTimer.current); };
  }, []);

  useEffect(() => {
    if (paused || !available || error || actionRequest.current) return;
    if (lastReadRevision.current === revision && previousJob.current?.id === jobId && previousJob.current.status !== "running") return;
    // A retry hands off an already-observed response, not a stale saved read.
    if (revision === 0 && initial?.id === jobId) {
      if (initial.status === "running") pollTimer.current = setTimeout(() => setRevision(value => value + 1), 2500);
      return () => clearTimeout(pollTimer.current);
    }
    const request = ++generation.current;
    const controller = new AbortController();
    readRequest.current = controller;
    // A command's readback cannot join a peer's older, still-pending status.
    const boundary = commandRevision.current ? [readOwner, commandRevision.current] : [];
    void readSaved(["inventory-refresh-job", jobId, ...boundary], signal =>
      getInventoryRefreshJob(jobId, { signal }), controller.signal).then(result => {
      if (controller.signal.aborted || generation.current !== request || document.visibilityState !== "visible" || !navigator.onLine) return;
      if (result.id !== jobId) throw new Error("The source returned a different job. Reload the exact job.");
      setJob(result);
      setError(undefined);
      observed(result, previousJob.current?.id === jobId ? previousJob.current : undefined);
      previousJob.current = result;
      lastReadRevision.current = revision;
      if (result.status === "running") pollTimer.current = setTimeout(() => setRevision(value => value + 1), 2500);
    }).catch(caught => {
      if (controller.signal.aborted || generation.current !== request) return;
      setJob(undefined);
      setError(caught instanceof Error ? caught.message : "Unable to read this source job.");
    });
    return () => { controller.abort(); clearTimeout(pollTimer.current); generation.current += 1; };
  }, [jobId, revision, paused, available, error, readSaved, initial, readOwner]);

  async function act(action: "resume" | "cancel" | "retry") {
    if (!selected || paused || busy || error || actionRequest.current) return;
    if (action === "cancel") onCancelRequested?.();
    generation.current += 1;
    commandRevision.current += 1;
    readRequest.current?.abort();
    clearTimeout(pollTimer.current);
    const owner = lifetime.current;
    const controller = new AbortController();
    actionRequest.current = controller;
    setBusy(true);
    try {
      const result = action === "retry"
        ? await refreshInventory({ types: selected.requestedTypes, ...(selected.environmentScope ? { environmentId: selected.environmentScope } : {}) }, { signal: controller.signal })
        : action === "resume" ? await resumeInventoryRefresh(jobId, { signal: controller.signal }) : await cancelInventoryRefresh(jobId, { signal: controller.signal });
      if (!owner.active) return;
      if (action !== "retry" && result.id !== jobId) throw new Error("The source returned a different job. Reload the exact job.");
      setJob(result);
      onObserved(result, previousJob.current);
      previousJob.current = result;
      if (action === "retry") onSelect(result.id, result);
      else if (result.status === "running") pollTimer.current = setTimeout(() => setRevision(value => value + 1), 2500);
    } catch (caught) {
      if (!owner.active) return;
      setJob(undefined);
      setError(caught instanceof Error ? caught.message : "Unable to update this source job.");
    } finally {
      if (actionRequest.current === controller) actionRequest.current = undefined;
      if (owner.active) setBusy(false);
    }
  }

  return <section className="sync-inventory-tools" aria-label="Power Platform source job" aria-busy={paused || busy || !error && !selected}>
    <div className="section-heading"><h3>Power Platform source job</h3><button type="button" className="secondary" onClick={() => onSelect(undefined)}>Close source job</button></div>
    <p>Exact job: <code>{jobId}</code></p>
    {paused ? <p role="status">Waiting for the current source command…</p>
      : error ? <div role="alert">{error} <button type="button" onClick={() => { setError(undefined); setRevision(value => value + 1); }}>Reload source job</button></div>
      : !selected ? <p role="status">Loading source job…</p>
        : <>
          <p role="status">{busy ? "Updating source job… Last observed: " : ""}{selected.status.replaceAll("_", " ")}{selected.errorCode ? ` (${selected.errorCode})` : ""}{selected.message ? ` — ${selected.message}` : ""}</p>
          <dl className="sync-inventory-counts">
            <div><dt>Observed rows</dt><dd>{selected.observedCount.toLocaleString()}</dd></div>
            <div><dt>Provider total</dt><dd>{selected.totalRecords === null ? "Unknown" : selected.totalRecords.toLocaleString()}</dd></div>
            <div><dt>Pages</dt><dd>{selected.pageCount}</dd></div>
            <div><dt>Omitted fields</dt><dd>{selected.unknownFieldCount}</dd></div>
          </dl>
          <p>Scope: {selected.roleScope}; {selected.environmentScope ?? "all authorized environments"}. Requested: {selected.requestedTypes.join(", ")}.</p>
          <p>Created: {selected.createdAt}. Updated: {selected.updatedAt}. {selected.snapshotId ? `Saved snapshot: ${selected.snapshotId}` : "No snapshot published by this job."}</p>
          {selected.status === "waiting_authorization" ? <p><a href={`/api/auth/login?${new URLSearchParams({ returnTo: jobUrl })}`}>Sign in again</a>, then resume this exact job.</p> : null}
          <div className="inline-actions">
            {selected.status === "waiting_authorization" ? <WorkbenchActionGate actionId="power-platform.resume"><button type="button" disabled={busy} onClick={() => void act("resume")}>Resume source job</button></WorkbenchActionGate> : null}
            {["waiting_authorization", "running"].includes(selected.status) ? <WorkbenchActionGate actionId="power-platform.cancel"><button type="button" disabled={busy} onClick={() => void act("cancel")}>Cancel source job</button></WorkbenchActionGate> : null}
            {["failed", "cancelled"].includes(selected.status) ? <WorkbenchActionGate actionId="power-platform.refresh"><button type="button" disabled={busy} onClick={() => void act("retry")}>Start a new source refresh</button></WorkbenchActionGate> : null}
          </div>
        </>}
  </section>;
}
