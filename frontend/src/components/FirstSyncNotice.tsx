import { CircleAlert, Database, LoaderCircle } from "lucide-react";
import type { DataSyncSourceId, DataSyncState } from "../api/client";
import type { AutomaticRefreshStatus } from "../useAutomaticRefresh";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { automaticSyncSources, syncSourceDetails, syncStatusLabel } from "./syncPresentation";

export function FirstSyncNotice({
  state, loading, busy, error, automaticRefresh, cannotStart, onStart, onCheckStatus, onOpenSync,
}: {
  state?: DataSyncState;
  loading: boolean;
  busy: boolean;
  error: string;
  automaticRefresh?: AutomaticRefreshStatus;
  cannotStart: boolean;
  onStart: (sources: DataSyncSourceId[]) => void;
  onCheckStatus: () => void;
  onOpenSync: () => void;
}) {
  const sources = automaticSyncSources.map(id => {
    const saved = state?.sources.find(source => source.source === id);
    return { id, saved: saved?.status === "succeeded",
      observation: saved?.status === "succeeded" ? saved : state?.run?.sources.find(source => source.source === id) ?? saved };
  });
  const savedCount = sources.filter(source => source.saved).length;
  const progressing = state?.run?.status === "running" || state?.run?.status === "waiting";
  const collecting = progressing && sources.some(({ observation }) => observation?.status === "running" || observation?.status === "queued");
  const needsAttention = sources.some(({ observation }) => observation
    && ["failed", "partial", "waiting_authorization", "permission_required"].includes(observation.status));
  const preparing = !state && loading || busy || !state?.run && automaticRefresh?.checking;
  const title = error ? "Sync status is unavailable"
    : !state ? "Checking workspace setup"
      : needsAttention ? "First sync needs attention"
        : collecting ? "Your first sync is in progress"
          : state.run?.status === "cancelled" ? "First sync was cancelled"
            : preparing ? "Preparing your first sync" : "Set up your workspace";
  const automaticMessage = automaticRefresh?.paused ? "Automatic sync is paused for this session. You can still start a sync below."
    : automaticRefresh && !automaticRefresh.online ? "You are offline. Reconnect to continue syncing."
      : automaticRefresh?.message
        ?? (automaticRefresh && !automaticRefresh.enabled ? "Automatic sync is waiting for workbench access."
          : !state?.run ? "Automatic sync starts when this page is visible, online, and authorized." : undefined);

  return <section className="first-sync-notice" aria-labelledby="first-sync-heading">
    <header className="first-sync-heading">
      {!error && (collecting || preparing) ? <LoaderCircle size={24} className="data-sync-spinning" aria-hidden="true" />
        : error || needsAttention ? <CircleAlert size={24} aria-hidden="true" /> : <Database size={24} aria-hidden="true" />}
      <div>
        <h2 id="first-sync-heading" aria-live="polite">{title}</h2>
        <p>The first sync collects users and agent inventory. This can take several minutes, especially for large tenants.
          Data appears here as each source finishes.</p>
      </div>
    </header>
    {error ? <div className="error-banner" role="alert">{error} {state ? "Progress below is the last reported status." : null}</div> : null}
    {state ? <>
      <div className="first-sync-completion">
        <span>{savedCount} of {automaticSyncSources.length} sources saved</span>
        <progress aria-label="First sync sources saved" value={savedCount} max={automaticSyncSources.length} />
      </div>
      <ul className="first-sync-sources" aria-label="First sync sources">
        {sources.map(({ id, saved, observation }) => <li key={id}>
          <div><strong>{syncSourceDetails[id].label}</strong><span>{syncStatusLabel(observation?.status ?? "not_started")}</span></div>
          {saved ? <p>{observation?.count === null || observation?.count === undefined ? "Saved successfully."
            : `${observation.count.toLocaleString()} ${syncSourceDetails[id].unit} saved`}</p>
            : <p>{observation?.message || (observation?.status === "queued" ? "Waiting to start."
              : observation?.status === "running" ? "Waiting for the provider's next update." : "No successful collection yet.")}</p>}
          {!saved && observation?.count !== null && observation?.count !== undefined && observation.status === "running"
            ? <p>{observation.count.toLocaleString()} processed in this stage</p> : null}
          {observation?.status === "waiting_authorization" ? <a href="/api/auth/login">Sign in again</a> : null}
          {observation?.status === "permission_required" ? <a href="/permissions">Review permissions</a> : null}
        </li>)}
      </ul>
    </> : null}
    {automaticMessage ? <p>{automaticMessage}</p> : null}
    {progressing && !collecting ? <p>Resolve the waiting step, or cancel the run in Sync before trying again.</p> : null}
    <p>You can keep using the app while sync runs. Sync only reads Microsoft data; it does not change settings.
      CSV usage reports are a separate step in Sync and do not block this collection.</p>
    <div className="first-sync-actions">
      {state && !progressing ? <WorkbenchActionGate actionId="data-sync.start">
        <button type="button" disabled={cannotStart || Boolean(error) || automaticRefresh?.checking || automaticRefresh?.online === false}
          onClick={() => onStart(sources.filter(source => !source.saved).map(source => source.id))}>
          {busy ? "Starting sync..." : state.run ? "Retry incomplete sources" : "Start initial sync"}
        </button>
      </WorkbenchActionGate> : null}
      {error ? <WorkbenchActionGate actionId="data-sync.read" compact>
        <button type="button" className="secondary" disabled={loading || busy} onClick={onCheckStatus}>Retry status check</button>
      </WorkbenchActionGate> : null}
      <button type="button" className="secondary" onClick={onOpenSync}>View sync details</button>
    </div>
  </section>;
}
