import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  Check,
  CircleCheck,
  CircleAlert,
  CircleStop,
  Clock3,
  Database,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Upload,
} from "lucide-react";
import {
  ApiError,
  cancelDataSyncRun,
  getDataSyncRun,
  getDataSyncState,
  startDataSync,
  type DataSyncMode,
  type DataSyncRun,
  type DataSyncSourceId,
  type DataSyncSourceState,
  type DataSyncSourceStatus,
  type DataSyncState,
} from "../api/client";
import { useSavedRead } from "../savedQueries";
import { useBrowserAvailability } from "../useBrowserAvailability";
import { useCapabilityContext } from "../capabilityContext";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { SyncDialog } from "./SyncDialog";
import { FirstSyncNotice } from "./FirstSyncNotice";
import type { AutomaticRefreshStatus } from "../useAutomaticRefresh";
import {
  automaticSyncSources,
  formatSyncInstant as formatInstant,
  syncDuration,
  syncModeLabel as modeLabel,
  syncSourceDetails as sourceDetails,
  syncStatusLabel as statusLabel,
} from "./syncPresentation";
import "./dataSync.css";

const pollIntervalMs = 1_000;

export type WorkspaceSetupStatus = "checking" | "required" | "ready" | "error";

export type DataSyncPanelHandle = {
  refresh: (explicit?: boolean) => Promise<void>;
  start: (mode: DataSyncMode, sources?: DataSyncSourceId[]) => Promise<void>;
};

type DataSyncPanelProps = {
  principalKey: string;
  canUploadUsage: boolean;
  active?: boolean;
  onOpenSync?: () => void;
  automaticRefresh?: AutomaticRefreshStatus;
  onSetupStatusChange?: (status: WorkspaceSetupStatus) => void;
  onRunsChanged?: () => void;
  requestedRunId?: string;
  onOpenUsageImport: () => void;
  onRequestedRunChange: (runId: string | undefined) => void;
  onSourcesChanged: (sources: DataSyncSourceId[]) => void;
  onCheckPublication?: (sources: DataSyncSourceId[]) => void;
  onCancelRequested?: () => void;
};

export const DataSyncPanel = forwardRef<DataSyncPanelHandle, DataSyncPanelProps>(function DataSyncPanel(props, ref) {
  return <PrincipalDataSyncPanel key={props.principalKey} {...props} ref={ref} />;
});

const PrincipalDataSyncPanel = forwardRef<DataSyncPanelHandle, DataSyncPanelProps>(function PrincipalDataSyncPanel({
  principalKey,
  canUploadUsage,
  active = true,
  onOpenSync,
  automaticRefresh,
  onSetupStatusChange,
  onRunsChanged,
  requestedRunId,
  onOpenUsageImport,
  onRequestedRunChange,
  onSourcesChanged,
  onCheckPublication,
  onCancelRequested,
}, ref) {
  const { openPermissions } = useCapabilityContext();
  const available = useBrowserAvailability();
  const [state, setState] = useState<DataSyncState>();
  const [requestedRunResult, setRequestedRunResult] = useState<{ principalKey: string; run: DataSyncRun }>();
  const requestedRun = requestedRunResult?.principalKey === principalKey && requestedRunResult.run.id === requestedRunId
    ? requestedRunResult.run : undefined;
  const [requestedRunError, setRequestedRunError] = useState("");
  const [requestedRunLoading, setRequestedRunLoading] = useState(false);
  const [requestedRunReload, setRequestedRunReload] = useState(0);
  const [confirmClean, setConfirmClean] = useState(false);
  const [cleanAcknowledged, setCleanAcknowledged] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"start" | "cancel">();
  const [error, setError] = useState("");
  const [stateReadFailed, setStateReadFailed] = useState(false);
  const cleanConsent = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const readOwner = useId();
  const mounted = useRef(false);
  const generation = useRef(0);
  const pollingGeneration = useRef(0);
  const loadController = useRef<AbortController | undefined>(undefined);
  const actionController = useRef<AbortController | undefined>(undefined);
  const accessDenied = useRef(false);
  const actionRevision = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const sourceStatuses = useRef<Map<DataSyncSourceId, DataSyncSourceStatus> | undefined>(undefined);
  const stateRef = useRef<DataSyncState | undefined>(undefined);
  const requestedRunIdRef = useRef(requestedRunId);
  const requestedRunGeneration = useRef(0);
  const requestedRunController = useRef<AbortController | undefined>(undefined);
  const requestedRunTimer = useRef<number | undefined>(undefined);
  const requestedSourceStatuses = useRef<Map<DataSyncSourceId, DataSyncSourceStatus> | undefined>(undefined);
  const notifiedSources = useRef(new Map<DataSyncSourceId, string>());
  const onSourcesChangedRef = useRef(onSourcesChanged);
  const onCheckPublicationRef = useRef(onCheckPublication);
  const onRunsChangedRef = useRef(onRunsChanged);
  const wasActive = useRef(active);
  const readSaved = useSavedRead();
  const setupStatus: WorkspaceSetupStatus = state ? state.onboardingRequired ? "required" : "ready"
    : error ? "error" : "checking";
  useEffect(() => {
    onSetupStatusChange?.(setupStatus);
  }, [onSetupStatusChange, setupStatus]);

  useEffect(() => {
    onSourcesChangedRef.current = onSourcesChanged;
  }, [onSourcesChanged]);
  useEffect(() => { onCheckPublicationRef.current = onCheckPublication; }, [onCheckPublication]);

  useEffect(() => {
    onRunsChangedRef.current = onRunsChanged;
  }, [onRunsChanged]);

  useEffect(() => {
    requestedRunIdRef.current = requestedRunId;
    requestedSourceStatuses.current = undefined;
  }, [principalKey, requestedRunId]);

  const stopPolling = useCallback(() => {
    pollingGeneration.current += 1;
    loadController.current?.abort();
    loadController.current = undefined;
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const stopRequestedRunPolling = useCallback(() => {
    requestedRunController.current?.abort();
    requestedRunController.current = undefined;
    if (requestedRunTimer.current !== undefined) window.clearTimeout(requestedRunTimer.current);
    requestedRunTimer.current = undefined;
  }, []);

  const closeCleanConfirmation = useCallback(() => {
    cleanConsent.current = false;
    setConfirmClean(false);
    setCleanAcknowledged(false);
  }, []);

  const clearDeniedState = useCallback((reason: unknown) => {
    if (!(reason instanceof ApiError) || (reason.status !== 401 && reason.status !== 403)) return false;
    accessDenied.current = true;
    generation.current += 1;
    requestedRunGeneration.current += 1;
    stopPolling();
    stopRequestedRunPolling();
    actionController.current?.abort();
    actionController.current = undefined;
    actionRevision.current += 1;
    stateRef.current = undefined;
    sourceStatuses.current = undefined;
    requestedSourceStatuses.current = undefined;
    notifiedSources.current.clear();
    setState(undefined);
    setRequestedRunResult(undefined);
    setRequestedRunError("");
    setRequestedRunLoading(false);
    setLoading(false);
    setBusy(undefined);
    setError(requestError(reason, "Data sync access was denied."));
    setCheckedAt(undefined);
    closeCleanConfirmation();
    return true;
  }, [closeCleanConfirmation, stopPolling, stopRequestedRunPolling]);

  const observeSources = useCallback((
    sources: DataSyncSourceStatus[],
    statuses: typeof sourceStatuses,
  ) => {
    const priorStatuses = statuses.current;
    statuses.current = new Map(sources.map(source => [source.source, source]));
    if (priorStatuses) {
      const changed = sources
        .filter(source => {
          const previous = priorStatuses.get(source.source);
          if (source.status === "succeeded") {
            return !previous || sourceObservationIdentity(previous) !== sourceObservationIdentity(source);
          }
          return source.count === null && source.lastSuccessAt === null
            && (!previous || previous.status === "succeeded" || previous.lastSuccessAt !== null);
        })
        .filter(source => {
          const observation = source.status === "succeeded" ? sourceObservationIdentity(source) : "cleared";
          if (notifiedSources.current.get(source.source) === observation) return false;
          notifiedSources.current.set(source.source, observation);
          return true;
        })
        .map(source => source.source);
      // Job status is only a hint to check persisted publications, not authority
      // to invalidate saved content or infer that a failed attempt cleared it.
      if (changed.length) onCheckPublicationRef.current?.(changed);
    }
  }, []);

  const applyState = useCallback((next: DataSyncState) => {
    stateRef.current = next;
    setState(next);
    observeSources(next.sources, sourceStatuses);
  }, [observeSources]);

  const applyRun = useCallback((run: DataSyncRun) => {
    const current = stateRef.current;
    if (!current) return;
    const next = { ...current, run };
    stateRef.current = next;
    setState(next);
  }, []);

  const load = useCallback(async (owner: number, preserveActionError = false) => {
    if (loadController.current) return false;
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    try {
      const next = await readSaved(
        ["data-sync-state", principalKey, actionRevision.current ? `${readOwner}:${actionRevision.current}` : 0],
        signal => getDataSyncState({ signal }),
        controller.signal,
      );
      if (controller.signal.aborted || owner !== generation.current) return false;
      applyState(next);
      if (controller.signal.aborted || owner !== generation.current) return false;
      setCheckedAt(new Date().toISOString());
      setStateReadFailed(false);
      if (!preserveActionError) setError("");
      return isProgressing(next.run) && (wasActive.current || next.onboardingRequired);
    } catch (reason) {
      if (controller.signal.aborted || owner !== generation.current) return false;
      if (clearDeniedState(reason)) return false;
      const message = requestError(reason, "Saved data sync status is unavailable.");
      setStateReadFailed(true);
      setError(current => preserveActionError && current ? current : message);
      return false;
    } finally {
      if (loadController.current === controller) loadController.current = undefined;
      if (!controller.signal.aborted && owner === generation.current) setLoading(false);
    }
  }, [applyState, clearDeniedState, principalKey, readOwner, readSaved]);

  const startPolling = useCallback((owner: number, preserveActionError = false) => {
    stopPolling();
    const pollingOwner = pollingGeneration.current;
    const poll = async () => {
      timer.current = undefined;
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      const progressing = await load(owner, preserveActionError);
      if (owner !== generation.current || pollingOwner !== pollingGeneration.current || !progressing) return;
      timer.current = window.setTimeout(() => void poll(), pollIntervalMs);
    };
    return poll();
  }, [load, stopPolling]);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    const owner = generation.current;
    accessDenied.current = false;
    stopPolling();
    actionController.current?.abort();
    actionController.current = undefined;
    sourceStatuses.current = undefined;
    stateRef.current = undefined;
    void Promise.resolve().then(() => {
      if (owner !== generation.current) return;
      setState(undefined);
      setLoading(true);
      setBusy(undefined);
      setError("");
      setStateReadFailed(false);
      closeCleanConfirmation();
      setCheckedAt(undefined);
      if (!loadController.current) void startPolling(owner);
    });
    return () => {
      mounted.current = false;
      generation.current += 1;
      stopPolling();
      actionController.current?.abort();
      actionController.current = undefined;
    };
  }, [closeCleanConfirmation, principalKey, startPolling, stopPolling]);

  useEffect(() => {
    requestedRunGeneration.current += 1;
    const owner = requestedRunGeneration.current;
    stopRequestedRunPolling();
    void Promise.resolve().then(() => {
      if (owner !== requestedRunGeneration.current) return;
      setRequestedRunResult(current => current?.principalKey === principalKey && current.run.id === requestedRunId
        ? current : undefined);
      setRequestedRunError("");
      setRequestedRunLoading(Boolean(requestedRunId) && active && available && !accessDenied.current);
    });
    if (!requestedRunId || !active || !available || accessDenied.current) return;

    const poll = async () => {
      requestedRunTimer.current = undefined;
      const controller = new AbortController();
      requestedRunController.current = controller;
      try {
        const run = await readSaved(
          ["data-sync-run", principalKey, requestedRunId, requestedRunReload, actionRevision.current ? `${readOwner}:${actionRevision.current}` : 0],
          signal => getDataSyncRun(requestedRunId, { signal }),
          controller.signal,
        );
        if (controller.signal.aborted || owner !== requestedRunGeneration.current) return;
        setRequestedRunResult({ principalKey, run });
        setRequestedRunError("");
        observeSources(run.sources, requestedSourceStatuses);
        if (controller.signal.aborted || owner !== requestedRunGeneration.current) return;
        if (!isProgressing(run)) return;
        requestedRunTimer.current = window.setTimeout(() => void poll(), pollIntervalMs);
      } catch (reason) {
        if (controller.signal.aborted || owner !== requestedRunGeneration.current) return;
        if (clearDeniedState(reason)) return;
        if (reason instanceof ApiError && reason.status === 404) setRequestedRunResult(undefined);
        setRequestedRunError(requestError(reason, "The requested data sync run is unavailable."));
      } finally {
        if (requestedRunController.current === controller) requestedRunController.current = undefined;
        if (owner === requestedRunGeneration.current) setRequestedRunLoading(false);
      }
    };
    void Promise.resolve().then(() => {
      if (owner === requestedRunGeneration.current) void poll();
    });
    return () => {
      requestedRunGeneration.current += 1;
      stopRequestedRunPolling();
    };
  }, [active, available, clearDeniedState, observeSources, principalKey, readOwner, readSaved, requestedRunId, requestedRunReload, stopRequestedRunPolling]);

  const perform = useCallback(async (
    key: "start" | "cancel",
    operation: (signal: AbortSignal) => Promise<DataSyncRun>,
  ) => {
    if (!mounted.current || actionController.current || accessDenied.current) return;
    const owner = generation.current;
    stopPolling();
    requestedRunGeneration.current += 1;
    stopRequestedRunPolling();
    actionRevision.current += 1;
    const controller = new AbortController();
    actionController.current = controller;
    setBusy(key);
    setError("");
    let actionFailed = false;
    try {
      const run = await operation(controller.signal);
      if (controller.signal.aborted || owner !== generation.current) return;
      const current = stateRef.current;
      const updatesCurrentRun = key === "start" || current?.run?.id === run.id;
      if (requestedRunIdRef.current === run.id) {
        requestedRunGeneration.current += 1;
        stopRequestedRunPolling();
        setRequestedRunResult({ principalKey, run });
        setRequestedRunError("");
        observeSources(run.sources, requestedSourceStatuses);
      } else if (updatesCurrentRun && current) {
        observeSources(current.sources.map(source =>
          run.sources.find(attempt => attempt.source === source.source && attempt.status === "succeeded") ?? source,
        ), sourceStatuses);
      }
      if (updatesCurrentRun) applyRun(run);
    } catch (reason) {
      if (controller.signal.aborted || owner !== generation.current) return;
      if (clearDeniedState(reason)) return;
      actionFailed = true;
      setError(requestError(reason, "The data sync operation failed."));
    } finally {
      if (!controller.signal.aborted && owner === generation.current) {
        let revision: number;
        do {
          // Route changes and external publications can retire even a command's readback.
          revision = ++actionRevision.current;
          requestedRunGeneration.current += 1;
          stopRequestedRunPolling();
          if (requestedRunIdRef.current) setRequestedRunReload(value => value + 1);
          await startPolling(owner, actionFailed);
        } while (!controller.signal.aborted && owner === generation.current && revision !== actionRevision.current);
      }
      if (actionController.current === controller) actionController.current = undefined;
      if (owner === generation.current) {
        setBusy(undefined);
        onRunsChangedRef.current?.();
      }
    }
  }, [applyRun, clearDeniedState, observeSources, principalKey, startPolling, stopPolling, stopRequestedRunPolling]);

  const start = useCallback(async (mode: DataSyncMode, sources?: DataSyncSourceId[], clearSavedData = false) => {
    if (!mounted.current || actionController.current || accessDenied.current || !stateRef.current
      || (clearSavedData && !cleanConsent.current)
      || isProgressing(stateRef.current.run) || isProgressing(requestedRun)) return;
    closeCleanConfirmation();
    if (requestedRunId) {
      requestedRunIdRef.current = undefined;
      onRequestedRunChange(undefined);
    }
    await perform("start", async signal => {
      const run = await startDataSync(
        { mode, ...(sources ? { sources } : {}), ...(clearSavedData ? { clearSavedData: true } : {}) },
        { signal },
      );
      if (clearSavedData && !signal.aborted) {
        const current = stateRef.current;
        if (current) {
          const sources = current.sources.map(source => source.source === "usage_reports" ? source : {
            ...source, status: "not_started" as const, count: null, lastSuccessAt: null, jobId: null,
            message: "Saved data was reset. A new collection has not completed.", canRetry: false,
          });
          const next = { ...current, sources, onboardingRequired: true };
          sourceStatuses.current = new Map(sources.map(source => [source.source, source]));
          stateRef.current = next;
          setState(next);
        }
        for (const source of automaticSyncSources) notifiedSources.current.set(source, "cleared");
        onSourcesChangedRef.current([...automaticSyncSources]);
      }
      return run;
    });
  }, [closeCleanConfirmation, onRequestedRunChange, perform, requestedRun, requestedRunId]);

  const refresh = useCallback(async (explicit = true) => {
    if (!mounted.current) return;
    if (!explicit && (actionController.current || accessDenied.current || loadController.current || timer.current !== undefined
      || requestedRunController.current || requestedRunTimer.current !== undefined)) return;
    accessDenied.current = false;
    actionRevision.current += 1;
    requestedRunGeneration.current += 1;
    stopRequestedRunPolling();
    if (actionController.current) {
      stopPolling();
      return;
    }
    void startPolling(generation.current);
    if (requestedRunId) setRequestedRunReload(value => value + 1);
  }, [requestedRunId, startPolling, stopPolling, stopRequestedRunPolling]);

  useImperativeHandle(ref, () => ({ refresh, start }), [refresh, start]);

  function checkStatus() {
    if (loadController.current || requestedRunController.current) return;
    void refresh();
  }

  const currentRun = state?.run;
  const cannotStart = !state || isProgressing(currentRun) || isProgressing(requestedRun) || Boolean(busy);
  const savedSources = state?.sources.filter(source => source.source !== "usage_reports") ?? [];
  const savedSourceCount = savedSources.filter(source => source.status === "succeeded").length;

  useEffect(() => {
    if (active && !wasActive.current) void refresh(false);
    if (!active && wasActive.current) {
      if (stateRef.current?.onboardingRequired === false) stopPolling();
      cleanConsent.current = false;
      void Promise.resolve().then(closeCleanConfirmation);
    }
    wasActive.current = active;
  }, [active, closeCleanConfirmation, refresh, stopPolling]);

  const wasAvailable = useRef(available);
  useEffect(() => {
    if (!available) stopPolling();
    else if (!wasAvailable.current && (active || !stateRef.current || stateRef.current.onboardingRequired)) void refresh(false);
    wasAvailable.current = available;
  }, [active, available, refresh, stopPolling]);

  function runActions(run: DataSyncRun) {
    if (!isProgressing(run)) return null;
    return (
      <div className="data-sync-run-actions">
        <WorkbenchActionGate actionId="data-sync.cancel">
          <button type="button" className="secondary data-sync-cancel" disabled={Boolean(busy)} aria-busy={busy === "cancel"}
            onClick={() => {
              onCancelRequested?.();
              void perform("cancel", signal => cancelDataSyncRun(run.id, { signal }));
            }}>
            {busy === "cancel"
              ? <LoaderCircle size={16} className="data-sync-spinning" aria-hidden="true" />
              : <CircleStop size={16} aria-hidden="true" />}
            {busy === "cancel" ? "Cancelling..." : "Cancel run"}
          </button>
        </WorkbenchActionGate>
      </div>
    );
  }

  if (!active) {
    if (!onOpenSync) return null;
    if (state?.onboardingRequired) return <FirstSyncNotice state={state} loading={loading} busy={Boolean(busy)} error={error}
      stale={stateReadFailed}
      automaticRefresh={automaticRefresh} cannotStart={cannotStart}
      onStart={sources => { if (!loadController.current) void start("initial", sources); }}
      onCheckStatus={checkStatus} onOpenSync={onOpenSync} onOpenPermissions={openPermissions} />;
    if (!state && error) return <section className="data-sync-panel" aria-label="Workspace status">
      <h2>Workspace status is unavailable</h2>
      <p>We could not check whether your workspace is ready. Retry the status check, or open Sync for details.</p>
      <div className="error-banner" role="alert">{error}</div>
      <div className="first-sync-actions">
        <WorkbenchActionGate actionId="data-sync.read" compact>
          <button type="button" disabled={loading || Boolean(busy)} onClick={checkStatus}>
            {loading ? "Checking status..." : "Retry status check"}
          </button>
        </WorkbenchActionGate>
        <button type="button" className="secondary" onClick={onOpenSync}>View sync details</button>
        <button type="button" className="secondary" onClick={openPermissions}>Review permissions</button>
      </div>
    </section>;
    return null;
  }

  return (
    <section className="data-sync-panel" aria-labelledby="data-sync-heading" aria-busy={loading || Boolean(busy)}>
      <header className="data-sync-page-header">
        <div className="data-sync-page-icon"><Database size={24} aria-hidden="true" /></div>
        <div>
          <h2 id="data-sync-heading" ref={heading} tabIndex={-1}>Data sync</h2>
          <p>Keep workspace data up to date. Sync reads Microsoft data without changing its settings.</p>
        </div>
        <div className="data-sync-toolbar">
          {state ? <WorkbenchActionGate actionId="data-sync.start">
            <button type="button" disabled={cannotStart} onClick={() => void start(state.onboardingRequired ? "initial" : "incremental")}>
              <RefreshCw size={16} aria-hidden="true" />
              {busy === "start" ? "Starting sync..." : state.onboardingRequired ? "Start initial sync" : "Sync all sources"}
            </button>
          </WorkbenchActionGate> : null}
          <WorkbenchActionGate actionId="data-sync.read" compact>
            <button type="button" className="secondary" disabled={loading || requestedRunLoading || Boolean(busy)} onClick={checkStatus}
              title="Reload saved status without starting a Microsoft data collection">
              <RotateCcw size={15} aria-hidden="true" />{error ? "Retry status check" : "Check status"}
            </button>
          </WorkbenchActionGate>
        </div>
      </header>
      <div className="data-sync-details">
        {error && !requestedRunId ? <div className="error-banner" role="alert">
          {error}{stateReadFailed && state ? " Showing the last reported workspace status." : null}
        </div> : null}
        {!state && loading ? <p role="status">Loading saved data sync status...</p> : null}
        {state ? (
          <>
            {currentRun ? (
              !isComplete(currentRun) && currentRun.status !== "cancelled" ? (
                <section className="data-sync-activity" aria-label="Current sync">
                  <SyncProgress run={currentRun} stale={stateReadFailed || Boolean(busy)} />
                  <div className="data-sync-activity-footer" role="group" aria-label="Current sync actions">
                    <p className="data-sync-run-meta">
                      {isProgressing(currentRun) ? "Sync continues when you switch tabs." : "Run results stay available when you start a new sync."}
                      {" "}<button type="button" className="sync-text-button" onClick={() => onRequestedRunChange(currentRun.id)}>View run details</button>
                    </p>
                    {runActions(currentRun)}
                  </div>
                </section>
              ) : (
                <div className="data-sync-last-run" role="status">
                  {isComplete(currentRun) ? <CircleCheck size={19} aria-hidden="true" /> : <CircleAlert size={19} aria-hidden="true" />}
                  <div>
                    <strong>{isComplete(currentRun) ? "Sync complete" : "Sync cancelled"}</strong>
                    <span>{currentRun.sources.map(source => sourceDetails[source.source].label).join(", ")}
                      {" · "}{formatInstant(currentRun.completedAt ?? currentRun.updatedAt)}</span>
                  </div>
                  <button type="button" className="sync-text-button" onClick={() => onRequestedRunChange(currentRun.id)}>View run details</button>
                </div>
              )
            ) : null}
            <section className="data-sync-workspace" aria-labelledby="sync-workspace-heading">
              <div className="section-heading">
                <div>
                  <h3 id="sync-workspace-heading">Workspace data</h3>
                  <p>Last successful collection across all sources, not just the latest run.</p>
                </div>
                <span className={`data-sync-state state-${savedSourceCount === automaticSyncSources.length ? "success" : "attention"}`}>
                  {savedSourceCount} of {automaticSyncSources.length} sources synced
                </span>
              </div>
              {savedSourceCount === 0 ? <p className="data-sync-empty">Start a sync to collect users and inventory. Upload usage reports in the separate CSV usage reports section above.</p> : null}
              <div className="data-sync-sources" aria-label="Workspace sync sources">
                {savedSources.map(source => (
                  <SavedSourceRow
                    key={source.source}
                    source={source}
                    attempt={currentRun?.sources.find(attempt => attempt.source === source.source)}
                    stale={stateReadFailed || Boolean(busy)}
                    disabled={cannotStart}
                    onSync={() => void start("incremental", [source.source])}
                  />
                ))}
              </div>
              <div className="data-sync-workspace-footer">
                <p>Sync keeps previous successful data until a replacement is ready.
                  {checkedAt ? <> Status checked <time dateTime={checkedAt}>{new Date(checkedAt).toLocaleTimeString()}</time>.</> : null}
                </p>
                <WorkbenchActionGate actionId="data-sync.start" compact>
                  <button type="button" className="sync-text-button" disabled={cannotStart} onClick={() => {
                    cleanConsent.current = false;
                    setCleanAcknowledged(false);
                    setConfirmClean(true);
                  }}>
                    Reset saved data...
                  </button>
                </WorkbenchActionGate>
              </div>
            </section>
          </>
        ) : null}
      </div>
      <SyncDialog open={Boolean(requestedRunId)} title="Sync run details"
        description="Results for this run, not your overall workspace state."
        fallbackFocusRef={heading}
        onClose={() => onRequestedRunChange(undefined)}>
        {requestedRunLoading ? <p role="status">Loading exact sync run {requestedRunId}...</p> : null}
        {requestedRunError ? <div className="error-banner" role="alert">
          {requestedRunError}{requestedRun ? " Showing the last reported run status." : null}
        </div> : null}
        {error ? <div className="error-banner" role="alert">
          {error}{stateReadFailed && state ? " Showing the last reported workspace status." : null}
        </div> : null}
        {requestedRunError || error ? <button type="button" className="secondary"
          disabled={loading || requestedRunLoading || Boolean(busy)} aria-busy={loading || requestedRunLoading} onClick={checkStatus}>
          {loading || requestedRunLoading ? "Checking status..." : "Retry status check"}
        </button> : null}
        {requestedRun ? (
          <>
            <dl className="data-sync-run-facts">
              <div><dt>Run</dt><dd><code>{requestedRun.id}</code></dd></div>
              <div><dt>Collection</dt><dd>{requestedRun.automatic ? "Automatic refresh" : modeLabel(requestedRun.mode)}</dd></div>
              <div><dt>Started</dt><dd>{formatInstant(requestedRun.startedAt)}</dd></div>
              <div><dt>{requestedRun.completedAt ? "Duration (including waits)" : "Last update"}</dt><dd>{requestedRun.completedAt
                ? syncDuration(requestedRun.startedAt, requestedRun.completedAt) : formatInstant(requestedRun.updatedAt)}</dd></div>
            </dl>
            <SyncProgress run={requestedRun} showJobIds stale={Boolean(requestedRunError) || requestedRunLoading || Boolean(busy)} />
            {runActions(requestedRun)}
            {requestedRun.sources.some(source => source.status === "awaiting_upload") ? (
              <div className="notice">
                <p>This older run includes a manual CSV step. Import reports to complete it, or cancel the waiting run before starting a new automatic sync.</p>
                {canUploadUsage ? <button type="button" className="secondary" onClick={() => { onRequestedRunChange(undefined); onOpenUsageImport(); }}>Add CSV reports</button> : null}
              </div>
            ) : null}
          </>
        ) : null}
        <button type="button" className="secondary" onClick={() => onRequestedRunChange(undefined)}>Back to workspace</button>
      </SyncDialog>
      <SyncDialog open={confirmClean} title="Reset saved data" fallbackFocusRef={heading} onClose={closeCleanConfirmation}>
        <div className="data-sync-clean-confirm">
          <strong>Clear saved data before syncing?</strong>
          <p>Your account's saved users, license and app-activity data, Graph packages, and Power Platform inventory will be removed first. These views may be empty until sync succeeds. A failed or cancelled sync does not restore the cleared data.</p>
          <p>Accepted usage reports, report history, audit records, configuration, and other users' saved data are kept.</p>
          <label>
            <input type="checkbox" checked={cleanAcknowledged} onChange={event => {
              cleanConsent.current = event.target.checked;
              setCleanAcknowledged(event.target.checked);
            }} />
            I understand my saved users and inventory will be cleared.
          </label>
          <div className="data-sync-run-actions">
            <button type="button" className="secondary" onClick={closeCleanConfirmation}>Keep saved data</button>
            <WorkbenchActionGate actionId="data-sync.start">
              <button type="button" className="danger" disabled={cannotStart || !cleanAcknowledged} onClick={() => void start("full", undefined, true)}>
                Clear and start full resync
              </button>
            </WorkbenchActionGate>
          </div>
        </div>
      </SyncDialog>
    </section>
  );
});

function SyncProgress({ run, showJobIds = false, stale = false }: { run: DataSyncRun; showJobIds?: boolean; stale?: boolean }) {
  const { openPermissions } = useCapabilityContext();
  const automatic = run.sources.filter(source => source.source !== "usage_reports");
  const completed = automatic.filter(source => source.status === "succeeded").length;
  const running = automatic.filter(source => source.status === "running");
  const queued = automatic.some(source => source.status === "queued");
  const complete = isComplete(run);
  const collecting = isProgressing(run) && (running.length > 0 || queued);
  const heading = complete
    ? "Sync complete"
    : run.status === "cancelled"
      ? "Sync cancelled"
      : running.length
        ? `Syncing ${running.map(source => sourceDetails[source.source].label.toLowerCase()).join(", ")}`
        : queued && isProgressing(run)
          ? "Preparing your sync"
          : "Sync needs attention";
  return (
    <section className={`data-sync-progress${complete ? " is-complete" : ""}${collecting && !stale ? " is-running" : ""}`} aria-label="Sync status">
      <div className="data-sync-progress-heading" role="status" aria-live="polite">
        {complete ? <CircleCheck size={24} aria-hidden="true" />
          : collecting && !stale ? <LoaderCircle className="data-sync-spinning" size={24} aria-hidden="true" />
            : <CircleAlert size={24} aria-hidden="true" />}
        <div>
          <strong>{stale && isProgressing(run) ? "Last reported: " : ""}{heading}</strong>
          <p>{automatic.length ? `${completed} of ${automatic.length} automatic sources complete` : "Manual report step"}
            {" · "}{run.automatic ? "Automatic refresh" : modeLabel(run.mode)}</p>
        </div>
      </div>
      {!complete && automatic.length > 0 ? <progress aria-label="Completed sync sources" value={completed} max={automatic.length} /> : null}
      <ol className="data-sync-live-sources" aria-label="Progress by source">
        {run.sources.map(source => (
          <li key={source.source} className={`data-sync-live-source source-${source.status.replaceAll("_", "-")}`}>
            <SourceBadge status={source.status} stale={stale} />
            <div>
              <strong>{sourceDetails[source.source].label}</strong>
              <p>{source.message || (source.status === "queued" ? "Waiting for collection to start."
                : source.status === "running" ? "Waiting for the provider's next update." : statusLabel(source.status))}</p>
              {source.status === "waiting_authorization" ? <a href="/api/auth/login">Sign in again</a> : null}
              {source.status === "permission_required" ? <button type="button" className="secondary" onClick={openPermissions}>Review permissions</button> : null}
              {showJobIds && source.jobId ? <p className="data-sync-run-meta">Source job <code>{source.jobId}</code></p> : null}
            </div>
            <div className="data-sync-live-count">
              <strong>{source.status === "queued" || source.count === null ? "—" : source.count.toLocaleString()}</strong>
              <span>{source.status === "succeeded" ? `${sourceDetails[source.source].unit} saved`
                : source.status === "running" ? "processed in this stage" : "reported, not a saved total"}</span>
            </div>
          </li>
        ))}
      </ol>
      <p className="data-sync-progress-note">{stale
        ? "These are the last reported results. Checking status does not start or cancel collection."
        : collecting
        ? "Counts update as the provider responds and may restart for a new stage. The bar measures completed sources, not time or total objects."
        : complete ? "These are this run's results. Other successful source collections remain in Workspace data."
          : isProgressing(run) ? "Previous successful data stays available. Resolve the waiting step or cancel this run before starting a new sync."
            : "Previous successful data stays available. Start a new sync when you're ready."}</p>
      <p className="data-sync-run-meta">Started {formatInstant(run.startedAt)} · Last update {formatInstant(run.updatedAt)}</p>
    </section>
  );
}

function SavedSourceRow({ source, attempt, stale, disabled, onSync }: {
  source: DataSyncSourceStatus;
  attempt?: DataSyncSourceStatus;
  stale: boolean;
  disabled: boolean;
  onSync: () => void;
}) {
  const details = sourceDetails[source.source];
  const saved = source.status === "succeeded" || source.lastSuccessAt !== null;
  return (
    <article className="data-sync-source" aria-label={details.label}>
      <div className="data-sync-source-name">
        <strong>{details.label}</strong>
        <p>{details.description}</p>
      </div>
      <dl>
        <div>
          <dt>Last saved count</dt>
          <dd>{saved ? source.count === null ? "Not reported" : source.count.toLocaleString() : "Not synced"}</dd>
          {saved && source.count !== null ? <dd className="data-sync-count-unit">{details.unit}</dd> : null}
        </div>
        <div>
          <dt>Last successful sync</dt>
          <dd>{source.lastSuccessAt ? formatInstant(source.lastSuccessAt) : saved ? "Not recorded" : "Never"}</dd>
        </div>
      </dl>
      <div className="data-sync-source-actions">
        <div className="data-sync-source-attempt">
          <span>{attempt ? stale ? "Last reported attempt" : "Latest attempt" : "Last collection"}</span>
          <SourceBadge status={attempt?.status ?? source.status} stale={stale} />
        </div>
        <WorkbenchActionGate actionId="data-sync.start" compact>
          <button type="button" className="secondary" disabled={disabled} onClick={onSync}>Sync {details.label.toLowerCase()}</button>
        </WorkbenchActionGate>
      </div>
    </article>
  );
}

function SourceBadge({ status, stale = false }: { status: DataSyncSourceState; stale?: boolean }) {
  return <span className={`status-badge status-${status.replaceAll("_", "-")}`}>
    {status === "succeeded" ? <Check size={14} aria-hidden="true" />
      : status === "running" ? stale ? <Clock3 size={14} aria-hidden="true" />
        : <LoaderCircle size={14} className="data-sync-spinning" aria-hidden="true" />
        : status === "queued" || status === "not_started" ? <Clock3 size={14} aria-hidden="true" />
          : status === "awaiting_upload" ? <Upload size={14} aria-hidden="true" />
            : <CircleAlert size={14} aria-hidden="true" />}
    {statusLabel(status)}
  </span>;
}

function isProgressing(run: DataSyncRun | null | undefined) {
  return run?.status === "running" || run?.status === "waiting";
}

function isComplete(run: DataSyncRun | null | undefined) {
  return run?.status === "completed" && run.sources.every(source => source.status === "succeeded");
}

function sourceObservationIdentity(source: DataSyncSourceStatus) {
  return source.status === "succeeded"
    ? `succeeded:${source.lastSuccessAt ?? source.jobId ?? ""}`
    : `status:${source.status}`;
}

function requestError(reason: unknown, fallback: string) {
  if (reason instanceof ApiError) {
    return `${reason.message}${reason.requestId ? ` Request ${reason.requestId}.` : ""}`;
  }
  return reason instanceof Error ? reason.message : fallback;
}
