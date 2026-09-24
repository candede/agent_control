import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { AutomaticRefreshResult } from "../src/api/client";
import { automaticRefreshFixture, isAutomaticRefreshRequest } from "./automaticRefreshFixtures";
import { layoutTime, mockLayoutApi } from "./layoutFixtures";

test.beforeEach(async ({ page }) => {
  // The network-isolated fixture has only loopback; these mocked scheduler cases model an online browser.
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, value: true }));
});
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

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
