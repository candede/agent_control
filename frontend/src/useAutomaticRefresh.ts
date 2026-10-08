import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { ApiError, automaticDataSyncSourceIds, checkAutomaticRefresh, dataSyncFailureStatus, type AutomaticRefreshResult, type DataSyncSourceId } from "./api/client";
import { isPublicationRevisions, type PublicationRevisions } from "../../backend/src/types/dataSelection";

const checkIntervalMs = 60_000;
const maximumBackoffMs = 5 * 60_000;
const requestTimeoutMs = 30_000;
type Phase = "ready" | "checking" | "refreshing" | "backoff" | "sign_in_required" | "permission_required" | "failed";
type Observation = { phase: Phase; message?: string; checkedAt?: string };
type SourceIssue = "sign_in_required" | "permission_required" | "failed";
type Options = {
  principalKey: string;
  authorizationKey: string;
  enabled: boolean;
  onSourcesChanged: (sources: DataSyncSourceId[]) => void;
  onRunsChanged: () => void;
};

function sourceIssueObservation(issues: Map<string, SourceIssue>): Observation | undefined {
  const phases = [...issues.values()];
  if (phases.includes("sign_in_required")) {
    return { phase: "sign_in_required", message: "Some sources require Microsoft authorization. Sign in again to refresh those sources; this does not block other eligible sources." };
  }
  if (phases.includes("permission_required")) {
    return { phase: "permission_required", message: "Some sources need permission. Review Sync and Permissions; saved data remains available." };
  }
  if (phases.includes("failed")) {
    return { phase: "failed", message: "Some automatic refresh work failed. Review Sync for details; saved data remains available." };
  }
}

function resultObservation(result: AutomaticRefreshResult, issues: Map<string, SourceIssue>): Observation {
  for (const source of result.run?.sources ?? []) {
    if (["succeeded", "running", "queued", "cancelled"].includes(source.status)) issues.delete(source.source);
    else if (result.run?.automatic) {
      if (source.status === "waiting_authorization") issues.set(source.source, "sign_in_required");
      else if (source.status === "permission_required") issues.set(source.source, "permission_required");
      else if (source.status === "failed" || source.status === "partial") issues.set(source.source, "failed");
    }
  }
  const details = result.detailJob;
  if (details) {
    if (details.status === "failed" || details.status === "waiting_authorization" && details.errorCode) {
      const failure = dataSyncFailureStatus(details.errorCode ?? "");
      issues.set("details", failure === "waiting_authorization" ? "sign_in_required" : failure);
    } else issues.delete("details");
  }
  return sourceIssueObservation(issues) ?? {
    phase: result.run?.automatic && result.run.status === "running"
      || details && ["running", "waiting_authorization"].includes(details.status) ? "refreshing" : "ready",
  };
}

export function useAutomaticRefresh({
  principalKey,
  authorizationKey,
  enabled,
  onSourcesChanged,
  onRunsChanged,
}: Options) {
  const [pausedOwner, setPausedOwner] = useState<string>();
  const paused = pausedOwner === principalKey;
  const [availability, setAvailability] = useState(() => ({
    visible: document.visibilityState === "visible",
    online: navigator.onLine,
  }));
  const [observation, setObservation] = useState<Observation & { owner: string; authorization: string }>();
  const [checkingRequest, setCheckingRequest] = useState<{ owner: string; authorization: string }>();
  const [publication, setPublication] = useState<{ owner: string; revisions: PublicationRevisions }>();
  const session = useRef<{
    owner: string;
    authorization: string;
    paused: boolean;
    dueAt: number;
    failures: number;
    interaction: boolean;
    denied: boolean;
    sourceIssues: Map<string, SourceIssue>;
    publicationCheckRequested: boolean;
    revisions?: AutomaticRefreshResult["revisions"];
    admitted?: PublicationRevisions;
    compared?: PublicationRevisions;
    jobs?: string;
  } | undefined>(undefined);
  // Retain the transport lock across effect restarts, even if an aborted transport settles late.
  const inFlight = useRef<AbortController | undefined>(undefined);
  const wake = useRef<(() => void) | undefined>(undefined);
  const sourcesChanged = useRef(onSourcesChanged);
  useLayoutEffect(() => { sourcesChanged.current = onSourcesChanged; }, [onSourcesChanged]);
  const observeJobs = useEffectEvent(onRunsChanged);
  const comparePublication = useCallback(() => {
    const current = session.current;
    if (!current || current.owner !== principalKey || !current.revisions || !current.admitted) return;
    const prior = current.compared ?? current.admitted;
    const changed = automaticDataSyncSourceIds.filter(source => prior[source] !== current.revisions![source]);
    // A frozen page keeps its captured vector. Neither its revalidation nor a
    // pending page/ended lease can roll this observer acknowledgement backwards.
    current.compared = current.revisions;
    if (changed.length) sourcesChanged.current(changed);
  }, [principalKey]);
  const admitPublication = useCallback((revisions: PublicationRevisions) => {
    const current = session.current;
    if (current?.owner !== principalKey || !isPublicationRevisions(revisions)) return;
    current.admitted = { ...revisions };
    comparePublication();
  }, [comparePublication, principalKey]);

  useEffect(() => {
    const changed = () => {
      const visible = document.visibilityState === "visible";
      const online = navigator.onLine;
      if (!visible || !online) inFlight.current?.abort();
      setAvailability({ visible, online });
    };
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    return () => {
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
    };
  }, []);

  useEffect(() => {
    if (session.current?.owner !== principalKey) {
      session.current = {
        owner: principalKey, authorization: authorizationKey, paused, dueAt: 0, failures: 0,
        interaction: false, denied: false, sourceIssues: new Map(), publicationCheckRequested: false,
      };
    }
    const current = session.current;
    if (current.authorization !== authorizationKey) {
      current.authorization = authorizationKey;
      current.denied = false;
      current.dueAt = 0;
    }
    let active = true;
    let timer: number | undefined;
    let requestTimeout: number | undefined;
    const admitted = () => active && enabled && !current.paused && !current.interaction && !current.denied
      && document.visibilityState === "visible" && navigator.onLine;
    const publish = (value: Observation) => setObservation({ ...value, owner: principalKey, authorization: authorizationKey });
    if (current.interaction) publish({ phase: "sign_in_required", message: "Sign in again to continue automatic refresh." });

    const backoff = () => {
      current.failures += 1;
      current.dueAt = Date.now() + Math.min(maximumBackoffMs, checkIntervalMs * 2 ** Math.min(current.failures - 1, 4));
      const issue = sourceIssueObservation(current.sourceIssues);
      publish({
        phase: issue?.phase ?? "backoff",
        message: `${issue?.message ? `${issue.message} ` : ""}Automatic refresh could not be checked. The next eligible check will retry after a delay; saved data remains available.`,
      });
    };

    async function check() {
      if (!admitted() || inFlight.current) return;
      if (timer !== undefined) window.clearTimeout(timer);
      if (Date.now() < current.dueAt) {
        timer = window.setTimeout(() => void check(), current.dueAt - Date.now());
        return;
      }
      const controller = new AbortController();
      inFlight.current = controller;
      const request = { owner: principalKey, authorization: authorizationKey };
      setCheckingRequest(request);
      const finishChecking = () => setCheckingRequest(current => current === request ? undefined : current);
      controller.signal.addEventListener("abort", finishChecking, { once: true });
      const timeout = window.setTimeout(() => {
        if (controller.signal.aborted) return;
        controller.abort();
        // Report the deadline without releasing the lock on a transport still settling.
        backoff();
      }, requestTimeoutMs);
      requestTimeout = timeout;
      publish(sourceIssueObservation(current.sourceIssues) ?? { phase: "checking" });
      try {
        const result = await checkAutomaticRefresh({ signal: controller.signal });
        if (!active || controller.signal.aborted) return;
        if (!isPublicationRevisions(result?.revisions)) {
          throw new Error("The server returned invalid automatic refresh status.");
        }
        current.revisions = { ...result.revisions };
        setPublication(previous => previous?.owner === principalKey
          && automaticDataSyncSourceIds.every(source => previous.revisions[source] === result.revisions[source])
          ? previous : { owner: principalKey, revisions: current.revisions! });
        comparePublication();
        const jobs = JSON.stringify([result.run, result.detailJob]);
        if (jobs !== current.jobs && (current.jobs !== undefined || result.run || result.detailJob)) observeJobs();
        current.jobs = jobs;
        current.failures = 0;
        const next = resultObservation(result, current.sourceIssues);
        // A successful due-check is cheap; backend cadence decides when real collection is due.
        const suggested = Date.parse(result.nextCheckAt);
        current.dueAt = Date.now() + Math.max(checkIntervalMs, Math.min(maximumBackoffMs, Number.isFinite(suggested) ? suggested - Date.now() : checkIntervalMs));
        publish({ ...next, checkedAt: new Date().toISOString() });
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        if (cause instanceof ApiError && (cause.status === 401 || ["interaction_required", "authorization_expired"].includes(cause.code))) {
          current.interaction = true;
          publish({ phase: "sign_in_required", message: "Sign in again to continue automatic refresh. Saved data has not been cleared." });
        } else if (cause instanceof ApiError && cause.status === 403) {
          current.denied = true;
          publish({ phase: "permission_required", message: "Automatic refresh access was denied. Review Sync and Permissions." });
        } else {
          backoff();
        }
      } finally {
        controller.signal.removeEventListener("abort", finishChecking);
        finishChecking();
        window.clearTimeout(timeout);
        requestTimeout = undefined;
        if (inFlight.current === controller) inFlight.current = undefined;
        if (current.publicationCheckRequested) {
          current.publicationCheckRequested = false;
          if (!current.failures) current.dueAt = 0;
        }
        // A new account/permission scope may have been waiting for the old request to settle.
        if (!active) wake.current?.();
        else if (admitted()) timer = window.setTimeout(() => void check(), Math.max(0, current.dueAt - Date.now()));
      }
    }

    const requestCheck = () => void check();
    wake.current = requestCheck;
    window.addEventListener("focus", requestCheck);
    // StrictMode can retire this owner before admitting the first transport.
    void Promise.resolve().then(() => check());
    return () => {
      active = false;
      wake.current = undefined;
      window.removeEventListener("focus", requestCheck);
      if (timer !== undefined) window.clearTimeout(timer);
      if (requestTimeout !== undefined) window.clearTimeout(requestTimeout);
      inFlight.current?.abort();
    };
  }, [principalKey, authorizationKey, enabled, paused, availability.visible, availability.online, comparePublication]);

  const status = observation?.owner === principalKey
    && (observation.authorization === authorizationKey || observation.phase === "sign_in_required") ? observation : undefined;
  return {
    admitPublication,
    publicationRevisions: publication?.owner === principalKey ? publication.revisions : undefined,
    checkNow: () => {
      const current = session.current;
      if (current?.owner !== principalKey || current.failures) return;
      current.dueAt = 0;
      if (inFlight.current) {
        current.publicationCheckRequested = true;
        return;
      }
      wake.current?.();
    },
    phase: status?.phase ?? (enabled ? "checking" as const : "ready" as const),
    checking: enabled && !paused && availability.visible && availability.online
      && checkingRequest?.owner === principalKey && checkingRequest.authorization === authorizationKey,
    message: status?.message,
    checkedAt: status?.checkedAt,
    paused,
    enabled,
    ...availability,
    setPaused: (value: boolean) => {
      if (session.current?.owner !== principalKey) return;
      // Fence admission and publication before React commits the pause.
      session.current.paused = value;
      if (value) inFlight.current?.abort();
      setPausedOwner(value ? principalKey : undefined);
    },
  };
}

export type AutomaticRefreshStatus = Omit<ReturnType<typeof useAutomaticRefresh>, "admitPublication" | "publicationRevisions" | "checkNow">;
