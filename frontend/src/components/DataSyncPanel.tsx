import {
  forwardRef,
  useCallback,
  useEffect,
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
import { WorkbenchActionGate } from "../workbenchActionContext";
import "./dataSync.css";

const pollIntervalMs = 1_000;
const pollBudgetMs = 5 * 60_000;

const sourceDetails: Record<DataSyncSourceId, { label: string; description: string }> = {
  users: {
    label: "Users",
    description: "Entra users, license assignments, and Microsoft 365 Copilot app activity.",
  },
  graph_packages: {
    label: "Graph packages",
    description: "Copilot agents and packages available through Microsoft Graph.",
  },
  power_platform: {
    label: "Power Platform objects",
    description: "Environments, resources, and Copilot Studio agents.",
  },
  usage_reports: {
    label: "Official usage reports",
    description: "Three CSV exports uploaded by an admin. Not collected automatically.",
  },
};

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
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"start" | "retry" | "cancel">();
  const [error, setError] = useState("");
  const [pollingPaused, setPollingPaused] = useState(false);
  const generation = useRef(0);
  const pollingGeneration = useRef(0);
  const loadController = useRef<AbortController | undefined>(undefined);
  const actionController = useRef<AbortController | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const pollDeadline = useRef(0);
  const sourceStatuses = useRef<Map<DataSyncSourceId, string> | undefined>(undefined);
  const stateRef = useRef<DataSyncState | undefined>(undefined);
  const requestedRunIdRef = useRef(requestedRunId);
  const requestedRunGeneration = useRef(0);
  const requestedRunController = useRef<AbortController | undefined>(undefined);
  const requestedRunTimer = useRef<number | undefined>(undefined);
  const requestedSourceStatuses = useRef<Map<DataSyncSourceId, string> | undefined>(undefined);
  const onSourcesChangedRef = useRef(onSourcesChanged);
  const onRunsChangedRef = useRef(onRunsChanged);
  const wasActive = useRef(active);
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

  const observeSources = useCallback((
    sources: DataSyncSourceStatus[],
    statuses: typeof sourceStatuses,
  ) => {
    const priorStatuses = statuses.current;
    statuses.current = new Map(sources.map(source => [source.source, sourceObservationIdentity(source)]));
    if (priorStatuses) {
      const changed = sources
        .filter(source => {
          const previous = priorStatuses.get(source.source);
          return source.status === "succeeded"
            ? previous !== sourceObservationIdentity(source)
            : previous?.startsWith("succeeded:") && source.count === null && source.lastSuccessAt === null;
        })
        .map(source => source.source);
      if (changed.length) onSourcesChangedRef.current(changed);
    }
  }, []);

  const applyState = useCallback((next: DataSyncState) => {
    observeSources(next.sources, sourceStatuses);

    stateRef.current = next;
    setState(next);
  }, [observeSources]);

  const applyRun = useCallback((run: DataSyncRun) => {
    const current = stateRef.current;
    if (!current) return;
    applyState({ ...current, run, sources: run.sources });
  }, [applyState]);

  const load = useCallback(async (owner: number, preserveActionError = false) => {
    if (loadController.current) return false;
    const controller = new AbortController();
    loadController.current = controller;
    try {
      const next = await getDataSyncState({ signal: controller.signal });
      if (controller.signal.aborted || owner !== generation.current) return false;
      applyState(next);
      if (!preserveActionError) setError("");
      return isProgressing(next.run);
    } catch (reason) {
      if (controller.signal.aborted || owner !== generation.current) return false;
      const message = requestError(reason, "Saved data sync status is unavailable.");
      setError(current => preserveActionError && current ? current : message);
      return false;
    } finally {
      if (loadController.current === controller) loadController.current = undefined;
      if (!controller.signal.aborted && owner === generation.current) setLoading(false);
    }
  }, [applyState]);

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
        pollDeadline.current = 0;
        setPollingPaused(true);
        return;
      }
      timer.current = window.setTimeout(() => void poll(), pollIntervalMs);
    };
    void poll();
  }, [load, stopPolling]);

  useEffect(() => {
    generation.current += 1;
    const owner = generation.current;
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
      setShowSetupGuide(false);
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
      setRequestedRunLoading(Boolean(requestedRunId));
      setRequestedPollingPaused(false);
    });
    if (!requestedRunId) return;

    const deadline = Date.now() + pollBudgetMs;
    const poll = async () => {
      const controller = new AbortController();
      requestedRunController.current = controller;
      try {
        const run = await getDataSyncRun(requestedRunId, { signal: controller.signal });
        if (controller.signal.aborted || owner !== requestedRunGeneration.current) return;
        setRequestedRun(run);
        setRequestedRunError("");
        observeSources(run.sources, requestedSourceStatuses);
        if (!isProgressing(run)) return;
        if (Date.now() >= deadline) {
          setRequestedPollingPaused(true);
          return;
        }
        requestedRunTimer.current = window.setTimeout(() => void poll(), pollIntervalMs);
      } catch (reason) {
        if (controller.signal.aborted || owner !== requestedRunGeneration.current) return;
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
  }, [observeSources, principalKey, requestedRunId, requestedRunReload, stopRequestedRunPolling]);

  const perform = useCallback(async (
    key: "start" | "retry" | "cancel",
    operation: (signal: AbortSignal) => Promise<DataSyncRun>,
  ) => {
    if (actionController.current) return;
    const owner = generation.current;
    stopPolling();
    const controller = new AbortController();
    actionController.current = controller;
    setBusy(key);
    setError("");
    try {
      const run = await operation(controller.signal);
      if (controller.signal.aborted || owner !== generation.current) return;
      if (requestedRunIdRef.current === run.id) {
        requestedRunGeneration.current += 1;
        stopRequestedRunPolling();
        setRequestedRun(run);
        setRequestedRunError("");
        observeSources(run.sources, requestedSourceStatuses);
        setRequestedRunReload(value => value + 1);
      } else if (key === "start" || stateRef.current?.run?.id === run.id) {
        applyRun(run);
      }
      startPolling(owner, true);
    } catch (reason) {
      if (controller.signal.aborted || owner !== generation.current) return;
      setError(requestError(reason, "The data sync operation failed."));
      if (requestedRunIdRef.current) setRequestedRunReload(value => value + 1);
      startPolling(owner, true, true);
    } finally {
      if (actionController.current === controller) actionController.current = undefined;
      if (owner === generation.current) {
        setBusy(undefined);
        onRunsChangedRef.current?.();
      }
    }
  }, [applyRun, observeSources, startPolling, stopPolling, stopRequestedRunPolling]);

  const start = useCallback(async (mode: DataSyncMode, sources?: DataSyncSourceId[], clearSavedData = false) => {
    setConfirmClean(false);
    setCleanAcknowledged(false);
    setShowSetupGuide(false);
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
        onSourcesChangedRef.current(["users", "graph_packages", "power_platform"]);
      }
      return run;
    });
  }, [onRequestedRunChange, perform, requestedRunId]);

  const refresh = useCallback(async () => {
    startPolling(generation.current, true);
    if (requestedRunId) setRequestedRunReload(value => value + 1);
  }, [requestedRunId, startPolling]);

  useImperativeHandle(ref, () => ({ refresh, start }), [refresh, start]);

  const displayedRun = requestedRunId ? requestedRun : state?.run;
  const displayedSources = requestedRunId ? requestedRun?.sources ?? [] : state?.sources ?? [];
  const displayedState = state ? { ...state, run: displayedRun ?? null, sources: displayedSources } : undefined;
  const retrySources = displayedRun?.sources
    .filter(source => source.canRetry && incompleteStates.has(source.status))
    .map(source => source.source) ?? [];
  const runActive = isProgressing(displayedRun);
  const runComplete = isComplete(displayedRun);
  const status = requestedRunId && requestedRunLoading
    ? "Loading requested run"
    : requestedRunId && requestedRunError
      ? "Run unavailable"
      : panelStatus(displayedState, loading);
  const tone = requestedRunId && requestedRunError ? "error" : panelTone(displayedState);
  const updatesPaused = requestedRunId ? requestedPollingPaused : pollingPaused;
  const cannotStart = isProgressing(state?.run) || runActive || Boolean(busy);

  useEffect(() => {
    if (active && !wasActive.current) void refresh();
    if (!active && wasActive.current) void Promise.resolve().then(() => {
      setConfirmClean(false);
      setCleanAcknowledged(false);
    });
    wasActive.current = active;
  }, [active, refresh]);

  if (!active) return null;

  return (
    <section className={`data-sync-panel${state?.onboardingRequired ? " onboarding-required" : ""}`} aria-labelledby="data-sync-heading">
        <header className="data-sync-page-header">
          <div className="data-sync-page-icon"><Database size={24} aria-hidden="true" /></div>
          <div>
            <h2 id="data-sync-heading">Data sync</h2>
            <p>Collect saved data for this workspace. Sync never changes settings in Microsoft 365.</p>
          </div>
          <span className={`data-sync-state state-${error ? "error" : tone}`}>{error ? "Status unavailable" : status}</span>
        </header>
        <div id="data-sync-details" className="data-sync-details">
          {runActive ? <p className="data-sync-run-meta">Sync continues when you switch tabs. Return here for progress and source logs.</p> : null}
          {requestedRunId ? (
            <div className="data-sync-selected-run" role="status">
              <div>
                <strong>Requested sync run {requestedRunId}</strong>
                <p>This exact retained run is shown below. Current onboarding requirements still come from the central saved sync state.</p>
              </div>
              <button type="button" className="secondary" onClick={() => onRequestedRunChange(undefined)}>Return to latest run</button>
            </div>
          ) : null}

          {error ? <div className="error-banner" role="alert">{error}</div> : null}
          {requestedRunError ? <div className="error-banner" role="alert">{requestedRunError}</div> : null}
          {error || requestedRunError ? (
            <WorkbenchActionGate actionId="data-sync.read" compact>
              <button type="button" className="secondary" disabled={loading || requestedRunLoading || Boolean(busy)} onClick={() => void refresh()}>
                <RefreshCw size={15} aria-hidden="true" />Retry status check
              </button>
            </WorkbenchActionGate>
          ) : null}
          {!state && loading ? <p role="status">Loading saved data sync status...</p> : null}
          {state && requestedRunId && requestedRunLoading ? <p role="status">Loading exact sync run {requestedRunId}...</p> : null}

          {state ? (
            <>
              {displayedRun ? <SyncProgress run={displayedRun} /> : null}
              {!displayedRun && !requestedRunId ? (
                <div className="data-sync-start-card">
                  <div>
                    <h3>{state.onboardingRequired ? "Set up your saved data" : "Update your workspace"}</h3>
                    <p>{state.onboardingRequired
                      ? "Read users, Graph packages, and Power Platform inventory for the first time. No saved data is deleted."
                      : "Read the latest users and inventory. Keep existing data available until each replacement is ready."}</p>
                  </div>
                  <WorkbenchActionGate actionId="data-sync.start">
                    <button type="button" disabled={cannotStart} onClick={() => void start(state.onboardingRequired ? "initial" : "incremental")}>
                      <RefreshCw size={16} aria-hidden="true" />
                      {busy === "start" ? "Starting sync..." : state.onboardingRequired ? "Start initial sync" : "Refresh saved data"}
                    </button>
                  </WorkbenchActionGate>
                </div>
              ) : null}
              {updatesPaused && runActive ? (
                <div className="data-sync-run-actions">
                  <p className="data-sync-poll-note" role="status">Live updates are paused. The server job is not stopped.</p>
                  <WorkbenchActionGate actionId="data-sync.read" compact>
                    <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void refresh()}>
                      <RotateCcw size={15} aria-hidden="true" />Resume updates
                    </button>
                  </WorkbenchActionGate>
                </div>
              ) : null}
              {displayedRun ? (
                <div className="data-sync-run-actions">
                  {!runActive && !retrySources.length ? (
                    <WorkbenchActionGate actionId="data-sync.start">
                      <button type="button" className="secondary" disabled={cannotStart} onClick={() => void start("incremental")}>
                        <RefreshCw size={16} aria-hidden="true" />
                        {busy === "start" ? "Starting sync..." : "Refresh saved data"}
                      </button>
                    </WorkbenchActionGate>
                  ) : null}
                  {retrySources.length ? (
                    <WorkbenchActionGate actionId="data-sync.retry">
                      <button
                        type="button"
                        className="secondary"
                        disabled={Boolean(busy)}
                        onClick={() => void perform(
                          "retry",
                          signal => retryDataSyncRun(displayedRun.id, retrySources, { signal }),
                        )}
                      >
                        Retry incomplete ({retrySources.length})
                      </button>
                    </WorkbenchActionGate>
                  ) : null}
                  {runActive ? (
                    <WorkbenchActionGate actionId="data-sync.cancel">
                      <button
                        type="button"
                        className="secondary"
                        disabled={Boolean(busy)}
                        onClick={() => void perform(
                          "cancel",
                          signal => cancelDataSyncRun(displayedRun.id, { signal }),
                        )}
                      >
                        <Square size={14} aria-hidden="true" />Cancel run
                      </button>
                    </WorkbenchActionGate>
                  ) : null}
                </div>
              ) : null}

              {displayedRun || !requestedRunId ? (
                <details className="data-sync-source-details" key={displayedRun?.id ?? "setup"} open={!runComplete}>
                  <summary>{runComplete ? "View sync details" : "Source details"}</summary>
                  <div className="data-sync-source-details-content">
                    {displayedRun ? (
                      <p className="data-sync-run-meta">
                        {modeLabel(displayedRun.mode)} run <code>{displayedRun.id}</code> · {displayedRun.status.replaceAll("_", " ")}
                      </p>
                    ) : null}
                    <div className="data-sync-sources" aria-label="Data sync sources">
                      {displayedSources.map(source => (
                        <SourceStatus
                          key={source.source}
                          source={source}
                          canUploadUsage={canUploadUsage}
                          disabled={cannotStart}
                          onOpenUsageImport={onOpenUsageImport}
                          onSync={() => void start("incremental", [source.source])}
                        />
                      ))}
                    </div>
                    {!runActive ? (
                      <section className="data-sync-clean" aria-label="Full resync">
                        <div>
                          <strong>Need a fresh start?</strong>
                          <p>Clear your saved users and inventory, then collect them again from Microsoft.</p>
                        </div>
                        {confirmClean ? (
                          <div className="data-sync-clean-confirm">
                            <strong>Clear saved data before syncing?</strong>
                            <p>Your account's saved users, license and app-activity data, Graph packages, and Power Platform inventory will be removed first. These views may be empty until sync succeeds. A failed or cancelled sync does not restore the cleared data.</p>
                            <p>Accepted usage reports, report history, audit records, configuration, and other users' saved data are kept.</p>
                            <label>
                              <input type="checkbox" checked={cleanAcknowledged} onChange={event => setCleanAcknowledged(event.target.checked)} />
                              I understand my saved users and inventory will be cleared.
                            </label>
                            <div className="data-sync-run-actions">
                              <WorkbenchActionGate actionId="data-sync.start">
                                <button type="button" className="danger" disabled={cannotStart || !cleanAcknowledged} onClick={() => void start("full", undefined, true)}>
                                  Clear and start full resync
                                </button>
                              </WorkbenchActionGate>
                              <button type="button" className="secondary" onClick={() => { setConfirmClean(false); setCleanAcknowledged(false); }}>Keep saved data</button>
                            </div>
                          </div>
                        ) : (
                          <WorkbenchActionGate actionId="data-sync.start">
                            <button type="button" className="secondary" disabled={cannotStart} onClick={() => setConfirmClean(true)}>
                              <RotateCcw size={15} aria-hidden="true" />Clear saved data and resync
                            </button>
                          </WorkbenchActionGate>
                        )}
                      </section>
                    ) : null}
                    {showSetupGuide ? (
                      <section className="data-sync-setup" aria-label="Sync scope">
                        <div>
                          <strong>What is included?</strong>
                          <p>
                            Users, Graph packages, and Power Platform objects are read from Microsoft.
                            Official usage comes from CSVs you upload separately. Audit and security data
                            are separate, bounded query workflows rather than an all-logs collection.
                          </p>
                          <div className="data-sync-links">
                            <a href="/audit">Open bounded audit searches</a>
                            <a href="/security">Open bounded security hunts</a>
                          </div>
                        </div>
                        <button type="button" className="secondary" onClick={() => setShowSetupGuide(false)}>Hide setup guide</button>
                      </section>
                    ) : (
                      <button type="button" className="data-sync-guide-link" onClick={() => setShowSetupGuide(true)}>
                        What does sync include?
                      </button>
                    )}
                  </div>
                </details>
              ) : null}
              {state.usageImportRequired ? (
                <div className="data-sync-usage-callout" role="status">
                  <CircleAlert size={20} aria-hidden="true" />
                  <div>
                    <strong>Three official usage CSVs are still required.</strong>
                    <p>
                      Export Agents, Users &amp; agents, and Users for the same 7- or 30-day selection from
                      Microsoft 365 admin center → Reports → Usage → Microsoft Copilot → Agents.
                    </p>
                    <p>
                      Uploads accumulate retained snapshots. Exact duplicates are reused; previous imports
                      remain available, and changed aggregate metrics are recorded as later observations,
                      not overwritten or summed across overlapping windows.
                    </p>
                  </div>
                  {canUploadUsage ? (
                    <button type="button" onClick={onOpenUsageImport}><Upload size={16} aria-hidden="true" />Upload three CSVs</button>
                  ) : (
                    <span>Ask an AgentControl.Admin to upload the three-report bundle. Other authorized pages remain available.</span>
                  )}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
    </section>
  );
});

function SyncProgress({ run }: { run: DataSyncRun }) {
  const completed = run.sources.filter(source => source.status === "succeeded").length;
  const running = run.sources.filter(source => source.status === "running");
  const queued = run.sources.some(source => source.status === "queued");
  const complete = isComplete(run);
  const active = isProgressing(run);
  const heading = complete
    ? "Sync complete"
    : run.status === "cancelled"
      ? "Sync cancelled"
      : running.length
        ? `Syncing ${running.map(source => sourceDetails[source.source].label.toLowerCase()).join(", ")}`
        : queued && active
          ? "Preparing your sync"
          : "Sync needs your attention";
  return (
    <section className={`data-sync-progress${complete ? " is-complete" : ""}`} aria-label="Sync status">
      <div className="data-sync-progress-heading" role="status" aria-live="polite">
        {complete ? <CircleCheck size={24} aria-hidden="true" />
          : active && (running.length > 0 || queued) ? <LoaderCircle className="data-sync-spinning" size={24} aria-hidden="true" />
            : <CircleAlert size={24} aria-hidden="true" />}
        <div>
          <strong>{heading}</strong>
          <p>{completed} of {run.sources.length} sources complete</p>
        </div>
      </div>
      {!complete && run.sources.length > 0 ? <progress aria-label="Completed sync sources" value={completed} max={run.sources.length} /> : null}
      <p>{complete
        ? "Requested source collection completed. Verify saved inventory below to inspect stored/provider counts, requested scope and exact source accounting without a new provider read."
        : active && (running.length > 0 || queued)
          ? "Sources can run in parallel. Counts appear as results are saved; this is source progress, not an estimated time."
          : "Review the source statuses below. Completed sources remain available; retry only the sources that need it."}</p>
    </section>
  );
}

function SourceStatus({
  source,
  canUploadUsage,
  disabled,
  onOpenUsageImport,
  onSync,
}: {
  source: DataSyncSourceStatus;
  canUploadUsage: boolean;
  disabled: boolean;
  onOpenUsageImport: () => void;
  onSync: () => void;
}) {
  const details = sourceDetails[source.source];
  return (
    <article className={`data-sync-source source-${source.status.replaceAll("_", "-")}`} aria-label={details.label}>
      <div className="data-sync-source-heading">
        <strong>{details.label}</strong>
        <span className={`status-badge status-${source.status.replaceAll("_", "-")}`}>
          {source.status === "succeeded" ? <Check size={14} aria-hidden="true" />
            : source.status === "running" ? <LoaderCircle size={14} className="data-sync-spinning" aria-hidden="true" />
              : source.status === "queued" || source.status === "not_started" ? <Clock3 size={14} aria-hidden="true" />
                : source.status === "awaiting_upload" ? <Upload size={14} aria-hidden="true" />
                  : <CircleAlert size={14} aria-hidden="true" />}
          {statusLabel(source.status)}
        </span>
      </div>
      <p className="data-sync-source-description">{details.description}</p>
      <dl>
        <div>
          <dt>{source.status === "succeeded" ? "Saved count" : "Reported count"}</dt>
          <dd>{source.count === null ? "Not reported" : source.count.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Last successful</dt>
          <dd>{source.lastSuccessAt ? formatInstant(source.lastSuccessAt) : "Never"}</dd>
        </div>
      </dl>
      {source.message ? <p>{source.message}</p> : null}
      <div className="data-sync-source-actions">
        {source.source === "usage_reports" ? (
          canUploadUsage ? (
            <button type="button" className="secondary" onClick={onOpenUsageImport}>
              <Upload size={15} aria-hidden="true" />Manage uploads
            </button>
          ) : <span>Uploads require AgentControl.Admin.</span>
        ) : (
          <WorkbenchActionGate actionId="data-sync.start" compact>
            <button type="button" className="secondary" disabled={disabled} onClick={onSync}>
              Sync {details.label.toLowerCase()}
            </button>
          </WorkbenchActionGate>
        )}
        {source.status === "waiting_authorization" ? <a href="/api/auth/login">Sign in again</a> : null}
        {source.status === "permission_required" ? <a href="/permissions">Review permissions</a> : null}
        {source.source === "usage_reports" && source.status === "awaiting_upload"
          ? <a href="https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide" target="_blank" rel="noreferrer">Microsoft export guidance</a>
          : null}
      </div>
    </article>
  );
}

function isProgressing(run: DataSyncRun | null | undefined) {
  return run?.status === "running" || run?.status === "waiting";
}

function isComplete(run: DataSyncRun | null | undefined) {
  return run?.status === "completed" && run.sources.every(source => source.status === "succeeded");
}

function panelStatus(state: DataSyncState | undefined, loading: boolean) {
  if (!state) return loading ? "Loading status" : "Status unavailable";
  if (state.run?.status === "running") return "Sync running";
  if (state.run?.status === "waiting") return "Action required";
  if (state.onboardingRequired) return "Setup required";
  const usage = state.sources.find(source => source.source === "usage_reports");
  if (state.usageImportRequired || usage?.status === "awaiting_upload" || usage?.status === "not_started") {
    return "Usage upload required";
  }
  if (state.sources.some(source => source.status !== "succeeded")) return "Needs attention";
  return "Setup complete";
}

function panelTone(state: DataSyncState | undefined) {
  if (isProgressing(state?.run)) return "progress";
  const usage = state?.sources.find(source => source.source === "usage_reports");
  if (
    !state
    || state.onboardingRequired
    || state.usageImportRequired
    || usage?.status === "awaiting_upload"
    || usage?.status === "not_started"
  ) return "attention";
  if (state.sources.some(source => source.status !== "succeeded")) return "error";
  return "success";
}

function sourceObservationIdentity(source: DataSyncSourceStatus) {
  return source.status === "succeeded"
    ? `succeeded:${source.jobId ?? ""}:${source.lastSuccessAt ?? ""}`
    : `status:${source.status}`;
}

function statusLabel(status: DataSyncSourceState) {
  if (status === "succeeded") return "Complete";
  if (status === "running") return "Syncing";
  if (status === "not_started") return "Not started";
  if (status === "queued") return "Queued";
  if (status === "failed") return "Failed";
  if (status === "partial") return "Incomplete";
  if (status === "cancelled") return "Cancelled";
  if (status === "awaiting_upload") return "Awaiting upload";
  if (status === "permission_required") return "Permission required";
  if (status === "waiting_authorization") return "Sign-in required";
  return status;
}

function modeLabel(mode: DataSyncMode) {
  return mode === "full" ? "Full resync" : mode === "initial" ? "Initial sync" : "Saved data refresh";
}

function formatInstant(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function requestError(reason: unknown, fallback: string) {
  if (reason instanceof ApiError) {
    return `${reason.message}${reason.requestId ? ` Request ${reason.requestId}.` : ""}`;
  }
  return reason instanceof Error ? reason.message : fallback;
}
