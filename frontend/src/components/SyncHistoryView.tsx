import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, getWorkbenchJobs, type SessionUser, type WorkbenchJobsResponse } from "../api/client";
import { useSavedRead } from "../savedQueries";
import { SyncHistoryTable } from "./SyncHistoryTable";

const pollIntervalMs = 2_000;
const syncSources = new Set(["data-sync", "package-refresh", "power-platform"]);
const progressingStatuses = new Set(["queued", "running", "waiting"]);

export function SyncHistoryView({ user, onOpenSyncRun, revision = 0 }: {
  user: SessionUser;
  onOpenSyncRun?: (runId: string) => void;
  revision?: number;
}) {
  const [state, setState] = useState<WorkbenchJobsResponse>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const pollingGeneration = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const refreshRevision = useRef(0);
  const readOwner = useId();
  const readSaved = useSavedRead();
  const principalKey = `${user.tenantId ?? ""}:${user.homeAccountId}:${[...user.roles].sort().join(",")}`;

  const stop = useCallback(() => {
    pollingGeneration.current += 1;
    request.current?.abort();
    request.current = undefined;
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const load = useCallback(async (owner: number) => {
    if (request.current) return false;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
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
      if (controller.signal.aborted || owner !== generation.current || (reason instanceof ApiError && reason.kind === "aborted")) return false;
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) setState(undefined);
      setError(reason instanceof ApiError
        ? `${reason.message}${reason.requestId ? ` Request ${reason.requestId}.` : ""}`
        : "Sync history is unavailable.");
      return false;
    } finally {
      if (request.current === controller) request.current = undefined;
      if (!controller.signal.aborted && owner === generation.current) setLoading(false);
    }
  }, [principalKey, readOwner, readSaved, revision]);

  const startPolling = useCallback((owner: number) => {
    const pollingOwner = pollingGeneration.current;
    const poll = async () => {
      const progressing = await load(owner);
      if (owner !== generation.current || pollingOwner !== pollingGeneration.current || !progressing) return;
      timer.current = window.setTimeout(() => void poll(), pollIntervalMs);
    };
    return poll();
  }, [load]);

  useEffect(() => {
    const owner = ++generation.current;
    stop();
    void startPolling(owner);
    void Promise.resolve().then(() => {
      if (owner !== generation.current) return;
      setState(undefined);
      setError("");
    });
    return () => {
      generation.current += 1;
      stop();
    };
  }, [startPolling, stop]);

  function refresh() {
    refreshRevision.current += 1;
    stop();
    void startPolling(generation.current);
  }

  return <SyncHistoryTable key={principalKey} state={state} error={error} loading={loading}
    onOpenSyncRun={onOpenSyncRun} onRefresh={refresh} />;
}
