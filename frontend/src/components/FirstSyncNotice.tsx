import { LoaderCircle } from "lucide-react";
import type { DataSyncSourceId, DataSyncState } from "../api/client";
import type { AutomaticRefreshStatus } from "../useAutomaticRefresh";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { automaticSyncSources, syncSourceDetails, syncStatusLabel } from "./syncPresentation";
import { WorkbenchDialog } from "./WorkbenchDialog";

export function FirstSyncNotice({
  state, loading, busy, error, stale, automaticRefresh, cannotStart, onStart, onCancel, onCheckStatus, onOpenPermissions,
}: {
  state: DataSyncState;
  loading: boolean;
  busy?: "start" | "cancel";
  error: string;
  stale: boolean;
  automaticRefresh?: AutomaticRefreshStatus;
  cannotStart: boolean;
  onStart: (sources: DataSyncSourceId[]) => void;
  onCancel: () => void;
  onCheckStatus: () => void;
  onOpenPermissions: () => void;
}) {
  const attempts = state.run?.sources.filter(source => automaticSyncSources.some(id => id === source.source)) ?? [];
  const sources = automaticSyncSources.map(id => {
    const saved = state.sources.find(source => source.source === id);
    const attempt = attempts.find(source => source.source === id);
    return { id, saved: saved?.status === "succeeded",
      observation: saved?.status === "succeeded" ? saved : attempt && attempt.status !== "succeeded" ? attempt : saved };
  });
  const savedCount = sources.filter(source => source.saved).length;
  const progressing = state.run?.status === "running" || state.run?.status === "waiting";
  const collecting = progressing && attempts.some(source => source.status === "running" || source.status === "queued");
  const needsAttention = (progressing ? attempts : sources.map(source => source.observation)).some(observation => observation
    && ["failed", "partial", "waiting_authorization", "permission_required"].includes(observation.status))
    || automaticRefresh?.phase === "sign_in_required" || automaticRefresh?.phase === "permission_required"
    || automaticRefresh?.phase === "failed" || automaticRefresh?.phase === "backoff";
  const needsSignIn = automaticRefresh?.phase === "sign_in_required"
    || progressing && attempts.some(source => source.status === "waiting_authorization");
  const preparing = busy === "start" || !state.run && automaticRefresh?.checking;
  const updating = Boolean(busy && state.run);
  const syncError = error || (automaticRefresh?.phase === "backoff" ? automaticRefresh.message : undefined);
  const canRetry = Boolean(state.run || error || automaticRefresh?.paused)
    || automaticRefresh?.phase === "backoff" || automaticRefresh?.phase === "failed";
  const needsPermissions = automaticRefresh?.phase === "permission_required";
  const title = stale ? "Sync status is unavailable"
    : updating ? "Updating sync status"
      : needsAttention ? "First sync needs attention"
        : collecting ? "Your first sync is in progress"
          : state.run?.status === "cancelled" ? "First sync was cancelled"
            : preparing ? "Preparing your first sync" : "Set up your workspace";
  const automaticMessage = automaticRefresh && !automaticRefresh.online ? "You are offline. Reconnect to continue syncing."
    : automaticRefresh?.paused ? "Automatic sync is paused for this session. Retry sync to continue."
      : automaticRefresh?.message
        ?? (!state.run ? "Your first sync starts automatically." : undefined);

  return <WorkbenchDialog open title={title} className="first-sync-dialog"
    description="We're preparing your users and agent inventory. This can take several minutes, especially for large tenants. Your workspace will open automatically when all three sources are saved.">
    <div className="first-sync-notice">
    {syncError ? <div className="error-banner" role="alert">{syncError}{stale ? " Progress below is the last reported status." : null}</div> : null}
      <div className="first-sync-completion">
        <span role="status">{!stale && !updating && (collecting || preparing)
          ? <LoaderCircle size={18} className="data-sync-spinning" aria-hidden="true" /> : null}
          {savedCount} of {automaticSyncSources.length} sources saved</span>
        <progress aria-label="First sync sources saved" value={savedCount} max={automaticSyncSources.length} />
      </div>
      {updating ? <p role="status">Progress below is the last reported status while the sync operation finishes.</p> : null}
      <ul className="first-sync-sources" aria-label="First sync sources">
        {sources.map(({ id, saved, observation }) => <li key={id}>
          <div><strong>{syncSourceDetails[id].label}</strong><span>{syncStatusLabel(observation?.status ?? "not_started")}</span></div>
          {saved ? <p>{observation?.count === null || observation?.count === undefined ? "Saved successfully."
            : `${observation.count.toLocaleString()} ${syncSourceDetails[id].unit} saved`}</p>
            : <p>{!observation || observation.status === "not_started" || observation.status === "queued" ? "Waiting to start."
              : observation.message || (observation.status === "running" ? "Waiting for the provider's next update." : "No successful collection yet.")}</p>}
          {!saved && observation?.count !== null && observation?.count !== undefined && observation.status === "running"
            ? <p>{observation.count.toLocaleString()} processed in this stage</p> : null}
          {observation?.status === "waiting_authorization" ? <a href="/api/auth/login">Sign in again</a> : null}
          {observation?.status === "permission_required" ? <button type="button" className="secondary" onClick={onOpenPermissions}>Review permissions</button> : null}
        </li>)}
      </ul>
    {automaticMessage && automaticMessage !== syncError ? <p>{automaticMessage}</p> : null}
    {progressing && !collecting ? <p>Resolve the waiting step, or cancel this sync before trying again.</p> : null}
    <p>Sync only reads Microsoft data; it does not change settings.</p>
    {canRetry && !progressing || progressing && !collecting || needsAttention || stale || error ? <div className="first-sync-actions">
      {canRetry && !progressing ? <WorkbenchActionGate actionId="data-sync.start">
        <button type="button" disabled={cannotStart || loading || stale || automaticRefresh?.checking || automaticRefresh?.online === false}
          onClick={() => onStart(sources.filter(source => !source.saved).map(source => source.id))}>
          {busy === "start" ? "Starting sync..." : state.run ? "Retry incomplete sources" : "Retry sync"}
        </button>
      </WorkbenchActionGate> : null}
      {progressing && !collecting ? <WorkbenchActionGate actionId="data-sync.cancel">
        <button type="button" className="secondary" disabled={loading || Boolean(busy)} onClick={onCancel}>
          {busy === "cancel" ? "Cancelling sync..." : "Cancel sync"}
        </button>
      </WorkbenchActionGate> : null}
      {error ? <WorkbenchActionGate actionId="data-sync.read" compact>
        <button type="button" className="secondary" disabled={loading || Boolean(busy)} onClick={onCheckStatus}>
          {loading ? "Checking status..." : "Retry status check"}
        </button>
      </WorkbenchActionGate> : null}
      {needsSignIn && !sources.some(({ observation }) => observation?.status === "waiting_authorization")
        ? <a href="/api/auth/login">Sign in again</a> : null}
      {needsPermissions && !sources.some(({ observation }) => observation?.status === "permission_required")
        ? <button type="button" className="secondary" onClick={onOpenPermissions}>Review permissions</button> : null}
    </div> : null}
    </div>
  </WorkbenchDialog>;
}
