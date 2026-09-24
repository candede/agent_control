import { useEffect, useEffectEvent, useRef, useState } from "react";
import { cancelInventoryRefresh, getInventoryRefreshJob, refreshInventory, resumeInventoryRefresh, type InventoryRefreshJob } from "../api/client";
import { useSavedRead } from "../savedQueries";
import { WorkbenchActionGate } from "../workbenchActionContext";

export function PowerPlatformSourceJob({ jobId, onSelect, onChanged, onCancelRequested }: {
  jobId: string;
  onSelect: (id: string | undefined) => void;
  onChanged: () => void;
  onCancelRequested?: () => void;
}) {
  const [job, setJob] = useState<InventoryRefreshJob>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const lifetime = useRef({ active: false });
  const previousStatus = useRef<InventoryRefreshJob["status"] | undefined>(undefined);
  const changed = useEffectEvent(onChanged);
  const readSaved = useSavedRead();
  const selected = job?.id === jobId ? job : undefined;

  useEffect(() => {
    const owner = { active: true };
    lifetime.current = owner;
    return () => { owner.active = false; };
  }, []);

  useEffect(() => {
    if (busy || error) return;
    const request = ++generation.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    void readSaved(["power-platform-source-job", jobId, revision], signal =>
      getInventoryRefreshJob(jobId, { signal }), controller.signal).then(result => {
      if (controller.signal.aborted || generation.current !== request) return;
      if (result.id !== jobId) throw new Error("The source returned a different job. Reload the exact job.");
      setJob(result);
      setError(undefined);
      if (previousStatus.current && ["running", "waiting_authorization"].includes(previousStatus.current)
        && !["running", "waiting_authorization"].includes(result.status)) changed();
      previousStatus.current = result.status;
      if (result.status === "running") timer = setTimeout(() => setRevision(value => value + 1), 2500);
    }).catch(caught => {
      if (controller.signal.aborted || generation.current !== request) return;
      setJob(undefined);
      setError(caught instanceof Error ? caught.message : "Unable to read this source job.");
    });
    return () => { controller.abort(); clearTimeout(timer); generation.current += 1; };
  }, [jobId, revision, busy, error, readSaved]);

  async function act(action: "resume" | "cancel" | "retry") {
    if (!selected || busy || error) return;
    if (action === "cancel") onCancelRequested?.();
    generation.current += 1;
    const owner = lifetime.current;
    setBusy(true);
    try {
      const result = action === "retry"
        ? await refreshInventory({ types: selected.requestedTypes, ...(selected.environmentScope ? { environmentId: selected.environmentScope } : {}) })
        : action === "resume" ? await resumeInventoryRefresh(jobId) : await cancelInventoryRefresh(jobId);
      if (!owner.active) return;
      if (action !== "retry" && result.id !== jobId) throw new Error("The source returned a different job. Reload the exact job.");
      setJob(result);
      previousStatus.current = result.status;
      setRevision(value => value + 1);
      onChanged();
      if (action === "retry") onSelect(result.id);
    } catch (caught) {
      if (!owner.active) return;
      setJob(undefined);
      setError(caught instanceof Error ? caught.message : "Unable to update this source job.");
    } finally {
      if (owner.active) setBusy(false);
    }
  }

  return <section className="sync-inventory-tools" aria-label="Power Platform source job">
    <div className="section-heading"><h3>Power Platform source job</h3><button type="button" className="secondary" onClick={() => onSelect(undefined)}>Close source job</button></div>
    <p>Exact job: <code>{jobId}</code></p>
    {error ? <div role="alert">{error} <button type="button" onClick={() => { setError(undefined); setRevision(value => value + 1); }}>Reload source job</button></div>
      : !selected ? <p role="status">Loading source job…</p>
        : <>
          <p role="status">{selected.status.replaceAll("_", " ")}{selected.errorCode ? ` (${selected.errorCode})` : ""}{selected.message ? ` — ${selected.message}` : ""}</p>
          <dl className="sync-inventory-counts">
            <div><dt>Observed rows</dt><dd>{selected.observedCount.toLocaleString()}</dd></div>
            <div><dt>Provider total</dt><dd>{selected.totalRecords === null ? "Unknown" : selected.totalRecords.toLocaleString()}</dd></div>
            <div><dt>Pages</dt><dd>{selected.pageCount}</dd></div>
            <div><dt>Omitted fields</dt><dd>{selected.unknownFieldCount}</dd></div>
          </dl>
          <p>Scope: {selected.roleScope}; {selected.environmentScope ?? "all authorized environments"}. Requested: {selected.requestedTypes.join(", ")}.</p>
          <p>Created: {selected.createdAt}. Updated: {selected.updatedAt}. {selected.snapshotId ? `Saved snapshot: ${selected.snapshotId}` : "No snapshot published by this job."}</p>
          {selected.status === "waiting_authorization" ? <p><a href="/api/auth/login">Sign in again</a>, then resume this exact job.</p> : null}
          <div className="inline-actions">
            {selected.status === "waiting_authorization" ? <WorkbenchActionGate actionId="power-platform.resume"><button type="button" disabled={busy} onClick={() => void act("resume")}>Resume source job</button></WorkbenchActionGate> : null}
            {["waiting_authorization", "running"].includes(selected.status) ? <WorkbenchActionGate actionId="power-platform.cancel"><button type="button" disabled={busy} onClick={() => void act("cancel")}>Cancel source job</button></WorkbenchActionGate> : null}
            {["failed", "cancelled"].includes(selected.status) ? <WorkbenchActionGate actionId="power-platform.refresh"><button type="button" disabled={busy} onClick={() => void act("retry")}>Start a new source refresh</button></WorkbenchActionGate> : null}
          </div>
        </>}
  </section>;
}
