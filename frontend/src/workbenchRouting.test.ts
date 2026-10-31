import { describe, expect, it } from "vitest";
import {
  agentRouteSearch,
  auditRouteSearch,
  dataSyncRouteSearch,
  dashboardRouteSearch,
  parseDashboardRoute,
  parseDataSyncRoute,
  parseAgentRoute,
  parseAuditRoute,
  parseSyncReportRoute,
  isWorkbenchPath,
  parseUsersRoute,
  parseWorkbenchView,
  usersRouteSearch,
  workbenchUrl,
  maximumInlinePackageRouteBytes,
} from "./workbenchRouting";

describe("workbench routing", () => {
  it("round trips exact administrative origin filters without actor or provider authority", () => {
    const route = parseAuditRoute("origin=mcp&integration=app-id&client=Case-sensitive&callingAgent=reported-caller&page=2");
    expect(route).toMatchObject({ originChannel: "mcp", originIntegrationClientId: "app-id", originClientId: "Case-sensitive",
      originCallingAgentId: "reported-caller", page: 1 });
    expect(parseAuditRoute(auditRouteSearch(route).toString())).toEqual(route);
    expect(parseAuditRoute("origin=spoof&client=bad%00label")).toMatchObject({ originChannel: "all", originClientId: undefined });
  });
  it.each(["client", "callingAgent"] as const)("preserves 256 Unicode characters in exact %s origin filters", key => {
    const label = "🤖".repeat(256);
    const query = new URLSearchParams({ [key]: label });
    const field = key === "client" ? "originClientId" : "originCallingAgentId";
    const route = parseAuditRoute(query.toString());
    expect(route[field]).toBe(label);
    expect(auditRouteSearch(route).get(key)).toBe(label);
    expect(parseAuditRoute(auditRouteSearch(route).toString())).toEqual(route);
    expect(parseAuditRoute(new URLSearchParams({ [key]: `${label}x` }).toString())[field]).toBeUndefined();
    expect(auditRouteSearch({ ...route, [field]: `${label}x` }).has(key)).toBe(false);
  });
  it("round trips server-owned 5000-target selection without member IDs in the URL", () => {
    const query = agentRouteSearch({ ...parseAgentRoute("status=blocked"), selectedIds: [],
      selectionStorage: "session", selectionCount: 5_000 });
    expect(query.get("selectionState")).toBe("session");
    expect(query.get("selectionCount")).toBe("5000");
    expect(query.getAll("selected")).toEqual([]);
    expect(query.toString().length).toBeLessThan(100);
    expect(parseAgentRoute(query.toString())).toMatchObject({ selectionStorage: "session", selectionCount: 5_000, selectedIds: [] });
  });

  it.each(["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "AAAAAAAA-AAAA-7AAA-1AAA-AAAAAAAAAAAA"])(
    "round trips exact Graph user %s and leaves invalid identities explicitly invalid", detailId => {
    const route = { view: "licenses" as const, detailId, detailTab: "responsibility" as const, search: "", page: 0 };
    const query = usersRouteSearch(route);
    expect(query.toString()).toBe(`detail=${detailId.toLowerCase()}&tab=responsibility`);
    expect(parseUsersRoute(query.toString())).toMatchObject({ ...route, detailId: route.detailId.toLowerCase() });
    expect(parseUsersRoute("detail=Alice&tab=responsibility")).toMatchObject({ view: "licenses", detailId: "invalid" });
    expect(usersRouteSearch({ ...route, detailId: "Alice" }).get("detail")).toBe("invalid");
    expect(parseUsersRoute(`detail=${route.detailId}&tab=invalid`).detailTab).toBe("overview");
  });
  it.each(["available", "unavailable", "unknown"] as const)("round trips the %s end-user access filter", endUserAccess => {
    const state = { ...parseAgentRoute(""), endUserAccess };
    const query = agentRouteSearch(state);
    expect(query.get("access")).toBe(endUserAccess);
    expect(parseAgentRoute(query.toString()).endUserAccess).toBe(endUserAccess);
  });

  it.each(["catalog", "power_platform_only", "all"] as const)("round trips the %s inventory independently of access filters", inventoryScope => {
    const state = { ...parseAgentRoute(""), inventoryScope, endUserAccess: "available" as const };
    const query = agentRouteSearch(state);
    expect(query.get("inventory")).toBe(inventoryScope === "catalog" ? null : inventoryScope);
    expect(query.get("access")).toBe("available");
    expect(parseAgentRoute(query.toString())).toMatchObject({ inventoryScope, endUserAccess: "available" });
    expect(parseAgentRoute("inventory=invalid").inventoryScope).toBe("catalog");
    expect(parseAgentRoute("").inventoryScope).toBe("catalog");
  });

  it("maps every canonical deep link without a query-string view alias", () => {
    expect(parseWorkbenchView("/dashboard")).toBe("dashboard");
    expect(isWorkbenchPath("/dashboard")).toBe(true);
    expect(parseWorkbenchView("/agents")).toBe("agents");
    expect(parseWorkbenchView("/sync")).toBe("sync");
    expect(parseWorkbenchView("/unknown")).toBe("agents");
  });

  it("round trips a dashboard baseline without changing the report selection", () => {
    const baselineId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const state = parseDashboardRoute(`?baseline=${baselineId}&snapshot=not-dashboard-context`);
    expect(state).toEqual({ baselineId: baselineId.toLowerCase() });
    expect(workbenchUrl("dashboard", dashboardRouteSearch(state))).toBe(`/dashboard?baseline=${baselineId.toLowerCase()}`);
    expect(parseDashboardRoute("?baseline=invalid")).toEqual({ baselineId: undefined });
    expect(dashboardRouteSearch({ baselineId: "invalid" }).toString()).toBe("");
  });

  it("round trips dashboard company filters including explicit missing companies", () => {
    for (const company of ["Contoso & Partners", null]) {
      const state = { baselineId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", company };
      expect(parseDashboardRoute(`?${dashboardRouteSearch(state)}`)).toEqual(state);
    }
    expect(parseDashboardRoute("?company=~string:Contoso").company).toBe("Contoso");
  });

  it("does not recognize an unregistered path", () => {
    const path = "/not-a-current-page";
    expect(isWorkbenchPath(path)).toBe(false);
    expect(parseWorkbenchView(path)).toBe("agents");
  });

  it("round trips exact sync and package refresh jobs on the dedicated sync route", () => {
    const route = parseDataSyncRoute("?powerPlatformJob=exact-source-job&syncRun=retained-run&refreshJob=exact-package-job&mode=application&q=not-a-sync-filter");
    expect(route).toEqual({ powerPlatformJobId: "exact-source-job", syncRunId: "retained-run", refreshJobId: "exact-package-job", refreshMode: "application", reports: undefined });
    expect(workbenchUrl("sync", dataSyncRouteSearch(route))).toBe("/sync?powerPlatformJob=exact-source-job&syncRun=retained-run&refreshJob=exact-package-job&mode=application");
    expect(parseDataSyncRoute(`?syncRun=${"x".repeat(513)}&mode=invalid`).syncRunId).toBeUndefined();
    expect(dataSyncRouteSearch({ syncRunId: "bad\nid", refreshMode: "application" }).toString()).toBe("");
  });

  it("canonicalizes Power Platform source-job UUIDs for exact reads and poll ownership", () => {
    const id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const route = parseDataSyncRoute(`?powerPlatformJob=${id}`);
    expect(route.powerPlatformJobId).toBe(id.toLowerCase());
    expect(dataSyncRouteSearch({ ...route, powerPlatformJobId: id }).get("powerPlatformJob")).toBe(id.toLowerCase());
  });

  it.each(["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAAAAA"])(
    "canonicalizes durable job, report and snapshot UUID %s without changing opaque identities",
    id => {
      const params = new URLSearchParams();
      for (const key of ["syncRun", "refreshJob", "controlJob", "quarantineJob", "inventorySnapshot", "staging", "correction", "snapshot"]) {
        params.set(key, id);
      }
      const agent = parseAgentRoute(params.toString());
      expect(agent).toMatchObject({
        refreshJobId: id.toLowerCase(), controlJobId: id.toLowerCase(),
        quarantineJobId: id.toLowerCase(), inventorySnapshotId: id.toLowerCase(),
      });
      const sync = parseDataSyncRoute(`${params}&reports=import`);
      expect(sync).toMatchObject({ syncRunId: id.toLowerCase(), refreshJobId: id.toLowerCase(),
        reports: { stagingId: id.toLowerCase(), reportSetId: id.toLowerCase() } });
      expect(parseUsersRoute(params.toString()).reportSetId).toBe(id.toLowerCase());
      expect(parseSyncReportRoute(`${params}&reports=snapshot`)?.reportSetId).toBe(id.toLowerCase());
      const agentSearch = agentRouteSearch({ ...agent, refreshJobId: id, controlJobId: id,
        quarantineJobId: id, inventorySnapshotId: id, selectedIds: [id] });
      for (const key of ["refreshJob", "controlJob", "quarantineJob", "inventorySnapshot"]) {
        expect(agentSearch.get(key)).toBe(id.toLowerCase());
      }
      expect(agentSearch.getAll("selected")).toEqual([id]);
      const syncSearch = dataSyncRouteSearch({ refreshMode: "application", syncRunId: id, refreshJobId: id,
        reports: { view: "import", stagingId: id, reportSetId: id, activityWindowDays: 30 } });
      for (const key of ["syncRun", "refreshJob", "staging", "correction"]) expect(syncSearch.get(key)).toBe(id.toLowerCase());
      expect(usersRouteSearch({ view: "activity", search: "", page: 0, reportSetId: id, agentId: id }).get("snapshot")).toBe(id.toLowerCase());
      expect(usersRouteSearch({ view: "activity", search: "", page: 0, agentId: id }).get("agent")).toBe(id);
      expect(parseDataSyncRoute("syncRun=Opaque%2FRun").syncRunId).toBe("Opaque/Run");
    },
  );

  it("round trips report-scoped activity filters", () => {
    const state = {
      view: "activity" as const, search: "Ada@example.invalid", agentId: "Report/Agent:Upper",
      reportSetId: "11111111-1111-4111-8111-111111111111", page: 0,
    };
    const query = usersRouteSearch(state);
    expect(parseUsersRoute(query.toString())).toEqual(state);
    expect(query.get("view")).toBe("activity");
    expect(workbenchUrl("users", query)).toContain("agent=Report%2FAgent%3AUpper");
    expect(parseUsersRoute("view=unknown&page=-1")).toEqual({ view: "licenses", search: "", agentId: undefined, reportSetId: undefined, page: 0 });
    expect(usersRouteSearch({ ...state, view: "licenses" }).toString())
      .toBe("q=Ada%40example.invalid&snapshot=11111111-1111-4111-8111-111111111111");
    expect(parseUsersRoute(`view=activity&agent=${"x".repeat(513)}&snapshot=bad%0Aid`).agentId).toBeUndefined();
    expect(parseUsersRoute("view=activity&snapshot=bad%0Aid").reportSetId).toBeUndefined();
  });

  it("retains licensed-user search and report scope beside an exact detail link", () => {
    const state = { view: "licenses" as const, search: "Ada", page: 0,
      reportSetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      detailId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", detailTab: "responsibility" as const };
    expect(parseUsersRoute(usersRouteSearch(state).toString())).toEqual({ ...state, agentId: undefined });
  });

  it.each(["licenses", "activity"] as const)("omits unsupported query parameters from canonical %s Users routes", view => {
    const state = parseUsersRoute(new URLSearchParams({ view, q: "Ada", unsupported: "3" }).toString());
    expect(state).toMatchObject({ view, search: "Ada" });
    expect(usersRouteSearch(state).has("unsupported")).toBe(false);
  });
  it("round trips bounded agent search, status and selection", () => {
    const query = agentRouteSearch({
      inventoryScope: "catalog",
      packageType: undefined,
      endUserAccess: "all", reportedUsage: "all", management: "all", relevance: "all",
      search: "  owned bot  ",
      status: "blocked",
      publisher: undefined,
      availability: undefined,
      host: undefined,
      platform: undefined,
      createdWithinDays: "",
      sortBy: "displayName",
      sortDirection: "asc",
      page: 0,
      selectedIds: ["native-1", "native-1", "native-2"],
      refreshMode: "application",
      environmentId: undefined,
      selectedPowerPlatformIds: [],
    });
    expect(workbenchUrl("agents", query)).toBe(
      "/agents?q=owned+bot&status=blocked&selected=native-1&selected=native-2",
    );
    expect(parseAgentRoute(query.toString())).toEqual({
      inventoryScope: "catalog",
      packageType: undefined,
      endUserAccess: "all", reportedUsage: "all", management: "all", relevance: "all",
      search: "owned bot",
      status: "blocked",
      publisher: undefined,
      availability: undefined,
      host: undefined,
      platform: undefined,
      createdWithinDays: "",
      sortBy: "displayName",
      sortDirection: "asc",
      page: 0,
      detailId: undefined,
      detailTab: undefined,
      selectedIds: ["native-1", "native-2"],
      refreshJobId: undefined,
      refreshMode: "application",
      controlJobId: undefined,
      environmentId: undefined,
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

  it("rejects repeated scalar routes without choosing a detail, job or filter", () => {
    const route = parseAgentRoute("inventory=all&inventory=catalog&detail=one&detail=two&refreshJob=one&refreshJob=two"
      + "&controlJob=one&controlJob=two&syncRun=one&syncRun=two&quarantineJob=one&quarantineJob=two"
      + "&inventorySnapshot=one&inventorySnapshot=two&type=~string:a&type=~string:b"
      + "&q=first&q=second&status=allowed&status=blocked&sort=status&sort=publisher&page=2&page=3"
      + "&selected=one&selected=two&selectedResource=graph_packages:one&selectedResource=graph_packages:two");
    expect(route).toMatchObject({
      inventoryScope: "catalog", detailId: undefined, refreshJobId: undefined, controlJobId: undefined,
      quarantineJobId: undefined, inventorySnapshotId: undefined,
      packageType: undefined, search: "", status: "all", sortBy: "displayName", page: 0,
      selectedIds: ["one", "two"], selectedPowerPlatformIds: ["graph_packages:one", "graph_packages:two"],
    });
    expect(parseDataSyncRoute("powerPlatformJob=one&powerPlatformJob=two&reports=import&reports=manage"))
      .toMatchObject({ powerPlatformJobId: undefined, reports: undefined });
    expect(parseSyncReportRoute("reports=import&staging=one&staging=two&correction=one&correction=two"))
      .toMatchObject({ stagingId: undefined, reportSetId: undefined });
    expect(parseUsersRoute("detail=one&detail=two&agent=one&agent=two&snapshot=one&snapshot=two"))
      .toMatchObject({ detailId: "invalid", agentId: undefined, reportSetId: undefined });
    expect(parseAuditRoute("q=one&q=two&action=block&action=unblock&status=failed&status=succeeded&page=2&page=3"))
      .toEqual({ search: "", action: "all", status: "all", page: 0, originChannel: "all" });
    expect(parseAgentRoute(agentRouteSearch(route).toString())).toEqual(route);
  });

  it("normalizes environment and numeric spellings before constructing inventory state", () => {
    const environmentId = "Default-AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const state = parseAgentRoute(`environment=~string:${environmentId}&createdWithinDays=00030`);
    expect(state).toMatchObject({ environmentId: environmentId.toLowerCase(), createdWithinDays: "30" });
    const search = agentRouteSearch({ ...state, environmentId, createdWithinDays: "00030" });
    expect(search.get("environment")).toBe(`~string:${environmentId.toLowerCase()}`);
    expect(search.get("createdWithinDays")).toBe("30");
    expect(parseAgentRoute("q=bad%00search").search).toBe("");
    expect(agentRouteSearch({ ...state, search: "bad\0search" }).has("q")).toBe(false);
    expect(auditRouteSearch({ ...parseAuditRoute(""), search: "bad\0search" }).has("q")).toBe(false);
    expect(usersRouteSearch({ ...parseUsersRoute(""), search: "bad\0search" }).has("q")).toBe(false);
    const opaque = parseAgentRoute("environment=~string:ENV-A");
    expect(opaque.environmentId).toBe("ENV-A");
    expect(agentRouteSearch(opaque).get("environment")).toBe("~string:ENV-A");
  });

  it.each([NaN, Infinity, 1.5])("does not serialize invalid numeric route state %s", value => {
    expect(agentRouteSearch({ ...parseAgentRoute(""), page: value, createdWithinDays: String(value) }).toString()).toBe("");
    expect(auditRouteSearch({ ...parseAuditRoute(""), page: value }).toString()).toBe("");
    const search = dataSyncRouteSearch({ refreshMode: "application", reports: { view: "snapshot", activityWindowDays: value } });
    expect(search.toString()).toBe("reports=snapshot");
    expect(parseSyncReportRoute(search.toString())?.activityWindowDays).toBe(30);
  });

  it("drops conflicting facets and malformed identities without losing valid page and sort state", () => {
    const params = new URLSearchParams({
      inventory: "all", page: "2", sort: "status", direction: "desc",
      publisher: "~string:Publisher A", environment: "~some-or-all",
      detail: "power_platform:env:bad%ZZ", inventorySnapshot: "bad\nsnapshot",
      selectionState: "session", selectionCount: "5001",
    });
    params.append("publisher", "~string:Publisher B");
    params.append("selectedResource", "agent:invalid");
    params.append("selectedResource", "power_platform:env:valid%2Fid");
    const route = parseAgentRoute(params.toString());
    expect(route).toMatchObject({
      inventoryScope: "all", page: 1, sortBy: "status", sortDirection: "desc",
      publisher: undefined, environmentId: undefined, detailId: undefined, inventorySnapshotId: undefined,
      selectedPowerPlatformIds: ["power_platform:env:valid%2Fid"],
    });
    expect(route).not.toHaveProperty("selectionStorage");
    expect(parseAgentRoute(agentRouteSearch(route).toString())).toEqual(route);
  });

  it("moves an oversized 5000-package selection out of the request URL without truncating its count", () => {
    const selectedIds = Array.from({ length: 5_000 }, (_, index) => `package-${index}-${"x".repeat(32)}`);
    const query = agentRouteSearch({
      inventoryScope: "catalog",
      packageType: undefined,
      endUserAccess: "all", reportedUsage: "all", management: "all", relevance: "all",
      search: "",
      status: "all",
      publisher: undefined,
      availability: undefined,
      host: undefined,
      platform: undefined,
      createdWithinDays: "",
      sortBy: "displayName",
      sortDirection: "asc",
      page: 0,
      selectedIds,
      refreshMode: "application",
      environmentId: undefined,
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

  it.each(["reports", "users", "controls"])("round trips the %s tab and canonical selections alongside exact source targets", detailTab => {
    const canonical = "agent:11111111-1111-4111-8111-111111111111";
    const native = "power_platform:environment-a:native%2Fagent";
    const route = parseAgentRoute(new URLSearchParams({
      detail: canonical, detailTab, inventorySnapshot: "snapshot-a",
    }).toString());
    route.selectedIds = ["package-a", "package-b"];
    route.selectedPowerPlatformIds = [canonical, native];
    expect(parseAgentRoute(agentRouteSearch(route).toString())).toMatchObject({
      detailId: canonical, detailTab, inventorySnapshotId: "snapshot-a",
      selectedIds: ["package-a", "package-b"], selectedPowerPlatformIds: [canonical, native],
    });
    expect(parseAgentRoute("detail=agent%3Ainvalid&selectedResource=agent%3Ainvalid")).toMatchObject({
      detailId: undefined, selectedPowerPlatformIds: [],
    });
  });

  it("keeps quarantine job-only links independently of a saved selection", () => {
    expect(parseAgentRoute("quarantineJob=job-1")).toMatchObject({
      selectedPowerPlatformIds: [],
      quarantineJobId: "job-1",
    });
  });

  it("canonicalizes environment and canonical-agent links without folding opaque native GUIDs for quarantine ownership", () => {
    const canonical = "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const environmentId = "default-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const native = `power_platform:${environmentId}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    const upperNative = `power_platform:${environmentId.toUpperCase()}:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA`;
    const upperResource = `power_platform:${environmentId}:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA`;
    const params = new URLSearchParams({ detail: "agent:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" });
    for (const id of [native, upperNative, canonical, "agent:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"]) params.append("selectedResource", id);
    expect(parseAgentRoute(params.toString())).toMatchObject({ detailId: canonical, selectedPowerPlatformIds: [native, upperResource, canonical] });
    const search = agentRouteSearch({ ...parseAgentRoute(""), detailId: upperNative,
      selectedPowerPlatformIds: [native, upperNative] });
    expect(search.get("detail")).toBe(upperResource);
    expect(search.getAll("selectedResource")).toEqual([native, upperResource]);
    expect(parseAgentRoute(new URLSearchParams({ detail: "graph_packages:Opaque%2fPackage%252Fvalue" }).toString()).detailId)
      .toBe("graph_packages:Opaque%2FPackage%252Fvalue");
    expect(parseAgentRoute(new URLSearchParams({ detail: "power_platform:ENV-A:Opaque%2fNative" }).toString()).detailId)
      .toBe("power_platform:ENV-A:Opaque%2FNative");
  });

  it("keeps package refresh/control links current and data sync owned only by the Sync route", () => {
    const route = parseAgentRoute("refreshJob=refresh-old&mode=application&controlJob=control-old&syncRun=sync-old&job=ambiguous");
    expect(route).toMatchObject({
      refreshJobId: "refresh-old",
      refreshMode: "application",
      controlJobId: "control-old",
    });

    expect(agentRouteSearch(route).toString()).toContain("refreshJob=refresh-old");
    expect(agentRouteSearch(route).toString()).toContain("controlJob=control-old");
    expect(route).not.toHaveProperty("syncRunId");
    expect(agentRouteSearch(route).has("syncRun")).toBe(false);
    expect(parseDataSyncRoute("syncRun=sync-current").syncRunId).toBe("sync-current");
    expect(agentRouteSearch(route).toString()).not.toContain("job=ambiguous");
  });

  it("ignores obsolete source/link filters without inferring a native detail identity", () => {
    const route = parseAgentRoute("source=power_platform&linkState=matched&environment=~string%3Aenv-a&detail=bot-a&selectedResource=power_platform%3Aenv-a%3Abot-a");
    expect(route).toMatchObject({
      environmentId: "env-a",
      detailId: "bot-a",
      selectedPowerPlatformIds: ["power_platform:env-a:bot-a"],
    });

    expect(agentRouteSearch(route).has("source")).toBe(false);
    expect(agentRouteSearch(route).has("linkState")).toBe(false);
    expect(route).not.toHaveProperty("source");
    expect(route).not.toHaveProperty("linkState");
    expect(parseAgentRoute(agentRouteSearch(route).toString()).detailId).toBe(route.detailId);
    expect(parseAgentRoute("source=power_platform&environment=~string%3Aenv-a&detail=graph_packages%3Apackage-a").detailId).toBe("graph_packages:package-a");
  });

  it("round trips source-specific audit and Sync report state", () => {
    const audit = parseAuditRoute("source=purview&job=older&q=actor&action=block&status=failed&page=3");
    expect(audit).toEqual({ search: "actor", action: "block", status: "failed", page: 2, originChannel: "all" });
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
    const search = dataSyncRouteSearch({ refreshMode: "application", reports: {
      view: "snapshot", reportSetId: "bad\nid", activityWindowDays: 365,
    } });
    expect(search.has("snapshot")).toBe(false);
    expect(parseSyncReportRoute(search.toString())).toMatchObject({ reportSetId: undefined, activityWindowDays: 365 });
  });

  it.each([undefined, "owned-stage"])("round trips correction intent with staging link %s", stagingId => {
    const state = { refreshMode: "application" as const, reports: {
      view: "import" as const, reportSetId: "11111111-1111-4111-8111-111111111111", stagingId, activityWindowDays: 30,
    } };
    const search = dataSyncRouteSearch(state);
    expect(search.get("correction")).toBe(state.reports.reportSetId);
    expect(search.has("snapshot")).toBe(false);
    expect(parseDataSyncRoute(search.toString()).reports).toEqual(state.reports);
    expect(parseSyncReportRoute("reports=manage&correction=retained")?.reportSetId).toBeUndefined();
    expect(parseSyncReportRoute("reports=snapshot&correction=retained")?.reportSetId).toBeUndefined();
    expect(parseSyncReportRoute("reports=import&correction=bad%0Aid")?.reportSetId).toBeUndefined();
  });

  it("round trips raw Graph types and combined evidence filters with all supported table sorts", () => {
    for (const packageType of [undefined, null, "firstParty", "thirdParty", "shared", "lob", "futureType", "microsoft", "all", "a & b"]) {
      for (const sortBy of ["hosts", "responses", "activeUsers", "lastActivity", "owner", "publisher"] as const) {
        const route = { ...parseAgentRoute("detail=graph_packages%3Apackage-a&access=available&usage=used&management=organization_managed&relevance=organization"), packageType, sortBy, sortDirection: "desc" as const };
        expect(parseAgentRoute(agentRouteSearch(route).toString())).toEqual(route);
      }
    }
    expect(parseAgentRoute("show=unsupported&sort=unsupported")).toMatchObject({ packageType: undefined, sortBy: "displayName" });
    expect(agentRouteSearch(parseAgentRoute("")).has("show")).toBe(false);
  });

  it("round trips unknown and literal reserved-looking facets without changing their meaning", () => {
    for (const value of [undefined, null, "all", "__unknown__", "__some_or_all__", "~null", "~some-or-all", "公司🌏"]) {
      const state = { ...parseAgentRoute(""), packageType: value, publisher: value, host: value, platform: value,
        availability: value, environmentId: value };
      expect(parseAgentRoute(agentRouteSearch(state).toString())).toEqual(state);
    }
    const state = { ...parseAgentRoute(""), availability: { kind: "some-or-all" as const } };
    expect(parseAgentRoute(agentRouteSearch(state).toString())).toEqual(state);
    expect(agentRouteSearch({ ...parseAgentRoute(""), publisher: "all" }).get("publisher")).toBe("~string:all");
    expect(agentRouteSearch({ ...parseAgentRoute(""), publisher: null }).get("publisher")).toBe("~null");
  });

  it("round trips the unified agent inventory export audit action", () => {
    const route = parseAuditRoute("action=export-agent-inventory&status=succeeded");
    expect(route.action).toBe("export-agent-inventory");
    expect(parseAuditRoute(auditRouteSearch(route).toString())).toEqual(route);
  });

  it.each([
    "reassign", "submit-hunting", "query-hunting",
    "cancel-hunting", "delete-hunting",
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
    expect(dataSyncRouteSearch({ refreshMode: "application", reports: historical }).toString()).toBe(`reports=snapshot&snapshot=${reportSetId}`);
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

  it("falls back from deferred user Purview deep links while retaining adoption state", () => {
    const detailId = "11111111-1111-4111-8111-111111111111";
    const search = usersRouteSearch({ view: "licenses", section: "adoption", company: "Contoso", detailId, search: "", page: 0 });
    search.set("tab", "purview");
    const route = parseUsersRoute(search.toString());
    expect(route).toMatchObject({ section: "adoption", company: "Contoso", detailId, detailTab: "overview" });
    expect(usersRouteSearch({ ...route, detailTab: "purview" }).get("tab")).toBeNull();
    expect(parseUsersRoute(usersRouteSearch(route).toString())).toMatchObject({ company: "Contoso" });
  });

  it("drops obsolete provider source, job and user parameters from local Audit", () => {
    const route = parseAuditRoute("source=purview&user=employee%2Btest%40example.invalid");
    expect(route).toEqual({ search: "", action: "all", status: "all", page: 0, originChannel: "all" });
    expect(auditRouteSearch(route).toString()).toBe("");
    expect(auditRouteSearch(parseAuditRoute("job=old&source=purview&action=block")).toString()).toBe("action=block");
  });
});
