import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { OfficialUsageHistoryView } from "../../backend/src/types/officialUsage";
import { copilotUsageFixture } from "../src/test/copilotUsageFixture";
import { usageAggregateFixture, usageAgentDetailFixture, usageFixtureSetId, usageUsersFixture } from "../src/test/usageInsightsFixture";
import { mockLayoutApi } from "./layoutFixtures";
import { activeWithoutPaidUsersFixture } from "./userCohortFixtures";

async function mockUsageReports(page: Page, unexpected: string[]) {
  await page.route(url => url.pathname === "/api/official-usage/aggregate", route => {
    expect(route.request().method()).toBe("GET");
    const params = new URL(route.request().url()).searchParams;
    if (params.has("setId") && params.get("setId") !== usageFixtureSetId) {
      return route.fulfill({ status: 404, json: { code: "official_usage_set_not_found", detail: "The exact synthetic report set is unavailable." } });
    }
    return route.fulfill({ json: usageAggregateFixture({
      staleAfterDays: 35, search: params.get("search") ?? undefined,
      creatorType: params.get("creatorType") ?? undefined,
      startDate: params.get("startDate") ?? undefined, endDate: params.get("endDate") ?? undefined,
      agentSortBy: (["agentName", "responses", "activeUsers", "licensedUsers", "unlicensedUsers", "lastActivity"] as const).find(value => value === params.get("sortBy")),
      sortDirection: params.get("sortDirection") === "asc" ? "asc" : "desc",
      limit: Number(params.get("limit") ?? 100), offset: Number(params.get("offset") ?? 0),
    }) });
  });
  await page.route(url => url.pathname === "/api/official-usage/users", route => {
    expect(route.request().method()).toBe("GET");
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("licenseCohort")).toBe("active_without_paid");
    if (params.has("setId") && params.get("setId") !== usageFixtureSetId) {
      return route.fulfill({ status: 404, json: { code: "official_usage_set_not_found", detail: "The exact synthetic report set is unavailable." } });
    }
    return route.fulfill({ json: activeWithoutPaidUsersFixture({
      staleAfterDays: 35, search: params.get("search") ?? undefined, agentId: params.get("agentId") ?? undefined,
      creatorType: params.get("creatorType") ?? undefined, responsesOnly: params.get("responsesOnly") === "true",
      startDate: params.get("startDate") ?? undefined, endDate: params.get("endDate") ?? undefined,
      cohort: (["all", "zero", "low", "review"] as const).find(value => value === params.get("cohort")),
      activity: (["all", "recent", "inactive", "no-activity"] as const).find(value => value === params.get("activity")),
      lowResponseThreshold: Number(params.get("lowResponseThreshold") ?? 5),
      limit: Number(params.get("limit") ?? 100), offset: Number(params.get("offset") ?? 0),
      userSortBy: (["displayName", "responses", "agentsUsed", "lastActivity"] as const).find(value => value === params.get("sortBy")),
      sortDirection: params.get("sortDirection") === "asc" ? "asc" : "desc",
    }) });
  });
  await page.route("**/api/official-usage/agents/**", route => {
    if (route.request().method() !== "GET") {
      unexpected.push(`Unexpected report write: ${route.request().method()}`);
      return route.fulfill({ status: 405, json: { error: "Read only" } });
    }
    const url = new URL(route.request().url());
    if (url.searchParams.has("setId") && url.searchParams.get("setId") !== usageFixtureSetId) {
      return route.fulfill({ status: 404, json: { code: "official_usage_set_not_found", detail: "The exact synthetic report set is unavailable." } });
    }
    const id = decodeURIComponent(url.pathname.slice("/api/official-usage/agents/".length));
    const data = usageAgentDetailFixture(id);
    const search = (url.searchParams.get("search") ?? "").toLowerCase();
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const users = data.users.value.filter(user => `${user.displayName} ${user.username}`.toLowerCase().includes(search));
    return route.fulfill({ json: { ...data, users: { value: users.slice(offset, offset + limit), count: users.length, offset, limit } } });
  });
  const directory = structuredClone(copilotUsageFixture);
  directory.users = directory.users.map(user => ({
    ...user, importedUsage: usageUsersFixture().users.value.find(row => row.username === user.directory.userPrincipalName) ?? null,
  }));
  await page.route("**/api/copilot-usage/users", route => route.fulfill({ json: directory }));
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("Agents separates its compact overview from agent details and snapshot response totals", async ({ page }, info) => {
  test.setTimeout(60_000);
  const unexpected = await mockLayoutApi(page);
  await mockUsageReports(page, unexpected);
  const reportReads: string[] = [];
  const otherReportRequests: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/official-usage/") && path !== "/api/official-usage/overview") otherReportRequests.push(request.url());
  });
  page.on("requestfinished", request => {
    if (new URL(request.url()).pathname.startsWith("/api/official-usage/")) reportReads.push(request.url());
  });
  await page.goto("/agents");
  await expect(page.getByRole("button", { name: "Service desk assistant", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Tenant adoption insights" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Explore usage & users" })).toHaveCount(0);
  await expect(page.getByLabel("Tenant report totals")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Official usage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Official usage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Agent inventory overview" })).toContainText("Reported used agents");
  await expect.poll(() => reportReads.map(url => new URL(url).pathname)).toEqual(["/api/official-usage/overview"]);
  await page.screenshot({ path: info.outputPath("agents-inventory.png"), fullPage: true });
  await page.getByRole("button", { name: "Service desk assistant", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Service desk assistant" });
  await expect(dialog.getByRole("tab")).toHaveText(["Overview", "Usage & users", "Manage", "Activity"]);
  await expect(dialog.getByText("Representative saved catalog observation; no live provider requests.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Review usage|Review access|Details & services/ })).toHaveCount(0);
  await expect(dialog.getByText("Tenant adoption snapshot")).toHaveCount(0);
  await expect(dialog.getByLabel("Tenant report totals")).toHaveCount(0);
  await expect(dialog.getByLabel("Selected agent report metrics")).toHaveCount(0);
  await expect(dialog.getByLabel("Find a reported agent")).toHaveCount(0);
  const bounds = await dialog.boundingBox();
  await page.screenshot({ path: info.outputPath("agent-overview.png") });
  await dialog.getByRole("tab", { name: "Usage & users" }).click();
  await expect(dialog.getByRole("heading", { name: "No matched usage data for this agent" })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Usage and users for Service desk assistant" })).toContainText("Its response totals, active users, and last-used date are unavailable.");
  await expect(dialog.getByText(/Missing usage data does not mean zero usage/)).toBeVisible();
  await expect(dialog.getByLabel("Tenant report totals")).toHaveCount(0);
  await expect(dialog.getByLabel("Selected agent report metrics")).toHaveCount(0);
  await expect(dialog.getByLabel("Find a reported agent")).toHaveCount(0);
  await expect(dialog.getByText("Researcher", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: "Users of the reported agent" })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: /active users without paid Copilot/i })).toHaveCount(0);
  expect(await dialog.boundingBox()).toEqual(bounds);
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("agent-usage-users.png") });
  await dialog.getByRole("tab", { name: "Manage" }).click();
  await expect(dialog.getByRole("heading", { name: "Manage", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: /Manage access for|Manage installation for/ })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Select who can use this agent" })).toBeVisible();
  await dialog.getByRole("button", { name: /^Installed for/ }).click();
  await expect(dialog.getByRole("heading", { name: "Select who this agent is installed for" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(dialog.getByRole("heading", { name: "Quarantine and restore" })).toHaveCount(0);
  expect(await dialog.boundingBox()).toEqual(bounds);
  await page.screenshot({ path: info.outputPath("agent-access.png") });
  await dialog.getByRole("tab", { name: "Activity" }).click();
  await expect(dialog.getByRole("heading", { name: "Activity for Service desk assistant" })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Search tenant interactions" })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "View management audit" })).toHaveCount(0);
  await expect(dialog.getByText("No saved activity is linked to this agent's inventory record.")).toBeVisible();
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("agent-activity.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Service desk assistant", exact: true })).toBeFocused();
  await expect(page.getByRole("region", { name: "Tenant adoption insights" })).toHaveCount(0);
  expect(reportReads.map(url => new URL(url).pathname)).toEqual(["/api/official-usage/overview"]);
  expect(otherReportRequests).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("users can switch cohorts and traverse nonpaid activity without losing route state", async ({ page }, info) => {
  test.setTimeout(60_000);
  const unexpected = await mockLayoutApi(page);
  await mockUsageReports(page, unexpected);
  await page.goto("/users");
  const cohort = page.getByRole("combobox", { name: "User cohort", exact: true });
  await expect(cohort).toHaveValue("licenses");
  await cohort.selectOption("activity");
  await expect(page).toHaveURL(/\/users\?view=activity$/);
  const activity = page.getByRole("region", { name: "Active users without paid Copilot", exact: true }).and(page.locator(".copilot-users-table-shell"));
  await expect(activity.locator("tbody tr")).toHaveCount(2);
  await expect(activity.getByRole("columnheader")).toHaveCount(6);
  await expect(activity.getByRole("row", { name: /Concealed report user|Ada|Ben|Cleo/ })).toHaveCount(0);
  await expect(activity.getByRole("row", { name: /Emery/ })).toContainText("No active M365 Copilot license");
  await expect(activity.getByRole("row", { name: /Finley/ })).toContainText("Not reported");
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("reported-user-activity.png"), fullPage: true });
  await activity.getByRole("button", { name: "View reported details for Emery", exact: true }).click();
  await page.getByRole("dialog", { name: "Emery" }).getByRole("button", { name: "Researcher: active users without paid Copilot", exact: true }).click();
  const selectedAgentUrl = new RegExp(`agent=synthetic-researcher&snapshot=${usageFixtureSetId}$`);
  await expect(page).toHaveURL(selectedAgentUrl);
  await expect(activity.locator("tbody tr")).toHaveCount(1);
  await activity.getByRole("button", { name: "View reported details for Emery", exact: true }).click();
  const user = page.getByRole("dialog", { name: "Emery" });
  await expect(user.getByText("Responses (Users report)", { exact: true })).toBeVisible();
  await user.getByRole("button", { name: "Researcher: active users without paid Copilot", exact: true }).click();
  await expect(user).not.toBeVisible();
  await expect(page).toHaveURL(selectedAgentUrl);
  await page.goBack();
  await expect(page).toHaveURL(/\/users\?view=activity$/);
  await expect(activity.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await expect(cohort).toHaveValue("activity");
  await expect(activity.locator("tbody tr")).toHaveCount(2);
  await cohort.selectOption("licenses");
  await expect(page).toHaveURL(/\/users$/);
  await expect(page.getByRole("region", { name: "M365 Copilot license status", exact: true }).locator("tbody tr")).toHaveCount(4);
  await expect(activity).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

for (const state of ["missing", "unavailable"] as const) {
  test(`agent usage stays scoped when tenant reports are ${state}`, async ({ page }) => {
    const unexpected = await mockLayoutApi(page);
    const empty = usageAggregateFixture();
    empty.activeSet = null;
    empty.availability = "never_imported";
    await page.route("**/api/official-usage/aggregate*", route => state === "missing"
      ? route.fulfill({ json: empty })
      : route.fulfill({ status: 503, json: { detail: "Tenant usage unavailable.", code: "synthetic_tenant_reports_unavailable" } }));
    await page.goto("/sync?reports=snapshot");
    const reports = page.locator("dialog.official-usage-modal");
    await expect(reports).toBeVisible();
    if (state === "missing") {
      await expect(page.getByRole("heading", { name: "Reports not imported" })).toBeVisible();
    }
    else await expect(page.getByRole("alert")).toContainText("Tenant usage unavailable.");
    await reports.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.getByRole("region", { name: "Tenant adoption insights" })).toHaveCount(0);
    await page.getByRole("button", { name: "Service desk assistant", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Service desk assistant" });
    await dialog.getByRole("tab", { name: "Usage & users" }).click();
    await expect(dialog.getByRole("heading", { name: "No matched usage data for this agent" })).toBeVisible();
    await expect(dialog.getByText(/Missing usage data does not mean zero usage/)).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Open usage reports" })).toHaveCount(0);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(dialog.getByLabel("Tenant report totals")).toHaveCount(0);
    await expect(dialog.getByLabel("Find a reported agent")).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });
}

test("fresh activity links keep their search, page and snapshot separate from other workbench views", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await mockUsageReports(page, unexpected);
  const history: OfficialUsageHistoryView = {
    summary: {
      importCount: 0, uniqueObservationCount: 0, observationRowCount: 0, uniquePayloadCount: 0, repeatedRowsReused: 0,
      earliestObservedAt: null, latestObservedAt: null,
      activityDateRange: { earliestDateUtc: null, latestDateUtc: null, provenance: "last_activity_dates", provesReportingCoverage: false },
      reportingWindows: { knownCount: 0, unknownCount: 0, overlappingKnownWindowCount: 0, additive: false },
      warning: { code: "rolling_snapshots_not_additive", message: "Report snapshots are not additive." },
    },
    bundles: { value: [], count: 0, limit: 10, offset: 0 },
  };
  await page.route("**/api/official-usage/history*", route => route.fulfill({ json: history }));
  const activityUrl = `/users?view=activity&q=Emery&snapshot=${usageFixtureSetId}&page=2`;
  await page.goto(activityUrl);
  await expect(page.getByRole("searchbox", { name: "Search reported users or agents" })).toHaveValue("Emery");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search", exact: true })).toHaveValue("");
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByLabel("Tenant report totals")).toHaveCount(0);
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: /^Sync/ }).click();
  await page.getByRole("button", { name: "Manage reports", exact: true }).click();
  await expect(page).toHaveURL(/\/sync\?reports=manage$/);
  const reports = page.getByRole("dialog", { name: "Manage reports", exact: true });
  await expect(reports.getByRole("region", { name: "Retained agent activity rows" })).toHaveCount(0);
  const reportRead = page.waitForRequest(request => new URL(request.url()).pathname === "/api/official-usage/overview");
  await reports.getByText("Find an agent across reports", { exact: true }).click();
  const reportParams = new URL((await reportRead).url()).searchParams;
  expect(reportParams.has("setId")).toBe(false);
  expect(reportParams.has("search")).toBe(false);
  expect(reportParams.get("offset")).toBe("0");
  await reports.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${activityUrl.replace("?", "\\?")}$`));
  await expect(page.getByRole("searchbox", { name: "Search reported users or agents" })).toHaveValue("Emery");
  expect(unexpected).toEqual([]);
});
