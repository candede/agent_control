import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { OfficialUsageHistoryView } from "../../backend/src/types/officialUsage";
import { copilotUsageFixture } from "../src/test/copilotUsageFixture";
import { usageAggregateFixture, usageAgentDetailFixture, usageFixtureSetId, usageUsersFixture } from "../src/test/usageInsightsFixture";
import { mockLayoutApi } from "./layoutFixtures";

async function mockUsageReports(page: Page, unexpected: string[]) {
  await page.route("**/api/official-usage/aggregate*", route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: usageAggregateFixture({
      staleAfterDays: 35, search: params.get("search") ?? undefined,
      limit: Number(params.get("limit") ?? 100), offset: Number(params.get("offset") ?? 0),
    }) });
  });
  await page.route("**/api/official-usage/users*", route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: usageUsersFixture({
      staleAfterDays: 35, search: params.get("search") ?? undefined, agentId: params.get("agentId") ?? undefined,
      limit: Number(params.get("limit") ?? 100), offset: Number(params.get("offset") ?? 0),
      userSortBy: "displayName", sortDirection: "asc",
    }) });
  });
  await page.route("**/api/official-usage/agents/**", route => {
    if (route.request().method() !== "GET") {
      unexpected.push(`Unexpected report write: ${route.request().method()}`);
      return route.fulfill({ status: 405, json: { error: "Read only" } });
    }
    const url = new URL(route.request().url());
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

test("agent details stay specific to the selected agent while tenant reports remain outside the modal", async ({ page }, info) => {
  test.setTimeout(60_000);
  const unexpected = await mockLayoutApi(page);
  await mockUsageReports(page, unexpected);
  const reportReads: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/official-usage/")) reportReads.push(request.url());
  });
  await page.goto("/agents");
  const tenant = page.getByRole("region", { name: "Tenant adoption insights" });
  await expect(tenant.getByLabel("Tenant report totals")).toContainText("270");
  await tenant.getByRole("button", { name: "Explore usage & users" }).click();
  await tenant.getByRole("button", { name: /^Explore report for Researcher/ }).click();
  await expect(tenant.getByLabel("Selected agent report metrics")).toContainText("215");
  await expect(tenant.getByRole("row", { name: /Ben/ })).toContainText("Zero responses reported");
  await expect(tenant.getByRole("link", { name: "Open in user-agent matrix" })).toHaveAttribute("href", `/users?view=matrix&agent=synthetic-researcher&snapshot=${usageFixtureSetId}`);
  const readsBeforeModal = [...reportReads];
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
  await expect(dialog.getByRole("heading", { name: "No verified usage data for this agent" })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Usage and users for Service desk assistant" })).toContainText("Its response totals, active users, and last-used date are unavailable.");
  await expect(dialog.getByText(/Missing usage data does not mean zero usage/)).toBeVisible();
  await expect(dialog.getByLabel("Tenant report totals")).toHaveCount(0);
  await expect(dialog.getByLabel("Selected agent report metrics")).toHaveCount(0);
  await expect(dialog.getByLabel("Find a reported agent")).toHaveCount(0);
  await expect(dialog.getByText("Researcher", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: "Users of the reported agent" })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: /user-agent matrix/i })).toHaveCount(0);
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
  await expect(tenant.getByLabel("Selected agent report metrics")).toContainText("215");
  expect(reportReads).toEqual(readsBeforeModal);
  expect(unexpected).toEqual([]);
});

test("users can traverse the response matrix, license details and exact reported agent without losing route state", async ({ page }, info) => {
  test.setTimeout(60_000);
  const unexpected = await mockLayoutApi(page);
  await mockUsageReports(page, unexpected);
  await page.goto("/users");
  await page.getByRole("button", { name: "User-agent matrix", exact: true }).click();
  await expect(page).toHaveURL(/\/users\?view=matrix$/);
  const matrix = page.getByRole("region", { name: "User-agent response matrix" });
  await expect(matrix.locator("tbody tr")).toHaveCount(4);
  await expect(matrix.getByRole("row", { name: /Concealed report user/ })).toContainText("Unknown");
  await expect(matrix.getByRole("row", { name: /Ben/ })).toContainText("0");
  await expect(matrix.getByRole("row", { name: /Cleo/ })).toContainText("Not reported");
  if (info.project.name === "mobile") {
    await matrix.scrollIntoViewIfNeeded();
    await matrix.evaluate(element => { element.scrollLeft = element.scrollWidth - element.clientWidth; });
    const header = await matrix.locator("tbody th").first().boundingBox();
    const region = await matrix.boundingBox();
    expect(Math.abs(header!.x - region!.x), "Reported user identity stays visible while reading off-screen agent columns").toBeLessThanOrEqual(2);
    await matrix.evaluate(element => { element.scrollLeft = 0; });
  }
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("user-agent-matrix.png"), fullPage: true });
  await matrix.getByRole("button", { name: "Researcher", exact: true }).click();
  const selectedAgentUrl = new RegExp(`agent=synthetic-researcher&snapshot=${usageFixtureSetId}$`);
  await expect(page).toHaveURL(selectedAgentUrl);
  await expect(matrix.locator("tbody tr")).toHaveCount(3);
  await matrix.getByRole("button", { name: "Ada", exact: true }).click();
  const user = page.getByRole("dialog", { name: "Ada" });
  await expect(user.getByRole("heading", { name: "Copilot in Office apps" })).toBeVisible();
  await user.getByRole("button", { name: "Researcher", exact: true }).click();
  await expect(user).not.toBeVisible();
  await expect(page).toHaveURL(selectedAgentUrl);
  await page.goBack();
  await expect(page).toHaveURL(/\/users\?view=matrix$/);
  await expect(matrix.locator("tbody tr")).toHaveCount(4);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await expect(page.getByRole("button", { name: "User-agent matrix", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(matrix.locator("tbody tr")).toHaveCount(4);
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
      : route.fulfill({ status: 503, json: { error: "Tenant usage unavailable.", code: "synthetic_tenant_reports_unavailable" } }));
    await page.goto("/agents");
    const tenant = page.getByRole("region", { name: "Tenant adoption insights" });
    if (state === "missing") await expect(tenant.getByRole("link", { name: "Open usage reports" })).toBeVisible();
    else await expect(tenant.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Service desk assistant", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Service desk assistant" });
    await dialog.getByRole("tab", { name: "Usage & users" }).click();
    await expect(dialog.getByRole("heading", { name: "No verified usage data for this agent" })).toBeVisible();
    await expect(dialog.getByText(/Missing usage data does not mean zero usage/)).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Open usage reports" })).toHaveCount(0);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(dialog.getByLabel("Tenant report totals")).toHaveCount(0);
    await expect(dialog.getByLabel("Find a reported agent")).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });
}

test("fresh matrix links keep their search, page and snapshot separate from other workbench views", async ({ page }) => {
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
  const matrixUrl = `/users?view=matrix&q=Ada&snapshot=${usageFixtureSetId}&page=2`;
  await page.goto(matrixUrl);
  await expect(page.getByRole("searchbox", { name: "Search the user-agent matrix" })).toHaveValue("Ada");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search", exact: true })).toHaveValue("");
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByLabel("Tenant report totals")).toBeVisible();
  const reportRead = page.waitForRequest(request => new URL(request.url()).pathname === "/api/official-usage/aggregate");
  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  expect(new URL((await reportRead).url()).searchParams.has("setId")).toBe(false);
  await expect(page).toHaveURL(/\/official-usage$/);
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${matrixUrl.replace("?", "\\?")}$`));
  await expect(page.getByRole("searchbox", { name: "Search the user-agent matrix" })).toHaveValue("Ada");
  expect(unexpected).toEqual([]);
});
