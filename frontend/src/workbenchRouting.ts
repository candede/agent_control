import { parseUnifiedAgentRecordId, unifiedAgentRecordId, unifiedAgentSortKeys, unifiedAgentViews, type UnifiedAgentSort, type UnifiedAgentView } from "../../backend/src/types/unifiedAgents";
import { isDirectoryObjectId } from "../../backend/src/types/copilotPackage";

export const workbenchViewIds = [
  "agents",
  "users",
  "sync",
  "audit",
  "permissions",
  "jobs",
] as const;

export type WorkbenchViewId = (typeof workbenchViewIds)[number];

export type AgentRouteState = {
  agentView: UnifiedAgentView;
  search: string;
  status: "all" | "allowed" | "blocked";
  publisher: string;
  availability: string;
  host: string;
  platform: string;
  createdWithinDays: string;
  sortBy: UnifiedAgentSort;
  sortDirection: "asc" | "desc";
  page: number;
  detailId?: string;
  detailTab?: string;
  selectedIds: string[];
  selectionStorage?: "session";
  selectionCount?: number;
  refreshJobId?: string;
  refreshMode: "delegated" | "application";
  controlJobId?: string;
  syncRunId?: string;
  source: "all" | "graph_packages" | "power_platform" | "both";
  linkState: "all" | "matched" | "unmatched" | "ambiguous" | "conflicting";
  environmentId: string;
  inventorySnapshotId?: string;
  selectedPowerPlatformIds: string[];
  quarantineJobId?: string;
};

export type AuditRouteState = {
  search: string;
  action: string;
  status: string;
  page: number;
};

export type SyncReportRouteState = {
  view: "import" | "manage" | "snapshot";
  stagingId?: string;
  reportSetId?: string;
  activityWindowDays: number;
};

export type UsersRouteState = {
  view: "licenses" | "activity" | "responsibility";
  personId?: string;
  search: string;
  agentId?: string;
  reportSetId?: string;
  page: number;
};

export type DataSyncRouteState = {
  powerPlatformJobId?: string;
  syncRunId?: string;
  refreshJobId?: string;
  refreshMode: "delegated" | "application";
  reports?: SyncReportRouteState;
};

export const maximumPackageSelection = 5_000;
export const maximumInlinePackageRouteBytes = 4_096;

const viewPaths: Record<WorkbenchViewId, string> = {
  agents: "/agents",
  users: "/users",
  sync: "/sync",
  audit: "/audit",
  permissions: "/permissions",
  jobs: "/jobs",
};

const viewsByPath = new Map(
  Object.entries(viewPaths).map(([view, path]) => [path, view as WorkbenchViewId]),
);

export function parseWorkbenchView(pathname: string): WorkbenchViewId {
  if (normalizePath(pathname) === "/official-usage") return "sync";
  return viewsByPath.get(normalizePath(pathname)) ?? "agents";
}

export function isWorkbenchPath(pathname: string) {
  const path = normalizePath(pathname);
  return path === "/" || path === "/official-usage" || path === "/security" || viewsByPath.has(path);
}

export function migrateSecurityRoute(pathname: string): string | undefined {
  return normalizePath(pathname) === "/security" ? "/agents" : undefined;
}

export function workbenchUrl(
  view: WorkbenchViewId,
  search: URLSearchParams = new URLSearchParams(),
) {
  const query = search.toString();
  return `${viewPaths[view]}${query ? `?${query}` : ""}`;
}

export function parseDataSyncRoute(search: string): DataSyncRouteState {
  const params = new URLSearchParams(search);
  return {
    powerPlatformJobId: bounded(params.get("powerPlatformJob"), 512),
    syncRunId: bounded(params.get("syncRun"), 512),
    refreshJobId: bounded(params.get("refreshJob"), 512),
    refreshMode: params.get("mode") === "application" ? "application" : "delegated",
    reports: parseSyncReportRoute(search),
  };
}

export function dataSyncRouteSearch(state: DataSyncRouteState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.powerPlatformJobId && validSelectedId(state.powerPlatformJobId)) params.set("powerPlatformJob", state.powerPlatformJobId);
  if (state.syncRunId && validSelectedId(state.syncRunId)) params.set("syncRun", state.syncRunId);
  if (state.refreshJobId && validSelectedId(state.refreshJobId)) {
    params.set("refreshJob", state.refreshJobId);
    if (state.refreshMode === "application") params.set("mode", state.refreshMode);
  }
  if (state.reports) {
    params.set("reports", state.reports.view);
    if (state.reports.view === "import" && state.reports.stagingId && validSelectedId(state.reports.stagingId)) {
      params.set("staging", state.reports.stagingId);
    }
    if (state.reports.view === "snapshot") {
      if (state.reports.reportSetId && validSelectedId(state.reports.reportSetId)) params.set("snapshot", state.reports.reportSetId);
      const defaultDays = state.reports.reportSetId ? 365 : 30;
      if (state.reports.activityWindowDays !== defaultDays) {
        params.set("window", String(Math.min(365, Math.max(1, state.reports.activityWindowDays))));
      }
    }
  }
  return params;
}

export function parseAgentRoute(search: string): AgentRouteState {
  const params = new URLSearchParams(search);
  const query = (params.get("q") ?? "").slice(0, 256);
  const status = params.get("status");
  const sortBy = params.get("sort");
  const selectedIds = [...new Set(params.getAll("selected").filter(validSelectedId))].slice(0, maximumPackageSelection);
  const selectionCount = boundedSelectionCount(params.get("selectionCount"));
  const selectionStored = params.get("selectionState") === "session" && selectionCount !== undefined;
  const environmentId = bounded(params.get("environment"), 512) ?? "";
  const rawDetailId = agentRecordId(params.get("detail"));
  const detailId = rawDetailId && !parseUnifiedAgentRecordId(rawDetailId) && params.get("source") === "power_platform" && environmentId
    ? unifiedAgentRecordId({ source: "power_platform", environmentId, nativeId: rawDetailId })
    : rawDetailId;
  return {
    agentView: unifiedAgentViews.find(value => value === params.get("show")) ?? "all",
    search: query,
    status: status === "allowed" || status === "blocked" ? status : "all",
    publisher: bounded(params.get("publisher"), 256) ?? "all",
    availability: bounded(params.get("availability"), 128) ?? "all",
    host: bounded(params.get("host"), 256) ?? "all",
    platform: bounded(params.get("platform"), 256) ?? "all",
    createdWithinDays: boundedIntegerText(params.get("createdWithinDays"), 3650),
    sortBy: unifiedAgentSortKeys.find(value => value === sortBy) ?? "displayName",
    sortDirection: params.get("direction") === "desc" ? "desc" : "asc",
    page: boundedPage(params.get("page")),
    detailId,
    detailTab: bounded(params.get("detailTab"), 64),
    selectedIds,
    ...(selectionStored ? { selectionStorage: "session" as const, selectionCount } : {}),
    refreshJobId: bounded(params.get("refreshJob"), 512),
    refreshMode: params.get("mode") === "application" ? "application" : "delegated",
    controlJobId: bounded(params.get("controlJob"), 512),
    syncRunId: bounded(params.get("syncRun"), 512),
    source: "all",
    linkState: "all",
    environmentId,
    inventorySnapshotId: bounded(params.get("inventorySnapshot"), 64),
    selectedPowerPlatformIds: [...new Set(params.getAll("selectedResource").filter(value => agentRecordId(value) !== undefined))].slice(0, 25),
    quarantineJobId: bounded(params.get("quarantineJob"), 512),
  };
}

export function agentRouteSearch(state: AgentRouteState) {
  const params = new URLSearchParams();
  if (state.agentView !== "all") params.set("show", state.agentView);
  if (state.search.trim()) params.set("q", state.search.trim().slice(0, 256));
  if (state.status !== "all") params.set("status", state.status);
  if (state.publisher !== "all") params.set("publisher", state.publisher);
  if (state.availability !== "all") params.set("availability", state.availability);
  if (state.host !== "all") params.set("host", state.host);
  if (state.platform !== "all") params.set("platform", state.platform);
  if (state.createdWithinDays) params.set("createdWithinDays", state.createdWithinDays);
  if (state.sortBy !== "displayName") params.set("sort", state.sortBy);
  if (state.sortDirection !== "asc") params.set("direction", state.sortDirection);
  if (state.page > 0) params.set("page", String(state.page + 1));
  if (state.detailId && agentRecordId(state.detailId)) params.set("detail", state.detailId);
  if (state.detailId && state.detailTab && state.detailTab !== "identities") params.set("detailTab", state.detailTab.slice(0, 64));
  if (state.refreshJobId && validSelectedId(state.refreshJobId)) {
    params.set("refreshJob", state.refreshJobId);
    if (state.refreshMode === "application") params.set("mode", "application");
  }
  if (state.controlJobId && validSelectedId(state.controlJobId)) params.set("controlJob", state.controlJobId);
  if (state.syncRunId && validSelectedId(state.syncRunId)) params.set("syncRun", state.syncRunId);
  if (state.environmentId.trim()) params.set("environment", state.environmentId.trim().slice(0, 512));
  if (state.inventorySnapshotId) params.set("inventorySnapshot", state.inventorySnapshotId);
  for (const id of [...new Set(state.selectedPowerPlatformIds.filter(value => agentRecordId(value) !== undefined))].slice(0, 25)) params.append("selectedResource", id);
  if (state.quarantineJobId && validSelectedId(state.quarantineJobId)) params.set("quarantineJob", state.quarantineJobId);
  const selectedIds = [...new Set(state.selectedIds.filter(validSelectedId))].slice(0, maximumPackageSelection);
  for (const id of selectedIds) {
    params.append("selected", id);
    if (params.toString().length > maximumInlinePackageRouteBytes) {
      params.delete("selected");
      params.set("selectionState", "session");
      params.set("selectionCount", String(selectedIds.length));
      break;
    }
  }
  return params;
}

const localAuditActions = new Set([
  "block", "unblock", "update-availability", "update-installation", "reassign",
  "view-audit-search", "export-audit-search", "view-hunting", "export-hunting",
  "approve-hunting", "qualify-hunting", "submit-hunting", "query-hunting", "cancel-hunting", "delete-hunting", "revoke-hunting-scope",
  "export-package-inventory", "export-power-platform-inventory", "export-agent-inventory",
  "export-official-usage-aggregate", "export-official-usage-users", "export-administrative-audit",
  "associate-agent-usage", "remove-agent-usage-association",
]);
const localAuditStatuses = new Set([
  "requested", "started", "succeeded", "failed", "skipped", "inconclusive", "cancelled",
]);

export function parseAuditRoute(search: string): AuditRouteState {
  const params = new URLSearchParams(search);
  const action = bounded(params.get("action"), 64);
  const status = bounded(params.get("status"), 64);
  return {
    search: bounded(params.get("q"), 256) ?? "",
    action: action && localAuditActions.has(action) ? action : "all",
    status: status && localAuditStatuses.has(status) ? status : "all",
    page: boundedPage(params.get("page")),
  };
}

export function auditRouteSearch(state: AuditRouteState) {
  const params = new URLSearchParams();
  if (state.search.trim()) params.set("q", state.search.trim().slice(0, 256));
  if (state.action !== "all" && localAuditActions.has(state.action)) params.set("action", state.action);
  if (state.status !== "all" && localAuditStatuses.has(state.status)) params.set("status", state.status);
  if (state.page > 0) params.set("page", String(state.page + 1));
  return params;
}

export function parseSyncReportRoute(search: string): SyncReportRouteState | undefined {
  const params = new URLSearchParams(search);
  const view = params.get("reports");
  if (view !== "import" && view !== "manage" && view !== "snapshot") return undefined;
  const reportSetId = bounded(params.get("snapshot"), 512);
  const activityWindowDays = Number(params.get("window"));
  return {
    view,
    stagingId: view === "import" ? bounded(params.get("staging"), 512) : undefined,
    reportSetId: view === "snapshot" ? reportSetId : undefined,
    activityWindowDays: view !== "snapshot" ? 30 : Number.isSafeInteger(activityWindowDays) && activityWindowDays >= 1 && activityWindowDays <= 365
      ? activityWindowDays
      : reportSetId ? 365 : 30,
  };
}

export function migrateOfficialUsageRoute(pathname: string, search: string): URLSearchParams | undefined {
  if (normalizePath(pathname) !== "/official-usage") return undefined;
  const params = new URLSearchParams(search);
  const stagingId = bounded(params.get("staging"), 512);
  const reportSetId = bounded(params.get("snapshot"), 512);
  const window = Number(params.get("window"));
  const validWindow = Number.isSafeInteger(window) && window >= 1 && window <= 365;
  const view = stagingId ? "import"
    : params.get("view") === "history" ? "manage"
    : params.get("view") === "snapshot" || reportSetId || validWindow ? "snapshot" : "manage";
  return dataSyncRouteSearch({
    refreshMode: "delegated",
    reports: { view, stagingId, reportSetId, activityWindowDays: validWindow ? window : reportSetId ? 365 : 30 },
  });
}

export function parseUsersRoute(search: string): UsersRouteState {
  const params = new URLSearchParams(search);
  return {
    view: params.get("view") === "responsibility" ? "responsibility"
      : params.get("view") === "activity" || params.get("view") === "matrix" ? "activity" : "licenses",
    ...(params.get("view") === "responsibility" && params.has("person")
      ? { personId: bounded(params.get("person"), 128) || "invalid" } : {}),
    search: bounded(params.get("q"), 256) ?? "",
    agentId: bounded(params.get("agent"), 512),
    reportSetId: bounded(params.get("snapshot"), 512),
    page: boundedPage(params.get("page")),
  };
}

export function usersRouteSearch(state: UsersRouteState) {
  const params = new URLSearchParams();
  if (state.view === "licenses") return params;
  params.set("view", state.view);
  if (state.view === "responsibility") {
    if (state.personId) params.set("person", isDirectoryObjectId(state.personId) ? state.personId.toLowerCase() : "invalid");
    if (state.search.trim()) params.set("q", state.search.trim().slice(0, 256));
    if (state.page > 0) params.set("page", String(Math.min(601, state.page + 1)));
    return params;
  }
  if (state.search.trim()) params.set("q", state.search.trim().slice(0, 256));
  if (state.agentId && validSelectedId(state.agentId)) params.set("agent", state.agentId);
  if (state.reportSetId && validSelectedId(state.reportSetId)) params.set("snapshot", state.reportSetId);
  if (state.page > 0) params.set("page", String(Math.min(2_001, state.page + 1)));
  return params;
}

function normalizePath(pathname: string) {
  if (pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

function validSelectedId(value: string) {
  return value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
}

function agentRecordId(value: string | null): string | undefined {
  if (!value || value.length > 10000) return undefined;
  try {
    return parseUnifiedAgentRecordId(value) || validSelectedId(value) ? value : undefined;
  } catch (error) {
    if (error instanceof URIError || error instanceof RangeError) return undefined;
    throw error;
  }
}

function boundedSelectionCount(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 && parsed <= maximumPackageSelection ? parsed : undefined;
}

function bounded(value: string | null, maximum: number) {
  return value && value.length <= maximum && !/[\0\r\n]/.test(value) ? value : undefined;
}

function boundedPage(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return 0;
  const oneBased = Number(value);
  return Number.isSafeInteger(oneBased) && oneBased >= 1 && oneBased <= 2_001 ? oneBased - 1 : 0;
}

function boundedIntegerText(value: string | null, maximum: number) {
  if (!value || !/^\d+$/.test(value)) return "";
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum ? value : "";
}
