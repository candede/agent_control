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
  Clock3,
  Database,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Square,
  Upload,
} from "lucide-react";
import {
  ApiError,
  cancelDataSyncRun,
  getDataSyncRun,
  getDataSyncState,
  retryDataSyncRun,
  startDataSync,
  type DataSyncMode,
  type DataSyncRun,
  type DataSyncSourceId,
  type DataSyncSourceState,
  type DataSyncSourceStatus,
  type DataSyncState,
} from "../api/client";
import { useSavedRead } from "../savedQueries";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { SyncDialog } from "./SyncDialog";
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
const pollBudgetMs = 5 * 60_000;

const incompleteStates = new Set<DataSyncSourceState>([
  "not_started",
  "waiting_authorization",
  "permission_required",
  "awaiting_upload",
  "partial",
  "failed",
  "cancelled",
]);

export type DataSyncPanelHandle = {
  refresh: () => Promise<void>;
  start: (mode: DataSyncMode, sources?: DataSyncSourceId[]) => Promise<void>;
};

export const DataSyncPanel = forwardRef<DataSyncPanelHandle, {
  principalKey: string;
  canUploadUsage: boolean;
  active?: boolean;
  onSetupRequiredChange?: (required: boolean) => void;
  onRunsChanged?: () => void;
  requestedRunId?: string;
  onOpenUsageImport: () => void;
  onManageUsageReports?: () => void;
  onRequestedRunChange: (runId: string | undefined) => void;
  onSourcesChanged: (sources: DataSyncSourceId[]) => void;
}>(function DataSyncPanel({
  principalKey,
  canUploadUsage,
  active = true,
  onSetupRequiredChange,
  onRunsChanged,
  requestedRunId,
  onOpenUsageImport,
  onManageUsageReports,
  onRequestedRunChange,
  onSourcesChanged,
}, ref) {
  const [state, setState] = useState<DataSyncState>();
  const [requestedRun, setRequestedRun] = useState<DataSyncRun>();
  const [requestedRunError, setRequestedRunError] = useState("");
  const [requestedRunLoading, setRequestedRunLoading] = useState(false);
  const [requestedRunReload, setRequestedRunReload] = useState(0);
  const [requestedPollingPaused, setRequestedPollingPaused] = useState(false);
  const [confirmClean, setConfirmClean] = useState(false);
  const [cleanAcknowledged, setCleanAcknowledged] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"start" | "retry" | "cancel">();
  const [error, setError] = useState("");
  const [pollingPaused, setPollingPaused] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const readOwner = useId();
  const generation = useRef(0);
  const pollingGeneration = useRef(0);
  const loadController = useRef<AbortController | undefined>(undefined);
  const actionController = useRef<AbortController | undefined>(undefined);
  const accessDenied = useRef(false);
  const actionRevision = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const pollDeadline = useRef(0);
  const sourceStatuses = useRef<Map<DataSyncSourceId, DataSyncSourceStatus> | undefined>(undefined);
  const stateRef = useRef<DataSyncState | undefined>(undefined);
  const requestedRunIdRef = useRef(requestedRunId);
  const requestedRunGeneration = useRef(0);
  const requestedRunController = useRef<AbortController | undefined>(undefined);
  const requestedRunTimer = useRef<number | undefined>(undefined);
  const requestedPollDeadline = useRef(0);
  const requestedSourceStatuses = useRef<Map<DataSyncSourceId, DataSyncSourceStatus> | undefined>(undefined);
  const onSourcesChangedRef = useRef(onSourcesChanged);
  const onRunsChangedRef = useRef(onRunsChanged);
  const wasActive = useRef(active);
  const readSaved = useSavedRead();
  useEffect(() => {
    onSetupRequiredChange?.(state?.onboardingRequired ?? false);
  }, [onSetupRequiredChange, state?.onboardingRequired]);

  useEffect(() => {
    onSourcesChangedRef.current = onSourcesChanged;
  }, [onSourcesChanged]);

  useEffect(() => {
    onRunsChangedRef.current = onRunsChanged;
  }, [onRunsChanged]);

  useEffect(() => {
    requestedRunIdRef.current = requestedRunId;
    requestedSourceStatuses.current = undefined;
    requestedPollDeadline.current = 0;
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
    pollDeadline.current = 0;
    requestedPollDeadline.current = 0;
    setState(undefined);
    setRequestedRun(undefined);
    setRequestedRunError("");
    setRequestedRunLoading(false);
    setLoading(false);
    setBusy(undefined);
    setError(requestError(reason, "Data sync access was denied."));
    setPollingPaused(false);
    setRequestedPollingPaused(false);
    setCheckedAt(undefined);
    setConfirmClean(false);
    setCleanAcknowledged(false);
    return true;
  }, [stopPolling, stopRequestedRunPolling]);

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
          // Failed attempts and sources omitted by limited runs can still have saved data.
          return source.count === null && source.lastSuccessAt === null
            && (!previous || previous.status === "succeeded" || previous.lastSuccessAt !== null);
        })
        .map(source => source.source);
      if (changed.length) onSourcesChangedRef.current(changed);
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
    observeSources(current.sources.map(source =>
      run.sources.find(attempt => attempt.source === source.source && attempt.status === "succeeded") ?? source,
    ), sourceStatuses);
    const next = { ...current, run };
    stateRef.current = next;
    setState(next);
  }, [observeSources]);

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
      if (!preserveActionError) setError("");
      return isProgressing(next.run);
    } catch (reason) {
      if (controller.signal.aborted || owner !== generation.current || (reason instanceof ApiError && reason.kind === "aborted")) return false;
      if (clearDeniedState(reason)) return false;
      const message = requestError(reason, "Saved data sync status is unavailable.");
      setError(current => preserveActionError && current ? current : message);
      return false;
    } finally {
      if (loadController.current === controller) loadController.current = undefined;
      if (!controller.signal.aborted && owner === generation.current) setLoading(false);
    }
  }, [applyState, clearDeniedState, principalKey, readOwner, readSaved]);

  const startPolling = useCallback((owner: number, resetBudget: boolean, preserveActionError = false) => {
    stopPolling();
    const pollingOwner = pollingGeneration.current;
    setPollingPaused(false);
    if (resetBudget || pollDeadline.current === 0) {
      pollDeadline.current = Date.now() + pollBudgetMs;
    }
    const poll = async () => {
      const progressing = await load(owner, preserveActionError);
      if (owner !== generation.current || pollingOwner !== pollingGeneration.current) return;
      if (!progressing) {
        pollDeadline.current = 0;
        return;
      }
      if (Date.now() >= pollDeadline.current) {
        setPollingPaused(true);
        return;
      }
      timer.current = window.setTimeout(() => void poll(), pollIntervalMs);
    };
    return poll();
  }, [load, stopPolling]);

  useEffect(() => {
    generation.current += 1;
    const owner = generation.current;
    accessDenied.current = false;
    stopPolling();
    actionController.current?.abort();
    actionController.current = undefined;
    sourceStatuses.current = undefined;
    stateRef.current = undefined;
    pollDeadline.current = 0;
    void Promise.resolve().then(() => {
      if (owner !== generation.current) return;
      setState(undefined);
      setLoading(true);
      setBusy(undefined);
      setError("");
      setPollingPaused(false);
      setConfirmClean(false);
      setCleanAcknowledged(false);
      setCheckedAt(undefined);
    });
    startPolling(owner, true);
    return () => {
      generation.current += 1;
      stopPolling();
      actionController.current?.abort();
      actionController.current = undefined;
    };
  }, [principalKey, startPolling, stopPolling]);

  useEffect(() => {
    requestedRunGeneration.current += 1;
    const owner = requestedRunGeneration.current;
    stopRequestedRunPolling();
    void Promise.resolve().then(() => {
      if (owner !== requestedRunGeneration.current) return;
      setRequestedRun(undefined);
      setRequestedRunError("");
      setRequestedRunLoading(Boolean(requestedRunId) && !accessDenied.current);
      setRequestedPollingPaused(false);
    });
    if (!requestedRunId || accessDenied.current) return;

    if (requestedPollDeadline.current === 0) requestedPollDeadline.current = Date.now() + pollBudgetMs;
    const deadline = requestedPollDeadline.current;
    const poll = async () => {
      const controller = new AbortController();
      requestedRunController.current = controller;
      try {
        const run = await readSaved(
          ["data-sync-run", principalKey, requestedRunId, requestedRunReload, actionRevision.current ? `${readOwner}:${actionRevision.current}` : 0],
          signal => getDataSyncRun(requestedRunId, { signal }),
          controller.signal,
        );
        if (controller.signal.aborted || owner !== requestedRunGeneration.current) return;
        setRequestedRun(run);
        setRequestedRunError("");
        observeSources(run.sources, requestedSourceStatuses);
        if (controller.signal.aborted || owner !== requestedRunGeneration.current) return;
        if (!isProgressing(run)) return;
        if (Date.now() >= deadline) {
          setRequestedPollingPaused(true);
          return;
        }
        requestedRunTimer.current = window.setTimeout(() => void poll(), pollIntervalMs);
      } catch (reason) {
        if (controller.signal.aborted || owner !== requestedRunGeneration.current || (reason instanceof ApiError && reason.kind === "aborted")) return;
        if (clearDeniedState(reason)) return;
        setRequestedRun(undefined);
        setRequestedRunError(requestError(reason, "The requested data sync run is unavailable."));
      } finally {
        if (requestedRunController.current === controller) requestedRunController.current = undefined;
        if (owner === requestedRunGeneration.current) setRequestedRunLoading(false);
      }
    };
    void poll();
    return () => {
      requestedRunGeneration.current += 1;
      stopRequestedRunPolling();
    };
  }, [clearDeniedState, observeSources, principalKey, readOwner, readSaved, requestedRunId, requestedRunReload, stopRequestedRunPolling]);

  const perform = useCallback(async (
    key: "start" | "retry" | "cancel",
    operation: (signal: AbortSignal) => Promise<DataSyncRun>,
  ) => {
    if (actionController.current || accessDenied.current) return;
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
      if (requestedRunIdRef.current === run.id) {
        requestedRunGeneration.current += 1;
        stopRequestedRunPolling();
        setRequestedRun(run);
        setRequestedRunError("");
        observeSources(run.sources, requestedSourceStatuses);
      } else if (key === "start" || stateRef.current?.run?.id === run.id) {
        applyRun(run);
      }
    } catch (reason) {
      if (controller.signal.aborted || owner !== generation.current) return;
      if (clearDeniedState(reason)) return;
      actionFailed = true;
      setError(requestError(reason, "The data sync operation failed."));
    } finally {
      if (!controller.signal.aborted && owner === generation.current) {
        // Route changes can admit reads during a command; fence again after it settles.
        actionRevision.current += 1;
        requestedRunGeneration.current += 1;
        stopRequestedRunPolling();
        requestedPollDeadline.current = 0;
        if (requestedRunIdRef.current) setRequestedRunReload(value => value + 1);
        await startPolling(owner, true, actionFailed);
      }
      if (actionController.current === controller) actionController.current = undefined;
      if (owner === generation.current) {
        setBusy(undefined);
        onRunsChangedRef.current?.();
      }
    }
  }, [applyRun, clearDeniedState, observeSources, startPolling, stopPolling, stopRequestedRunPolling]);

  const start = useCallback(async (mode: DataSyncMode, sources?: DataSyncSourceId[], clearSavedData = false) => {
    if (actionController.current || accessDenied.current) return;
    setConfirmClean(false);
    setCleanAcknowledged(false);
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
        onSourcesChangedRef.current(["users", "graph_packages", "power_platform"]);
      }
      return run;
    });
  }, [onRequestedRunChange, perform, requestedRunId]);

  const refresh = useCallback(async (resetBudget = true) => {
    if (actionController.current) return;
    if (accessDenied.current && !resetBudget) return;
    accessDenied.current = false;
    actionRevision.current += 1;
    requestedRunGeneration.current += 1;
    stopRequestedRunPolling();
    if (resetBudget) requestedPollDeadline.current = 0;
    void startPolling(generation.current, resetBudget);
    if (requestedRunId) setRequestedRunReload(value => value + 1);
  }, [requestedRunId, startPolling, stopRequestedRunPolling]);

  useImperativeHandle(ref, () => ({ refresh, start }), [refresh, start]);

  const currentRun = state?.run;
  const cannotStart = !state || isProgressing(currentRun) || isProgressing(requestedRun) || Boolean(busy);
  const savedSources = state?.sources.filter(source => source.source !== "usage_reports") ?? [];
  const savedSourceCount = savedSources.filter(source => source.status === "succeeded").length;
  const usage = state?.sources.find(source => source.source === "usage_reports");
  const usageReady = usage?.status === "succeeded" && !state?.usageImportRequired;

  useEffect(() => {
    if (active && !wasActive.current) void refresh(false);
    if (!active && wasActive.current) void Promise.resolve().then(() => {
      setConfirmClean(false);
      setCleanAcknowledged(false);
    });
    wasActive.current = active;
  }, [active, refresh]);

  function runActions(run: DataSyncRun, paused: boolean) {
    const retrySources = run.sources
      .filter(source => source.canRetry && incompleteStates.has(source.status))
      .map(source => source.source);
    const retryBlocked = run.status === "running"
      || (isProgressing(currentRun) && currentRun?.id !== run.id);
    return (
      <div className="data-sync-run-actions">
        {paused && isProgressing(run) ? (
          <>
            <p className="data-sync-poll-note" role="status">Live updates are paused. The server job is not stopped.</p>
            <WorkbenchActionGate actionId="data-sync.read" compact>
              <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void refresh()}>
                <RotateCcw size={15} aria-hidden="true" />Resume updates
              </button>
            </WorkbenchActionGate>
          </>
        ) : null}
        {retrySources.length ? (
          <WorkbenchActionGate actionId="data-sync.retry">
            <button type="button" className="secondary" disabled={Boolean(busy) || retryBlocked}
              onClick={() => void perform("retry", signal => retryDataSyncRun(run.id, retrySources, { signal }))}>
              Retry incomplete ({retrySources.length})
            </button>
          </WorkbenchActionGate>
        ) : null}
        {retrySources.length > 0 && retryBlocked ? (
          <p className="data-sync-run-meta">Finish or cancel the active sync run before retrying these sources.</p>
        ) : null}
        {isProgressing(run) ? (
          <WorkbenchActionGate actionId="data-sync.cancel">
            <button type="button" className="secondary" disabled={Boolean(busy)}
              onClick={() => void perform("cancel", signal => cancelDataSyncRun(run.id, { signal }))}>
              <Square size={14} aria-hidden="true" />{busy === "cancel" ? "Cancelling..." : "Cancel run"}
            </button>
          </WorkbenchActionGate>
        ) : null}
      </div>
    );
  }

  if (!active) return null;

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
            <button type="button" className="secondary" disabled={loading || Boolean(busy)} onClick={() => void refresh()}
              title="Reload saved status without starting a Microsoft data collection">
              <RotateCcw size={15} aria-hidden="true" />{error ? "Retry status check" : "Check status"}
            </button>
          </WorkbenchActionGate>
        </div>
      </header>
      <div className="data-sync-details">
        {error && !requestedRunId ? <div className="error-banner" role="alert">{error}</div> : null}
        {!state && loading ? <p role="status">Loading saved data sync status...</p> : null}
        {state ? (
          <>
            {currentRun ? (
              !isComplete(currentRun) && currentRun.status !== "cancelled" ? (
                <section className="data-sync-activity" aria-label="Current sync">
                  <SyncProgress run={currentRun} />
                  {runActions(currentRun, pollingPaused)}
                  <p className="data-sync-run-meta">
                    Sync continues when you switch tabs.
                    {" "}<button type="button" className="sync-text-button" onClick={() => onRequestedRunChange(currentRun.id)}>View run details</button>
                  </p>
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
              {savedSourceCount === 0 ? <p className="data-sync-empty">Start a sync to collect users and inventory. CSV reports are imported separately below.</p> : null}
              <div className="data-sync-sources" aria-label="Workspace sync sources">
                {savedSources.map(source => (
                  <SavedSourceRow
                    key={source.source}
                    source={source}
                    attempt={currentRun?.sources.find(attempt => attempt.source === source.source)}
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
                  <button type="button" className="sync-text-button" disabled={cannotStart} onClick={() => setConfirmClean(true)}>
                    Reset saved data...
                  </button>
                </WorkbenchActionGate>
              </div>
            </section>
            <section className="data-sync-reports" aria-labelledby="sync-reports-heading">
              <div className="data-sync-report-icon"><Upload size={22} aria-hidden="true" /></div>
              <div>
                <div className="sync-health-heading"><h3 id="sync-reports-heading">CSV usage reports</h3><span className={`data-sync-state state-${usageReady ? "success" : "attention"}`}>{usageReady ? "Available" : "Import needed"}</span></div>
                <p>{usageReady
                  ? `${usage.count?.toLocaleString() ?? "Validated"} report rows across three accepted CSVs.`
                  : "Import Agents, Users & agents, and Users exports for the same 7- or 30-day selection."}</p>
                {usageReady && usage.lastSuccessAt ? <p>Accepted <time dateTime={usage.lastSuccessAt}>{formatInstant(usage.lastSuccessAt)}</time>. Overlapping snapshots are not added together.</p>
                  : <p>Manual import is separate from automatic sync and does not block collecting users or inventory.</p>}
                <div className="data-sync-links">
                  <a href="/official-usage?view=history">View report history</a>
                  {canUploadUsage && onManageUsageReports ? <button type="button" className="sync-text-button" onClick={onManageUsageReports}>Manage reports</button> : null}
                </div>
              </div>
              {canUploadUsage ? <button type="button" className="secondary" onClick={onOpenUsageImport}>
                <Upload size={16} aria-hidden="true" />Add CSV reports
              </button> : <p className="data-sync-admin-note">An AgentControl.Admin can import reports.</p>}
            </section>
          </>
        ) : null}
      </div>
      <SyncDialog open={Boolean(requestedRunId)} title="Sync run details"
        description="Results for this run, not your overall workspace state."
        fallbackFocusRef={heading}
        onClose={() => onRequestedRunChange(undefined)}>
        {requestedRunLoading ? <p role="status">Loading exact sync run {requestedRunId}...</p> : null}
        {requestedRunError ? <div className="error-banner" role="alert">{requestedRunError}</div> : null}
        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        {requestedRunError ? <button type="button" className="secondary" onClick={() => void refresh()}>Retry status check</button> : null}
        {requestedRun ? (
          <>
            <dl className="data-sync-run-facts">
              <div><dt>Run</dt><dd><code>{requestedRun.id}</code></dd></div>
              <div><dt>Collection</dt><dd>{modeLabel(requestedRun.mode)}</dd></div>
              <div><dt>Started</dt><dd>{formatInstant(requestedRun.startedAt)}</dd></div>
              <div><dt>{requestedRun.completedAt ? "Duration (including waits)" : "Last update"}</dt><dd>{requestedRun.completedAt
                ? syncDuration(requestedRun.startedAt, requestedRun.completedAt) : formatInstant(requestedRun.updatedAt)}</dd></div>
            </dl>
            <SyncProgress run={requestedRun} showJobIds />
            {runActions(requestedRun, requestedPollingPaused)}
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
      <SyncDialog open={confirmClean} title="Reset saved data" fallbackFocusRef={heading} onClose={() => { setConfirmClean(false); setCleanAcknowledged(false); }}>
        <div className="data-sync-clean-confirm">
          <strong>Clear saved data before syncing?</strong>
          <p>Your account's saved users, license and app-activity data, Graph packages, and Power Platform inventory will be removed first. These views may be empty until sync succeeds. A failed or cancelled sync does not restore the cleared data.</p>
          <p>Accepted usage reports, report history, audit records, configuration, and other users' saved data are kept.</p>
          <label>
            <input type="checkbox" checked={cleanAcknowledged} onChange={event => setCleanAcknowledged(event.target.checked)} />
            I understand my saved users and inventory will be cleared.
          </label>
          <div className="data-sync-run-actions">
            <button type="button" className="secondary" onClick={() => { setConfirmClean(false); setCleanAcknowledged(false); }}>Keep saved data</button>
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

function SyncProgress({ run, showJobIds = false }: { run: DataSyncRun; showJobIds?: boolean }) {
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
    <section className={`data-sync-progress${complete ? " is-complete" : ""}${collecting ? " is-running" : ""}`} aria-label="Sync status">
      <div className="data-sync-progress-heading" role="status" aria-live="polite">
        {complete ? <CircleCheck size={24} aria-hidden="true" />
          : collecting ? <LoaderCircle className="data-sync-spinning" size={24} aria-hidden="true" />
            : <CircleAlert size={24} aria-hidden="true" />}
        <div>
          <strong>{heading}</strong>
          <p>{automatic.length ? `${completed} of ${automatic.length} automatic sources complete` : "Manual report step"}
            {" · "}{modeLabel(run.mode)}</p>
        </div>
      </div>
      {!complete && automatic.length > 0 ? <progress aria-label="Completed sync sources" value={completed} max={automatic.length} /> : null}
      <ol className="data-sync-live-sources" aria-label="Progress by source">
        {run.sources.map(source => (
          <li key={source.source} className={`data-sync-live-source source-${source.status.replaceAll("_", "-")}`}>
            <SourceBadge status={source.status} />
            <div>
              <strong>{sourceDetails[source.source].label}</strong>
              <p>{source.message || (source.status === "queued" ? "Waiting for collection to start."
                : source.status === "running" ? "Waiting for the provider's next update." : statusLabel(source.status))}</p>
              {source.status === "waiting_authorization" ? <a href="/api/auth/login">Sign in again</a> : null}
              {source.status === "permission_required" ? <a href="/permissions">Review permissions</a> : null}
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
      <p className="data-sync-progress-note">{collecting
        ? "Counts update as the provider responds and may restart for a new stage. The bar measures completed sources, not time or total objects."
        : complete ? "These are this run's results. Other successful source collections remain in Workspace data."
          : "Previous successful data stays available. Only incomplete sources need recovery."}</p>
      <p className="data-sync-run-meta">Started {formatInstant(run.startedAt)} · Last update {formatInstant(run.updatedAt)}</p>
    </section>
  );
}

function SavedSourceRow({ source, attempt, disabled, onSync }: {
  source: DataSyncSourceStatus;
  attempt?: DataSyncSourceStatus;
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
          <span>{attempt ? "Latest attempt" : "Last collection"}</span>
          <SourceBadge status={attempt?.status ?? source.status} />
        </div>
        <WorkbenchActionGate actionId="data-sync.start" compact>
          <button type="button" className="secondary" disabled={disabled} onClick={onSync}>Sync {details.label.toLowerCase()}</button>
        </WorkbenchActionGate>
      </div>
    </article>
  );
}

function SourceBadge({ status }: { status: DataSyncSourceState }) {
  return <span className={`status-badge status-${status.replaceAll("_", "-")}`}>
    {status === "succeeded" ? <Check size={14} aria-hidden="true" />
      : status === "running" ? <LoaderCircle size={14} className="data-sync-spinning" aria-hidden="true" />
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
