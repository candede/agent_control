export const workbenchViewIds = [
  "agents",
  "power-platform",
  "users",
  "official-usage",
  "audit",
  "security",
  "permissions",
  "jobs",
] as const;

export type WorkbenchViewId = (typeof workbenchViewIds)[number];

export type AgentRouteState = {
  search: string;
  status: "all" | "allowed" | "blocked";
  publisher: string;
  availability: string;
  host: string;
  platform: string;
  createdWithinDays: string;
  sortBy: "displayName" | "publisher" | "lastModifiedAt";
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
};

export type PowerPlatformRouteState = {
  search: string;
  type: string;
  environmentId: string;
  sortBy: "displayName" | "type" | "environmentId" | "createdAt" | "lastPublishedAt";
  sortDirection: "asc" | "desc";
  page: number;
  snapshotId: string;
  detailId?: string;
  detailType?: string;
  detailEnvironmentId?: string;
  detailTab?: string;
  selectedIds: string[];
  refreshJobId?: string;
  quarantineJobId?: string;
};

export type AuditRouteState = {
  source: "local" | "purview";
  search: string;
  action: string;
  status: string;
  page: number;
  jobId?: string;
};

export type SecurityRouteState = {
  jobId?: string;
  tokenMode?: "delegated" | "application";
  templateId?: "agents_inventory" | "agent_activity" | "agent_tools";
  operations?: string[];
  startDateTime?: string;
  endDateTime?: string;
  agentIds?: string;
  blueprintIds?: string;
  actorObjectIds?: string;
};

export type OfficialUsageRouteState = {
  stagingId?: string;
  activityWindowDays: number;
};

export const maximumPackageSelection = 5_000;
export const maximumInlinePackageRouteBytes = 4_096;

const viewPaths: Record<WorkbenchViewId, string> = {
  agents: "/agents",
  "power-platform": "/power-platform",
  users: "/users",
  "official-usage": "/official-usage",
  audit: "/audit",
  security: "/security",
  permissions: "/permissions",
  jobs: "/jobs",
};

const viewsByPath = new Map(
  Object.entries(viewPaths).map(([view, path]) => [path, view as WorkbenchViewId]),
);

export function parseWorkbenchView(pathname: string): WorkbenchViewId {
  return viewsByPath.get(normalizePath(pathname)) ?? "agents";
}

export function workbenchUrl(
  view: WorkbenchViewId,
  search: URLSearchParams = new URLSearchParams(),
) {
  const query = search.toString();
  return `${viewPaths[view]}${query ? `?${query}` : ""}`;
}

export function parseAgentRoute(search: string): AgentRouteState {
  const params = new URLSearchParams(search);
  const query = (params.get("q") ?? "").slice(0, 256);
  const status = params.get("status");
  const sortBy = params.get("sort");
  const selectedIds = [...new Set(params.getAll("selected").filter(validSelectedId))].slice(0, maximumPackageSelection);
  const selectionCount = boundedSelectionCount(params.get("selectionCount"));
  const selectionStored = params.get("selectionState") === "session" && selectionCount !== undefined;
  return {
    search: query,
    status: status === "allowed" || status === "blocked" ? status : "all",
    publisher: bounded(params.get("publisher"), 256) ?? "all",
    availability: bounded(params.get("availability"), 128) ?? "all",
    host: bounded(params.get("host"), 256) ?? "all",
    platform: bounded(params.get("platform"), 256) ?? "all",
    createdWithinDays: boundedIntegerText(params.get("createdWithinDays"), 3650),
    sortBy: sortBy === "publisher" || sortBy === "lastModifiedAt" ? sortBy : "displayName",
    sortDirection: params.get("direction") === "desc" ? "desc" : "asc",
    page: boundedPage(params.get("page")),
    detailId: bounded(params.get("detail"), 512),
    detailTab: bounded(params.get("detailTab"), 64),
    selectedIds,
    ...(selectionStored ? { selectionStorage: "session" as const, selectionCount } : {}),
    refreshJobId: bounded(params.get("refreshJob"), 512),
    refreshMode: params.get("mode") === "application" ? "application" : "delegated",
    controlJobId: bounded(params.get("controlJob"), 512),
  };
}

export function agentRouteSearch(state: AgentRouteState) {
  const params = new URLSearchParams();
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
  if (state.detailId && validSelectedId(state.detailId)) params.set("detail", state.detailId);
  if (state.detailId && state.detailTab && state.detailTab !== "identities") params.set("detailTab", state.detailTab.slice(0, 64));
  if (state.refreshJobId && validSelectedId(state.refreshJobId)) {
    params.set("refreshJob", state.refreshJobId);
    if (state.refreshMode === "application") params.set("mode", "application");
  }
  if (state.controlJobId && validSelectedId(state.controlJobId)) params.set("controlJob", state.controlJobId);
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

export function parsePowerPlatformRoute(search: string): PowerPlatformRouteState {
  const params = new URLSearchParams(search);
  const sort = params.get("sort");
  return {
    search: bounded(params.get("q"), 256) ?? "",
    type: bounded(params.get("type"), 256) ?? "all",
    environmentId: bounded(params.get("environment"), 512) ?? "",
    sortBy: sort === "type" || sort === "environmentId" || sort === "createdAt" || sort === "lastPublishedAt" ? sort : "displayName",
    sortDirection: params.get("direction") === "desc" ? "desc" : "asc",
    page: boundedPage(params.get("page")),
    snapshotId: bounded(params.get("snapshot"), 64) ?? "",
    detailId: bounded(params.get("detail"), 512),
    detailType: bounded(params.get("detailType"), 256),
    detailEnvironmentId: bounded(params.get("detailEnvironment"), 512),
    detailTab: bounded(params.get("detailTab"), 64),
    selectedIds: [...new Set(params.getAll("selected").filter(validSelectedId))].slice(0, 25),
    refreshJobId: bounded(params.get("refreshJob"), 512),
    quarantineJobId: bounded(params.get("quarantineJob"), 512),
  };
}

export function powerPlatformRouteSearch(state: PowerPlatformRouteState) {
  const params = new URLSearchParams();
  if (state.search.trim()) params.set("q", state.search.trim().slice(0, 256));
  if (state.type !== "all") params.set("type", state.type);
  if (state.environmentId.trim()) params.set("environment", state.environmentId.trim().slice(0, 512));
  if (state.sortBy !== "displayName") params.set("sort", state.sortBy);
  if (state.sortDirection !== "asc") params.set("direction", state.sortDirection);
  if (state.page > 0) params.set("page", String(state.page + 1));
  if (state.snapshotId) params.set("snapshot", state.snapshotId);
  if (state.detailId && validSelectedId(state.detailId)) params.set("detail", state.detailId);
  if (state.detailType) params.set("detailType", state.detailType.slice(0, 256));
  if (state.detailEnvironmentId) params.set("detailEnvironment", state.detailEnvironmentId.slice(0, 512));
  if (state.detailId && state.detailTab && state.detailTab !== "identity") params.set("detailTab", state.detailTab.slice(0, 64));
  if (state.refreshJobId && validSelectedId(state.refreshJobId)) params.set("refreshJob", state.refreshJobId);
  if (state.quarantineJobId && validSelectedId(state.quarantineJobId)) params.set("quarantineJob", state.quarantineJobId);
  for (const id of [...new Set(state.selectedIds.filter(validSelectedId))].slice(0, 25)) params.append("selected", id);
  return params;
}

const localAuditActions = new Set([
  "block", "unblock", "update-availability", "update-installation",
  "view-audit-search", "export-audit-search", "view-hunting", "export-hunting",
  "export-package-inventory", "export-power-platform-inventory",
]);
const localAuditStatuses = new Set([
  "requested", "started", "succeeded", "failed", "skipped", "inconclusive", "cancelled",
]);

export function parseAuditRoute(search: string): AuditRouteState {
  const params = new URLSearchParams(search);
  const jobId = bounded(params.get("job"), 512);
  const action = bounded(params.get("action"), 64);
  const status = bounded(params.get("status"), 64);
  return {
    source: jobId || params.get("source") === "purview" ? "purview" : "local",
    search: bounded(params.get("q"), 256) ?? "",
    action: action && localAuditActions.has(action) ? action : "all",
    status: status && localAuditStatuses.has(status) ? status : "all",
    page: boundedPage(params.get("page")),
    jobId,
  };
}

export function auditRouteSearch(state: AuditRouteState) {
  const params = new URLSearchParams();
  if (state.source === "purview") params.set("source", "purview");
  if (state.search.trim()) params.set("q", state.search.trim().slice(0, 256));
  if (state.action !== "all" && localAuditActions.has(state.action)) params.set("action", state.action);
  if (state.status !== "all" && localAuditStatuses.has(state.status)) params.set("status", state.status);
  if (state.page > 0) params.set("page", String(state.page + 1));
  if (state.jobId && validSelectedId(state.jobId)) params.set("job", state.jobId);
  return params;
}

export function parseSecurityRoute(search: string): SecurityRouteState {
  const params = new URLSearchParams(search);
  const tokenMode = params.get("mode");
  const templateId = params.get("template");
  const operationValues = params.getAll("operation").filter(value => bounded(value, 128));
  return {
    jobId: bounded(params.get("job"), 512),
    tokenMode: tokenMode === "delegated" || tokenMode === "application" ? tokenMode : undefined,
    templateId: templateId === "agents_inventory" || templateId === "agent_activity" || templateId === "agent_tools"
      ? templateId
      : undefined,
    operations: operationValues.length ? [...new Set(operationValues)].slice(0, 20) : undefined,
    startDateTime: bounded(params.get("start"), 64),
    endDateTime: bounded(params.get("end"), 64),
    agentIds: bounded(params.get("agentIds"), 2_048),
    blueprintIds: bounded(params.get("blueprintIds"), 2_048),
    actorObjectIds: bounded(params.get("actorObjectIds"), 2_048),
  };
}

export function securityRouteSearch(state: SecurityRouteState) {
  const params = new URLSearchParams();
  if (state.jobId && validSelectedId(state.jobId)) params.set("job", state.jobId);
  if (state.tokenMode) params.set("mode", state.tokenMode);
  if (state.templateId) params.set("template", state.templateId);
  for (const operation of [...new Set(state.operations ?? [])].filter(value => bounded(value, 128)).slice(0, 20)) {
    params.append("operation", operation);
  }
  if (state.startDateTime) params.set("start", state.startDateTime);
  if (state.endDateTime) params.set("end", state.endDateTime);
  if (state.agentIds?.trim()) params.set("agentIds", state.agentIds.trim().slice(0, 2_048));
  if (state.blueprintIds?.trim()) params.set("blueprintIds", state.blueprintIds.trim().slice(0, 2_048));
  if (state.actorObjectIds?.trim()) params.set("actorObjectIds", state.actorObjectIds.trim().slice(0, 2_048));
  return params;
}

export function parseOfficialUsageRoute(search: string): OfficialUsageRouteState {
  const params = new URLSearchParams(search);
  const activityWindowDays = Number(params.get("window"));
  return {
    stagingId: bounded(params.get("staging"), 512),
    activityWindowDays: Number.isSafeInteger(activityWindowDays) && activityWindowDays >= 1 && activityWindowDays <= 365
      ? activityWindowDays
      : 30,
  };
}

export function officialUsageRouteSearch(state: OfficialUsageRouteState) {
  const params = new URLSearchParams();
  if (state.stagingId && validSelectedId(state.stagingId)) params.set("staging", state.stagingId);
  if (state.activityWindowDays !== 30) params.set("window", String(Math.min(365, Math.max(1, state.activityWindowDays))));
  return params;
}

function normalizePath(pathname: string) {
  if (pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

function validSelectedId(value: string) {
  return value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
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
