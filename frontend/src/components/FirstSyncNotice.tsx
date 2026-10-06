import { LoaderCircle } from "lucide-react";
import type { DataSyncSourceId, DataSyncState } from "../api/client";
import type { AutomaticRefreshStatus } from "../useAutomaticRefresh";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { automaticSyncSources, syncSourceDetails, syncStatusLabel } from "./syncPresentation";
import { WorkbenchDialog } from "./WorkbenchDialog";

export function FirstSyncNotice({
  state, loading, busy, error, automaticRefresh, cannotStart, onStart, onCheckStatus, onOpenSync,
}: {
  state: DataSyncState;
  loading: boolean;
  busy: boolean;
  error: string;
  automaticRefresh?: AutomaticRefreshStatus;
  cannotStart: boolean;
  onStart: (sources: DataSyncSourceId[]) => void;
  onCheckStatus: () => void;
  onOpenSync: () => void;
}) {
  const attempts = state.run?.sources.filter(source => automaticSyncSources.some(id => id === source.source)) ?? [];
  const sources = automaticSyncSources.map(id => {
    const saved = state.sources.find(source => source.source === id);
    return { id, saved: saved?.status === "succeeded",
      observation: saved?.status === "succeeded" ? saved : attempts.find(source => source.source === id) ?? saved };
  });
  const savedCount = sources.filter(source => source.saved).length;
  const progressing = state.run?.status === "running" || state.run?.status === "waiting";
  const collecting = progressing && attempts.some(source => source.status === "running" || source.status === "queued");
  const needsAttention = (progressing ? attempts : sources.map(source => source.observation)).some(observation => observation
    && ["failed", "partial", "waiting_authorization", "permission_required"].includes(observation.status))
    || automaticRefresh?.phase === "sign_in_required" || automaticRefresh?.phase === "permission_required" || automaticRefresh?.phase === "failed";
  const needsSignIn = automaticRefresh?.phase === "sign_in_required"
    || progressing && attempts.some(source => source.status === "waiting_authorization");
  const preparing = busy || !state.run && automaticRefresh?.checking;
  const title = error ? "Sync status is unavailable"
    : needsAttention ? "First sync needs attention"
      : collecting ? "Your first sync is in progress"
        : state.run?.status === "cancelled" ? "First sync was cancelled"
          : preparing ? "Preparing your first sync" : "Set up your workspace";
  const automaticMessage = automaticRefresh?.paused ? "Automatic sync is paused for this session. You can still start a sync below."
    : automaticRefresh && !automaticRefresh.online ? "You are offline. Reconnect to continue syncing."
      : automaticRefresh?.message
        ?? (automaticRefresh && !automaticRefresh.enabled ? "Automatic sync is waiting for workbench access."
          : !state.run ? "Automatic sync starts when this page is visible, online, and authorized." : undefined);

  return <WorkbenchDialog open title={title} className="first-sync-dialog"
    description="We're preparing your users and agent inventory. This can take several minutes, especially for large tenants. Your workspace will open automatically when all three sources are saved.">
    <div className="first-sync-notice">
    {error ? <div className="error-banner" role="alert">{error} Progress below is the last reported status.</div> : null}
      <div className="first-sync-completion">
        <span role="status">{!error && (collecting || preparing)
          ? <LoaderCircle size={18} className="data-sync-spinning" aria-hidden="true" /> : null}
          {savedCount} of {automaticSyncSources.length} sources saved</span>
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
    {automaticMessage ? <p>{automaticMessage}</p> : null}
    {progressing && !collecting ? <p>Resolve the waiting step, or cancel the run in Sync before trying again.</p> : null}
    <p>Sync only reads Microsoft data; it does not change settings.
      CSV usage reports are a separate step in Sync and do not block this collection.</p>
    <div className="first-sync-actions">
      {!progressing ? <WorkbenchActionGate actionId="data-sync.start">
        <button type="button" disabled={cannotStart || Boolean(error) || automaticRefresh?.checking || automaticRefresh?.online === false}
          onClick={() => onStart(sources.filter(source => !source.saved).map(source => source.id))}>
          {busy ? "Starting sync..." : state.run ? "Retry incomplete sources" : "Start initial sync"}
        </button>
      </WorkbenchActionGate> : null}
      {error ? <WorkbenchActionGate actionId="data-sync.read" compact>
        <button type="button" className="secondary" disabled={loading || busy} onClick={onCheckStatus}>Retry status check</button>
      </WorkbenchActionGate> : null}
      <button type="button" className="secondary" onClick={onOpenSync}>View sync details</button>
      {needsSignIn && !sources.some(({ observation }) => observation?.status === "waiting_authorization")
        ? <a href="/api/auth/login">Sign in again</a> : null}
      {!sources.some(({ observation }) => observation?.status === "permission_required")
        ? <a href="/permissions">Review permissions</a> : null}
    </div>
    </div>
  </WorkbenchDialog>;
}
