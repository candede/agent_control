import { useEffect, useState } from "react";
import type { PackageDetailFreshness } from "../api/client";

export function PackageDetailFreshnessStatus({ freshness, now }: {
  freshness?: PackageDetailFreshness;
  now?: number;
}) {
  const [clock, setClock] = useState(Date.now);
  const expires = Date.parse(freshness?.expiresAt ?? "");
  useEffect(() => {
    if (now !== undefined || freshness?.state !== "fresh" || !Number.isFinite(expires) || clock >= expires) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, Math.min(2_147_483_647, expires - Date.now())));
    return () => window.clearTimeout(timer);
  }, [now, freshness?.state, expires, clock]);
  if (!freshness) return null;
  const state = freshness.state === "fresh" && !(expires > (now ?? clock)) ? "stale" : freshness.state;
  const label = { fresh: "Fresh", stale: "Stale", missing: "Not collected", invalidated: "Refresh required after inventory change" }[state];
  return <aside className="agent-insight-note" aria-label="Package detail freshness">
    <strong>Package details · {label}</strong>
    <p>Details collected: <FreshnessTime value={freshness.observedAt} fallback="Not yet collected" />.
      {" "}Details expire: <FreshnessTime value={freshness.expiresAt} fallback="Unknown" />.</p>
    <p>Package details refresh hourly, independently of the 15-minute inventory refresh.
      {state !== "fresh" ? <> Saved details may be incomplete or out of date. Review <a href="/sync">Sync</a> for refresh status.</> : null}</p>
  </aside>;
}

function FreshnessTime({ value, fallback }: { value: string | null; fallback: string }) {
  if (!value || !Number.isFinite(Date.parse(value))) return fallback;
  return <time dateTime={value}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))}</time>;
}
