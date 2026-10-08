import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ApiError, getWorkbenchJobs, type SessionUser, type WorkbenchJobsResponse } from "../api/client";
import { useSavedRead } from "../savedQueries";
import { SyncHistoryTable } from "./SyncHistoryTable";

const pollIntervalMs = 2_000;
const syncSources = new Set(["data-sync", "package-refresh", "power-platform"]);
const progressingStatuses = new Set(["queued", "running", "waiting"]);

type Props = {
  user: SessionUser;
  onOpenSyncRun?: (runId: string) => void;
  onOpenSourceJob?: (href: string) => void;
  revision?: number;
};

export function SyncHistoryView({ user, ...props }: Props) {
  const principalKey = `${user.tenantId ?? ""}:${user.homeAccountId}:${[...user.roles].sort().join(",")}`;
  return <OwnedSyncHistoryView key={principalKey} {...props} principalKey={principalKey} />;
}

function OwnedSyncHistoryView({ principalKey, onOpenSyncRun, onOpenSourceJob, revision = 0 }: Omit<Props, "user"> & { principalKey: string }) {
  const [state, setState] = useState<WorkbenchJobsResponse>();
  const [error, setError] = useState("");
  const [activity, setActivity] = useState<"loading" | "refreshing" | "idle">("loading");
  const generation = useRef(0);
  const pollingGeneration = useRef(0);
  const request = useRef<{ controller: AbortController; manual: boolean } | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const refreshRevision = useRef(0);
  const readOwner = useId();
  const readSaved = useSavedRead();
  const action = {};
  const committed = useRef<object | undefined>(undefined);
  useLayoutEffect(() => {
    committed.current = action;
    return () => { committed.current = undefined; };
  });

  const stop = useCallback(() => {
    pollingGeneration.current += 1;
    request.current?.controller.abort();
    request.current = undefined;
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const load = useCallback(async (owner: number, manual: boolean) => {
    if (request.current) return false;
    const controller = new AbortController();
    request.current = { controller, manual };
    setActivity(manual ? "refreshing" : "loading");
    setError("");
    try {
      const next = await readSaved(
        ["workbench-jobs", principalKey, revision, refreshRevision.current ? `${readOwner}:${refreshRevision.current}` : 0],
        signal => getWorkbenchJobs({ signal }),
        controller.signal,
      );
      if (controller.signal.aborted || owner !== generation.current) return false;
      setState(next);
      setError("");
      return next.value.some(job => syncSources.has(job.source) && progressingStatuses.has(job.status));
    } catch (reason) {
      if (controller.signal.aborted || owner !== generation.current) return false;
      if (reason instanceof ApiError && reason.kind === "aborted") {
        setState(undefined);
        setError("The sync history read was cancelled. Refresh history to try again.");
        return false;
      }
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) setState(undefined);
      setError(reason instanceof ApiError
        ? `${reason.message}${reason.requestId ? ` Request ${reason.requestId}.` : ""}`
        : "Sync history is unavailable.");
      return false;
    } finally {
      if (request.current?.controller === controller) request.current = undefined;
      if (!controller.signal.aborted && owner === generation.current) setActivity("idle");
    }
  }, [principalKey, readOwner, readSaved, revision]);

  const startPolling = useCallback((owner: number, manual = false) => {
    const pollingOwner = pollingGeneration.current;
    const poll = async (manual = false) => {
      const progressing = await load(owner, manual);
      if (owner !== generation.current || pollingOwner !== pollingGeneration.current || !progressing) return;
      timer.current = window.setTimeout(() => void poll(), pollIntervalMs);
    };
    return poll(manual);
  }, [load]);

  useEffect(() => {
    const owner = ++generation.current;
    stop();
    void startPolling(owner);
    return () => {
      generation.current += 1;
      stop();
    };
  }, [startPolling, stop]);

  function refresh() {
    if (committed.current !== action || request.current?.manual) return;
    refreshRevision.current += 1;
    stop();
    void startPolling(generation.current, true);
  }

  return <SyncHistoryTable state={state} error={error} loading={activity !== "idle"} refreshing={activity === "refreshing"}
    onOpenSyncRun={onOpenSyncRun} onOpenSourceJob={onOpenSourceJob} onRefresh={refresh} />;
}
