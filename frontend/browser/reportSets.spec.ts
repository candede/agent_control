import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { buildOfficialUsageAggregateView } from "../../backend/src/services/officialUsageViews";
import type { OfficialUsageConfirmation } from "../src/api/client";
import { reportHistoryFixture } from "../src/components/reportHistoryFixture";
import { usageInsightsPublished, usageOverviewFixture } from "../src/test/usageInsightsFixture";
import { mockLayoutApi } from "./layoutFixtures";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

async function mockReportSelection(page: Page) {
  const unexpected = await mockLayoutApi(page);
  const first = { ...usageInsightsPublished.activeSet!, id: "55555555-5555-4555-8555-555555555555" };
  const second = {
    ...first, id: "77777777-7777-4777-8777-777777777777",
    reportingPeriod: { startDate: "2026-07-01", endDate: "2026-07-30", provenance: "activity_range" as const },
  };
  let selected = first.id;
  let revision = 1;
  const mutations: string[] = [];
  const overviewScopes: Array<string | null> = [];
  const snapshotRequests: URLSearchParams[] = [];
  let directoryReads = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/copilot-usage/users") directoryReads++;
  });
  await page.route("**/api/official-usage/admin", route => route.fulfill({
    json: { activeSetId: selected, activeRevision: revision, sets: [first, second], staging: [] },
  }));
  await page.route("**/api/official-usage/history?*", route => route.fulfill({
    json: reportHistoryFixture([first, second], selected),
  }));
  await page.route("**/api/official-usage/overview?*", route => {
    overviewScopes.push(new URL(route.request().url()).searchParams.get("scope"));
    const data = usageOverviewFixture();
    data.summary.usedAgents = selected === first.id ? 2 : 7;
    return route.fulfill({ json: data });
  });
  await page.route("**/api/official-usage/aggregate?*", route => {
    const params = new URL(route.request().url()).searchParams;
    snapshotRequests.push(params);
    const id = params.get("setId") ?? selected;
    expect([first.id, second.id]).toContain(id);
    return route.fulfill({ json: buildOfficialUsageAggregateView({
      ...usageInsightsPublished, activeRevision: revision, activeSet: id === first.id ? first : second,
    }, [], { staleAfterDays: 35, limit: Number(params.get("limit") ?? 25), offset: Number(params.get("offset") ?? 0) }) });
  });
  await page.route("**/api/official-usage/sets/*/preview", route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ operation: "select" });
    mutations.push("preview");
    const setId = new URL(route.request().url()).pathname.split("/")[4];
    const preview: OfficialUsageConfirmation = {
      id: "synthetic-select-token", operation: "select", setId, activeSetId: selected, expectedRevision: revision,
      confirmationHash: "a".repeat(64), expiresAt: "2030-01-01T00:00:00.000Z",
    };
    return route.fulfill({ json: preview });
  });
  await page.route("**/api/official-usage/confirmations/*", route => {
    expect(route.request().postDataJSON()).toMatchObject({
      operation: "select", activeSetId: selected, expectedRevision: revision, confirmationHash: "a".repeat(64),
    });
    mutations.push("confirm");
    selected = route.request().postDataJSON().setId;
    revision++;
    return route.fulfill({ json: { activeSetId: selected, activeRevision: revision } });
  });
  return { unexpected, first, second, mutations, overviewScopes, snapshotRequests, directoryReads: () => directoryReads };
}

test("report selection updates Agents and Users without navigating away or combining snapshots", async ({ page }, info) => {
  const state = await mockReportSelection(page);
  await page.goto("/agents");
  const selector = page.getByRole("region", { name: "Report set selection" });
  const overview = page.getByRole("region", { name: "Agent inventory overview" });
  const usedCount = overview.getByText("Reported used agents", { exact: true }).locator("..");
  await expect(selector.getByRole("combobox", { name: "Report set", exact: true })).toHaveValue(state.first.id);
  await expect(usedCount).toContainText("2");
  const scopes = page.locator(".agent-catalog-heading").getByRole("group", { name: "Inventory scope" });
  await expect(scopes.getByRole("button")).toHaveCount(2);
  await expect(scopes.getByRole("combobox", { name: "Report set" })).toHaveCount(0);
  await expect(overview.getByRole("group", { name: "Inventory scope" })).toHaveCount(0);
  await expect(overview.locator(".agent-report-context").getByRole("combobox", { name: "Report set" })).toBeVisible();
  await expect(scopes.getByRole("button", { name: "Combined inventory", exact: true })).toHaveCount(0);
  await expect(selector.getByRole("button")).toHaveCount(0);
  await expect(page.getByText(/Select one saved three-file/)).toHaveCount(0);
  expect(state.mutations).toEqual([]);
  await expect(selector.getByRole("option", { name: /Observed activity.*2026-07-01/ })).toHaveCount(1);
  if (info.project.name === "desktop") {
    const scopeBounds = await scopes.boundingBox();
    const metric = await overview.getByText("Reported active · 30 days", { exact: true }).locator("..").boundingBox();
    const context = await overview.locator(".agent-report-context").boundingBox();
    const dropdown = await selector.getByRole("combobox").boundingBox();
    expect(context!.y).toBeCloseTo(metric!.y, 1);
    expect(context!.x).toBeGreaterThanOrEqual(metric!.x + metric!.width - 1);
    expect(dropdown!.y).toBeGreaterThanOrEqual(scopeBounds!.y + scopeBounds!.height);
    expect(dropdown!.x).toBeGreaterThanOrEqual(context!.x);
    expect(dropdown!.x + dropdown!.width).toBeLessThanOrEqual(context!.x + context!.width);
  }
  await selector.getByRole("combobox").selectOption(state.second.id);
  await expect(usedCount).toContainText("7");
  await expect(page).toHaveURL(/\/agents$/);
  expect(state.mutations).toEqual(["preview", "confirm"]);
  expect(state.overviewScopes.every(scope => scope === "selected")).toBe(true);
  await expect(selector.getByRole("combobox")).toHaveValue(state.second.id);
  expect((await new AxeBuilder({ page }).include(".usage-report-selector").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("selected-report-agents.png"), fullPage: true });

  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Users", exact: true }).click();
  await expect(selector.getByRole("combobox")).toHaveValue(state.second.id);
  await expect.poll(state.directoryReads).toBeGreaterThan(0);
  const before = state.directoryReads();
  await selector.getByRole("combobox").selectOption(state.first.id);
  await expect(selector.getByRole("combobox")).toHaveValue(state.first.id);
  await expect.poll(state.directoryReads).toBeGreaterThan(before);
  await expect(page).toHaveURL(/\/users(?:\?|$)/);
  expect(state.mutations).toEqual(["preview", "confirm", "preview", "confirm"]);
  expect(state.unexpected).toEqual([]);
});

test("switching the shared report clears a pinned historical Users report", async ({ page }) => {
  const state = await mockReportSelection(page);
  await page.goto(`/users?view=activity&snapshot=${state.first.id}&agent=agent-a`);
  const selector = page.getByRole("region", { name: "Report set selection" });
  await expect(selector.getByRole("combobox")).toBeEnabled();
  await selector.getByRole("combobox").selectOption(state.second.id);
  await expect(selector.getByRole("combobox")).toHaveValue(state.second.id);
  await expect(page).toHaveURL(/\/users\?view=activity$/);
  expect(state.unexpected).toEqual([]);
});

test("viewing a different saved report never changes the Agents report selection", async ({ page }) => {
  const state = await mockReportSelection(page);
  await page.goto("/agents");
  const selector = page.getByRole("region", { name: "Report set selection" });
  await selector.getByRole("combobox").selectOption(state.second.id);
  await expect(selector.getByRole("combobox")).toHaveValue(state.second.id);
  const navigation = page.getByRole("navigation", { name: "Primary views" });
  await navigation.getByRole("button", { name: /^Sync/ }).click();
  await page.getByRole("button", { name: "Manage reports", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "Manage reports", exact: true });
  await expect(manager.getByRole("button", { name: /Make current|View current snapshot/ })).toHaveCount(0);
  await expect(manager.getByRole("combobox", { name: "Report set", exact: true })).toHaveCount(0);
  const saved = manager.getByRole("row").filter({ has: page.getByRole("cell", { name: "Saved", exact: true }) });
  await saved.getByRole("button", { name: "View report", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Report details", exact: true });
  await expect(details.getByRole("region", { name: "Report agent rows" })).toBeVisible();
  expect(state.snapshotRequests.at(-1)?.get("setId")).toBe(state.first.id);
  expect(state.mutations).toEqual(["preview", "confirm"]);
  await details.getByRole("button", { name: "Back to reports", exact: true }).click();
  await expect(manager.getByRole("row").filter({ has: page.getByRole("cell", { name: "Current", exact: true }) })).toContainText("Jul 1, 2026");
  await manager.getByRole("button", { name: "Close reports", exact: true }).click();
  await navigation.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(selector.getByRole("combobox")).toHaveValue(state.second.id);
  await expect(page.getByRole("region", { name: "Agent inventory overview" }).getByText("Reported used agents").locator("..")).toContainText("7");
  expect(state.mutations).toEqual(["preview", "confirm"]);
  expect(state.unexpected).toEqual([]);
});

test("viewers see report metrics without an admin selection control", async ({ page }) => {
  const state = await mockReportSelection(page);
  await page.route("**/api/me", route => route.fulfill({ json: {
    user: {
      homeAccountId: "fixture-viewer", tenantId: "fixture-tenant", username: "viewer@example.test", displayName: "Viewer",
      roles: ["AgentControl.Viewer"],
    },
    roleAssignmentRequired: false, csrfToken: "fixture-csrf",
  } }));
  const adminReads: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/official-usage/admin") adminReads.push(request.url());
  });
  await page.goto("/agents");
  await expect(page.getByRole("region", { name: "Agent inventory overview" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Report set selection" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Inventory scope" }).getByRole("button")).toHaveCount(2);
  expect(adminReads).toEqual([]);
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
