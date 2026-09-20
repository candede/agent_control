import { describe, expect, it } from "vitest";
import {
  agentRouteSearch,
  auditRouteSearch,
  dataSyncRouteSearch,
  parseDataSyncRoute,
  officialUsageRouteSearch,
  parseAgentRoute,
  parseAuditRoute,
  parseOfficialUsageRoute,
  parsePowerPlatformRoute,
  parseSecurityRoute,
  parseUsersRoute,
  parseWorkbenchView,
  powerPlatformRouteSearch,
  securityRouteSearch,
  usersRouteSearch,
  workbenchUrl,
  maximumInlinePackageRouteBytes,
  migratePowerPlatformAgentRoute,
} from "./workbenchRouting";

describe("workbench routing", () => {
  it("maps every canonical deep link without a query-string view alias", () => {
    expect(parseWorkbenchView("/agents")).toBe("agents");
    expect(parseWorkbenchView("/power-platform/")).toBe("power-platform");
    expect(parseWorkbenchView("/official-usage")).toBe("official-usage");
    expect(parseWorkbenchView("/security")).toBe("security");
    expect(parseWorkbenchView("/jobs")).toBe("jobs");
    expect(parseWorkbenchView("/sync")).toBe("sync");
    expect(parseWorkbenchView("/unknown")).toBe("agents");
  });

  it("round trips exact sync and package refresh jobs on the dedicated sync route", () => {
    const route = parseDataSyncRoute("?syncRun=retained-run&refreshJob=exact-package-job&mode=application&q=not-a-sync-filter");
    expect(route).toEqual({ syncRunId: "retained-run", refreshJobId: "exact-package-job", refreshMode: "application" });
    expect(workbenchUrl("sync", dataSyncRouteSearch(route))).toBe("/sync?syncRun=retained-run&refreshJob=exact-package-job&mode=application");
    expect(parseDataSyncRoute(`?syncRun=${"x".repeat(513)}&mode=invalid`).syncRunId).toBeUndefined();
    expect(dataSyncRouteSearch({ syncRunId: "bad\nid", refreshMode: "delegated" }).toString()).toBe("");
  });

  it("round trips report-scoped activity filters and preserves legacy matrix links", () => {
    const state = {
      view: "activity" as const, search: "Ada@example.invalid", agentId: "Report/Agent:Upper",
      reportSetId: "11111111-1111-4111-8111-111111111111", page: 3,
    };
    const query = usersRouteSearch(state);
    expect(parseUsersRoute(query.toString())).toEqual(state);
    expect(query.get("view")).toBe("activity");
    expect(parseUsersRoute(query.toString().replace("view=activity", "view=matrix"))).toEqual(state);
    expect(workbenchUrl("users", query)).toContain("agent=Report%2FAgent%3AUpper");
    expect(parseUsersRoute("view=unknown&page=-1")).toEqual({ view: "licenses", search: "", agentId: undefined, reportSetId: undefined, page: 0 });
    expect(usersRouteSearch({ ...state, view: "licenses" }).toString()).toBe("");
    expect(parseUsersRoute(`view=matrix&agent=${"x".repeat(513)}&snapshot=bad%0Aid`).agentId).toBeUndefined();
    expect(parseUsersRoute("view=matrix&snapshot=bad%0Aid").reportSetId).toBeUndefined();
  });
  it("round trips bounded agent search, status and selection", () => {
    const query = agentRouteSearch({
      agentView: "all",
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
      source: "all",
      linkState: "all",
      environmentId: "",
      selectedPowerPlatformIds: [],
    });
    expect(workbenchUrl("agents", query)).toBe(
      "/agents?q=owned+bot&status=blocked&selected=native-1&selected=native-2",
    );
    expect(parseAgentRoute(query.toString())).toEqual({
      agentView: "all",
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
      syncRunId: undefined,
      source: "all",
      linkState: "all",
      environmentId: "",
      inventorySnapshotId: undefined,
      selectedPowerPlatformIds: [],
      quarantineJobId: undefined,
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
      agentView: "all",
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
      source: "all",
      linkState: "all",
      environmentId: "",
      selectedPowerPlatformIds: [],
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

  it("migrates only legacy Power Platform agent and quarantine links to Agents", () => {
    const migrated = migratePowerPlatformAgentRoute(
      "q=builder&type=microsoft.copilotstudio%2Fagents&environment=environment-1&snapshot=snapshot-1&detail=agent-1&detailType=microsoft.copilotstudio%2Fagents&detailTab=controls&selected=agent-1&quarantineJob=job-1",
    );
    expect(migrated).toBeDefined();
    expect(parseAgentRoute(migrated!.toString())).toMatchObject({
      search: "builder",
      environmentId: "environment-1",
      detailId: "power_platform:environment-1:agent-1",
      detailTab: "controls",
      inventorySnapshotId: "snapshot-1",
      selectedPowerPlatformIds: ["power_platform:environment-1:agent-1"],
      source: "all",
      quarantineJobId: "job-1",
    });
    expect(migratePowerPlatformAgentRoute("type=microsoft.powerapps%2Fapps")).toBeUndefined();
  });

  it("preserves the detail environment independently of the old Power Platform list filter", () => {
    const migrated = migratePowerPlatformAgentRoute("detail=bot-1&detailType=microsoft.copilotstudio%2Fagents&detailEnvironment=env-1&detailTab=audit");
    expect(parseAgentRoute(migrated!.toString())).toMatchObject({
      detailId: "power_platform:env-1:bot-1",
      environmentId: "",
      source: "all",
      detailTab: "audit-security",
    });
    const anotherEnvironment = migratePowerPlatformAgentRoute("detail=bot-1&detailType=microsoft.copilotstudio%2Fagents&detailEnvironment=env-2");
    expect(parseAgentRoute(anotherEnvironment!.toString()).detailId).toBe("power_platform:env-2:bot-1");
  });

  it("retains source-qualified links for native IDs at the existing length limit", () => {
    const nativeId = "a".repeat(512);
    const migrated = migratePowerPlatformAgentRoute(`type=microsoft.copilotstudio%2Fagents&environment=env-1&detail=${nativeId}&selected=${nativeId}`);
    expect(parseAgentRoute(migrated!.toString())).toMatchObject({
      detailId: `power_platform:env-1:${nativeId}`,
      selectedPowerPlatformIds: [`power_platform:env-1:${nativeId}`],
    });
    expect(parseAgentRoute("detail=power_platform%3Aenv-1%3A%250A").detailId).toBeUndefined();
  });

  it("round trips canonical details and legacy canonical selections alongside exact source targets", () => {
    const canonical = "agent:11111111-1111-4111-8111-111111111111";
    const native = "power_platform:environment-a:native%2Fagent";
    const route = parseAgentRoute(new URLSearchParams({
      detail: canonical, detailTab: "controls", inventorySnapshot: "snapshot-a",
    }).toString());
    route.selectedIds = ["package-a", "package-b"];
    route.selectedPowerPlatformIds = [canonical, native];
    expect(parseAgentRoute(agentRouteSearch(route).toString())).toMatchObject({
      detailId: canonical, detailTab: "controls", inventorySnapshotId: "snapshot-a",
      selectedIds: ["package-a", "package-b"], selectedPowerPlatformIds: [canonical, native],
    });
    expect(parseAgentRoute("detail=agent%3Ainvalid&selectedResource=agent%3Ainvalid")).toMatchObject({
      detailId: undefined, selectedPowerPlatformIds: [],
    });
  });

  it("keeps quarantine job-only links independently of a saved selection", () => {
    const migrated = migratePowerPlatformAgentRoute("quarantineJob=job-1");
    expect(parseAgentRoute(migrated!.toString())).toMatchObject({
      source: "all",
      selectedPowerPlatformIds: [],
      quarantineJobId: "job-1",
    });
  });

  it("keeps package refresh, controls, and data sync explicitly source-discriminated", () => {
    const route = parseAgentRoute("refreshJob=refresh-old&mode=application&controlJob=control-old&syncRun=sync-old&job=ambiguous");
    expect(route).toMatchObject({
      refreshJobId: "refresh-old",
      refreshMode: "application",
      controlJobId: "control-old",
      syncRunId: "sync-old",
    });

    expect(agentRouteSearch(route).toString()).toContain("refreshJob=refresh-old");
    expect(agentRouteSearch(route).toString()).toContain("controlJob=control-old");
    expect(agentRouteSearch(route).toString()).toContain("syncRun=sync-old");
    expect(agentRouteSearch(route).toString()).not.toContain("job=ambiguous");
  });

  it("drops obsolete source/link filters without losing legacy exact resource identities", () => {
    const route = parseAgentRoute("source=power_platform&linkState=matched&environment=env-a&detail=bot-a&selectedResource=power_platform%3Aenv-a%3Abot-a");
    expect(route).toMatchObject({
      source: "all", linkState: "all", environmentId: "env-a",
      detailId: "power_platform:env-a:bot-a",
      selectedPowerPlatformIds: ["power_platform:env-a:bot-a"],
    });

    expect(agentRouteSearch(route).has("source")).toBe(false);
    expect(agentRouteSearch(route).has("linkState")).toBe(false);
    expect(parseAgentRoute(agentRouteSearch(route).toString()).detailId).toBe(route.detailId);
    expect(parseAgentRoute("source=power_platform&environment=env-a&detail=graph_packages%3Apackage-a").detailId).toBe("graph_packages:package-a");
  });

  it("round trips source-specific audit, security and official-usage state", () => {
    const audit = parseAuditRoute("source=purview&job=older&q=actor&action=block&status=failed&page=3");
    expect(audit).toEqual({ source: "purview", jobId: "older", search: "actor", action: "block", status: "failed", page: 2 });
    expect(parseAuditRoute(auditRouteSearch(audit).toString())).toEqual(audit);

    const security = parseSecurityRoute("job=older&mode=application&template=agent_activity&operation=InvokeAgent&agentIds=agent-a");
    expect(parseSecurityRoute(securityRouteSearch(security).toString())).toEqual(security);

    const officialUsage = parseOfficialUsageRoute("staging=stage-old&snapshot=11111111-1111-4111-8111-111111111111&window=90");
    expect(parseOfficialUsageRoute(officialUsageRouteSearch(officialUsage).toString())).toEqual(officialUsage);
  });

  it("round trips organization views and all supported table sorts without changing old links", () => {
    for (const agentView of ["all", "organization", "used", "unknown"] as const) {
      for (const sortBy of ["hosts", "responses", "activeUsers", "lastActivity", "owner", "publisher"] as const) {
        const route = { ...parseAgentRoute("detail=graph_packages%3Apackage-a"), agentView, sortBy, sortDirection: "desc" as const };
        expect(parseAgentRoute(agentRouteSearch(route).toString())).toEqual(route);
      }
    }
    expect(parseAgentRoute("show=unsupported&sortBy=unsupported")).toMatchObject({ agentView: "all", sortBy: "displayName" });
    expect(agentRouteSearch(parseAgentRoute("")).has("show")).toBe(false);
  });

  it("round trips the unified agent inventory export audit action", () => {
    const route = parseAuditRoute("action=export-agent-inventory&status=succeeded");
    expect(route.action).toBe("export-agent-inventory");
    expect(parseAuditRoute(auditRouteSearch(route).toString())).toEqual(route);
  });

  it("defaults retained usage snapshots to the full historical activity window", () => {
    const reportSetId = "11111111-1111-4111-8111-111111111111";
    const historical = parseOfficialUsageRoute(`snapshot=${reportSetId}`);
    expect(historical).toEqual({
      stagingId: undefined,
      reportSetId,
      activityWindowDays: 365,
    });
    expect(officialUsageRouteSearch(historical).toString()).toBe(`snapshot=${reportSetId}`);
    expect(parseOfficialUsageRoute("")).toEqual({
      stagingId: undefined,
      reportSetId: undefined,
      activityWindowDays: 30,
    });
  });

  it("carries an exact employee identity into an explicit Purview search", () => {
    const route = parseAuditRoute("source=purview&user=employee%2Btest%40example.invalid");
    expect(route.userPrincipalName).toBe("employee+test@example.invalid");
    expect(parseAuditRoute(auditRouteSearch(route).toString())).toEqual(route);
    expect(auditRouteSearch({ ...route, source: "local" }).has("user")).toBe(false);
    expect(parseAuditRoute(`source=purview&user=${"a".repeat(500)}`).userPrincipalName).toBeUndefined();
  });
});
