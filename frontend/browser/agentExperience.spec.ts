import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { selectedAgentsPage, selectedFixtureRead, selectedFixtureReports, selectedHistoryPage } from "../src/test/selectedUsageFixture";
import { mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { selectedCohortData, selectedCohortRead } from "./selectedCohortFixture";
import { fulfillInventoryPage, inventoryFixtureQuery } from "./selectedInventoryFixture";

const usageFixtureSetId = selectedFixtureReports.setId!;
async function mockUnavailableAgentUsage(page: Page) {
  await page.route(url => /^\/api\/agent-inventory\/[^/]+\/usage$/.test(url.pathname), route => route.fulfill({
    status: 503, json: { code: "synthetic_usage_unavailable", detail: "Report data is unavailable. Restart usage to try again." },
  }));
}

async function mockUsageReports(page: Page, unexpected: string[]) {
  const data = selectedCohortData();
  await page.route(url => url.pathname === "/api/agent-inventory", route => {
    const recordId = inventoryFixtureQuery(route).get("recordId"), value = unifiedAgents.value.filter(row => !recordId || row.id === recordId);
    return fulfillInventoryPage(route, { ...unifiedAgents, value, counts: { ...unifiedAgents.counts, filtered: value.length },
      usageContext: { revision: "a".repeat(64), reports: data.directory.reports, expiresAt: data.directory.reports.expiresAt } });
  });
  await mockUnavailableAgentUsage(page);
  await page.route(url => url.pathname.startsWith("/api/official-usage/") || url.pathname.startsWith("/api/copilot-usage/users"), route => {
    if (route.request().method() !== "GET") {
      unexpected.push(`Unexpected report write: ${route.request().method()}`);
      return route.fulfill({ status: 405, json: { error: "Read only" } });
    }
    const url = new URL(route.request().url());
    if (url.searchParams.has("setId") && url.searchParams.get("setId") !== usageFixtureSetId) {
      return route.fulfill({ status: 404, json: { code: "official_usage_set_not_found", detail: "The exact synthetic report set is unavailable." } });
    }
    if (url.pathname === "/api/official-usage/users") expect(url.searchParams.get("licenseCohort")).toBe("active_without_paid");
    const body = url.pathname.startsWith("/api/official-usage/users") ? selectedCohortRead(url.href, data) : selectedFixtureRead(url.href, data.directory);
    if (!body) { unexpected.push(url.pathname); return route.fulfill({ status: 404, json: { code: "synthetic_exact_not_found", detail: "No exact selected fixture." } }); }
    return route.fulfill({ json: body });
  });
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("Agents separates its compact overview from agent details and snapshot response totals", async ({ page }, info) => {
  test.setTimeout(60_000);
  const unexpected = await mockLayoutApi(page);
  await mockUsageReports(page, unexpected);
  const reportReads: string[] = [];
  const otherReportRequests: string[] = [];
  const overviewReads = ["/api/official-usage/history", "/api/official-usage/overview"];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/official-usage/") && !overviewReads.includes(path)) otherReportRequests.push(request.url());
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
  await expect.poll(() => reportReads.map(url => new URL(url).pathname).sort()).toEqual(overviewReads);
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
  await expect(dialog.getByRole("alert")).toContainText("Report data is unavailable. Restart usage to try again.");
  await expect(dialog.getByRole("button", { name: "Restart usage selection" })).toBeEnabled();
  await expect(dialog.getByText(/Missing usage data does not mean zero usage/)).toHaveCount(0);
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
  await expect(dialog.getByRole("heading", { name: "Agent logs", exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Search tenant interactions" })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "View management audit" })).toHaveCount(0);
  await expect(dialog.getByText("No saved activity is linked to this agent.")).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: "Defender log coverage and setup" })).toBeVisible();
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("agent-activity.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Service desk assistant", exact: true })).toBeFocused();
  await expect(page.getByRole("region", { name: "Tenant adoption insights" })).toHaveCount(0);
  expect(reportReads.map(url => new URL(url).pathname).sort()).toEqual(overviewReads);
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
  const activity = page.getByRole("region", { name: "Reported user activity", exact: true }).and(page.locator(".copilot-users-table-shell"));
  await expect(activity.locator("tbody tr")).toHaveCount(2);
  await expect(activity.getByRole("columnheader")).toHaveCount(7);
  await expect(activity.getByRole("row", { name: /Concealed report user|Ada|Ben|Cleo/ })).toHaveCount(0);
  await expect(activity.getByRole("row", { name: /Emery/ })).toContainText("No active M365 Copilot license");
  await expect(activity.getByRole("row", { name: /Finley/ })).toContainText("Not reported");
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("reported-user-activity.png"), fullPage: true });
  await activity.getByRole("button", { name: "Emery", exact: true }).click();
  await page.getByRole("dialog", { name: "Emery" }).getByRole("tab", { name: "Usage & agents", exact: true }).click();
  await page.getByRole("dialog", { name: "Emery" }).getByRole("button", { name: "Researcher: active users without paid Copilot", exact: true }).click();
  const selectedAgentUrl = new RegExp(`agent=synthetic-researcher&snapshot=${usageFixtureSetId}$`);
  await expect(page).toHaveURL(selectedAgentUrl);
  await expect(activity.locator("tbody tr")).toHaveCount(1);
  await activity.getByRole("button", { name: "Emery", exact: true }).click();
  const user = page.getByRole("dialog", { name: "Emery" });
  await expect(user.getByText("Agent responses", { exact: true })).toBeVisible();
  await user.getByRole("tab", { name: "Usage & agents", exact: true }).click();
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
    const empty = selectedAgentsPage();
    empty.reports = { ...empty.reports, setId: null, activeSetId: null, availability: "never_imported", lineages: [] };
    empty.value = []; empty.counts = { total: 0, filtered: 0 };
    await mockUnavailableAgentUsage(page);
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
    await reports.getByRole("button", { name: "Back to reports", exact: true }).click();
    await reports.getByRole("button", { name: "Close reports", exact: true }).click();
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.getByRole("region", { name: "Tenant adoption insights" })).toHaveCount(0);
    await page.getByRole("button", { name: "Service desk assistant", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Service desk assistant" });
    await dialog.getByRole("tab", { name: "Usage & users" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Report data is unavailable. Restart usage to try again.");
    await expect(dialog.getByRole("button", { name: "Restart usage selection" })).toBeEnabled();
    await expect(dialog.getByRole("link", { name: "Open usage reports" })).toHaveCount(0);
    await expect(dialog.getByRole("alert")).toHaveCount(1);
    await expect(dialog.getByLabel("Tenant report totals")).toHaveCount(0);
    await expect(dialog.getByLabel("Find a reported agent")).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });
}

test("fresh activity links keep their search, page and snapshot separate from other workbench views", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await mockUsageReports(page, unexpected);
  const history = selectedHistoryPage([], null);
  await page.route("**/api/official-usage/history*", route => route.fulfill({ json: history }));
  const activityUrl = `/users?view=activity&q=Emery&snapshot=${usageFixtureSetId}&page=2`;
  await page.goto(activityUrl);
  await expect(page.getByRole("searchbox", { name: "Search reported users or agents" })).toHaveValue("Emery");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search", exact: true })).toHaveValue("");
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByLabel("Tenant report totals")).toHaveCount(0);
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: /^Sync/ }).click();
  const reportRead = page.waitForRequest(request => new URL(request.url()).pathname === "/api/official-usage/history");
  await page.getByRole("button", { name: "Manage reports", exact: true }).click();
  await expect(page).toHaveURL(/\/sync\?reports=manage$/);
  const reports = page.getByRole("dialog", { name: "Manage reports", exact: true });
  await expect(reports.getByRole("region", { name: "Saved report sets" })).toBeVisible();
  await expect(reports.getByRole("region", { name: "Retained agent activity rows" })).toHaveCount(0);
  await expect(reports.getByText("Find an agent across reports", { exact: true })).toHaveCount(0);
  const reportParams = new URL((await reportRead).url()).searchParams;
  expect(reportParams.has("setId")).toBe(false);
  expect(reportParams.has("search")).toBe(false);
  expect(reportParams.has("cursor")).toBe(false);
  expect(reportParams.has("offset")).toBe(false);
  await reports.getByRole("button", { name: "Close reports", exact: true }).click();
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${activityUrl.replace("?", "\\?")}$`));
  await expect(page.getByRole("searchbox", { name: "Search reported users or agents" })).toHaveValue("Emery");
  expect(unexpected).toEqual([]);
});
