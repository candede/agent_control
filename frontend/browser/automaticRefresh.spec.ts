import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { AutomaticRefreshResult } from "../src/api/client";
import { copilotUsageFixture } from "../src/test/copilotUsageFixture";
import { automaticRefreshFixture, isAutomaticRefreshRequest } from "./automaticRefreshFixtures";
import { layoutTime, mockLayoutApi } from "./layoutFixtures";

test.beforeEach(async ({ page }) => {
  // The network-isolated fixture has only loopback; these mocked scheduler cases model an online browser.
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, value: true }));
});
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("background Users refresh keeps the page stable and interactive with a subtle corner indicator", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install({ time: new Date(layoutTime) });
  const updated = structuredClone(copilotUsageFixture);
  updated.users[2].importedUsage!.reportedResponsesReceived = 2;
  let refreshing = false;
  let reads = 0;
  let checks = 0;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  await page.route("**/api/data-sync/auto-refresh", route => {
    checks += 1;
    return route.fulfill({ json: {
      ...automaticRefreshFixture({ users: refreshing ? "users-2" : "users-1", graph_packages: "packages-1", power_platform: "platform-1" }),
      nextCheckAt: layoutTime,
    } });
  });
  await page.route("**/api/copilot-usage/users", async route => {
    reads += 1;
    if (refreshing) await pending;
    await route.fulfill({ json: refreshing ? updated : copilotUsageFixture });
  });
  try {
    await page.goto("/users");
    const summary = page.getByLabel("M365 Copilot license summary");
    const table = page.getByRole("region", { name: "M365 Copilot license status", exact: true });
    const search = page.getByRole("searchbox", { name: "Search users or agents" });
    await expect(summary.locator("strong")).toHaveText(["4", "2", "2", "1"]);
    await expect.poll(() => checks).toBe(1);
    await page.clock.runFor(500);
    await search.fill("Ben");
    const tableBefore = await table.boundingBox();
    const rowBefore = await table.locator("tbody").innerText();
    const readsBefore = reads;

    refreshing = true;
    await page.clock.fastForward(60_000);
    await expect.poll(() => reads).toBe(readsBefore + 1);
    await page.clock.runFor(501);
    const indicator = page.getByRole("status", { name: "Background refresh" });
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveCSS("position", "fixed");
    await expect(indicator).toHaveCSS("pointer-events", "none");
    const indicatorBounds = await indicator.boundingBox();
    expect(indicatorBounds!.width).toBe(32);
    expect(indicatorBounds!.height).toBe(32);
    await expect(indicator).toHaveText("");
    await expect(indicator.locator("svg")).toHaveCSS("animation-name", "background-refresh-spin");
    await expect(indicator.locator("svg")).toHaveCSS("animation-timing-function", "linear");
    await expect(indicator.locator("svg")).toHaveCSS("animation-iteration-count", "infinite");
    const firstRotation = await indicator.locator("svg").evaluate(icon => getComputedStyle(icon).transform);
    await expect.poll(() => indicator.locator("svg").evaluate(icon => getComputedStyle(icon).transform)).not.toBe(firstRotation);
    await expect(summary.locator("strong")).toHaveText(["4", "2", "2", "1"]);
    expect(await table.locator("tbody").innerText()).toBe(rowBefore);
    expect(await table.boundingBox()).toEqual(tableBefore);
    await expect(search).toBeFocused();
    await expect(page.getByRole("region", { name: "Users and adoption" })).toHaveAttribute("aria-busy", "false");
    await expect(page.getByText(/Loading saved Copilot|Showing the last saved user snapshot/)).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(indicator.locator("svg")).toHaveCSS("animation-name", "none");
    expect(await new AxeBuilder({ page }).include(".copilot-users").include(".background-refresh-indicator").analyze()).toMatchObject({ violations: [] });
    await page.screenshot({ path: info.outputPath("users-background-refresh.png") });

    await search.fill("Cleo");
    await table.getByRole("button", { name: "Cleo", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Cleo", exact: true });
    await expect(dialog).toBeVisible();
    finish();
    await expect(dialog.getByText("Agent responses", { exact: true }).locator("..").locator("strong")).toHaveText("2");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close user details" }).click();
    await expect(indicator).toHaveCount(0);
    await expect(search).toHaveValue("Cleo");
    expect(unexpected).toEqual([]);
  } finally {
    finish();
  }
});

test("the icon disappears after login requests settle even while automatic sync continues", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install({ time: new Date(layoutTime) });
  let checks = 0;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const state: AutomaticRefreshResult = {
    ...automaticRefreshFixture(),
    nextCheckAt: layoutTime,
    run: {
      id: "login-sync", automatic: true, mode: "incremental", status: "running",
      startedAt: layoutTime, updatedAt: layoutTime, completedAt: null,
      sources: [{ source: "users", status: "running", jobId: null, count: null,
        lastSuccessAt: null, updatedAt: layoutTime, message: "", canRetry: false }],
    },
    detailJob: { id: "login-details", status: "waiting_authorization", updatedAt: layoutTime },
  };
  await page.route("**/api/data-sync/auto-refresh", async route => {
    checks += 1;
    if (checks === 1) await pending;
    await route.fulfill({ json: state });
  });
  try {
    await page.goto("/users");
    await expect.poll(() => checks).toBe(1);
    await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeVisible();
    await page.clock.runFor(501);
    const icon = page.getByRole("status", { name: "Background refresh" });
    await expect(icon).toBeVisible();
    await expect(icon).toHaveText("");
    finish();
    await expect(icon).toHaveCount(0);
    await page.clock.fastForward(60_000);
    await expect.poll(() => checks).toBe(2);
    await expect(icon).toHaveCount(0);
    await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Sync", exact: true }).click();
    await expect(page.getByRole("region", { name: "Automatic refresh", exact: true })).toContainText("Refreshing in the background");
    await expect(icon).toHaveCount(0);
    expect(unexpected).toEqual([]);
  } finally {
    finish();
  }
});

test("recovered automatic sync stays free of the stale sign-in warning across subsequent minute checks", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install({ time: new Date(layoutTime) });
  let result: AutomaticRefreshResult = {
    ...automaticRefreshFixture(),
    nextCheckAt: new Date(Date.parse(layoutTime) + 60_000).toISOString(),
    run: {
      id: "automatic-run", automatic: true, mode: "incremental", status: "partial",
      startedAt: layoutTime, updatedAt: layoutTime, completedAt: layoutTime,
      sources: [{ source: "graph_packages", status: "waiting_authorization", jobId: null, count: null,
        lastSuccessAt: null, updatedAt: layoutTime, message: "Sign in required.", canRetry: true }],
    },
  };
  let checks = 0;
  await page.route("**/api/data-sync/auto-refresh", route => {
    expect(isAutomaticRefreshRequest(route.request())).toBe(true);
    checks += 1;
    return route.fulfill({ json: result });
  });
  await page.goto("/sync");
  const status = page.getByRole("region", { name: "Automatic refresh", exact: true });
  await expect(status.getByRole("link", { name: "Sign in again" })).toBeVisible();
  result = {
    ...result, run: { ...result.run!, id: "recovered-run", status: "running", completedAt: null,
      sources: [{ ...result.run!.sources[0], status: "running", canRetry: false }] },
  };
  await page.clock.fastForward(60_000);
  await expect(status).toContainText("Refreshing in the background");
  await expect(status.getByRole("link", { name: "Sign in again" })).toHaveCount(0);
  result = {
    ...result, run: { ...result.run!, status: "completed", completedAt: layoutTime,
      sources: [{ ...result.run!.sources[0], status: "succeeded", count: 1, lastSuccessAt: layoutTime }] },
  };
  for (let minute = 0; minute < 3; minute += 1) {
    const previousChecks = checks;
    await page.clock.fastForward(60_000);
    await expect.poll(() => checks).toBeGreaterThan(previousChecks);
    await expect(status).toContainText("Automatic refresh · On");
    await expect(status.getByRole("link", { name: "Sign in again" })).toHaveCount(0);
  }
  expect(unexpected).toEqual([]);
});

test("detail permission failures offer permission review instead of another sign-in", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.route("**/api/data-sync/auto-refresh", route => route.fulfill({ json: {
    ...automaticRefreshFixture(),
    detailJob: { id: "denied-detail", status: "failed", errorCode: "missing_permission", updatedAt: layoutTime },
  } satisfies AutomaticRefreshResult }));
  await page.goto("/sync");
  const status = page.getByRole("region", { name: "Automatic refresh", exact: true });
  await expect(status).toContainText("Permission required");
  await expect(status.getByRole("button", { name: "Review permissions" })).toBeVisible();
  await expect(status.getByRole("link", { name: "Sign in again" })).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test("keeps automatic checks running on other pages without rendering the banner", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install();
  let checks = 0;
  await page.route("**/api/data-sync/auto-refresh", route => {
    checks += 1;
    return route.fulfill({ json: automaticRefreshFixture() });
  });
  await page.goto("/agents");
  await expect.poll(() => checks).toBeGreaterThan(0);
  const banner = page.getByRole("region", { name: "Automatic refresh", exact: true });
  const navigation = page.getByRole("navigation", { name: "Primary views" });
  await expect(banner).toHaveCount(0);
  for (const view of ["Users", "Audit", "Permissions", "Jobs"]) {
    await navigation.getByRole("button", { name: view, exact: true }).click();
    await expect(banner).toHaveCount(0);
  }
  const before = checks;
  await page.clock.fastForward(60_000);
  await expect.poll(() => checks).toBeGreaterThan(before);
  await navigation.getByRole("button", { name: /^Sync/ }).click();
  await expect(banner).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("opening Sync from inventory attention immediately shows its cause without a diagnostics dialog", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.goto("/agents");
  await page.getByRole("button", { name: "Inventory needs attention · Open Sync" }).click();
  const health = page.getByRole("region", { name: "Inventory health", exact: true });
  await expect(health.getByText("Power Platform saved inventory is unavailable.")).toBeVisible();
  await expect(health).toBeInViewport();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const healthBox = await health.boundingBox();
  const csvBox = await page.getByRole("region", { name: "CSV usage reports", exact: true }).boundingBox();
  expect(healthBox!.y + healthBox!.height).toBeLessThanOrEqual(csvBox!.y);
  expect(await new AxeBuilder({ page }).include(".sync-inventory-tools").analyze()).toMatchObject({ violations: [] });
  expect(unexpected).toEqual([]);
});
