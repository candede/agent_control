import type { ReactNode } from "react";
import { Check, CircleAlert, Clock3, LoaderCircle, Upload } from "lucide-react";
import type { DataSyncSourceState } from "../api/client";
import { syncStatusLabel } from "./syncPresentation";

export function SyncSourceRow({ label, description, statistics, status, statusLabel, statusCaption, stale = false, busy = false, actions, children }: {
  label: string;
  description: string;
  statistics: ReactNode;
  status: DataSyncSourceState;
  statusLabel?: string;
  statusCaption: string;
  stale?: boolean;
  busy?: boolean;
  actions: ReactNode;
  children?: ReactNode;
}) {
  return <article className="data-sync-source" aria-label={label} aria-busy={busy}>
    <div className="data-sync-source-name"><strong>{label}</strong><p>{description}</p></div>
    <dl>{statistics}</dl>
    <div className="data-sync-source-actions">
      <div className="data-sync-source-attempt">
        <span>{statusCaption}</span>
        <SyncSourceBadge status={status} label={statusLabel} stale={stale} />
      </div>
      <div className="data-sync-source-controls">{actions}</div>
    </div>
    {children ? <div className="data-sync-source-note">{children}</div> : null}
  </article>;
}

export function SyncSourceBadge({ status, stale = false, label }: { status: DataSyncSourceState; stale?: boolean; label?: string }) {
  return <span className={`status-badge status-${status.replaceAll("_", "-")}`}>
    {status === "succeeded" ? <Check size={14} aria-hidden="true" />
      : status === "running" ? stale ? <Clock3 size={14} aria-hidden="true" />
        : <LoaderCircle size={14} className="data-sync-spinning" aria-hidden="true" />
        : status === "queued" || status === "not_started" ? <Clock3 size={14} aria-hidden="true" />
          : status === "awaiting_upload" ? <Upload size={14} aria-hidden="true" />
            : <CircleAlert size={14} aria-hidden="true" />}
    {label ?? syncStatusLabel(status)}
  </span>;
}
