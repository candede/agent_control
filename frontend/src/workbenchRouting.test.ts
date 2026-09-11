import { describe, expect, it } from "vitest";
import {
  agentRouteSearch,
  auditRouteSearch,
  officialUsageRouteSearch,
  parseAgentRoute,
  parseAuditRoute,
  parseOfficialUsageRoute,
  parsePowerPlatformRoute,
  parseSecurityRoute,
  parseWorkbenchView,
  powerPlatformRouteSearch,
  securityRouteSearch,
  workbenchUrl,
  maximumInlinePackageRouteBytes,
} from "./workbenchRouting";

describe("workbench routing", () => {
  it("maps every canonical deep link without a query-string view alias", () => {
    expect(parseWorkbenchView("/agents")).toBe("agents");
    expect(parseWorkbenchView("/power-platform/")).toBe("power-platform");
    expect(parseWorkbenchView("/official-usage")).toBe("official-usage");
    expect(parseWorkbenchView("/security")).toBe("security");
    expect(parseWorkbenchView("/jobs")).toBe("jobs");
    expect(parseWorkbenchView("/unknown")).toBe("agents");
  });

  it("round trips bounded agent search, status and selection", () => {
    const query = agentRouteSearch({
      search: "  owned bot  ",
      status: "blocked",
      publisher: "all",
      availability: "all",
      host: "all",
      platform: "all",
      createdWithinDays: "",
      sortBy: "displayName",
      sortDirection: "asc",
      page: 0,
      selectedIds: ["native-1", "native-1", "native-2"],
      refreshMode: "delegated",
    });
    expect(workbenchUrl("agents", query)).toBe(
      "/agents?q=owned+bot&status=blocked&selected=native-1&selected=native-2",
    );
    expect(parseAgentRoute(query.toString())).toEqual({
      search: "owned bot",
      status: "blocked",
      publisher: "all",
      availability: "all",
      host: "all",
      platform: "all",
      createdWithinDays: "",
      sortBy: "displayName",
      sortDirection: "asc",
      page: 0,
      detailId: undefined,
      detailTab: undefined,
      selectedIds: ["native-1", "native-2"],
      refreshJobId: undefined,
      refreshMode: "delegated",
      controlJobId: undefined,
    });
  });

  it("rejects invalid status and bounds selection before state is applied", () => {
    const params = new URLSearchParams({ status: "inconclusive" });
    for (let index = 0; index < 30; index += 1) params.append("selected", `id-${index}`);
    params.append("selected", `bad\nvalue`);
    const route = parseAgentRoute(params.toString());
    expect(route.status).toBe("all");
    expect(route.selectedIds).toHaveLength(30);
    expect(route.selectedIds).not.toContain("bad\nvalue");
  });

  it("moves an oversized 5000-package selection out of the request URL without truncating its count", () => {
    const selectedIds = Array.from({ length: 5_000 }, (_, index) => `package-${index}-${"x".repeat(32)}`);
    const query = agentRouteSearch({
      search: "",
      status: "all",
      publisher: "all",
      availability: "all",
      host: "all",
      platform: "all",
      createdWithinDays: "",
      sortBy: "displayName",
      sortDirection: "asc",
      page: 0,
      selectedIds,
      refreshMode: "delegated",
    });

    expect(query.toString().length).toBeLessThanOrEqual(maximumInlinePackageRouteBytes);
    expect(query.getAll("selected")).toHaveLength(0);
    expect(query.get("selectionState")).toBe("session");
    expect(query.get("selectionCount")).toBe("5000");
    expect(parseAgentRoute(query.toString())).toMatchObject({
      selectedIds: [],
      selectionStorage: "session",
      selectionCount: 5_000,
    });
  });

  it("round trips Power Platform snapshot, paging, exact detail tab, and 25-target selection", () => {
    const selectedIds = Array.from({ length: 25 }, (_, index) => `native-${index}`);
    const query = powerPlatformRouteSearch({
      search: "maker bot", type: "microsoft.copilotstudio/agents", environmentId: "environment-1",
      sortBy: "lastPublishedAt", sortDirection: "desc", page: 3, snapshotId: "snapshot-1",
      detailId: "native-24", detailType: "microsoft.copilotstudio/agents", detailEnvironmentId: "environment-1",
      detailTab: "audit", selectedIds, refreshJobId: undefined, quarantineJobId: undefined,
    });
    expect(parsePowerPlatformRoute(query.toString())).toEqual({
      search: "maker bot", type: "microsoft.copilotstudio/agents", environmentId: "environment-1",
      sortBy: "lastPublishedAt", sortDirection: "desc", page: 3, snapshotId: "snapshot-1",
      detailId: "native-24", detailType: "microsoft.copilotstudio/agents", detailEnvironmentId: "environment-1",
      detailTab: "audit", selectedIds,
      refreshJobId: undefined, quarantineJobId: undefined,
    });
  });

  it("keeps package refresh and package controls explicitly source-discriminated", () => {
    const route = parseAgentRoute("refreshJob=refresh-old&mode=application&controlJob=control-old&job=ambiguous");
    expect(route).toMatchObject({
      refreshJobId: "refresh-old",
      refreshMode: "application",
      controlJobId: "control-old",
    });
    expect(agentRouteSearch(route).toString()).toContain("refreshJob=refresh-old");
    expect(agentRouteSearch(route).toString()).toContain("controlJob=control-old");
    expect(agentRouteSearch(route).toString()).not.toContain("job=ambiguous");
  });

  it("round trips source-specific audit, security and official-usage state", () => {
    const audit = parseAuditRoute("source=purview&job=older&q=actor&action=block&status=failed&page=3");
    expect(audit).toEqual({ source: "purview", jobId: "older", search: "actor", action: "block", status: "failed", page: 2 });
    expect(parseAuditRoute(auditRouteSearch(audit).toString())).toEqual(audit);

    const security = parseSecurityRoute("job=older&mode=application&template=agent_activity&operation=InvokeAgent&agentIds=agent-a");
    expect(parseSecurityRoute(securityRouteSearch(security).toString())).toEqual(security);

    const officialUsage = parseOfficialUsageRoute("staging=stage-old&window=90");
    expect(parseOfficialUsageRoute(officialUsageRouteSearch(officialUsage).toString())).toEqual(officialUsage);
  });
});
