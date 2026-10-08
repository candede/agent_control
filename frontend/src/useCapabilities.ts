import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, captureRequestSession, checkCapabilities, getCapabilities, type CapabilityView, type SessionUser } from "./api/client";
import { hasRole } from "./authorization";
import { useSavedRead } from "./savedQueries";
import { isTransientPermissionCheck } from "./permissionIssues";

const transportRetryDelayMs = 1_000;
const maximumTimerDelayMs = 2_147_483_647;

function transientTransportFailure(cause: unknown) {
  return cause instanceof ApiError && (cause.kind === "network" || [408, 500, 502, 503, 504].includes(cause.status));
}

function cancelledRequest(cause: unknown) {
  return cause instanceof ApiError && cause.kind === "aborted"
    || cause instanceof Error && cause.name === "AbortError";
}

function currentRequestSession(assertCurrentSession: () => void) {
  try {
    assertCurrentSession();
    return true;
  } catch (cause) {
    if (cancelledRequest(cause)) return false;
    throw cause;
  }
}

export async function retryPermissionRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const assertCurrentSession = captureRequestSession();
  try {
    return await read();
  } catch (cause) {
    if (signal.aborted || !transientTransportFailure(cause)) throw cause;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        window.clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(new ApiError(0, "request_aborted", "The request was cancelled.", { kind: "aborted" }));
      };
      const timer = window.setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, transportRetryDelayMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    if (signal.aborted) throw new ApiError(0, "request_aborted", "The request was cancelled.", { kind: "aborted" });
    assertCurrentSession();
    return read();
  }
}

function principalKey(user: SessionUser | undefined, sessionEpoch: number) {
  if (!user || !hasRole(user, "AgentControl.Viewer")) return undefined;
  return JSON.stringify([user.tenantId ?? "", user.homeAccountId, [...user.roles].sort(), sessionEpoch]);
}

function accessDenied(cause: unknown) {
  return cause instanceof ApiError && (cause.status === 401 || cause.status === 403)
    && cause.code !== "invalid_origin" && cause.code !== "invalid_csrf";
}

function evidenceExpiries(views: CapabilityView[]) {
  return views
    .filter(view => view.definition.mode !== "local")
    .flatMap(view => [view.decision.expiresAt, view.operationFailure?.expiresAt])
    .map(expiry => Date.parse(expiry ?? ""))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
}

export function useCapabilities(user: SessionUser | undefined, sessionEpoch = 0) {
  const readSaved = useSavedRead();
  const key = principalKey(user, sessionEpoch);
  const [scope, setScope] = useState(() => ({ key, assertCurrentSession: captureRequestSession() }));
  const activeScope = useRef<typeof scope | undefined>(undefined);
  const [views, setViews] = useState<CapabilityView[]>([]);
  const [owner, setOwner] = useState<string>();
  const [checkedOwner, setCheckedOwner] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [activeCheck, setActiveCheck] = useState<{ id: number; retryFailed: boolean }>();
  const checkSequence = useRef(0);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const request = useRef<{ generation: number; controller: AbortController; promise: Promise<void> } | undefined>(undefined);
  const reloadRequest = useRef<{ generation: number; promise: Promise<void> } | undefined>(undefined);
  const activeController = useRef<AbortController | undefined>(undefined);
  const initialCheckRequired = useRef(false);

  if (scope.key !== key) {
    setScope({ key, assertCurrentSession: captureRequestSession() });
    setViews([]);
    setOwner(undefined);
    setCheckedOwner(undefined);
    setLoading(false);
    setPending(false);
    setActiveCheck(undefined);
    setError(undefined);
  }

  const discardDeniedEvidence = useCallback(() => {
    setViews([]);
    setError("Permission checks were denied. Sign in again or ask your administrator to check your app role.");
    initialCheckRequired.current = false;
  }, []);

  const readCatalog = useCallback((signal: AbortSignal) => retryPermissionRead(() => {
    scope.assertCurrentSession();
    return getCapabilities({ signal });
  }, signal), [scope]);

  const runCheck = useCallback((current: number, controller: AbortController, retryFailed = false) => {
    if (!currentRequestSession(scope.assertCurrentSession)) return Promise.resolve();
    const existing = request.current;
    if (existing?.generation === current) return existing.promise;
    activeController.current = controller;
    setPending(true);
    setActiveCheck({ id: ++checkSequence.current, retryFailed });
    const promise = retryPermissionRead(() => checkCapabilities({ signal: controller.signal, retryFailed }), controller.signal)
      .then(result => {
        if (generation.current !== current) return;
        scope.assertCurrentSession();
        setViews(result.value);
        setOwner(key);
        setCheckedOwner(key);
        setError(undefined);
        setNow(Date.now());
      })
      .catch(cause => {
        if (generation.current !== current || controller.signal.aborted || cancelledRequest(cause)) return;
        // A genuine denial may itself invalidate the request session; still withdraw its evidence.
        if (accessDenied(cause)) {
          discardDeniedEvidence();
          return;
        }
        if (!currentRequestSession(scope.assertCurrentSession)) return;
        const detail = cause instanceof ApiError && cause.code === "invalid_origin" ? ` ${cause.message}` : "";
        setError(`Permission checks failed${transientTransportFailure(cause) ? " after retrying" : ""}.${detail} Use Check status to retry.`);
        setNow(Date.now());
      })
      .finally(() => {
        if (generation.current === current) setPending(false);
        if (request.current?.promise === promise) request.current = undefined;
      });
    request.current = { generation: current, controller, promise };
    return promise;
  }, [discardDeniedEvidence, key, scope]);

  useEffect(() => {
    const current = ++generation.current;
    activeScope.current = scope;
    activeController.current?.abort();
    request.current = undefined;
    reloadRequest.current = undefined;
    initialCheckRequired.current = false;
    const controller = new AbortController();
    activeController.current = controller;
    if (!key) {
      return () => {
        activeScope.current = undefined;
        controller.abort();
        generation.current += 1;
      };
    }
    void readSaved(["capabilities", key], readCatalog, controller.signal)
      .then(result => {
        if (generation.current !== current) return;
        scope.assertCurrentSession();
        initialCheckRequired.current = true;
        setViews(result.value);
        setOwner(key);
        setError(undefined);
        setLoading(false);
        setNow(Date.now());
      })
      .catch(cause => {
        if (generation.current !== current || controller.signal.aborted) return;
        setViews([]);
        setOwner(key);
        if (accessDenied(cause)) discardDeniedEvidence();
        else if (cancelledRequest(cause) || !currentRequestSession(scope.assertCurrentSession)) setError(undefined);
        else setError("Permission checks could not be loaded. Use Check status to retry.");
        setLoading(false);
        setPending(false);
      });
    return () => {
      activeScope.current = undefined;
      controller.abort();
      activeController.current?.abort();
      generation.current += 1;
    };
  }, [discardDeniedEvidence, key, readCatalog, readSaved, scope]);

  useEffect(() => {
    if (!key || owner !== key) return;
    const expiries = evidenceExpiries(views);
    if (!expiries.length && !initialCheckRequired.current) return;
    let timer: number | undefined;
    const updateDiagnostics = () => {
      setNow(Date.now());
      if (loading || pending || document.visibilityState !== "visible") return;
      if (!initialCheckRequired.current) return;
      initialCheckRequired.current = false;
      const controller = new AbortController();
      void runCheck(generation.current, controller, views.some(view => isTransientPermissionCheck(view)));
    };
    const currentTime = Date.now();
    // A deadline crossed during commit still needs to advance the displayed clock.
    const nextExpiry = expiries.find(expiry => expiry > now);
    if (nextExpiry !== undefined) timer = window.setTimeout(updateDiagnostics, Math.min(Math.max(nextExpiry - currentTime + 1, 0), maximumTimerDelayMs));
    if (!loading && !pending && document.visibilityState === "visible" && initialCheckRequired.current) updateDiagnostics();
    document.addEventListener("visibilitychange", updateDiagnostics);
    window.addEventListener("focus", updateDiagnostics);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", updateDiagnostics);
      window.removeEventListener("focus", updateDiagnostics);
    };
  }, [key, loading, now, owner, pending, runCheck, views]);

  const reload = useCallback(() => {
    if (!key || activeScope.current !== scope) return Promise.resolve();
    if (!currentRequestSession(scope.assertCurrentSession)) return Promise.resolve();
    const existing = reloadRequest.current;
    if (existing?.generation === generation.current) return existing.promise;
    const current = ++generation.current;
    activeController.current?.abort();
    request.current = undefined;
    initialCheckRequired.current = false;
    const controller = new AbortController();
    activeController.current = controller;
    setLoading(true);
    setPending(false);
    setError(undefined);
    const promise = readSaved(["capabilities", key, current], readCatalog, controller.signal)
      .then(async result => {
        if (current !== generation.current) return;
        scope.assertCurrentSession();
        setViews(result.value);
        setOwner(key);
        setError(undefined);
        setNow(Date.now());
        setLoading(false);
        await runCheck(current, controller, true);
      })
      .catch(cause => {
        if (current === generation.current && !controller.signal.aborted) {
          setOwner(key);
          if (accessDenied(cause)) discardDeniedEvidence();
          else if (cancelledRequest(cause) || !currentRequestSession(scope.assertCurrentSession)) setError(undefined);
          else setError("Permission checks could not be loaded. Use Check status to retry.");
        }
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
        if (reloadRequest.current?.promise === promise) reloadRequest.current = undefined;
      });
    reloadRequest.current = { generation: current, promise };
    return promise;
  }, [discardDeniedEvidence, key, readCatalog, readSaved, runCheck, scope]);

  return {
    views: key && owner === key ? views : [],
    loading: Boolean(key) && (loading || owner !== key),
    error: !key || owner === key ? error : undefined,
    pending: Boolean(key && owner === key && pending),
    ...(key && owner === key && pending && activeCheck ? { activeCheck } : {}),
    ...(key && checkedOwner !== key ? { awaitingInitialCheck: true } : {}),
    now,
    reload,
    user,
  };
}