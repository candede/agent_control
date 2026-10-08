import { useCallback, useRef } from "react";
import type { AutomaticRefreshStatus as RefreshStatus } from "../useAutomaticRefresh";
import "./automaticRefresh.css";

export function AutomaticRefreshStatus({ status, onOpenSync, onOpenPermissions }: {
  status: RefreshStatus;
  onOpenSync: () => void;
  onOpenPermissions: () => void;
}) {
  const pauseButton = useRef<HTMLButtonElement>(null);
  const signInLink = useCallback((link: HTMLAnchorElement | null) => {
    if (!link) return;
    return () => {
      if (document.activeElement === link) pauseButton.current?.focus();
    };
  }, []);
  const signInRequired = status.phase === "sign_in_required";
  const headline = !status.online ? "Offline — checks paused"
    : status.paused ? "Paused for this session"
      : signInRequired ? "Sign-in required"
        : !status.enabled ? "Waiting for workbench access"
          : !status.visible ? "Checks paused while hidden"
            : status.phase === "checking" ? status.checking ? "Checking saved data" : "Waiting for the next check"
              : status.phase === "refreshing" ? "Refreshing in the background"
                : status.phase === "permission_required" ? "Permission required"
                  : status.phase === "failed" ? "Some sources need attention"
                    : status.phase === "backoff" ? "Check failed — retrying with a delay"
                      : "On";
  return <section className="automatic-refresh-status" aria-label="Automatic refresh">
    <div>
      <div role="status" aria-live="polite" aria-atomic="true">
        <strong>Automatic refresh · {headline}</strong>
        {status.message ? <p>{status.message}</p> : null}
        {status.paused ? <p>New automatic work is paused. Existing work may finish; use Sync to cancel it.{" "}
          {status.online ? "Manual sync remains available." : "Reconnect before starting a manual sync."}</p> : null}
      </div>
      <p>Users and inventory every 15 minutes; package details hourly. Checks run about every minute while this page is visible and online.</p>
    </div>
    <div className="automatic-refresh-actions">
      {signInRequired ? <a ref={signInLink} href="/api/auth/login">Sign in again</a> : null}
      <button ref={pauseButton} type="button" className="secondary" onClick={() => status.setPaused(!status.paused)}>
        {status.paused ? "Resume automatic refresh" : "Pause automatic refresh"}
      </button>
      <button type="button" className="secondary" onClick={onOpenSync}>View sync status</button>
      <button type="button" className="secondary" onClick={onOpenPermissions}>Review permissions</button>
    </div>
  </section>;
}
