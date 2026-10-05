import { describe, expect, it } from "vitest";
import { reportQueryString } from "../api/reportData";
import { selectedAgentsPage, selectedFixtureLicensedRows, selectedFixtureQuery, selectedFixtureRead, selectedFixtureWindow,
  selectedLicensedUser, selectedOverviewPage, selectedPlansPage, selectedRelationshipsPage, selectedReportUsersPage, selectedUsersPage } from "./selectedUsageFixture";

describe("selected user fixture contracts", () => {
  it.each(selectedUsersPage().value)("keeps $directory.displayName scalar facts separate from paged plans and relationships", user => {
    const page = selectedUsersPage();
    expect(selectedFixtureRead(`/api/copilot-usage/users/${user.directory.objectId}?selectionId=${page.selection.id}`))
      .toEqual({ value: user, selection: page.selection, reports: page.reports, sources: page.sources });
    expect(user.servicePlanCount).toBe(1);
    expect(user).not.toHaveProperty("importedUsage");
    expect(user).not.toHaveProperty("servicePlans");
    expect(user).not.toHaveProperty("rows");
    expect(page.reports.lineages).toHaveLength(3);
  });

  it("counts recent app activity independently of zero or missing agent usage", () => {
    const page = selectedUsersPage();
    expect(page.sources.app_activity).toMatchObject({ state: "available", reportRefreshDate: "2026-09-12" });
    for (const user of page.value) {
      expect(user.appActivity).toMatchObject({ reportRefreshDate: "2026-09-12", lastActivityDate: "2026-09-11" });
    }
    expect(page.value.map(user => user.reportedResponses)).toEqual([200, 3, 0, null]);
    expect(page.summary).toMatchObject({ licensedUsers: 4, measuredActivityUsers: 4, needsAttentionUsers: 2,
      unknownMetricsUsers: 1, unresolvedIdentities: 1 });
    expect(page.counts).toEqual({ total: 4, filtered: 4 });
  });

  it.each([
    [null, "unknown", ["agent_usage_unknown"]],
    [0, "none", ["agent_usage_zero"]],
    [1, "active", ["agent_usage_low"]],
    [5, "active", ["agent_usage_low"]],
    [6, "active", []],
  ] as const)("preserves the response-count boundary %s", (count, activity, attention) => {
    const user = selectedLicensedUser(42, "Sample", count);
    expect(user.attention).toEqual(attention);
    expect(user.reportedResponses).toBe(count);
    expect(user.agentActivityState).toBe(activity);
    expect(user.reportMatch).toBe(count === null ? "missing" : "matched");
    expect(user.reportedAgentsUsed).toBe(count === null ? null : count > 0 ? 1 : 0);
    expect(user.appActivity?.lastActivityDate).toBe("2026-09-11");
    expect(user.copilotServiceState).toBe("enabled");
    expect(user.entitlement).toBe("paid_active");
    expect(selectedPlansPage().value).toEqual([expect.objectContaining({
      service: "M365_COPILOT_APPS", state: "enabled", capabilityStatus: "Enabled",
    })]);
    expect(user).not.toHaveProperty("licenses");
  });

  it("serves only the frozen service-plan child path and never aliases retired containers", () => {
    const page = selectedUsersPage(), path = `/api/copilot-usage/users/${page.value[0].directory.objectId}`;
    expect(selectedFixtureRead(`${path}/service-plans?selectionId=${page.selection.id}`))
      .toMatchObject({ value: selectedPlansPage().value, selection: page.selection, counts: { total: 1, filtered: 1 } });
    for (const path of ["/api/official-usage/admin", "/api/official-usage/agent-users", "/api/copilot-usage/users.csv"]) {
      expect(selectedFixtureRead(path)).toBeUndefined();
    }
    expect(selectedFixtureRead(`${path}/plans`)).toBeUndefined();
  });

  it("honors server-side search, cohorts, sort and current paid entitlement", () => {
    const directory = selectedUsersPage(), unpaid = selectedLicensedUser(5, "Unpaid", 999);
    unpaid.entitlement = "no_paid"; unpaid.copilotServiceState = "disabled";
    directory.value.push(unpaid);
    expect(selectedFixtureRead("/api/copilot-usage/users?sort=responses&order=asc&cohort=licensed", directory))
      .toMatchObject({ value: [directory.value[2], directory.value[1], directory.value[0], directory.value[3]], counts: { total: 4, filtered: 4 } });
    expect(selectedFixtureRead("/api/copilot-usage/users?cohort=needs_attention&lowResponseThreshold=2", directory))
      .toMatchObject({ value: [directory.value[2]], counts: { total: 4, filtered: 1 } });
    expect(selectedFixtureRead("/api/copilot-usage/users?search=drew&cohort=unknown_metrics", directory))
      .toMatchObject({ value: [directory.value[3]], counts: { total: 4, filtered: 1 } });
    expect(selectedFixtureRead("/api/copilot-usage/users?company=~string:Other", directory)).toMatchObject({ value: [], counts: { total: 4, filtered: 0 } });
    expect(selectedFixtureRead("/api/copilot-usage/users?company=~null", directory)).toMatchObject({ value: [], counts: { total: 4, filtered: 0 } });
  });

  it("uses bounded cursor pages while retaining exact server counts", () => {
    const rows = Array.from({ length: 2053 }, (_, index) => selectedLicensedUser(index + 1, `Person${index}`, index));
    const base = { ...selectedUsersPage(), counts: { total: rows.length, filtered: rows.length } };
    const first = selectedFixtureWindow("/api/copilot-usage/users?limit=50", rows, base);
    expect(first.value).toHaveLength(50);
    expect(first.counts).toEqual({ total: 2053, filtered: 2053 });
    expect(first.page).toEqual({ limit: 50, nextCursor: "fixture:50", previousCursor: null });
    const final = selectedFixtureWindow("/api/copilot-usage/users?limit=50&cursor=fixture:2050", rows, base);
    expect(final.value).toHaveLength(3);
    expect(final.page).toEqual({ limit: 50, nextCursor: null, previousCursor: "fixture:2000" });
  });

  it("retains supported query fields and endpoint ordering defaults", () => {
    const query = { entitlement: "paid_active", serviceState: "warning", appActivity: "inactive", inactiveDays: 7,
      responsesOnly: false, company: null, department: "~null" } as const;
    expect(selectedFixtureQuery(`/api/copilot-usage/users${reportQueryString(query)}`)).toMatchObject(query);
    expect(selectedFixtureQuery("/api/copilot-usage/users")).toMatchObject({ sort: "name", order: "asc" });
    expect(selectedFixtureQuery("/api/official-usage/aggregate")).toMatchObject({ sort: "responses", order: "desc" });
    expect(selectedFixtureQuery("/api/official-usage/history/options")).toMatchObject({ sort: "acceptedAt", order: "desc" });
  });

  it.each([
    ["zero", ["Cleo"]], ["low", ["Ben"]], ["review", ["Ben", "Cleo"]],
  ] as const)("supports the %s response cohort", (cohort, names) => {
    expect(selectedFixtureLicensedRows(selectedUsersPage(), { cohort, sort: "name", order: "asc" })
      .map(row => row.directory.displayName)).toEqual(names);
  });

  it("includes Office inactivity, unknown Office metrics and all non-enabled paid feature states", () => {
    const directory = selectedUsersPage();
    directory.value[0].activityState = "inactive";
    directory.value[1].activityState = "unknown";
    directory.value[3].copilotServiceState = "suspended";
    expect(selectedFixtureLicensedRows(directory, { cohort: "needs_attention", lowResponseThreshold: 2 }).map(row => row.directory.displayName))
      .toEqual(["Ada", "Cleo", "Drew"]);
    expect(selectedFixtureLicensedRows(directory, { cohort: "unknown_metrics" }).map(row => row.directory.displayName))
      .toEqual(["Ben", "Drew"]);
    expect(selectedFixtureRead("/api/copilot-usage/users?appActivity=inactive&serviceState=enabled", directory))
      .toMatchObject({ value: [directory.value[0]] });
  });

  it("searches normalized organization text and applies relationship filters to the same link", () => {
    const directory = selectedUsersPage();
    expect(selectedFixtureLicensedRows(directory, { search: "  \uFF2F\uFF30\uFF25\uFF32\uFF21\uFF34\uFF29\uFF2F\uFF2E\uFF33  " })).toHaveLength(4);
    expect(selectedFixtureLicensedRows(directory, { agentId: "synthetic-researcher", responsesOnly: true }))
      .toEqual([directory.value[0]]);
    expect(selectedFixtureLicensedRows(directory, { agentId: "synthetic-researcher", creatorType: "Your org" })).toEqual([]);
    expect(selectedFixtureLicensedRows(directory, { search: "Helpdesk", creatorType: "Microsoft" })).toEqual([]);
  });

  it("sorts UPN and Office last activity without substituting response counts", () => {
    const directory = selectedUsersPage();
    directory.value[0].directory.userPrincipalName = "zulu@example.invalid";
    directory.value[0].appActivity = null;
    directory.value[1].appActivity!.lastActivityDate = "2026-09-10";
    directory.value[2].appActivity!.lastActivityDate = "2026-09-12";
    directory.value[3].appActivity!.lastActivityDate = "2026-09-11";
    expect(selectedFixtureLicensedRows(directory, { sort: "upn", order: "asc" }).map(row => row.directory.displayName))
      .toEqual(["Ben", "Cleo", "Drew", "Ada"]);
    expect(selectedFixtureLicensedRows(directory, { sort: "appActivity", order: "desc" }).map(row => row.directory.displayName))
      .toEqual(["Cleo", "Drew", "Ben", "Ada"]);
  });

  it("filters dates using user activity and an inclusive observed-date window", () => {
    const directory = selectedUsersPage();
    directory.value[0].userLastActivityDateUtc = "2026-09-12";
    directory.value[1].userLastActivityDateUtc = "2026-09-10";
    directory.value[2].userLastActivityDateUtc = "2026-09-09";
    expect(selectedFixtureLicensedRows(directory, { reportActivity: "recent", inactiveDays: 3 }).map(row => row.directory.displayName))
      .toEqual(["Ada", "Ben"]);
    expect(selectedFixtureLicensedRows(directory, { reportActivity: "inactive", inactiveDays: 3 }).map(row => row.directory.displayName))
      .toEqual(["Cleo"]);
    expect(selectedFixtureLicensedRows(directory, { reportActivity: "no-activity" }).map(row => row.directory.displayName)).toEqual(["Drew"]);
    expect(selectedFixtureLicensedRows(directory, { startDate: "2026-09-10", endDate: "2026-09-10" })).toEqual([directory.value[1]]);
  });

  it("honors agent and reported-user filters and sorting", () => {
    expect(selectedAgentsPage({ creatorType: "Your org" }).value.map(row => row.agentName)).toEqual(["Helpdesk"]);
    expect(selectedAgentsPage({ agentId: "missing" }).value).toEqual([]);
    expect(selectedAgentsPage({ sort: "unlicensedUsers", order: "asc" }).value.map(row => row.agentName)).toEqual(["Helpdesk", "Researcher"]);
    expect(selectedReportUsersPage({ cohort: "zero" }).value.map(row => row.displayName)).toEqual(["Ben"]);
    expect(selectedReportUsersPage({ company: null }).value.map(row => row.displayName)).toEqual(["Concealed report user"]);
    expect(selectedReportUsersPage({ startDate: "2026-09-10" }).value).toEqual([]);
    expect(selectedReportUsersPage({ sort: "responses", order: "asc" }).value.map(row => row.reportedResponses)).toEqual([0, 12, 40, 215]);
  });

  it("searches, filters and sorts relationship rows before pagination", () => {
    const page = selectedRelationshipsPage({ username: "ada@example.invalid", search: "helpdesk" });
    expect(page.value.map(row => row.agentName)).toEqual(["Helpdesk"]);
    expect(selectedRelationshipsPage({ agentId: "synthetic-researcher", responsesOnly: true }).value).toHaveLength(2);
    expect(selectedRelationshipsPage({ creatorType: "Your org", sort: "responses", order: "asc" }).value.map(row => row.responses)).toEqual([15, 40]);
    expect(selectedRelationshipsPage({ startDate: "2026-09-12", endDate: "2026-09-12" }).value).toHaveLength(3);
  });

  it.each([
    ["/api/official-usage/aggregate", 2],
    ["/api/official-usage/overview", 2],
    ["/api/official-usage/users", 4],
    ["/api/official-usage/agents/synthetic-researcher/users", 3],
    ["/api/official-usage/users/ada%40example.invalid/agents", 2],
    [`/api/copilot-usage/users/${selectedUsersPage().value[0].directory.objectId}/agents`, 2],
  ])("pages %s without changing filtered counts", (path, count) => {
    const first = selectedFixtureRead(`${path}?limit=1`);
    expect(first).toMatchObject({ value: [expect.anything()], counts: { filtered: count },
      page: { limit: 1, nextCursor: "fixture:1", previousCursor: null } });
    const second = selectedFixtureRead(`${path}?limit=1&cursor=fixture:1`);
    expect(second).toMatchObject({ value: [expect.anything()], counts: { filtered: count },
      page: { limit: 1, previousCursor: "fixture:0" } });
    expect(second?.value).not.toEqual(first?.value);
  });

  it.each([
    "/api/official-usage/history", "/api/official-usage/history/options", "/api/copilot-usage/users/unresolved-identities",
    `/api/copilot-usage/users/${selectedUsersPage().value[0].directory.objectId}/service-plans`,
    "/api/official-usage/users/ada%40example.invalid/service-plans",
  ])("honors the page envelope on %s", path => {
    expect(selectedFixtureRead(`${path}?limit=1&cursor=fixture:1`)).toMatchObject({
      value: [], counts: { filtered: 1 }, page: { limit: 1, nextCursor: null },
    });
  });

  it("keeps history options lightweight", () => {
    const options = selectedFixtureRead("/api/official-usage/history/options?limit=1");
    expect(Object.keys(options!).sort()).toEqual(["counts", "page", "reports", "selection", "value"]);
  });

  it.each(["0", "101", "1000", "Infinity", "1.5", "1e2", "0x10", "", "-1"])("rejects invalid page limit %s rather than clamping it", limit => {
    expect(() => selectedFixtureWindow(`/api/copilot-usage/users?limit=${limit}`, [], selectedUsersPage())).toThrow("Invalid synthetic cursor page");
  });

  it.each(["", "1", "fixture:", "fixture:-1", "fixture:1.5", "fixture:1e2", "other:1"])("rejects malformed synthetic cursor %s", cursor => {
    expect(() => selectedFixtureWindow(`/api/copilot-usage/users?cursor=${cursor}`, [], selectedUsersPage())).toThrow("Invalid synthetic cursor page");
  });

  it("does not widen relationship scope when a directory identity has no report match", () => {
    const directory = selectedUsersPage(), user = directory.value[0];
    user.directory.userPrincipalName = ""; user.reportedUsername = null; user.reportMatch = "missing";
    expect(selectedFixtureRead(`/api/copilot-usage/users/${user.directory.objectId}/agents`, directory)).toMatchObject({
      value: [], counts: { total: 0, filtered: 0 },
    });
    user.directory.userPrincipalName = "alias@example.invalid"; user.reportedUsername = "ada@example.invalid"; user.reportMatch = "matched";
    expect(selectedFixtureRead(`/api/copilot-usage/users/${user.directory.objectId}/agents`, directory)).toMatchObject({
      counts: { total: 2, filtered: 2 }, value: [expect.objectContaining({ username: "ada@example.invalid" }), expect.objectContaining({ username: "ada@example.invalid" })],
    });
  });

  it.each([
    "/api/official-usage/agents/missing/users", "/api/official-usage/users/missing/agents",
    "/api/official-usage/agents/synthetic-researcher/users/extra", "/api/official-usage/users/ada%40example.invalid/agents/extra",
    `/api/copilot-usage/users/${selectedUsersPage().value[0].directory.objectId}/service-plans/extra`,
  ])("does not serve an unknown exact route %s", path => {
    expect(selectedFixtureRead(path)).toBeUndefined();
  });

  it("facets use their real rows, retain other filters and page matching options", () => {
    const directory = selectedUsersPage();
    directory.value[0].directory.companyName = "Fabrikam";
    directory.value[0].directory.department = "Sales";
    expect(selectedFixtureRead("/api/copilot-usage/users/facets?field=company&department=~string:Sales", directory))
      .toMatchObject({ value: [{ value: "Fabrikam", count: 1 }] });
    expect(selectedFixtureRead("/api/official-usage/aggregate/facets?field=creatorType&limit=1"))
      .toMatchObject({ value: [{ value: "Microsoft", count: 1 }], counts: { filtered: 2 }, page: { nextCursor: "fixture:1" } });
    expect(selectedFixtureRead("/api/official-usage/users/facets?field=company&search=missing"))
      .toMatchObject({ value: [], counts: { filtered: 0 } });
    expect(() => selectedFixtureRead("/api/official-usage/aggregate/facets?field=company")).toThrow("Unexpected selected fixture facet");
  });

  it("computes agent analytics independently of display sorting and within the requested window", () => {
    const page = selectedAgentsPage({ sort: "name", order: "asc", activityWindowDays: 1, inactiveDays: 1 });
    expect(page.analytics.agents).toMatchObject({ inactive: 2, windowAgents: 1, windowResponses: 215, windowDistinctActiveUsers: 2,
      mostResponses: [{ name: "Researcher", responses: 215 }, { name: "Helpdesk", responses: 55 }],
      leastResponses: [{ name: "Helpdesk", responses: 55 }, { name: "Researcher", responses: 215 }] });
    expect(selectedAgentsPage({ search: "Helpdesk" }).analytics.agents).toMatchObject({
      anchorDateUtc: "2026-09-12", windowAgents: 1, windowResponses: 55, windowDistinctActiveUsers: 2,
    });
    expect(selectedAgentsPage({ search: "missing" }).analytics).toMatchObject({
      rowCount: 0, responses: null, zeroResponses: 0, unknownResponses: 0,
      agents: { windowResponses: null, windowDistinctActiveUsers: 0, mostResponses: [], leastResponses: [] },
    });
  });

  it.each([
    ["/api/copilot-usage/users?cohort=review&limit=1", 2, 3, { zero: 1, low: 1, unknown: 0 }],
    ["/api/official-usage/users?cohort=zero", 1, 0, { zero: 1, low: 0, unknown: 0 }],
    ["/api/official-usage/users/ada%40example.invalid/agents?limit=1", 2, 215, null],
  ])("computes analytics over all filtered rows before paging %s", (path, rowCount, responses, review) => {
    expect(selectedFixtureRead(path)).toMatchObject({ value: [expect.anything()], analytics: { rowCount, responses, review } });
  });

  it("computes overview analytics from matching agents, including an empty result", () => {
    expect(selectedOverviewPage({ search: "Helpdesk" }).analytics.overview).toMatchObject({
      reportedAgents: 1, usedAgents: 1, active30Days: 1, earliestActivityDateUtc: "2026-09-11", latestActivityDateUtc: "2026-09-11",
    });
    expect(selectedOverviewPage({ search: "missing" }).analytics.overview).toMatchObject({
      reportedAgents: 0, usedAgents: 0, active30Days: 0, earliestActivityDateUtc: null, latestActivityDateUtc: null,
    });
  });
});
