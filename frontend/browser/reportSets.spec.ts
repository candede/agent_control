import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import type { ReportMetadata } from "../../backend/src/types/officialReportData";
import { historySet } from "../src/test/reportDataFixture";
import { selectedAgentsPage, selectedFixtureQuery, selectedFixtureRead, selectedFixtureReports, selectedHistoryPage, selectedOverviewPage, selectedUsersPage } from "../src/test/selectedUsageFixture";
import { mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { fulfillInventoryPage, inventoryFixtureQuery } from "./selectedInventoryFixture";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

async function mockReportSelection(page: Page, role: "Admin" | "Viewer" | "UsageReportUploader" = "Admin") {
  const unexpected = await mockLayoutApi(page);
  const first = historySet(1, { id: "55555555-5555-4555-8555-555555555555", reportingStart: "2026-08-14", reportingEnd: "2026-09-12" });
  const second = historySet(2, { id: "77777777-7777-4777-8777-777777777777",
    reportingStart: "2026-07-01", reportingEnd: "2026-07-30", periodProvenance: "activity_range", active: false });
  const third = historySet(3, { id: "99999999-9999-4999-8999-999999999999", reportingStart: "2026-09-14", reportingEnd: "2026-10-12" });
  const sets = new Map([[first.id, first], [second.id, second]]);
  let latest = first.id, revision = 1;
  const metadata = (setId = latest): ReportMetadata => {
    const set = sets.get(setId);
    if (!set) throw new Error(`Unknown fixture report ${setId}`);
    return { ...selectedFixtureReports, setId, activeSetId: latest, activeRevision: String(revision), historyRevision: String(sets.size), historyEpoch: "1",
      reportingPeriod: { startDate: set.reportingStart!, endDate: set.reportingEnd!, days: 30,
        provenance: set.id === second.id ? "activity_range" : "operator_asserted" } };
  };
  await page.route("**/api/me", route => route.fulfill({ json: {
    user: { homeAccountId: `fixture-${role}`, tenantId: "fixture-tenant", username: `${role}@example.test`, displayName: role,
      roles: [`AgentControl.${role}`] }, roleAssignmentRequired: false, csrfToken: "fixture-csrf",
  } }));
  const mutations: string[] = [], inventoryRequests: URLSearchParams[] = [], userRequests: URLSearchParams[] = [];
  const overviewScopes: Array<string | null> = [], snapshotRequests: URLSearchParams[] = [];
  const unavailable = (route: Route) => route.fulfill({
    status: 404, json: { code: "usage_report_unavailable", detail: "The selected report is no longer available." },
  });
  await page.route(url => url.pathname === "/api/agent-inventory", route => {
    const query = inventoryFixtureQuery(route), setId = query.get("setId") ?? latest;
    inventoryRequests.push(query);
    if (!sets.has(setId)) return unavailable(route);
    return fulfillInventoryPage(route, { ...unifiedAgents,
      usageContext: { revision: String(revision).repeat(64), reports: metadata(setId), expiresAt: selectedFixtureReports.expiresAt } });
  });
  await page.route(url => url.pathname.startsWith("/api/copilot-usage/users"), route => {
    const query = selectedFixtureQuery(route.request().url()), setId = query.setId ?? latest;
    userRequests.push(new URL(route.request().url()).searchParams);
    if (!sets.has(setId)) return unavailable(route);
    const directory = selectedUsersPage();
    directory.reports = metadata(setId);
    if (setId === second.id) directory.value = directory.value.map(row => ({ ...row,
      reportedResponses: row.reportedResponses === null ? null : row.reportedResponses ? 7 : 0,
      userLastActivityDateUtc: row.userLastActivityDateUtc ? "2026-07-29" : null }));
    const data = selectedFixtureRead(route.request().url(), directory);
    if (!data) throw new Error(`Missing user fixture ${route.request().url()}`);
    return route.fulfill({ json: data });
  });
  await page.route(url => /^\/api\/official-usage\/history(?:\/options)?$/.test(url.pathname), route => {
    const query = selectedFixtureQuery(route.request().url()), setId = query.setId ?? latest;
    if (!sets.has(setId)) return unavailable(route);
    const result = selectedHistoryPage([...sets.values()].map(set => ({ ...set, active: set.id === latest })), setId, query);
    result.reports = metadata(setId);
    if (!new URL(route.request().url()).pathname.endsWith("/options")) return route.fulfill({ json: result });
    const { value, page, counts, selection, reports } = result;
    return route.fulfill({ json: { value, page, counts, selection, reports } });
  });
  await page.route("**/api/official-usage/overview?*", route => {
    const query = selectedFixtureQuery(route.request().url()), setId = query.setId ?? latest;
    if (!sets.has(setId)) return unavailable(route);
    overviewScopes.push(new URL(route.request().url()).searchParams.get("scope"));
    const data = selectedOverviewPage(query);
    data.reports = metadata(setId);
    data.analytics.overview!.usedAgents = setId === second.id ? 7 : setId === third.id ? 9 : 2;
    data.analytics.overview!.reportedAgents = data.analytics.overview!.usedAgents;
    return route.fulfill({ json: data });
  });
  await page.route("**/api/official-usage/aggregate?*", route => {
    const params = new URL(route.request().url()).searchParams, setId = params.get("setId") ?? latest;
    snapshotRequests.push(params);
    if (!sets.has(setId)) return unavailable(route);
    return route.fulfill({ json: { ...selectedAgentsPage(selectedFixtureQuery(route.request().url())), reports: metadata(setId) } });
  });
  await page.route(url => /^\/api\/official-usage\/(?:sets\/[^/]+\/preview|confirmations\/[^/]+)$/.test(url.pathname), route => {
    mutations.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 400, json: { code: "invalid_operation", detail: "There is no tenant-wide report selection operation." } });
  });
  return { unexpected, first, second, third, mutations, overviewScopes, snapshotRequests, inventoryRequests, userRequests,
    latest: () => latest,
    publishLatest() { sets.set(third.id, third); latest = third.id; revision++; },
    removeOlder() { sets.delete(second.id); },
  };
}

test("report management emphasizes activity start and end dates without import metadata", async ({ page }, info) => {
  const state = await mockReportSelection(page);
  await page.goto("/sync?reports=manage");
  const dialog = page.getByRole("dialog", { name: "Manage reports", exact: true });
  const table = dialog.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["Activity dates", "Status", "Actions"]);
  await expect(table).not.toContainText(/Imported|Observed activity|Reporting period/);
  const current = table.getByRole("row").filter({ has: page.locator(`time[datetime="${state.first.reportingStart}"]`) });
  await expect(current.locator(".usage-history-dates dt")).toHaveText(["Start", "End"]);
  await expect(current.locator(".usage-history-dates time")).toHaveText(["Aug 14, 2026", "Sep 12, 2026"]);
  await expect(current.locator("time").last()).toHaveAttribute("datetime", state.first.reportingEnd!);
  await expect(current.getByText("Current", { exact: true })).toBeVisible();
  const saved = table.getByRole("row").filter({ has: page.locator(`time[datetime="${state.second.reportingStart}"]`) });
  expect((await saved.locator(".usage-history-dates dt").last().boundingBox())!.x)
    .toBeCloseTo((await current.locator(".usage-history-dates dt").last().boundingBox())!.x, 0);
  for (const time of await current.locator("time").all()) {
    await expect(time).toHaveCSS("font-weight", "650");
    await expect(time).toHaveCSS("color", "rgb(24, 35, 56)");
  }
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  await dialog.screenshot({ path: info.outputPath("report-management-activity-dates.png") });
  await current.getByRole("button", { name: "View report", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Report details", exact: true });
  await expect(details.getByRole("region", { name: "Reported agent activity" })).toBeVisible();
  expect(state.snapshotRequests.some(query => query.get("setId") === state.first.id)).toBe(true);
  await details.getByRole("button", { name: "Back to reports", exact: true }).click();
  await expect(table.getByRole("columnheader")).toHaveText(["Activity dates", "Status", "Actions"]);
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

for (const role of ["Admin", "Viewer", "UsageReportUploader"] as const) {
  test(`${role} personally selects one report across Agents and Users without tenant writes`, async ({ page }, info) => {
    const state = await mockReportSelection(page, role);
    await page.goto("/agents");
    const selector = page.getByRole("region", { name: "Report set selection" }).getByRole("combobox", { name: "Report set" });
    const overview = page.getByRole("region", { name: "Agent inventory overview" });
    const used = overview.getByText("Reported used agents", { exact: true }).locator("..");
    await expect(selector).toHaveValue("");
    await expect(used).toContainText("2");
    await selector.selectOption(state.second.id);
    await expect(selector).toHaveValue(state.second.id);
    await expect(used).toContainText("7");
    await expect(page).toHaveURL(`/agents?snapshot=${state.second.id}`);
    expect(state.inventoryRequests.at(-1)?.get("setId")).toBe(state.second.id);
    expect(state.latest()).toBe(state.first.id);
    expect(state.mutations).toEqual([]);
    expect(state.overviewScopes.every(scope => scope === "selected")).toBe(true);
    expect((await new AxeBuilder({ page }).include(".usage-report-selector").analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`personal-report-${role}.png`), fullPage: true });
    const navigation = page.getByRole("navigation", { name: "Primary views" });
    await navigation.getByRole("button", { name: "Users", exact: true }).click();
    await expect(selector).toHaveValue(state.second.id);
    await expect(page).toHaveURL(`/users?snapshot=${state.second.id}`);
    await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeVisible();
    expect(state.userRequests.some(query => query.get("setId") === state.second.id)).toBe(true);
    await selector.selectOption("");
    await expect(page).toHaveURL(/\/users$/);
    await expect(selector).toHaveValue("");
    await navigation.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(selector).toHaveValue("");
    await expect(used).toContainText("2");
    await expect(page).toHaveURL(/\/agents$/);
    expect(state.mutations).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
}

test("personal report bookmarks and browser history restore both pages without clearing table filters", async ({ page }) => {
  const state = await mockReportSelection(page);
  await page.goto(`/users?view=activity&snapshot=${state.first.id}&agent=agent-a`);
  const selector = page.getByRole("combobox", { name: "Report set", exact: true });
  await expect(selector).toHaveValue(state.first.id);
  await selector.selectOption(state.second.id);
  await expect(page).toHaveURL(`/users?view=activity&agent=agent-a&snapshot=${state.second.id}`);
  await page.goBack();
  await expect(selector).toHaveValue(state.first.id);
  await page.goForward();
  await expect(selector).toHaveValue(state.second.id);
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Agents", exact: true }).click();
  await expect(selector).toHaveValue(state.second.id);
  await page.reload();
  await expect(selector).toHaveValue(state.second.id);
  expect(state.latest()).toBe(state.first.id);
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("Latest follows new report content automatically while a personal pin stays pinned", async ({ page }) => {
  const state = await mockReportSelection(page, "Viewer");
  await page.goto("/agents");
  const selector = page.getByRole("combobox", { name: "Report set", exact: true });
  const used = page.getByRole("region", { name: "Agent inventory overview" }).getByText("Reported used agents").locator("..");
  await expect(used).toContainText("2");
  await selector.selectOption(state.second.id);
  await expect(used).toContainText("7");
  state.publishLatest();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(selector).toHaveValue(state.second.id);
  await expect(selector.locator(`option[value="${state.third.id}"]`)).toHaveCount(1);
  await expect(used).toContainText("7");
  await selector.selectOption("");
  await expect(used).toContainText("9");
  await expect(selector).toHaveValue("");
  await expect(page).toHaveURL(/\/agents$/);
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("a deleted personal report returns to Latest with an explicit notice, not an approval or manual-start step", async ({ page }) => {
  const state = await mockReportSelection(page, "Viewer");
  await page.goto(`/users?snapshot=${state.second.id}`);
  const selector = page.getByRole("combobox", { name: "Report set", exact: true });
  await expect(selector).toHaveValue(state.second.id);
  state.removeOlder();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(selector).toHaveValue("");
  await expect(page.getByText(/no longer available.*latest available/i)).toBeVisible();
  await expect(page).toHaveURL(/\/users$/);
  await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeVisible();
  expect(state.mutations).toEqual([]);
});

test("viewing a management snapshot does not change the personal report or automatic tenant default", async ({ page }) => {
  const state = await mockReportSelection(page);
  await page.goto("/agents");
  const selector = page.getByRole("combobox", { name: "Report set", exact: true });
  await selector.selectOption(state.second.id);
  const navigation = page.getByRole("navigation", { name: "Primary views" });
  await navigation.getByRole("button", { name: /^Sync/ }).click();
  await page.getByRole("button", { name: "Manage reports", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "Manage reports", exact: true });
  const current = manager.getByRole("row").filter({ has: page.getByRole("cell", { name: "Current", exact: true }) });
  await current.getByRole("button", { name: "View report", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Report details", exact: true });
  await expect(details.getByRole("region", { name: "Reported agent activity" })).toBeVisible();
  expect(state.snapshotRequests.at(-1)?.get("setId")).toBe(state.first.id);
  await details.getByRole("button", { name: "Back to reports", exact: true }).click();
  await manager.getByRole("button", { name: "Close reports", exact: true }).click();
  await navigation.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(selector).toHaveValue(state.second.id);
  expect(state.latest()).toBe(state.first.id);
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
