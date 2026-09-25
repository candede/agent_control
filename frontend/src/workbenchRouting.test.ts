import { describe, expect, it } from "vitest";
import {
  agentRouteSearch,
  auditRouteSearch,
  dataSyncRouteSearch,
  parseDataSyncRoute,
  parseAgentRoute,
  parseAuditRoute,
  parseSyncReportRoute,
  migrateOfficialUsageRoute,
  migrateSecurityRoute,
  migrateJobsRoute,
  isWorkbenchPath,
  parseUsersRoute,
  parseWorkbenchView,
  usersRouteSearch,
  workbenchUrl,
  maximumInlinePackageRouteBytes,
} from "./workbenchRouting";

describe("workbench routing", () => {
  it("round trips exact Users responsibility context and leaves invalid identities explicitly invalid", () => {
    const route = { view: "responsibility" as const, personId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", search: "", page: 2 };
    const query = usersRouteSearch(route);
    expect(query.toString()).toBe("view=responsibility&person=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&page=3");
    expect(parseUsersRoute(query.toString())).toMatchObject({ ...route, personId: route.personId.toLowerCase() });
    expect(parseUsersRoute("view=responsibility&person=Alice")).toMatchObject({ view: "responsibility", personId: "Alice" });
    expect(usersRouteSearch({ ...route, personId: "Alice" }).get("person")).toBe("invalid");
  });
  it.each(["available", "unavailable", "availability_unknown"] as const)("round trips the %s end-user access filter", agentView => {
    const state = { ...parseAgentRoute(""), agentView };
    const query = agentRouteSearch(state);
    expect(query.get("show")).toBe(agentView);
    expect(parseAgentRoute(query.toString()).agentView).toBe(agentView);
  });

  it.each(["catalog", "power_platform_only", "all"] as const)("round trips the %s inventory independently of access filters", inventoryScope => {
    const state = { ...parseAgentRoute(""), inventoryScope, agentView: "available" as const };
    const query = agentRouteSearch(state);
    expect(query.get("inventory")).toBe(inventoryScope === "catalog" ? null : inventoryScope);
    expect(query.get("show")).toBe("available");
    expect(parseAgentRoute(query.toString())).toMatchObject({ inventoryScope, agentView: "available" });
    expect(parseAgentRoute("inventory=invalid").inventoryScope).toBe("catalog");
    expect(parseAgentRoute("").inventoryScope).toBe("catalog");
  });

  it("maps every canonical deep link without a query-string view alias", () => {
    expect(parseWorkbenchView("/agents")).toBe("agents");
    expect(parseWorkbenchView("/power-platform/")).toBe("agents");
    expect(parseWorkbenchView("/official-usage")).toBe("sync");
    expect(parseWorkbenchView("/security")).toBe("agents");
    expect(migrateSecurityRoute("/security/")).toBe("/agents");
    expect(migrateSecurityRoute("/agents")).toBeUndefined();
    expect(parseWorkbenchView("/jobs")).toBe("sync");
    expect(parseWorkbenchView("/sync")).toBe("sync");
    expect(parseWorkbenchView("/unknown")).toBe("agents");
  });

  it("redirects retired Jobs bookmarks without keeping a separate view", () => {
    expect(isWorkbenchPath("/jobs/")).toBe(true);
    expect(migrateJobsRoute("/jobs/")).toBe("/sync");
    expect(migrateJobsRoute("/agents")).toBeUndefined();
  });

  it("round trips exact sync and package refresh jobs on the dedicated sync route", () => {
    const route = parseDataSyncRoute("?powerPlatformJob=exact-source-job&syncRun=retained-run&refreshJob=exact-package-job&mode=application&q=not-a-sync-filter");
    expect(route).toEqual({ powerPlatformJobId: "exact-source-job", syncRunId: "retained-run", refreshJobId: "exact-package-job", refreshMode: "application", reports: undefined });
    expect(workbenchUrl("sync", dataSyncRouteSearch(route))).toBe("/sync?powerPlatformJob=exact-source-job&syncRun=retained-run&refreshJob=exact-package-job&mode=application");
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
      inventoryScope: "catalog",
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
      inventoryScope: "catalog",
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
      inventoryScope: "catalog",
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

  it("retains source-qualified links for native IDs at the existing length limit", () => {
    const nativeId = "a".repeat(512);
    const route = agentRouteSearch({ ...parseAgentRoute(""), detailId: `power_platform:env-1:${nativeId}`, selectedPowerPlatformIds: [`power_platform:env-1:${nativeId}`] });
    expect(parseAgentRoute(route.toString())).toMatchObject({
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
    expect(parseAgentRoute("quarantineJob=job-1")).toMatchObject({
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

  it("round trips source-specific audit and Sync report state", () => {
    const audit = parseAuditRoute("source=purview&job=older&q=actor&action=block&status=failed&page=3");
    expect(audit).toEqual({ search: "actor", action: "block", status: "failed", page: 2 });
    expect(parseAuditRoute(auditRouteSearch(audit).toString())).toEqual(audit);

    const sync = parseDataSyncRoute("reports=snapshot&snapshot=11111111-1111-4111-8111-111111111111&window=90");
    expect(parseDataSyncRoute(dataSyncRouteSearch(sync).toString())).toEqual(sync);
  });

  it("bounds Audit search and page routes to the server's supported filters", () => {
    const route = parseAuditRoute(`q=${"a".repeat(200)}&page=1001`);
    expect(route).toMatchObject({ search: "a".repeat(200), page: 1000 });
    expect(parseAuditRoute(auditRouteSearch(route).toString())).toEqual(route);
    expect(parseAuditRoute(`q=${"a".repeat(201)}&page=1002`)).toMatchObject({ search: "", page: 1000 });
    const serialized = auditRouteSearch({ ...route, search: "a".repeat(201), page: 2000 });
    expect(serialized.get("q")).toHaveLength(200);
    expect(serialized.get("page")).toBe("1001");
  });

  it.each([
    ["", "reports=manage"],
    ["view=overview", "reports=manage"],
    ["view=history&snapshot=retained", "reports=manage"],
    ["view=snapshot", "reports=snapshot"],
    ["snapshot=retained", "reports=snapshot&snapshot=retained"],
    ["window=90", "reports=snapshot&window=90"],
    ["staging=draft&snapshot=retained", "reports=import&staging=draft"],
    ["snapshot=bad%0Aid&window=999", "reports=manage"],
  ])("migrates legacy report bookmarks %s without restoring a duplicate page", (search, expected) => {
    expect(migrateOfficialUsageRoute("/official-usage/", search)?.toString()).toBe(expected);
    expect(migrateOfficialUsageRoute("/agents", search)).toBeUndefined();
  });

  it("bounds report route state and keeps sync job links when opening or closing reports", () => {
    const state = parseDataSyncRoute("syncRun=run&refreshJob=job&mode=application&reports=import&staging=draft");
    expect(state.reports).toEqual({ view: "import", stagingId: "draft", reportSetId: undefined, activityWindowDays: 30 });
    expect(parseDataSyncRoute(dataSyncRouteSearch(state).toString())).toEqual(state);
    expect(dataSyncRouteSearch({ ...state, reports: undefined }).toString()).toBe("syncRun=run&refreshJob=job&mode=application");
    expect(parseSyncReportRoute("reports=unknown")).toBeUndefined();
    expect(parseSyncReportRoute("reports=snapshot&snapshot=bad%0Aid&window=-10"))
      .toEqual({ view: "snapshot", stagingId: undefined, reportSetId: undefined, activityWindowDays: 30 });
    expect(parseSyncReportRoute("reports=manage&snapshot=retained&staging=draft&window=90"))
      .toEqual({ view: "manage", stagingId: undefined, reportSetId: undefined, activityWindowDays: 30 });
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

  it.each([
    "reassign", "approve-hunting", "qualify-hunting", "submit-hunting", "query-hunting",
    "cancel-hunting", "delete-hunting", "revoke-hunting-scope",
    "export-official-usage-aggregate", "export-official-usage-users", "export-administrative-audit",
  ])("round trips the backend-supported %s administrative audit filter", action => {
    const route = parseAuditRoute(`action=${action}&status=succeeded`);
    expect(route.action).toBe(action);
    expect(parseAuditRoute(auditRouteSearch(route).toString())).toEqual(route);
  });

  it("defaults retained usage snapshots to the full historical activity window", () => {
    const reportSetId = "11111111-1111-4111-8111-111111111111";
    const historical = parseSyncReportRoute(`reports=snapshot&snapshot=${reportSetId}`);
    expect(historical).toEqual({
      view: "snapshot",
      stagingId: undefined,
      reportSetId,
      activityWindowDays: 365,
    });
    expect(dataSyncRouteSearch({ refreshMode: "delegated", reports: historical }).toString()).toBe(`reports=snapshot&snapshot=${reportSetId}`);
    expect(parseSyncReportRoute("reports=snapshot")).toEqual({
      view: "snapshot",
      stagingId: undefined,
      reportSetId: undefined,
      activityWindowDays: 30,
    });
  });

  it("keeps the Sync page, import workflow, history and snapshot routes distinct", () => {
    for (const search of ["", "reports=import", "reports=manage", "reports=snapshot", "reports=snapshot&window=90"]) {
      expect(dataSyncRouteSearch(parseDataSyncRoute(search)).toString()).toBe(search);
    }
    expect(parseSyncReportRoute("reports=snapshot&window=90")).toMatchObject({ view: "snapshot", activityWindowDays: 90 });
  });

  it("drops obsolete provider source, job and user parameters from local Audit", () => {
    const route = parseAuditRoute("source=purview&user=employee%2Btest%40example.invalid");
    expect(route).toEqual({ search: "", action: "all", status: "all", page: 0 });
    expect(auditRouteSearch(route).toString()).toBe("");
    expect(auditRouteSearch(parseAuditRoute("job=old&source=purview&action=block")).toString()).toBe("action=block");
  });
});
