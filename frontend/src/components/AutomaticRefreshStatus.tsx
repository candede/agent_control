import type { AutomaticRefreshStatus as RefreshStatus } from "../useAutomaticRefresh";
import "./automaticRefresh.css";

export function AutomaticRefreshStatus({ status, onOpenSync, onOpenPermissions }: {
  status: RefreshStatus;
  onOpenSync: () => void;
  onOpenPermissions: () => void;
}) {
  const signInRequired = status.phase === "sign_in_required";
  const headline = status.paused ? "Paused for this session"
    : signInRequired ? "Sign-in required"
      : !status.enabled ? "Waiting for workbench access"
        : !status.online ? "Offline — checks paused"
          : !status.visible ? "Checks paused while hidden"
            : status.phase === "checking" ? "Checking saved data"
              : status.phase === "refreshing" ? "Refreshing in the background"
                : status.phase === "permission_required" ? "Permission required"
                  : status.phase === "failed" ? "Some sources need attention"
                    : status.phase === "backoff" ? "Check failed — retrying with a delay"
                      : "On";
  return <section className="automatic-refresh-status" aria-label="Automatic refresh">
    <div>
      <strong>Automatic refresh · {headline}</strong>
      <p>Users and inventory every 15 minutes; package details hourly. Checks run about every minute while this page is visible and online.</p>
      {status.message ? <p>{status.message}</p> : null}
      {status.paused ? <p>New automatic work is paused. Existing work may finish; use Sync to cancel it. Manual sync remains available.</p> : null}
    </div>
    <div className="automatic-refresh-actions">
      {signInRequired ? <a href="/api/auth/login">Sign in again</a> : null}
      <button type="button" className="secondary" onClick={() => status.setPaused(!status.paused)}>
        {status.paused ? "Resume automatic refresh" : "Pause automatic refresh"}
      </button>
      <button type="button" className="secondary" onClick={onOpenSync}>View sync status</button>
      {(signInRequired || status.phase === "permission_required") ? <button type="button" className="secondary" onClick={onOpenPermissions}>Review permissions</button> : null}
    </div>
  </section>;
}
