import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { CircleStop, LoaderCircle } from "lucide-react";
import { ApiError, cancelPackageDetailSync, getPackageDetailSyncState, startPackageDetailSync, type DataSyncSourceState, type PackageDetailSyncState } from "../api/client";
import { useBrowserAvailability } from "../useBrowserAvailability";
import { useSavedRead } from "../savedQueries";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { formatSyncInstant } from "./syncPresentation";
import { SyncSourceRow } from "./SyncSourceRow";

type Props = {
  principalKey: string;
  revision: string;
  onStateChanged: (state: PackageDetailSyncState | undefined) => void;
  onPublicationChanged: () => void;
  onStartRequested: () => void;
  onCancelRequested: () => void;
};

const statuses: Record<PackageDetailSyncState["status"], DataSyncSourceState> = {
  not_collected: "not_started", ready: "partial", running: "running", complete: "succeeded",
  waiting_authorization: "waiting_authorization", permission_required: "permission_required", failed: "failed", paused: "cancelled",
};

export type PackageDetailsSyncPanelHandle = { refresh: () => void };

export const PackageDetailsSyncPanel = forwardRef<PackageDetailsSyncPanelHandle, Props>(function PackageDetailsSyncPanel(props, ref) {
  return <PrincipalPackageDetailsSyncPanel key={props.principalKey} {...props} ref={ref} />;
});

const PrincipalPackageDetailsSyncPanel = forwardRef<PackageDetailsSyncPanelHandle, Props>(function PrincipalPackageDetailsSyncPanel({
  principalKey, revision, onStateChanged, onPublicationChanged, onStartRequested, onCancelRequested,
}, ref) {
  const available = useBrowserAvailability();
  const readSaved = useSavedRead();
  const [state, setState] = useState<PackageDetailSyncState>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"start" | "cancel">();
  const [reload, setReload] = useState(0);
  const [catalogRevision, setCatalogRevision] = useState(revision);
  const activeRevision = useRef(revision);
  if (catalogRevision !== revision) {
    setCatalogRevision(revision);
    setState(undefined);
    setError("");
  }
  const action = useRef<AbortController | undefined>(undefined);
  const previousFresh = useRef<number | undefined>(undefined);
  const callbacks = useRef({ onStateChanged, onPublicationChanged, onStartRequested, onCancelRequested });
  useLayoutEffect(() => {
    callbacks.current = { onStateChanged, onPublicationChanged, onStartRequested, onCancelRequested };
  }, [onStateChanged, onPublicationChanged, onStartRequested, onCancelRequested]);
  useLayoutEffect(() => {
    activeRevision.current = revision;
    callbacks.current.onStateChanged(undefined);
  }, [revision]);
  useEffect(() => () => action.current?.abort(), []);
  useImperativeHandle(ref, () => ({ refresh: () => setReload(value => value + 1) }), []);

  const observe = useCallback((next: PackageDetailSyncState) => {
    if (activeRevision.current !== revision) return;
    if (previousFresh.current !== undefined && previousFresh.current !== next.fresh) callbacks.current.onPublicationChanged();
    previousFresh.current = next.fresh;
    setState(next);
    callbacks.current.onStateChanged(next);
  }, [revision]);

  useEffect(() => {
    if (!available || busy) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const read = async () => {
      try {
        const next = await readSaved(["package-detail-sync", principalKey, revision, reload],
          signal => getPackageDetailSyncState({ signal }), controller.signal);
        if (controller.signal.aborted) return;
        observe(next);
        setError("");
        timer = window.setTimeout(() => void read(), next.status === "running" ? 1_000 : 15_000);
      } catch (reason) {
        if (controller.signal.aborted) return;
        callbacks.current.onStateChanged(undefined);
        if (reason instanceof ApiError && [401, 403].includes(reason.status)) setState(undefined);
        setError(reason instanceof Error ? reason.message : "Package detail status could not be checked.");
      }
    };
    void read();
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [available, busy, observe, principalKey, readSaved, reload, revision]);

  async function control(kind: "start" | "cancel") {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy(kind);
    setError("");
    if (kind === "start") callbacks.current.onStartRequested();
    else callbacks.current.onCancelRequested();
    try {
      const next = await (kind === "start" ? startPackageDetailSync : cancelPackageDetailSync)({ signal: controller.signal });
      if (controller.signal.aborted) return;
      observe(next);
    } catch (reason) {
      if (!controller.signal.aborted) {
        callbacks.current.onStateChanged(undefined);
        if (reason instanceof ApiError && [401, 403].includes(reason.status)) setState(undefined);
        setError(reason instanceof Error ? reason.message : "Package detail collection could not be updated.");
      }
    } finally {
      if (action.current === controller) action.current = undefined;
      if (!controller.signal.aborted) { setBusy(undefined); setReload(value => value + 1); }
    }
  }

  const verified = error ? undefined : state;
  return <SyncSourceRow label="Graph package details" busy={Boolean(busy)}
    description="Exact matching metadata, access assignments, and sharing recipients."
    status={error ? "failed" : state ? statuses[state.status] : "queued"}
    statusLabel={error ? "Status unavailable" : !state ? "Checking"
      : state.status === "ready" ? "Details pending" : state.status === "not_collected" ? "Catalog required" : undefined}
    statusCaption="Collection status"
    statistics={<>
      <div>
        <dt>Fresh details / catalog total</dt>
        <dd>{verified ? `${verified.fresh.toLocaleString()} / ${verified.total.toLocaleString()}` : "Not checked"}</dd>
        {verified ? <dd className="data-sync-count-unit">packages fresh; {verified.pending.toLocaleString()} pending</dd> : null}
        {verified && verified.total > 0 && verified.pending > 0 ? <dd><progress className="data-sync-source-progress" aria-label="Package detail coverage"
          value={verified.fresh} max={verified.total} /></dd> : null}
      </div>
      <div>
        <dt>Latest batch update</dt>
        <dd>{verified?.job ? formatSyncInstant(verified.job.updatedAt) : "No batch recorded"}</dd>
        {verified?.job ? <dd className="data-sync-count-unit">{verified.job.observedCount} of {verified.job.targetCount} targets checked</dd> : null}
      </div>
    </>}
    actions={<>
      <WorkbenchActionGate actionId="data-sync.start" compact><button type="button" className="secondary"
        disabled={!available || Boolean(busy) || Boolean(error) || !state || ["running", "complete", "not_collected"].includes(state.status)}
        title={verified?.status === "complete" ? "No pending or stale package details to collect." : undefined}
        onClick={() => void control("start")}>{busy === "start" ? "Starting details..." : "Sync package details"}</button></WorkbenchActionGate>
      {state?.status === "running" ? <WorkbenchActionGate actionId="data-sync.cancel" compact><button type="button" className="secondary data-sync-cancel"
        disabled={!available || Boolean(busy) || Boolean(error)} aria-busy={busy === "cancel"}
        aria-label={busy === "cancel" ? "Cancelling detail collection" : "Cancel detail collection"} onClick={() => void control("cancel")}>
        {busy === "cancel" ? <LoaderCircle size={16} className="data-sync-spinning" aria-hidden="true" /> : <CircleStop size={16} aria-hidden="true" />}
        {busy === "cancel" ? "Cancelling..." : "Cancel details"}
      </button></WorkbenchActionGate> : null}
    </>}>
    {error ? <div className="error-banner" role="alert">{error}</div> : null}
    <p role="status">{verified ? verified.message : error
      ? "Detail coverage has not been reverified. Use Check status before starting another collection."
      : "Checking exact package-detail coverage."}</p>
    <p className="data-sync-run-meta">{verified?.status === "complete"
      ? "Nothing pending. This control collects missing or stale details; it does not force a reread of fresh details."
      : "Runs in paced 20-package batches while authorization remains valid, even when this page is hidden."}</p>
  </SyncSourceRow>;
});
