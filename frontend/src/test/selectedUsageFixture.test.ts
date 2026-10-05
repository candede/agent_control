import { describe, expect, it } from "vitest";
import { selectedFixtureRead, selectedFixtureWindow, selectedLicensedUser, selectedPlansPage, selectedUsersPage } from "./selectedUsageFixture";

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
});
