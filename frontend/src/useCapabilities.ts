import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, checkCapabilities, getCapabilities, type CapabilityView, type SessionUser } from "./api/client";
import { hasRole } from "./authorization";
import { useSavedRead } from "./savedQueries";

const expiryRetryDelayMs = 30_000;
const maximumTimerDelayMs = 2_147_483_647;

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
    .map(view => Date.parse(view.decision.expiresAt ?? ""))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
}

function expiredEvidenceSignature(views: CapabilityView[], now = Date.now()) {
  const delegatedViews = views.filter(view => view.definition.mode === "delegated" && view.definition.probe.adapterRegistered);
  return evidenceExpiries(delegatedViews).filter(expiry => expiry <= now).join(",") || undefined;
}

export function useCapabilities(user: SessionUser | undefined, sessionEpoch = 0) {
  const readSaved = useSavedRead();
  const key = principalKey(user, sessionEpoch);
  const [stateKey, setStateKey] = useState(key);
  const [views, setViews] = useState<CapabilityView[]>([]);
  const [owner, setOwner] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const request = useRef<{ generation: number; controller: AbortController; promise: Promise<void> } | undefined>(undefined);
  const activeController = useRef<AbortController | undefined>(undefined);
  const initialCheckRequired = useRef(false);
  const attemptedExpiry = useRef<string | undefined>(undefined);
  const expiryRetryCounts = useRef(new Map<string, number>());
  const expiryRetryTimer = useRef<{ id: number; signature: string; ready: boolean } | undefined>(undefined);

  if (stateKey !== key) {
    setStateKey(key);
    setViews([]);
    setOwner(undefined);
    setLoading(false);
    setPending(false);
    setError(undefined);
  }

  const discardDeniedEvidence = useCallback(() => {
    setViews([]);
    setError("Capability access was denied. Verify the current account and app roles, then use Check status to retry.");
    initialCheckRequired.current = false;
    attemptedExpiry.current = undefined;
    expiryRetryCounts.current.clear();
    if (expiryRetryTimer.current !== undefined) window.clearTimeout(expiryRetryTimer.current.id);
    expiryRetryTimer.current = undefined;
  }, []);

  const runCheck = useCallback((current: number, controller: AbortController, expirySignature?: string, retryFailed = false) => {
    const existing = request.current;
    if (existing?.generation === current) return existing.promise;
    const retry = expiryRetryTimer.current;
    if (retry?.ready) {
      expiryRetryCounts.current.set(retry.signature, 1);
      expiryRetryTimer.current = undefined;
    }
    activeController.current = controller;
    setPending(true);
    const scheduleExpiryRetry = (signature: string | undefined) => {
      if (expiryRetryTimer.current?.signature === signature) return;
      if (expiryRetryTimer.current !== undefined) window.clearTimeout(expiryRetryTimer.current.id);
      expiryRetryTimer.current = undefined;
      if (!signature || (expiryRetryCounts.current.get(signature) ?? 0) >= 1) return;
      expiryRetryTimer.current = {
        signature,
        ready: false,
        id: window.setTimeout(() => {
          if (generation.current !== current || expiryRetryTimer.current?.signature !== signature) return;
          expiryRetryTimer.current.ready = true;
          attemptedExpiry.current = undefined;
          setNow(Date.now());
        }, expiryRetryDelayMs),
      };
    };
    const promise = checkCapabilities({ signal: controller.signal, retryFailed })
      .then(result => {
        if (generation.current !== current) return;
        setViews(result.value);
        setOwner(key);
        setError(undefined);
        const currentTime = Date.now();
        setNow(currentTime);
        const expiredSignature = expiredEvidenceSignature(result.value, currentTime);
        scheduleExpiryRetry(expiredSignature);
        if (expiredSignature) {
          // A successful response can reuse evidence the browser already considers expired.
          attemptedExpiry.current = expiryRetryTimer.current?.ready ? undefined : expiredSignature;
        } else {
          attemptedExpiry.current = undefined;
          expiryRetryCounts.current.clear();
        }
      })
      .catch(cause => {
        if (generation.current !== current || controller.signal.aborted
          || cause instanceof ApiError && cause.kind === "aborted"
          || cause instanceof Error && cause.name === "AbortError") return;
        if (accessDenied(cause)) {
          discardDeniedEvidence();
          return;
        }
        const detail = cause instanceof ApiError && cause.code === "invalid_origin" ? ` ${cause.message}` : "";
        setError(`Automatic permission check failed.${detail} Existing decisions and saved-data permissions are unchanged. Use Check status to retry.`);
        setNow(Date.now());
        scheduleExpiryRetry(expirySignature);
      })
      .finally(() => {
        if (generation.current === current) setPending(false);
        if (request.current?.promise === promise) request.current = undefined;
      });
    request.current = { generation: current, controller, promise };
    return promise;
  }, [discardDeniedEvidence, key]);

  useEffect(() => {
    const current = ++generation.current;
    activeController.current?.abort();
    request.current = undefined;
    initialCheckRequired.current = false;
    attemptedExpiry.current = undefined;
    expiryRetryCounts.current.clear();
    if (expiryRetryTimer.current !== undefined) window.clearTimeout(expiryRetryTimer.current.id);
    expiryRetryTimer.current = undefined;
    const controller = new AbortController();
    activeController.current = controller;
    if (!key) {
      return () => {
        controller.abort();
        generation.current += 1;
      };
    }
    void readSaved(["capabilities", key], signal => getCapabilities({ signal }), controller.signal)
      .then(result => {
        if (generation.current !== current) return;
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
        else setError("Capability status could not be loaded. Saved-data permissions are unchanged.");
        setLoading(false);
        setPending(false);
      });
    return () => {
      controller.abort();
      activeController.current?.abort();
      if (expiryRetryTimer.current !== undefined) window.clearTimeout(expiryRetryTimer.current.id);
      expiryRetryTimer.current = undefined;
      generation.current += 1;
    };
  }, [discardDeniedEvidence, key, readSaved]);

  useEffect(() => {
    if (!key || owner !== key) return;
    const expiries = evidenceExpiries(views);
    if (!expiries.length && !initialCheckRequired.current) return;
    let timer: number | undefined;
    const checkExpired = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      const signature = expiredEvidenceSignature(views, currentTime);
      if (loading || pending || document.visibilityState !== "visible") return;
      if (!initialCheckRequired.current && (!signature || attemptedExpiry.current === signature)) return;
      initialCheckRequired.current = false;
      attemptedExpiry.current = signature;
      const controller = new AbortController();
      void runCheck(generation.current, controller, signature);
    };
    const currentTime = Date.now();
    const nextExpiry = expiries.find(expiry => expiry > currentTime);
    if (nextExpiry !== undefined) timer = window.setTimeout(checkExpired, Math.min(nextExpiry - currentTime + 1, maximumTimerDelayMs));
    const expiredSignature = expiredEvidenceSignature(views, currentTime);
    if (!loading && !pending && document.visibilityState === "visible" && (initialCheckRequired.current
      || expiredSignature && attemptedExpiry.current !== expiredSignature)) checkExpired();
    document.addEventListener("visibilitychange", checkExpired);
    window.addEventListener("focus", checkExpired);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", checkExpired);
      window.removeEventListener("focus", checkExpired);
    };
  }, [key, loading, now, owner, pending, runCheck, views]);

  async function reload() {
    if (!key) return;
    const current = ++generation.current;
    activeController.current?.abort();
    request.current = undefined;
    initialCheckRequired.current = false;
    attemptedExpiry.current = undefined;
    expiryRetryCounts.current.clear();
    if (expiryRetryTimer.current !== undefined) window.clearTimeout(expiryRetryTimer.current.id);
    expiryRetryTimer.current = undefined;
    const controller = new AbortController();
    activeController.current = controller;
    setLoading(true);
    setPending(false);
    try {
      const result = await readSaved(["capabilities", key, current],
        signal => getCapabilities({ signal }), controller.signal);
      if (current !== generation.current) return;
      setViews(result.value);
      setOwner(key);
      setError(undefined);
      setNow(Date.now());
      setLoading(false);
      const expiredSignature = expiredEvidenceSignature(result.value);
      attemptedExpiry.current = expiredSignature;
      await runCheck(current, controller, expiredSignature, true);
    } catch (cause) {
      if (current === generation.current && !controller.signal.aborted) {
        setOwner(key);
        if (accessDenied(cause)) discardDeniedEvidence();
        else setError("Capability status could not be loaded. Existing decisions and saved-data permissions are unchanged.");
      }
    } finally { if (current === generation.current) setLoading(false); }
  }

  return {
    views: key && owner === key ? views : [],
    loading: Boolean(key) && (loading || owner !== key),
    error: !key || owner === key ? error : undefined,
    pending: Boolean(key && owner === key && pending),
    now,
    reload,
    user,
  };
}