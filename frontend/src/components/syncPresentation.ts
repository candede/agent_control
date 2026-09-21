import { automaticDataSyncSourceIds, type DataSyncMode, type DataSyncSourceId, type DataSyncSourceState } from "../api/client";

export const automaticSyncSources = automaticDataSyncSourceIds;

export const syncSourceDetails: Record<DataSyncSourceId, {
  label: string;
  description: string;
  unit: string;
}> = {
  users: {
    label: "Users",
    description: "Paid M365 Copilot license assignments, app activity, and referenced agent people; count is paid-license users, not tenant headcount",
    unit: "paid M365 Copilot license users",
  },
  graph_packages: {
    label: "Graph packages",
    description: "Published agents and their matching identities",
    unit: "packages",
  },
  power_platform: {
    label: "Power Platform",
    description: "Environments, agents, apps, and flows",
    unit: "resources",
  },
  usage_reports: {
    label: "CSV usage reports",
    description: "Manually imported Microsoft 365 report snapshots",
    unit: "report rows",
  },
};

export function syncStatusLabel(status: DataSyncSourceState | string) {
  if (status === "succeeded" || status === "completed") return "Complete";
  if (status === "running") return "Syncing";
  if (status === "not_started") return "Not synced";
  if (status === "queued") return "Queued";
  if (status === "failed") return "Failed";
  if (status === "partial") return "Incomplete";
  if (status === "cancelled") return "Cancelled";
  if (status === "awaiting_upload") return "Import needed";
  if (status === "permission_required") return "Permission required";
  if (status === "waiting_authorization") return "Sign-in required";
  if (status === "waiting") return "Action required";
  return status.replaceAll("_", " ");
}

export function syncModeLabel(mode: DataSyncMode) {
  return mode === "full" ? "Full resync" : mode === "initial" ? "Initial sync" : "Data refresh";
}

export function formatSyncInstant(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function syncDuration(start: string, end: string) {
  const seconds = Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
