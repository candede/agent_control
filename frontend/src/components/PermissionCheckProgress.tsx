import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { ApiError, captureRequestSession, getCapabilityCheckProgress, type CapabilityCheckProgress, type CapabilityView } from "../api/client";
import { permissionFeatureName } from "../permissionIssues";
import { retryPermissionRead } from "../useCapabilities";

type Props = {
  loading: boolean;
  activeCheck?: { id: number; retryFailed: boolean };
  views: CapabilityView[];
};

export function PermissionCheckProgress(props: Props) {
  return <CheckRun key={props.activeCheck ? `${props.activeCheck.id}:${props.activeCheck.retryFailed}` : "catalog"} {...props} />;
}

function CheckRun({ loading, activeCheck, views }: Props) {
  const [progress, setProgress] = useState<CapabilityCheckProgress>();
  const [unavailable, setUnavailable] = useState(false);
  const checkId = activeCheck?.id;
  const retryFailed = activeCheck?.retryFailed;
  useEffect(() => {
    if (checkId === undefined) return;
    const assertCurrentSession = captureRequestSession();
    let controller = new AbortController();
    let timer: number | undefined;
    let retryAt = 0;
    let reading = false;
    let stopped = false;
    let hidden = document.visibilityState === "hidden";
    const poll = async () => {
      if (stopped || reading || document.visibilityState === "hidden") return;
      const current = new AbortController();
      controller = current;
      reading = true;
      let nextPollDelay = 1_000;
      try {
        assertCurrentSession();
        const remainingCooldown = retryAt - Date.now();
        if (remainingCooldown > 0) {
          nextPollDelay = remainingCooldown;
          return;
        }
        const result = await retryPermissionRead(() => getCapabilityCheckProgress({
          signal: current.signal, retryFailed,
        }), current.signal);
        if (!current.signal.aborted) {
          assertCurrentSession();
          setProgress(result.progress ?? undefined);
          setUnavailable(false);
        }
      } catch (cause) {
        if (!current.signal.aborted) {
          setProgress(undefined);
          if (cause instanceof ApiError && cause.kind === "aborted") {
            stopped = true;
            current.abort();
            setUnavailable(false);
          } else {
            setUnavailable(true);
            if (cause instanceof ApiError && [401, 403].includes(cause.status)) stopped = true;
            const retryAfterMs = cause instanceof ApiError && cause.status === 429 ? (cause.retryAfterSeconds ?? 0) * 1_000 : 0;
            if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
              nextPollDelay = Math.max(nextPollDelay, retryAfterMs);
              retryAt = Date.now() + nextPollDelay;
            }
          }
        }
      } finally {
        if (controller === current) {
          reading = false;
          if (!stopped && !current.signal.aborted) timer = window.setTimeout(() => void poll(), Math.min(nextPollDelay, 2_147_483_647));
        }
      }
    };
    const visibilityChanged = () => {
      const wasHidden = hidden;
      hidden = document.visibilityState === "hidden";
      if (hidden) {
        window.clearTimeout(timer);
        controller.abort();
        reading = false;
      } else if (wasHidden) {
        window.clearTimeout(timer);
        void poll();
      }
    };
    timer = window.setTimeout(() => void poll(), 500);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      stopped = true;
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [checkId, retryFailed]);

  const checks = progress?.checks.flatMap(check => {
    const view = views.find(item => item.definition.id === check.capabilityId);
    return view ? [{ ...check, name: permissionFeatureName(view) }] : [];
  }) ?? [];
  const complete = checks.filter(check => check.state === "complete").length;
  const active = checks.filter(check => check.state !== "complete");
  const title = loading ? "Loading permission results" : checks.length && !active.length ? "Updating results" : "Checking permissions";
  const detail = loading ? "Reading saved checks and recent issues."
    : unavailable ? "Live check details are unavailable. Checks are still running."
      : checks.length ? `${complete} of ${checks.length} reviewed` : "Waiting for check updates...";
  return <section className="permission-progress" aria-label="Permission check progress">
    <div className="permission-progress-heading">
      <LoaderCircle className="permission-spinner" size={22} aria-hidden="true" />
      <div role="status" aria-live="polite" aria-atomic="true"><strong>{title}</strong><p>{detail}</p></div>
    </div>
    <progress aria-label="Permission checks reviewed" max={checks.length || 1}
      value={checks.length ? complete : undefined} />
    {active.length ? <ul className="permission-progress-checks" aria-label="Current checks">{active.map(check => <li key={check.capabilityId}>
      <span className="permission-progress-dot" aria-hidden="true" />
      <span><strong>{check.name}</strong><span>{check.state === "reviewing" ? "Reviewing saved result" : "Checking Microsoft access"}</span></span>
    </li>)}</ul> : null}
  </section>;
}
