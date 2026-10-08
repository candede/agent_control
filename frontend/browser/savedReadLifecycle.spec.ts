import { expect, test } from "@playwright/test";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { captureInventorySelection, fulfillInventoryPage } from "./selectedInventoryFixture";
import { selectedUsersPage } from "../src/test/selectedUsageFixture";

for (const skewDays of [-365, 365]) {
  test(`retains authorized Agents and Users through lease end with ${skewDays} days calendar skew`, async ({ page }, info) => {
    const serverNow = Date.parse(layoutTime);
    await page.clock.install({ time: new Date(serverNow + skewDays * 86_400_000) });
    const unexpected = await mockLayoutApi(page);
    const metadata = { ...unifiedAgents.selection, validatedAt: layoutTime,
      expiresAt: new Date(serverNow + 10_000).toISOString() };
    const saved = structuredClone(unifiedAgents);
    const old = new Date(serverNow - 86_400_000).toISOString();
    for (const row of saved.value) {
      if (row.observations.graphPackages) row.observations.graphPackages.expiresAt = old;
      for (const detail of Object.values(row.observations.packageSnapshots)) detail.expiresAt = old;
    }

    if (saved.sources.graphPackages.observation) saved.sources.graphPackages.observation.expiresAt = old;
    let captures = 0, pages = 0, users = 0;
    await page.route("**/api/agent-inventory/selections", route => {
      captures++;
      return captureInventorySelection(route, metadata);
    });
    await page.route("**/api/agent-inventory?*", route => {
      pages++;
      return fulfillInventoryPage(route, saved);
    });
    await page.route("**/api/copilot-usage/users?*", route => {
      users++;
      const result = selectedUsersPage();
      result.selection = { ...metadata, id: result.selection.id };
      result.sources.directory = { ...result.sources.directory, state: "stale", expiresAt: old,
        attemptStatus: "failed", message: "Successor failed; retained published directory is readable." };
      return route.fulfill({ json: result });
    });
    await page.goto("/agents");
    await expect(page.getByText("Service desk assistant", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
    expect(captures).toBe(1);
    expect(pages).toBe(1);
    await page.clock.runFor(10_001);
    await expect(page.getByText("Service desk assistant", { exact: true })).toBeVisible();
    await expect(page.getByText(/Showing previously loaded saved inventory/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    expect(captures).toBe(1);
    expect(pages).toBe(1);
    await page.screenshot({ path: info.outputPath("historical-agents.png") });
    await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Users", exact: true }).click();
    await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeVisible();
    await page.clock.runFor(10_001);
    await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeVisible();
    await expect(page.getByText(/Showing previously loaded saved data/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
    expect(users).toBe(1);
    await page.screenshot({ path: info.outputPath("historical-users.png") });
    await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.getByText("Service desk assistant", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Export agent inventory CSV" })).toBeEnabled();
    expect(captures).toBe(2);
    expect(pages).toBe(2);
    expect(unexpected).toEqual([]);
  });
}

for (const mode of ["active", "idle"] as const) {
  test(`retains saved rows for an accelerated 45-minute ${mode} session with bounded requests`, async ({ page }, info) => {
    await page.clock.install({ time: new Date(layoutTime) });
    await page.clock.pauseAt(new Date(layoutTime));
    const unexpected = await mockLayoutApi(page);
    const selection = { ...unifiedAgents.selection, evaluatedAt: layoutTime, validatedAt: layoutTime,
      expiresAt: new Date(Date.parse(layoutTime) + 600_000).toISOString() };
    let captures = 0, pages = 0, observers = 0;
    await page.route("**/api/agent-inventory/selections", route => {
      captures++;
      return captureInventorySelection(route, selection);
    });
    await page.route("**/api/agent-inventory?*", route => {
      pages++;
      return fulfillInventoryPage(route, unifiedAgents);
    });
    await page.route("**/api/data-sync/auto-refresh", route => {
      observers++;
      return route.fulfill({ json: { run: null, detailJob: null,
        revisions: unifiedAgents.selection.publicationRevisions, nextCheckAt: layoutTime } });
    });
    await page.goto("/agents");
    await expect(page.getByText("Service desk assistant", { exact: true })).toBeVisible();
    await expect.poll(() => observers).toBe(1);
    if (mode === "idle") await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    for (let minute = 0; minute < 45; minute++) {
      await page.clock.runFor(60_000);
      await expect.poll(() => observers).toBe(mode === "idle" ? 1 : minute + 2);
      expect(captures).toBe(1);
      expect(pages).toBe(1);
    }
    await expect(page.getByText("Service desk assistant", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
    await expect(page.getByText(/Showing previously loaded saved inventory/)).toBeVisible();
    if (mode === "idle") {
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect.poll(() => observers).toBe(2);
    }
    expect(captures).toBe(1);
    expect(pages).toBe(1);
    expect(unexpected).toEqual([]);
    await info.attach("accelerated-session-counts", { body: JSON.stringify({ mode, elapsed: 2_700_000,
      captures, pages, observers }), contentType: "application/json" });
  });
}
