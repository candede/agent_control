import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page, Route } from "@playwright/test";
import type { CombinedUser, ReportPage, ReportQuery } from "../../../backend/src/types/officialReportData";
import { mockSelectedPaidUsers } from "../../browser/selectedPaidFixture";
import { reportQueryString } from "../api/reportData";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { SavedQueryProvider } from "../components/SavedQueryProvider";
import { createSavedQueryClient } from "../savedQueries";
import { useReportPage } from "../useReportPage";
import { deferred } from "./deferred";
import { historySet } from "./reportDataFixture";
import { selectedAgentsPage, selectedFixtureLicensedRows, selectedFixtureQuery, selectedFixtureRead, selectedFixtureWindow,
  selectedHistoryPage, selectedLicensedUser, selectedOverviewPage, selectedPlansPage, selectedRelationshipsPage, selectedReportUsersPage, selectedUsersPage } from "./selectedUsageFixture";

vi.mock("@playwright/test", () => ({ expect }));

const clients: ReturnType<typeof createSavedQueryClient>[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

async function paidFixture(source = selectedUsersPage()) {
  const route = vi.fn<Page["route"]>();
  const state = await mockSelectedPaidUsers({ route }, source);
  const handler = route.mock.calls[0][1];
  async function request(input: string) {
    const fulfill = vi.fn<Route["fulfill"]>(), fallback = vi.fn<Route["fallback"]>();
    const intercepted = {
      request: () => ({ url: () => new URL(input, "http://localhost").href, method: () => "GET" }) as ReturnType<Route["request"]>,
      fulfill, fallback, abort: vi.fn<Route["abort"]>(), continue: vi.fn<Route["continue"]>(), fetch: vi.fn<Route["fetch"]>(),
    } satisfies Route;
    await handler(intercepted, intercepted.request());
    expect(fallback).not.toHaveBeenCalled();
    expect(fulfill).toHaveBeenCalledOnce();
    const response = fulfill.mock.calls[0][0]!;
    return new Response(response.body?.toString() ?? JSON.stringify(response.json), { status: response.status ?? 200, headers: { "Content-Type": "application/json" } });
  }
  return { state, source, request };
}

describe("selected user fixture contracts", () => {
  it("isolates cursor responses from their input rows, filters and captured metadata", () => {
    const source = selectedUsersPage(), before = structuredClone(source);
    source.filters = { company: "Contoso Health" };
    const page = selectedFixtureWindow("/api/copilot-usage/users?limit=1", source.value, source);
    page.value[0].directory.displayName = "Other account";
    page.sources.directory.revision = "changed";
    page.filters.company = null;
    page.reports.lineages[0].rowCount = 0;
    page.selection.expiresAt = "invalid";
    page.analytics.review!.low = 0;
    expect(source).toEqual({ ...before, filters: { company: "Contoso Health" } });
  });

  it.each([
    "/api/copilot-usage/users",
    `/api/copilot-usage/users/${selectedUsersPage().value[0].directory.objectId}`,
    `/api/copilot-usage/users/${selectedUsersPage().value[0].directory.objectId}/agents`,
    `/api/copilot-usage/users/${selectedUsersPage().value[0].directory.objectId}/service-plans`,
    "/api/official-usage/users/ada%40example.invalid/directory",
    "/api/official-usage/users/ada%40example.invalid",
    "/api/official-usage/agents/synthetic-researcher",
    "/api/official-usage/history/options",
    "/api/copilot-usage/users/facets?field=company",
  ])("returns detached JSON evidence for %s", path => {
    const source = selectedUsersPage(), before = structuredClone(source);
    const response = selectedFixtureRead(path, source)!;
    const expected = structuredClone(response);
    if (!Array.isArray(response.value) && "directory" in response.value) response.value.directory.displayName = "Changed response";
    if ("sources" in response) response.sources.directory.generationId = "changed";
    expect(source).toEqual(before);
    source.value[0].directory.displayName = "Changed source";
    source.selection.revision = "changed";
    source.sources.app_activity.state = "unavailable";
    const reread = selectedFixtureRead(path, before);
    expect(reread).toEqual(expected);
    expect(response.selection.revision).toBe(expected.selection.revision);
    if ("sources" in response) expect(response.sources.app_activity.state).toBe("available");
    if (!Array.isArray(response.value) && "directory" in response.value) {
      expect(source.value[0].directory.displayName).toBe("Changed source");
    }
  });

  it("does not retain a caller's mutable query in agent or relationship pages", () => {
    for (const create of [selectedAgentsPage, selectedReportUsersPage, selectedRelationshipsPage, selectedOverviewPage]) {
      const query: ReportQuery = { search: "Researcher", order: "asc" };
      const page = create(query);
      query.search = "Helpdesk";
      expect(page.filters.search).toBe("Researcher");
      page.filters.order = "desc";
      expect(query.order).toBe("asc");
    }
  });

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
    expect(selectedFixtureRead("/api/capabilities/check-progress?retry=failed")).toBeUndefined();
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
    expect(selectedFixtureQuery("/api/official-usage/history/options")).toMatchObject({ sort: "reportingPeriod", order: "desc" });
    expect(selectedFixtureQuery("/api/official-usage/history?sort=reportingPeriod&order=desc"))
      .toMatchObject({ sort: "reportingPeriod", order: "desc" });
  });

  it.each([
    "cohort=missing", "responsesOnly=1", "order=up", "sort=missing", "scope=other", "inactiveDays=NaN",
    "inactiveDays=0", "activityWindowDays=366", "lowResponseThreshold=1.5", "lowResponseThreshold=100000001",
    "startDate=2026-02-30", "startDate=2026-09-12&endDate=2026-09-11", "search=%0A", "search=" + "a".repeat(257),
    "company=unencoded", "entitlement=paid_active&entitlement=no_paid", "typo=true", "agentId=%20", "setId=missing",
  ])("rejects invalid query data rather than serving an unfiltered success: %s", query => {
    expect(() => selectedFixtureQuery(`/api/copilot-usage/users?${query}`)).toThrow();
  });

  it("canonicalizes equivalent search forms before capturing filters", () => {
    for (const [text, expected] of [[" \u00a8 ", "\u0308"], ["J\u030c", "\u01f0"], [" ＡＤＡ ", "ada"]]) {
      expect(selectedFixtureQuery(`/api/copilot-usage/users${reportQueryString({ search: text })}`).search).toBe(expected);
      const directory = selectedUsersPage();
      directory.value[0].directory.displayName = text;
      expect(selectedFixtureLicensedRows(directory, { search: expected })).toEqual([directory.value[0]]);
    }
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

  it("filters the nonpaid cohort without inventing activity or changing scalar report facts", () => {
    const all = selectedReportUsersPage(), cohort = selectedReportUsersPage({ licenseCohort: "active_without_paid" });
    expect(cohort.value).toEqual(all.value.filter(row => row.hasActivity && ["no_paid", "paid_inactive"].includes(row.entitlement ?? "")));
    expect(cohort.summary).toEqual(all.summary);
    expect(cohort.analytics).toMatchObject({ rowCount: 1, responses: 40, review: { zero: 0, low: 0, unknown: 0 } });
    expect(selectedReportUsersPage({ licenseCohort: "active_without_paid", username: "ben@example.invalid" }).value).toEqual([]);
  });

  it("searches, filters and sorts relationship rows before pagination", () => {
    const page = selectedRelationshipsPage({ username: "ada@example.invalid", search: "helpdesk" });
    expect(page.value.map(row => row.agentName)).toEqual(["Helpdesk"]);
    expect(selectedRelationshipsPage({ agentId: "synthetic-researcher", responsesOnly: true }).value).toHaveLength(2);
    expect(selectedRelationshipsPage({ creatorType: "Your org", sort: "responses", order: "asc" }).value.map(row => row.responses)).toEqual([15, 40]);
    expect(selectedRelationshipsPage({ startDate: "2026-09-12", endDate: "2026-09-12" }).value).toHaveLength(3);
  });

  it.each([
    ["/api/official-usage/agents/synthetic-researcher/users?agentId=helpdesk%2Freport%3A2", 3],
    ["/api/official-usage/users/ada%40example.invalid/agents?username=ben%40example.invalid", 2],
    [`/api/copilot-usage/users/${selectedUsersPage().value[0].directory.objectId}/agents?username=ben%40example.invalid`, 2],
  ])("does not overwrite conflicting relationship filters with the exact path identity: %s", (path, total) => {
    expect(selectedFixtureRead(path)).toMatchObject({ value: [], counts: { total, filtered: 0 }, analytics: { rowCount: 0, responses: null } });
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

  describe("paid-user browser selection ownership", () => {
    const root = "/api/copilot-usage/users";

    it("revalidates equivalent filters but rejects report-set relabeling on captured children", async () => {
      const { source, request } = await paidFixture();
      const first = await (await request(`${root}?search=${encodeURIComponent(" ＡＤＡ ")}&limit=1`)).json();
      const selected = `selectionId=${first.selection.id}`;
      expect((await request(`${root}?${selected}&search=ada&lowResponseThreshold=5&inactiveDays=30&activityWindowDays=30`)).status).toBe(200);
      const missingSet = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      expect((await request(`${root}?setId=${missingSet}`)).status).toBe(404);
      expect((await request(`${root}/${source.value[0].directory.objectId}/agents?${selected}&setId=${missingSet}`)).status).toBe(400);
      for (const path of [`${root}/${source.value[0].directory.objectId}`, `${root}/${source.value[0].directory.objectId}/service-plans`,
        `${root}/facets?field=company`]) {
        expect((await request(`${path}${path.includes("?") ? "&" : "?"}${selected}&cohort=review`)).status).toBe(400);
      }
      expect((await request(`${root}?selectionId=`)).status).toBe(409);
      expect((await request(`${root}?selectionId=${first.selection.id.toUpperCase()}`)).status).toBe(200);
    });

    it("rejects expired captures without renewing retries or children", async () => {
      vi.useFakeTimers();
      const fixture = await paidFixture();
      fixture.source.selection.expiresAt = new Date(Date.now() + 1000).toISOString();
      const first = await (await fixture.request(root)).json();
      await vi.advanceTimersByTimeAsync(1000);
      const selected = `selectionId=${first.selection.id}`;
      for (const path of [root, `${root}/facets?field=company`, `${root}/${first.value[0].directory.objectId}/agents`]) {
        expect((await fixture.request(`${path}${path.includes("?") ? "&" : "?"}${selected}`)).status).toBe(409);
      }
    });

    it("invalidates deleted history without confusing publication revisions with invalidation", async () => {
      const fixture = await paidFixture();
      const first = await (await fixture.request(root)).json();
      fixture.source.reports.activeRevision = "next";
      fixture.source.reports.historyRevision = "next";
      expect(await (await fixture.request(`${root}?selectionId=${first.selection.id}`)).json()).toEqual(first);
      fixture.source.reports.historyEpoch = "deleted";
      expect((await fixture.request(`${root}?selectionId=${first.selection.id}`)).status).toBe(409);
      const replacement = await (await fixture.request(root)).json();
      expect(replacement.reports.historyEpoch).toBe("deleted");
      expect(replacement.selection.id).not.toBe(first.selection.id);
    });

    it("binds cursors to the captured owner, child route and child filters", async () => {
      const fixture = await paidFixture();
      const first = await (await fixture.request(`${root}?limit=1`)).json();
      const other = await (await fixture.request(`${root}?limit=1`)).json();
      expect((await fixture.request(`${root}?selectionId=${other.selection.id}&cursor=${encodeURIComponent(first.page.nextCursor)}`)).status).toBe(400);
      const child = `${root}/${first.value[0].directory.objectId}/agents`;
      const page = await (await fixture.request(`${child}?selectionId=${first.selection.id}&limit=1`)).json();
      const cursor = `selectionId=${first.selection.id}&cursor=${encodeURIComponent(page.page.nextCursor)}&limit=1`;
      expect((await fixture.request(`${root}?${cursor}`)).status).toBe(400);
      expect((await fixture.request(`${child}?${cursor}&responsesOnly=true`)).status).toBe(400);
      const next = await (await fixture.request(`${child}?${cursor}`)).json();
      expect(next.value[0]).not.toEqual(page.value[0]);
      expect(next.selection).toEqual(page.selection);
      expect((await fixture.request(`${root}?cursor=${encodeURIComponent(first.page.nextCursor)}&limit=1`)).status).toBe(200);
    });

    it("binds facet cursors to the option field and normalized search", async () => {
      const fixture = await paidFixture();
      fixture.source.value[0].directory.companyName = "Other Health";
      const first = await (await fixture.request(root)).json();
      const facet = `${root}/facets?selectionId=${first.selection.id}&field=company&limit=1`;
      const page = await (await fixture.request(`${facet}&search=health`)).json();
      const cursor = `cursor=${encodeURIComponent(page.page.nextCursor)}`;
      expect((await fixture.request(`${facet}&${cursor}&search=other`)).status).toBe(400);
      expect((await fixture.request(`${root}/facets?selectionId=${first.selection.id}&field=department&${cursor}`)).status).toBe(400);
      const next = await (await fixture.request(`${facet}&${cursor}&search=${encodeURIComponent(" ＨＥＡＬＴＨ ")}`)).json();
      expect(next.value).toEqual([{ value: "Other Health", count: 1 }]);
    });

    it("keeps captured filters, scalar facts, child membership, facets and analytics across source changes", async () => {
      const { source, state, request } = await paidFixture();
      source.value[0].directory.companyName = "Fabrikam";
      const first: ReportPage<CombinedUser> = await (await request(`${root}?cohort=review&limit=1`)).json();
      const selected = `selectionId=${first.selection.id}`;
      source.value[1].reportedResponses = 900;
      source.sources.directory.revision = "next";
      source.reports.activeRevision = "next";
      const observed = state.captures.get(first.selection.id)!;
      observed.cohort = "licensed";
      const next = await (await request(`${root}?${selected}&limit=1&cursor=${first.page.nextCursor}`)).json();
      expect(next).toMatchObject({ value: [{ directory: { displayName: "Cleo" } }], counts: { total: 4, filtered: 2 },
        selection: first.selection, sources: first.sources, reports: first.reports, filters: first.filters, analytics: first.analytics });
      expect((await request(`${root}?${selected}&cohort=licensed`)).status).toBe(400);
      expect((await request(`${root}/${source.value[0].directory.objectId}?${selected}`)).status).toBe(404);
      const facets = await (await request(`${root}/facets?${selected}&field=company&search=${encodeURIComponent(" ＨＥＡＬＴＨ ")}`)).json();
      expect(facets).toMatchObject({ value: [{ value: "Contoso Health", count: 2 }], counts: { total: 2, filtered: 1 }, selection: first.selection });
      const links = await (await request(`${root}/${source.value[1].directory.objectId}/agents?${selected}&responsesOnly=true`)).json();
      expect(links).toMatchObject({ value: [], counts: { total: 1, filtered: 0 }, selection: first.selection });
      const current = await (await request(`${root}?cohort=review`)).json();
      expect(current).toMatchObject({ counts: { filtered: 1 }, analytics: { rowCount: 1, responses: 0 } });
      expect(current.selection.id).not.toBe(first.selection.id);
    });

    it("never reuses another fixture owner's selection or revision", async () => {
      const first = await paidFixture(), second = await paidFixture();
      const before = await (await first.request(root)).json(), after = await (await second.request(root)).json();
      expect(after.selection.id).not.toBe(before.selection.id);
      expect(after.selection.revision).not.toBe(before.selection.revision);
      expect((await second.request(`${root}?selectionId=${before.selection.id}`)).status).toBe(409);
      expect((await first.request(`${root}?selectionId=${after.selection.id}`)).status).toBe(409);
    });

    it("shares requests, cancels obsolete pages and preserves an immutable capture through cache revalidation", async () => {
      const fixture = await paidFixture(), client = createSavedQueryClient();
      clients.push(client);
      const transport = vi.fn<typeof fetch>(async input => fixture.request(String(input)));
      vi.stubGlobal("fetch", transport);
      const wrapper = ({ children }: { children: ReactNode }) => createElement(SavedQueryProvider, { client, children });
      const initialQuery: ReportQuery & { limit: number } = { cohort: "review", limit: 1 };
      const { result, rerender } = renderHook(({ query }) => ({
        first: useReportPage<CombinedUser>("copilot-usage/users", query),
        second: useReportPage<CombinedUser>("copilot-usage/users", query),
      }), { wrapper, initialProps: { query: initialQuery } });
      await waitFor(() => expect(result.current.first.data?.value[0].directory.displayName).toBe("Ben"));
      expect(transport).toHaveBeenCalledOnce();
      const next = deferred<Response>(), replacement = deferred<Response>();
      let late: Response | undefined;
      transport.mockImplementationOnce(async input => { late = await fixture.request(String(input)); return next.promise; })
        .mockReturnValueOnce(replacement.promise);
      act(() => { result.current.first.next(); result.current.first.next(); });
      expect(transport).toHaveBeenCalledTimes(2);
      const signal = transport.mock.lastCall![1]?.signal;
      rerender({ query: { ...initialQuery, search: "Cleo" } });
      expect(signal?.aborted).toBe(true);
      expect(transport).toHaveBeenCalledTimes(3);
      await act(async () => next.resolve(late!));
      expect(result.current.first).toMatchObject({ data: undefined, loading: true, error: null });
      await act(async () => replacement.resolve(await fixture.request(String(transport.mock.lastCall![0]))));
      await waitFor(() => expect(result.current.first.data?.value[0].directory.displayName).toBe("Cleo"));
      const captured = result.current.first.data!;
      fixture.source.value[2].reportedResponses = 800;
      act(() => { void client.invalidateQueries({ queryKey: ["saved", "record-page"] }); });
      await waitFor(() => expect(result.current.first.loading).toBe(false));
      expect(transport).toHaveBeenCalledTimes(4);
      expect(result.current.first.data).toEqual(captured);
      act(() => result.current.first.invalidateSelection());
      expect(result.current.first).toMatchObject({ data: undefined, loading: false, invalidated: true });
      await waitFor(() => expect(result.current.second.invalidated).toBe(true));
      act(() => { result.current.first.restart(); result.current.first.restart(); });
      await waitFor(() => expect(result.current.first.data?.counts.filtered).toBe(0));
      expect(result.current.first.data?.analytics).toMatchObject({ rowCount: 0, responses: null });
      expect(transport).toHaveBeenCalledTimes(5);
      rerender({ query: { ...initialQuery, search: "Cleo" } });
      expect(transport).toHaveBeenCalledTimes(5);
    });

    it("cancels expired pinned child pages without renewing or admitting their late response", async () => {
      vi.useFakeTimers();
      const fixture = await paidFixture(), client = createSavedQueryClient();
      clients.push(client);
      fixture.source.selection.expiresAt = new Date(Date.now() + 1000).toISOString();
      const page: ReportPage<CombinedUser> = await (await fixture.request(root)).json();
      const pending = deferred<Response>();
      const transport = vi.fn<typeof fetch>(async input => fixture.request(String(input)));
      vi.stubGlobal("fetch", transport);
      const wrapper = ({ children }: { children: ReactNode }) => createElement(SavedQueryProvider, { client, children });
      const restart = vi.fn();
      const path = `copilot-usage/users/${page.value[0].directory.objectId}/agents`;
      const { result } = renderHook(() => useReportPage(path, { selectionId: page.selection.id, limit: 1 }, 0, true, restart), { wrapper });
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(result.current.data?.counts).toEqual({ total: 2, filtered: 2 });
      const response = await fixture.request(`${root}/${page.value[0].directory.objectId}/agents?selectionId=${page.selection.id}&cursor=${encodeURIComponent(result.current.data!.page.nextCursor!)}&limit=1`);
      transport.mockReturnValueOnce(pending.promise);
      act(() => result.current.next());
      const signal = transport.mock.lastCall![1]?.signal;
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(signal?.aborted).toBe(true);
      expect(result.current).toMatchObject({ data: undefined, loading: false, invalidated: true });
      act(() => { window.dispatchEvent(new Event("focus")); result.current.restart(); });
      expect(restart).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalledTimes(2);
      await act(async () => { pending.resolve(response); await vi.advanceTimersByTimeAsync(1); });
      expect(result.current.data).toBeUndefined();
    });

    it("retries one failed child page without reloading or displaying its previous rows and error", async () => {
      const fixture = await paidFixture(), client = createSavedQueryClient();
      clients.push(client);
      const page: ReportPage<CombinedUser> = await (await fixture.request(root)).json();
      const transport = vi.fn<typeof fetch>(async input => fixture.request(String(input)));
      vi.stubGlobal("fetch", transport);
      const wrapper = ({ children }: { children: ReactNode }) => createElement(SavedQueryProvider, { client, children });
      const { result } = renderHook(() => useReportPage(`copilot-usage/users/${page.value[0].directory.objectId}/agents`,
        { selectionId: page.selection.id, limit: 1 }), { wrapper });
      await waitFor(() => expect(result.current.data).toBeDefined());
      transport.mockResolvedValueOnce(Response.json({ code: "service_unavailable", detail: "Retry this page" }, { status: 503 }));
      act(() => result.current.next());
      await waitFor(() => expect(result.current.error).not.toBeNull());
      expect(result.current).toMatchObject({ data: undefined, loading: false });
      const retry = deferred<Response>();
      transport.mockReturnValueOnce(retry.promise);
      act(() => { result.current.retry(); result.current.retry(); });
      expect(result.current).toMatchObject({ data: undefined, loading: true, error: null });
      expect(transport).toHaveBeenCalledTimes(3);
      await act(async () => retry.resolve(await fixture.request(String(transport.mock.lastCall![0]))));
      await waitFor(() => expect(result.current.data).toBeDefined());
      expect(result.current.data?.selection).toEqual(page.selection);
      expect(fixture.state.captures.size).toBe(1);
    });

    it("rejects account-owned A-B-A pages even when the abandoned transport ignores cancellation", async () => {
      const fixtures = [await paidFixture(), await paidFixture(), await paidFixture()];
      const owners = fixtures.map(() => createSavedQueryClient());
      clients.push(...owners);
      const account: ReturnType<typeof useCapabilityContext> = {
        user: { tenantId: "tenant", homeAccountId: "A", displayName: "Viewer", username: "viewer@example.invalid", roles: ["AgentControl.Viewer"] },
        loading: false, pending: false, error: undefined, views: [], now: Date.now(), reload: vi.fn(async () => {}), openPermissions: vi.fn(),
      };
      let owner = 0;
      const transport = vi.fn<typeof fetch>(async input => fixtures[owner].request(String(input)));
      vi.stubGlobal("fetch", transport);
      const wrapper = ({ children }: { children: ReactNode }) => createElement(SavedQueryProvider, { client: owners[owner], children:
        createElement(CapabilityContext, { value: { ...account, user: { ...account.user!, homeAccountId: owner === 1 ? "B" : "A" } } }, children) });
      const { result, rerender } = renderHook(() => useReportPage<CombinedUser>("copilot-usage/users", { limit: 1 }), { wrapper });
      await waitFor(() => expect(result.current.data).toBeDefined());
      const firstId = result.current.selectionId;
      const abandoned = deferred<Response>(), replacement = deferred<Response>();
      const old = await fixtures[1].request(`${root}?limit=1`);
      transport.mockReturnValueOnce(abandoned.promise).mockReturnValueOnce(replacement.promise);
      owner = 1; rerender();
      const signal = transport.mock.lastCall![1]?.signal;
      expect(result.current.data).toBeUndefined();
      owner = 2; rerender();
      expect(signal?.aborted).toBe(true);
      await act(async () => abandoned.resolve(old));
      expect(result.current).toMatchObject({ data: undefined, loading: true, error: null });
      await act(async () => replacement.resolve(await fixtures[2].request(String(transport.mock.lastCall![0]))));
      await waitFor(() => expect(result.current.data).toBeDefined());
      expect(result.current.selectionId).not.toBe(firstId);
      expect(transport).toHaveBeenCalledTimes(3);
      expect(String(transport.mock.lastCall![0])).not.toContain("selectionId=");
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
      .toMatchObject({ value: [{ value: "Fabrikam", count: 1 }], counts: { total: 2, filtered: 1 } });
    expect(selectedFixtureRead("/api/official-usage/aggregate/facets?field=creatorType&limit=1"))
      .toMatchObject({ value: [{ value: "Microsoft", count: 1 }], counts: { filtered: 2 }, page: { nextCursor: "fixture:1" } });
    expect(selectedFixtureRead("/api/official-usage/users/facets?field=company&search=missing"))
      .toMatchObject({ value: [], counts: { total: 2, filtered: 0 } });
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

  it("derives history dates, known windows and overlap counts from unordered report rows", () => {
    const sets = [
      historySet(1, { acceptedAt: "2026-09-12T10:00:00.000Z", reportingStart: "2026-08-01", reportingEnd: "2026-08-31" }),
      historySet(2, { acceptedAt: "2026-09-14T10:00:00.000Z", reportingStart: "2026-08-31", reportingEnd: "2026-09-12" }),
      historySet(3, { acceptedAt: "2026-09-10T10:00:00.000Z", reportingStart: "2026-07-01", reportingEnd: "2026-07-31" }),
      historySet(4, { acceptedAt: "2026-09-13T10:00:00.000Z", reportingStart: "2026-06-01", reportingEnd: "2026-09-30", periodProvenance: "activity_range" }),
      historySet(5, { acceptedAt: "2026-09-11T10:00:00.000Z", reportingStart: null, reportingEnd: null }),
    ];
    const analytics = selectedHistoryPage(sets).analytics.history;
    expect(analytics).toMatchObject({ imports: 5, earliestAcceptedAt: sets[2].acceptedAt, latestAcceptedAt: sets[1].acceptedAt,
      earliestReportingStart: "2026-07-01", latestReportingEnd: "2026-09-12", knownWindows: 3, unknownWindows: 2, overlappingKnownWindows: 2 });
    expect(analytics!.observationRows - analytics!.uniquePayloads).toBe(analytics!.repeatedRowsReused);
    expect(selectedHistoryPage([...sets].reverse()).analytics.history).toEqual(analytics);
    expect(selectedHistoryPage([sets[0], sets[2]]).analytics.history).toMatchObject({ overlappingKnownWindows: 0 });
    expect(selectedHistoryPage([sets[3], sets[4]]).analytics.history).toMatchObject({
      earliestReportingStart: null, latestReportingEnd: null, knownWindows: 0, unknownWindows: 2, overlappingKnownWindows: 0,
    });
  });

  it("filters and orders history before deriving analytics, including empty options", () => {
    const sets = [
      historySet(1, { acceptedAt: "2026-09-15T10:00:00.000Z", reportingStart: null, reportingEnd: null }),
      historySet(2, { acceptedAt: "2026-09-14T10:00:00.000Z", reportingStart: "2026-07-01", reportingEnd: "2026-07-31" }),
      historySet(3, { acceptedAt: "2026-09-13T10:00:00.000Z", reportingStart: "2026-08-01", reportingEnd: "2026-08-31" }),
    ];
    expect(selectedHistoryPage(sets).value.map(row => row.id)).toEqual([sets[2].id, sets[1].id, sets[0].id]);
    const filtered = selectedHistoryPage(sets, sets[1].id, { search: sets[1].id, sort: "acceptedAt", order: "asc" });
    expect(filtered).toMatchObject({ value: [sets[1]], counts: { total: 3, filtered: 1 },
      analytics: { history: { imports: 1, earliestAcceptedAt: sets[1].acceptedAt, latestAcceptedAt: sets[1].acceptedAt } } });
    for (const path of ["/api/official-usage/history", "/api/official-usage/history/options"]) {
      expect(selectedFixtureRead(`${path}?search=missing`)).toMatchObject({ value: [], counts: { total: 1, filtered: 0 } });
    }
  });
});
