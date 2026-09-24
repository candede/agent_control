import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { getCapabilityCheckProgress, type CapabilityCheckProgress, type CapabilityView } from "../api/client";
import { permissionFeatureName } from "../permissionIssues";
import { retryPermissionRead } from "../useCapabilities";

type Props = {
  loading: boolean;
  activeCheck?: { id: number; retryFailed: boolean };
  views: CapabilityView[];
};

export function PermissionCheckProgress(props: Props) {
  return <CheckRun key={props.activeCheck?.id ?? "catalog"} {...props} />;
}

function CheckRun({ loading, activeCheck, views }: Props) {
  const [progress, setProgress] = useState<CapabilityCheckProgress>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!activeCheck) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let reading = false;
    const poll = async () => {
      if (controller.signal.aborted || reading || document.visibilityState === "hidden") return;
      reading = true;
      try {
        const result = await retryPermissionRead(() => getCapabilityCheckProgress({
          signal: controller.signal, retryFailed: activeCheck.retryFailed,
        }), controller.signal);
        if (!controller.signal.aborted) {
          setProgress(result.progress ?? undefined);
          setUnavailable(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setProgress(undefined);
          setUnavailable(true);
        }
      } finally {
        reading = false;
        if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 1_000);
      }
    };
    const resume = () => {
      if (document.visibilityState !== "hidden" && !reading) {
        window.clearTimeout(timer);
        void poll();
      }
    };
    timer = window.setTimeout(() => void poll(), 500);
    document.addEventListener("visibilitychange", resume);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [activeCheck]);

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
