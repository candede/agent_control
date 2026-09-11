import { useEffect, useRef, useState } from "react";
import { getCapabilities, refreshCapability, type CapabilityId, type CapabilityView, type SessionUser } from "./api/client";

export function useCapabilities(user: SessionUser | undefined) {
  const [views, setViews] = useState<CapabilityView[]>([]);
  const [owner, setOwner] = useState<SessionUser>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<CapabilityId>();
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    if (user) {
      void getCapabilities().then(result => {
        if (generation.current === current) { setViews(result.value); setOwner(user); setError(undefined); setPending(undefined); setLoading(false); }
      }).catch(() => {
        if (generation.current === current) { setViews([]); setOwner(user); setPending(undefined); setError("Capability status could not be loaded. Saved data permissions are unchanged."); setLoading(false); }
      });
    }
    return () => { generation.current += 1; };
  }, [user]);

  useEffect(() => {
    const expiry = views.map(view => Date.parse(view.decision.expiresAt ?? "")).filter(value => value > now);
    if (!expiry.length) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(...expiry) - Date.now() + 1));
    return () => window.clearTimeout(timer);
  }, [views, now]);

  async function reload() {
    const current = generation.current;
    setLoading(true);
    try {
      const result = await getCapabilities();
      if (current === generation.current) { setViews(result.value); setOwner(user); setError(undefined); setNow(Date.now()); }
    } catch {
      if (current === generation.current) { setViews([]); setError("Capability status could not be loaded. Saved data permissions are unchanged."); }
    } finally { if (current === generation.current) setLoading(false); }
  }

  async function refresh(id: CapabilityId) {
    const current = generation.current;
    setPending(id);
    try {
      const decision = await refreshCapability(id);
      if (current === generation.current) { setViews(previous => previous.map(view => view.definition.id === id ? { ...view, decision } : view)); setError(undefined); setNow(Date.now()); }
    } catch {
      if (current === generation.current) {
        setViews(previous => previous.map(view => view.definition.id === id ? { ...view, decision: { ...view.decision, authorized: false, fresh: false } } : view));
        setError("Probe refresh failed. Sign in again if authorization expired, or retry after checking setup. Saved data permissions are unchanged.");
      }
    } finally { if (current === generation.current) setPending(undefined); }
  }

  return { views: user && owner === user ? views : [], loading: loading || Boolean(user && owner !== user), error: owner === user ? error : undefined, pending, now, refresh, reload, user };
}