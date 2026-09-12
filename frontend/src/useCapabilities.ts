import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, checkCapabilities, getCapabilities, type CapabilityView, type SessionUser } from "./api/client";
import { hasRole } from "./authorization";

const expiryRetryDelayMs = 30_000;

function principalKey(user: SessionUser | undefined) {
  if (!user || !hasRole(user, "AgentControl.Viewer")) return undefined;
  return `${user.tenantId ?? ""}\0${user.homeAccountId}\0${[...user.roles].sort().join(",")}`;
}

function evidenceExpirySignature(views: CapabilityView[]) {
  return views
    .filter(view => view.definition.mode === "delegated" && view.definition.probe.adapterRegistered)
    .map(view => Date.parse(view.decision.expiresAt ?? ""))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
    .join(",");
}

function expiredEvidenceSignature(views: CapabilityView[], now = Date.now()) {
  const signature = evidenceExpirySignature(views);
  if (!signature) return undefined;
  return signature.split(",").some(value => Number(value) <= now) ? signature : undefined;
}

export function useCapabilities(user: SessionUser | undefined) {
  const [views, setViews] = useState<CapabilityView[]>([]);
  const [owner, setOwner] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const request = useRef<{ generation: number; controller: AbortController; promise: Promise<void> } | undefined>(undefined);
  const activeController = useRef<AbortController | undefined>(undefined);
  const attemptedExpiry = useRef<string | undefined>(undefined);
  const expiryRetryCounts = useRef(new Map<string, number>());
  const expiryRetryTimer = useRef<number | undefined>(undefined);
  const key = principalKey(user);

  const runCheck = useCallback((current: number, controller: AbortController, expirySignature?: string, retryFailed = false) => {
    const existing = request.current;
    if (existing?.generation === current) return existing.promise;
    activeController.current = controller;
    setPending(true);
    const promise = checkCapabilities({ signal: controller.signal, retryFailed })
      .then(result => {
        if (generation.current !== current) return;
        setViews(result.value);
        setOwner(key);
        setError(undefined);
        setNow(Date.now());
        expiryRetryCounts.current.clear();
        if (expiryRetryTimer.current !== undefined) window.clearTimeout(expiryRetryTimer.current);
        expiryRetryTimer.current = undefined;
      })
      .catch(cause => {
        if (generation.current !== current || controller.signal.aborted) return;
        const detail = cause instanceof ApiError && cause.code === "invalid_origin" ? ` ${cause.message}` : "";
        setError(`Automatic permission check failed.${detail} Existing decisions and saved-data permissions are unchanged. Use Check status to retry.`);
        setNow(Date.now());
        const retryCount = expirySignature ? expiryRetryCounts.current.get(expirySignature) ?? 0 : 1;
        if (expirySignature && retryCount < 1) {
          expiryRetryCounts.current.set(expirySignature, retryCount + 1);
          expiryRetryTimer.current = window.setTimeout(() => {
            if (generation.current !== current) return;
            attemptedExpiry.current = undefined;
            setNow(Date.now());
          }, expiryRetryDelayMs);
        }
        if (cause instanceof Error && cause.name === "AbortError") return;
      })
      .finally(() => {
        if (generation.current === current) setPending(false);
        if (request.current?.promise === promise) request.current = undefined;
      });
    request.current = { generation: current, controller, promise };
    return promise;
  }, [key]);

  useEffect(() => {
    const current = ++generation.current;
    activeController.current?.abort();
    request.current = undefined;
    attemptedExpiry.current = undefined;
    expiryRetryCounts.current.clear();
    if (expiryRetryTimer.current !== undefined) window.clearTimeout(expiryRetryTimer.current);
    expiryRetryTimer.current = undefined;
    const controller = new AbortController();
    activeController.current = controller;
    if (!key) {
      return () => {
        controller.abort();
        generation.current += 1;
      };
    }
    void getCapabilities({ signal: controller.signal })
      .then(async result => {
        if (generation.current !== current) return;
        setViews(result.value);
        setOwner(key);
        setError(undefined);
        setLoading(false);
        const expiredSignature = expiredEvidenceSignature(result.value);
        attemptedExpiry.current = expiredSignature;
        await runCheck(current, controller, expiredSignature);
      })
      .catch(() => {
        if (generation.current !== current || controller.signal.aborted) return;
        setViews([]);
        setOwner(key);
        setError("Capability status could not be loaded. Saved-data permissions are unchanged.");
        setLoading(false);
      });
    return () => {
      controller.abort();
      if (expiryRetryTimer.current !== undefined) window.clearTimeout(expiryRetryTimer.current);
      generation.current += 1;
    };
  }, [key, runCheck]);

  useEffect(() => {
    if (!key || owner !== key || loading || pending) return;
    const expiries = evidenceExpirySignature(views).split(",").filter(Boolean).map(Number);
    if (!expiries.length) return;
    const signature = expiries.join(",");
    const earliest = expiries[0];
    let timer: number | undefined;
    const checkExpired = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (currentTime <= earliest || document.visibilityState !== "visible" || attemptedExpiry.current === signature) return;
      attemptedExpiry.current = signature;
      const controller = new AbortController();
      void runCheck(generation.current, controller, signature);
    };
    if (earliest > Date.now()) timer = window.setTimeout(checkExpired, earliest - Date.now() + 1);
    else checkExpired();
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
    attemptedExpiry.current = undefined;
    expiryRetryCounts.current.clear();
    if (expiryRetryTimer.current !== undefined) window.clearTimeout(expiryRetryTimer.current);
    expiryRetryTimer.current = undefined;
    const controller = new AbortController();
    activeController.current = controller;
    setLoading(true);
    try {
      const result = await getCapabilities({ signal: controller.signal });
      if (current !== generation.current) return;
      setViews(result.value);
      setOwner(key);
      setError(undefined);
      setNow(Date.now());
      setLoading(false);
      const expiredSignature = expiredEvidenceSignature(result.value);
      attemptedExpiry.current = expiredSignature;
      await runCheck(current, controller, expiredSignature, true);
    } catch {
      if (current === generation.current && !controller.signal.aborted) {
        setError("Capability status could not be loaded. Existing decisions and saved-data permissions are unchanged.");
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