import {
  parseUnifiedAgentRecordId, unifiedAgentRecordId, unifiedAgentSortKeys,
  unifiedAgentInventoryScopes, unifiedAgentAccessFilters, unifiedAgentUsageFilters, unifiedAgentManagementFilters, unifiedAgentRelevanceFilters,
  type UnifiedAgentInventoryScope, type UnifiedAgentSort,
  type UnifiedAgentAccessFilter, type UnifiedAgentUsageFilter, type UnifiedAgentManagementFilter, type UnifiedAgentRelevanceFilter,
} from "../../backend/src/types/unifiedAgents";
import { isDirectoryObjectId } from "../../backend/src/types/copilotPackage";
import { auditDefaultPageSize, auditMaximumOffset, auditMaximumSearchLength } from "../../backend/src/types/audit";
import { decodeInventoryFacet, encodeInventoryFacet, type InventoryFacetValue } from "../../backend/src/types/inventoryFacets";

export const maximumAuditPageIndex = Math.floor(auditMaximumOffset / auditDefaultPageSize);

export type WorkbenchViewId = "agents" | "users" | "sync" | "audit" | "permissions";

export type AgentRouteState = {
  inventoryScope: UnifiedAgentInventoryScope;
  packageType?: string | null;
  endUserAccess: UnifiedAgentAccessFilter;
  reportedUsage: UnifiedAgentUsageFilter;
  management: UnifiedAgentManagementFilter;
  relevance: UnifiedAgentRelevanceFilter;
  search: string;
  status: "all" | "allowed" | "blocked";
  publisher?: string | null;
  availability?: InventoryFacetValue;
  host?: string | null;
  platform?: string | null;
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
  environmentId?: string | null;
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

export const userDetailTabs = ["overview", "usage", "licenses", "responsibility", "purview"] as const;
export type UserDetailTab = typeof userDetailTabs[number];

export type UsersRouteState = {
  view: "licenses" | "activity";
  detailId?: string;
  detailTab?: UserDetailTab;
  search: string;
  agentId?: string;
  reportSetId?: string;
  page: number;
};

type DataSyncRouteState = {
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
};

const viewsByPath = new Map(
  Object.entries(viewPaths).map(([view, path]) => [path, view as WorkbenchViewId]),
);

export function parseWorkbenchView(pathname: string): WorkbenchViewId {
  if (["/official-usage", "/jobs"].includes(normalizePath(pathname))) return "sync";
  return viewsByPath.get(normalizePath(pathname)) ?? "agents";
}

export function isWorkbenchPath(pathname: string) {
  const path = normalizePath(pathname);
  return path === "/" || path === "/official-usage" || path === "/security" || path === "/jobs" || viewsByPath.has(path);
}

export function migrateJobsRoute(pathname: string): string | undefined {
  return normalizePath(pathname) === "/jobs" ? "/sync" : undefined;
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
  const params = routeParams(search);
  return {
    powerPlatformJobId: bounded(params.get("powerPlatformJob"), 512)?.toLowerCase(),
    syncRunId: durableRouteId(params.get("syncRun")),
    refreshJobId: durableRouteId(params.get("refreshJob")),
    refreshMode: params.get("mode") === "application" ? "application" : "delegated",
    reports: parseSyncReportRoute(search),
  };
}

export function dataSyncRouteSearch(state: DataSyncRouteState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.powerPlatformJobId && validSelectedId(state.powerPlatformJobId)) params.set("powerPlatformJob", state.powerPlatformJobId.toLowerCase());
  setDurableRouteId(params, "syncRun", state.syncRunId);
  if (setDurableRouteId(params, "refreshJob", state.refreshJobId)) {
    if (state.refreshMode === "application") params.set("mode", state.refreshMode);
  }
  if (state.reports) {
    params.set("reports", state.reports.view);
    if (state.reports.view === "import") {
      setDurableRouteId(params, "staging", state.reports.stagingId);
      setDurableRouteId(params, "correction", state.reports.reportSetId);
    }
    if (state.reports.view === "snapshot") {
      const reportSetId = setDurableRouteId(params, "snapshot", state.reports.reportSetId);
      const defaultDays = reportSetId ? 365 : 30;
      const days = Number.isSafeInteger(state.reports.activityWindowDays)
        ? Math.min(365, Math.max(1, state.reports.activityWindowDays)) : defaultDays;
      if (days !== defaultDays) params.set("window", String(days));
    }
  }
  return params;
}

export function parseAgentRoute(search: string): AgentRouteState {
  const params = routeParams(search);
  const query = bounded((params.get("q") ?? "").slice(0, 256), 256) ?? "";
  const status = params.get("status");
  const legacyView = params.get("show");
  const sortBy = params.get("sort");
  const selectedIds = [...new Set(params.getAll("selected").filter(validSelectedId))].slice(0, maximumPackageSelection);
  const selectionCount = boundedSelectionCount(params.get("selectionCount"));
  const selectionStored = params.get("selectionState") === "session" && selectionCount !== undefined;
  const environment = routeFacet(params, "environment", 512);
  const environmentId = typeof environment === "string" ? environment.toLowerCase() : environment;
  const rawDetailId = agentRecordId(params.get("detail"));
  const detailId = rawDetailId && !parseUnifiedAgentRecordId(rawDetailId) && params.get("source") === "power_platform" && environmentId
    ? unifiedAgentRecordId({ source: "power_platform", environmentId, nativeId: rawDetailId })
    : rawDetailId;
  return {
    inventoryScope: unifiedAgentInventoryScopes.find(value => value === params.get("inventory")) ?? "catalog",
    packageType: params.has("type") ? routeFacet(params, "type", 4096) : legacyView === "first_party" ? "firstParty" : legacyView === "third_party" ? "thirdParty" : undefined,
    endUserAccess: unifiedAgentAccessFilters.find(value => value === params.get("access"))
      ?? (!params.has("access") && (legacyView === "available" || legacyView === "unavailable") ? legacyView
        : !params.has("access") && legacyView === "availability_unknown" ? "unknown" : "all"),
    reportedUsage: unifiedAgentUsageFilters.find(value => value === params.get("usage")) ?? (!params.has("usage") && legacyView === "used" ? "used" : "all"),
    management: unifiedAgentManagementFilters.find(value => value === params.get("management"))
      ?? (!params.has("management") && (legacyView === "user_managed" || legacyView === "organization_managed") ? legacyView : "all"),
    relevance: unifiedAgentRelevanceFilters.find(value => value === params.get("relevance"))
      ?? (!params.has("relevance") && (legacyView === "organization" || legacyView === "unknown") ? legacyView : "all"),
    search: query,
    status: status === "allowed" || status === "blocked" ? status : "all",
    publisher: routeFacet(params, "publisher", 4096),
    availability: routeFacet(params, "availability", 4096, true),
    host: routeFacet(params, "host", 4096),
    platform: params.has("platform") ? routeFacet(params, "platform", 4096) : legacyView === "copilot_studio" ? "Copilot Studio" : undefined,
    createdWithinDays: boundedIntegerText(params.get("createdWithinDays"), 3650),
    sortBy: unifiedAgentSortKeys.find(value => value === sortBy) ?? "displayName",
    sortDirection: params.get("direction") === "desc" ? "desc" : "asc",
    page: boundedPage(params.get("page")),
    detailId,
    detailTab: bounded(params.get("detailTab"), 64),
    selectedIds,
    ...(selectionStored ? { selectionStorage: "session" as const, selectionCount } : {}),
    refreshJobId: durableRouteId(params.get("refreshJob")),
    refreshMode: params.get("mode") === "application" ? "application" : "delegated",
    controlJobId: durableRouteId(params.get("controlJob")),
    syncRunId: durableRouteId(params.get("syncRun")),
    source: "all",
    linkState: "all",
    environmentId,
    inventorySnapshotId: durableRouteId(params.get("inventorySnapshot"), 64),
    selectedPowerPlatformIds: [...new Set(params.getAll("selectedResource").map(agentRecordId).filter(value => value !== undefined))].slice(0, 25),
    quarantineJobId: durableRouteId(params.get("quarantineJob")),
  };
}

function routeFacet(params: URLSearchParams, key: string, maximum: number): string | null | undefined;
function routeFacet(params: URLSearchParams, key: string, maximum: number, combined: true): InventoryFacetValue | undefined;
function routeFacet(params: URLSearchParams, key: string, maximum: number, combined = false) {
  const value = params.get(key);
  if (value === null || params.getAll(key).length !== 1 || value.length > maximum + 8 || /[\r\n\0]/.test(value)) return undefined;
  try {
    const decoded = decodeInventoryFacet(value);
    return decoded === null || typeof decoded === "string" && decoded.length > 0 || combined && typeof decoded === "object" ? decoded : undefined;
  } catch { return undefined; }
}

export function agentRouteSearch(state: AgentRouteState) {
  const params = new URLSearchParams();
  if (state.inventoryScope !== "catalog") params.set("inventory", state.inventoryScope);
  if (state.packageType !== undefined) params.set("type", encodeInventoryFacet(state.packageType));
  if (state.endUserAccess !== "all") params.set("access", state.endUserAccess);
  if (state.reportedUsage !== "all") params.set("usage", state.reportedUsage);
  if (state.management !== "all") params.set("management", state.management);
  if (state.relevance !== "all") params.set("relevance", state.relevance);
  const search = bounded(state.search.trim().slice(0, 256), 256);
  if (search) params.set("q", search);
  if (state.status !== "all") params.set("status", state.status);
  if (state.publisher !== undefined) params.set("publisher", encodeInventoryFacet(state.publisher));
  if (state.availability !== undefined) params.set("availability", encodeInventoryFacet(state.availability));
  if (state.host !== undefined) params.set("host", encodeInventoryFacet(state.host));
  if (state.platform !== undefined) params.set("platform", encodeInventoryFacet(state.platform));
  const createdWithinDays = boundedIntegerText(state.createdWithinDays, 3650);
  if (createdWithinDays) params.set("createdWithinDays", createdWithinDays);
  if (state.sortBy !== "displayName") params.set("sort", state.sortBy);
  if (state.sortDirection !== "asc") params.set("direction", state.sortDirection);
  if (Number.isSafeInteger(state.page) && state.page > 0 && state.page <= 2_000) params.set("page", String(state.page + 1));
  const detailId = agentRecordId(state.detailId ?? null);
  if (detailId) params.set("detail", detailId);
  const detailTab = bounded(state.detailTab?.slice(0, 64) ?? null, 64);
  if (detailId && detailTab && detailTab !== "identities") params.set("detailTab", detailTab);
  if (setDurableRouteId(params, "refreshJob", state.refreshJobId)) {
    if (state.refreshMode === "application") params.set("mode", "application");
  }
  setDurableRouteId(params, "controlJob", state.controlJobId);
  setDurableRouteId(params, "syncRun", state.syncRunId);
  if (state.environmentId !== undefined) params.set("environment", encodeInventoryFacet(state.environmentId?.toLowerCase() ?? null));
  setDurableRouteId(params, "inventorySnapshot", state.inventorySnapshotId, 64);
  for (const id of [...new Set(state.selectedPowerPlatformIds.map(agentRecordId).filter(value => value !== undefined))].slice(0, 25)) params.append("selectedResource", id);
  setDurableRouteId(params, "quarantineJob", state.quarantineJobId);
  if (state.selectionStorage === "session" && boundedSelectionCount(String(state.selectionCount)) !== undefined) {
    params.set("selectionState", "session");
    params.set("selectionCount", String(state.selectionCount));
    return params;
  }
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
  const params = routeParams(search);
  const action = bounded(params.get("action"), 64);
  const status = bounded(params.get("status"), 64);
  return {
    search: bounded(params.get("q"), auditMaximumSearchLength) ?? "",
    action: action && localAuditActions.has(action) ? action : "all",
    status: status && localAuditStatuses.has(status) ? status : "all",
    page: Math.min(boundedPage(params.get("page")), maximumAuditPageIndex),
  };
}

export function auditRouteSearch(state: AuditRouteState) {
  const params = new URLSearchParams();
  const search = bounded(state.search.trim().slice(0, auditMaximumSearchLength), auditMaximumSearchLength);
  if (search) params.set("q", search);
  if (state.action !== "all" && localAuditActions.has(state.action)) params.set("action", state.action);
  if (state.status !== "all" && localAuditStatuses.has(state.status)) params.set("status", state.status);
  if (Number.isSafeInteger(state.page) && state.page > 0) params.set("page", String(Math.min(state.page, maximumAuditPageIndex) + 1));
  return params;
}

export function parseSyncReportRoute(search: string): SyncReportRouteState | undefined {
  const params = routeParams(search);
  const view = params.get("reports");
  if (view !== "import" && view !== "manage" && view !== "snapshot") return undefined;
  const reportSetId = durableRouteId(params.get("snapshot"));
  const activityWindowDays = Number(params.get("window"));
  return {
    view,
    stagingId: view === "import" ? durableRouteId(params.get("staging")) : undefined,
    reportSetId: view === "snapshot" ? reportSetId : view === "import" ? durableRouteId(params.get("correction")) : undefined,
    activityWindowDays: view !== "snapshot" ? 30 : Number.isSafeInteger(activityWindowDays) && activityWindowDays >= 1 && activityWindowDays <= 365
      ? activityWindowDays
      : reportSetId ? 365 : 30,
  };
}

export function migrateOfficialUsageRoute(pathname: string, search: string): URLSearchParams | undefined {
  if (normalizePath(pathname) !== "/official-usage") return undefined;
  const params = routeParams(search);
  const stagingId = durableRouteId(params.get("staging"));
  const reportSetId = durableRouteId(params.get("snapshot"));
  const window = Number(params.get("window"));
  const validWindow = Number.isSafeInteger(window) && window >= 1 && window <= 365;
  const view = stagingId ? "import"
    : params.get("view") === "history" ? "manage"
    : params.get("view") === "snapshot" || reportSetId || validWindow ? "snapshot" : "manage";
  return dataSyncRouteSearch({
    refreshMode: "delegated",
    reports: { view, stagingId, reportSetId: view === "snapshot" ? reportSetId : undefined,
      activityWindowDays: validWindow ? window : reportSetId ? 365 : 30 },
  });
}

export function parseUsersRoute(search: string): UsersRouteState {
  const params = routeParams(search);
  const legacyResponsibility = params.get("view") === "responsibility";
  const detailId = params.get("detail") ?? (legacyResponsibility ? params.get("person") : null);
  return {
    view: params.get("view") === "activity" || params.get("view") === "matrix" ? "activity" : "licenses",
    ...(detailId !== null ? {
      detailId: isDirectoryObjectId(detailId) ? detailId.toLowerCase() : "invalid",
      detailTab: userDetailTabs.find(tab => tab === params.get("tab")) ?? (legacyResponsibility ? "responsibility" : "overview"),
    } : {}),
    search: bounded(params.get("q"), 256) ?? "",
    agentId: bounded(params.get("agent"), 512),
    reportSetId: durableRouteId(params.get("snapshot")),
    // Users pages require an owned selection cursor, not a legacy offset.
    page: 0,
  };
}

export function usersRouteSearch(state: UsersRouteState) {
  const params = new URLSearchParams();
  if (state.view === "activity") params.set("view", state.view);
  if (state.detailId) {
    params.set("detail", isDirectoryObjectId(state.detailId) ? state.detailId.toLowerCase() : "invalid");
    if (state.detailTab && state.detailTab !== "overview") params.set("tab", state.detailTab);
  }
  const search = bounded(state.search.trim().slice(0, 256), 256);
  if (search) params.set("q", search);
  if (state.view === "activity" && state.agentId && validSelectedId(state.agentId)) params.set("agent", state.agentId);
  setDurableRouteId(params, "snapshot", state.reportSetId);
  return params;
}

function normalizePath(pathname: string) {
  if (pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

function routeParams(search: string) {
  const params = new URLSearchParams(search);
  const counts = new Map<string, number>();
  for (const key of params.keys()) counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const [key, count] of counts) {
    if (key !== "selected" && key !== "selectedResource" && count > 1) {
      // Retain presence so an ambiguous explicit filter cannot fall back to a legacy alias.
      params.set(key, "");
    }
  }
  return params;
}

function validSelectedId(value: string) {
  return value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
}

function agentRecordId(value: string | null): string | undefined {
  if (!value || value.length > 10000) return undefined;
  try {
    const target = parseUnifiedAgentRecordId(value);
    return target ? unifiedAgentRecordId(target) : validSelectedId(value) ? value : undefined;
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

function durableRouteId(value: string | null | undefined, maximum = 512) {
  const id = bounded(value ?? null, maximum);
  return id?.replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, uuid => uuid.toLowerCase());
}

function setDurableRouteId(params: URLSearchParams, key: string, value: string | undefined, maximum = 512) {
  const id = durableRouteId(value, maximum);
  if (id) params.set(key, id);
  return id;
}

function boundedPage(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return 0;
  const oneBased = Number(value);
  return Number.isSafeInteger(oneBased) && oneBased >= 1 && oneBased <= 2_001 ? oneBased - 1 : 0;
}

function boundedIntegerText(value: string | null, maximum: number) {
  if (!value || !/^\d+$/.test(value)) return "";
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum ? String(number) : "";
}
