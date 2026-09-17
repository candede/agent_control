import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { DataSyncRun, DataSyncSourceId, DataSyncState, StartDataSyncInput } from "../src/api/client";
import { mockLayoutApi } from "./layoutFixtures";
import { createUnifiedVerification } from "../src/test/inventoryVerification";

const sourceIds: DataSyncSourceId[] = ["users", "graph_packages", "power_platform", "usage_reports"];
const initial: DataSyncState = {
  onboardingRequired: true,
  usageImportRequired: true,
  run: null,
  sources: sourceIds.map(source => ({
    source, status: "not_started", count: null, lastSuccessAt: null, updatedAt: null,
    jobId: null, message: "", canRetry: false,
  })),
};

async function mockSync(page: Page, firstState: DataSyncState, retainedRuns: DataSyncRun[] = []) {
  const unexpected = await mockLayoutApi(page);
  let state = firstState;
  const starts: StartDataSyncInput[] = [];
  const reads: string[] = [];
  await page.route("**/api/agent-inventory?*", route => route.fulfill({ json: {
    revision: "a".repeat(64),
    verification: createUnifiedVerification({ graphPackageCount: 0, powerPlatformAgentCount: 0, logicalAgentCount: 0 }, { sourceScopes: false }),
    value: [], count: 0, offset: 0, limit: 50,
    summary: { total: 0, linked: 0, graphOnly: 0, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 },
    filteredSummary: { total: 0, linked: 0, graphOnly: 0, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 },
    sources: {
      graphPackages: { state: "unavailable", observation: null, error: null },
      powerPlatform: { state: "unavailable", observation: null, error: null },
    },
    partial: false, errors: [],
  } }));
  await page.route("**/api/data-sync/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET") {
      reads.push(path);
      if (path === "/api/data-sync/state") return route.fulfill({ json: state });
      const run = [state.run, ...retainedRuns].find(run => run && path === `/api/data-sync/runs/${run.id}`);
      if (run) return route.fulfill({ json: run });
      return route.fulfill({ status: 404, json: { error: "Requested sync run not found." } });
    }
    if (route.request().method() !== "POST" || path !== "/api/data-sync/runs") {
      unexpected.push(`${route.request().method()} ${path}`);
      return route.fulfill({ status: 501, json: { error: "Unexpected sync fixture request" } });
    }
    const input = route.request().postDataJSON() as StartDataSyncInput;
    starts.push(input);
    const run: DataSyncRun = {
      id: "11111111-1111-4111-8111-111111111111", mode: input.mode, status: "running",
      startedAt: "2026-09-15T10:00:00.000Z", updatedAt: "2026-09-15T10:00:00.000Z", completedAt: null,
      sources: initial.sources.filter(source => !input.sources || input.sources.includes(source.source)).map(source => ({
        ...source,
        status: source.source === "usage_reports" ? "awaiting_upload"
          : source.source === "users" && !input.sources ? "succeeded" : "running",
        count: source.source === "users" && !input.sources ? 42 : null,
        message: source.source === "graph_packages" ? "Reading the next page of Graph packages." : "",
      })),
    };
    state = { ...state, run, sources: run.sources };
    return route.fulfill({ status: 202, json: run });
  });
  return { starts, reads, unexpected, finish() {
    if (!state.run) throw new Error("Expected a sync run before completion.");
    const sources = state.sources.map(source => ({ ...source, status: "succeeded" as const, count: 42 }));
    state = {
      onboardingRequired: false, usageImportRequired: false, sources,
      run: { ...state.run, status: "completed", sources },
    };
  } };
}

function completedState(): DataSyncState {
  const sources = initial.sources.map(source => ({
    ...source, status: "succeeded" as const, count: 42, lastSuccessAt: "2026-09-15T10:01:00.000Z",
  }));
  return {
    onboardingRequired: false, usageImportRequired: false, sources,
    run: {
      id: "be5ba369-4cc9-4a32-ba3b-f08d781acba0", mode: "initial", status: "completed",
      startedAt: "2026-09-15T10:00:00.000Z", updatedAt: "2026-09-15T10:01:00.000Z",
      completedAt: "2026-09-15T10:01:00.000Z", sources,
    },
  };
}

function primarySync(page: Page) {
  return page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: /^Sync/ });
}

async function expectAccessibleSyncPage(page: Page) {
  const panel = page.getByRole("region", { name: "Data sync", exact: true });
  await expect(panel.getByRole("heading", { name: "Data sync", level: 2 })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const sourceCounts = page.locator(".sync-inventory-counts");
  if (await sourceCounts.isVisible()) {
    expect(await sourceCounts.evaluate(element => getComputedStyle(element).display)).toBe("grid");
    expect(await sourceCounts.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(/\s+/).length))
      .toBe(page.viewportSize()!.width >= 1000 ? 4 : 2);
  }
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.width + bounds!.x).toBeLessThanOrEqual(page.viewportSize()!.width);
  const accessibility = await new AxeBuilder({ page })
    .include(".data-sync-panel").include(".sync-inventory-tools").include(".jobs-view").analyze();
  expect(accessibility.violations).toEqual([]);
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("setup stays out of Agents and the responsive Sync page continues live progress in the background", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const fixture = await mockSync(page, initial);
  await page.goto("/agents");
  const navigation = page.getByRole("navigation", { name: "Primary views" });
  const syncButton = primarySync(page);
  const panel = page.getByRole("region", { name: "Data sync", exact: true });
  await expect(syncButton).toContainText("Setup needed");
  await expect(page).toHaveURL(/\/agents$/);
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Data sync/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Source matching details" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Power Platform agent source" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Saved agent inventory verification" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Verify saved inventory" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Filters" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Exact package bulk actions" })).toHaveCount(0);
  await expect(page.locator(".bulk-panel, .selection-summary, .data-sync-toggle")).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  expect(fixture.starts).toEqual([]);
  await syncButton.click();
  await expect(page).toHaveURL(/\/sync$/);
  await expect(syncButton).toHaveAttribute("aria-current", "page");
  await expect(panel.getByRole("button", { name: "Start initial sync", exact: true })).toBeEnabled();
  await expect(page.getByText("Advanced results", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent inventory sources" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Sync history" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("sync-setup.png") });
  await panel.getByRole("button", { name: "Start initial sync", exact: true }).click();
  await expect(panel.getByText("Syncing graph packages, power platform objects", { exact: true })).toBeVisible();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "1");
  await expect(panel.getByRole("progressbar")).toHaveAttribute("max", "4");
  await expect(panel.getByText("Reading the next page of Graph packages.")).toBeVisible();
  await expect(panel.getByText(/Sync continues when you switch tabs/)).toBeVisible();
  expect(fixture.starts).toEqual([{ mode: "initial" }]);
  await expectAccessibleSyncPage(page);
  await page.screenshot({ path: info.outputPath("sync-progress.png") });
  await expect(panel.getByRole("button", { name: /Close data sync|Continue in app/ })).toHaveCount(0);
  await expect(panel.locator("footer")).toHaveCount(0);
  await syncButton.focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await expect(syncButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(navigation.getByRole("button", { name: "Permissions", exact: true })).toBeFocused();
  await navigation.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(panel).toHaveCount(0);
  const readsBeforeCompletion = fixture.reads.length;
  fixture.finish();
  await expect(syncButton).not.toContainText("Setup needed");
  expect(fixture.reads.length).toBeGreaterThan(readsBeforeCompletion);
  await expect(page).toHaveURL(/\/agents$/);
  await expect(panel).toHaveCount(0);
  await syncButton.click();
  await expect(panel.getByText("Sync complete", { exact: true })).toBeVisible();
  await expect(panel.getByRole("progressbar")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Check progress" })).toHaveCount(0);
  await expect(panel.getByText(/Closing this window does not cancel sync/)).toHaveCount(0);
  await expect(panel.getByText("Refresh saved data", { exact: true })).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Manage uploads" })).not.toBeVisible();
  await expectAccessibleSyncPage(page);
  await page.screenshot({ path: info.outputPath("sync-complete.png") });
  const sourceDetails = panel.locator("summary", { hasText: "View sync details" });
  await expect(panel.locator(".data-sync-source-details")).not.toHaveAttribute("open", "");
  await sourceDetails.focus();
  await page.keyboard.press("Enter");
  await panel.getByRole("button", { name: "Manage uploads" }).click();
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/\/sync$/);
  const importer = page.getByRole("dialog", { name: "Import and manage reports" });
  await expect(importer).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await importer.getByRole("button", { name: "Close report import" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  expect(fixture.starts).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test("a completed saved run opens without setup and progress clutter", async ({ page }, info) => {
  const fixture = await mockSync(page, completedState());
  await page.goto("/users");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await primarySync(page).click();
  const panel = page.getByRole("region", { name: "Data sync", exact: true });
  await expect(primarySync(page)).not.toContainText("Setup needed");
  await expect(panel.getByText("Sync complete", { exact: true })).toBeVisible();
  await expect(panel.getByText(/Saved inventory checks run automatically. Optional diagnostics are in Advanced results/)).toBeVisible();
  await expect(panel.getByText(/Verify saved inventory below/)).toHaveCount(0);
  await expect(panel.getByRole("progressbar")).toHaveCount(0);
  await expect(panel.getByText("Keep your saved data up to date")).toHaveCount(0);
  await expect(panel.getByText("Refresh saved data", { exact: true })).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Check progress" })).toHaveCount(0);
  await expect(panel.getByText("What does sync include?")).not.toBeVisible();
  await expect(panel.getByText("be5ba369-4cc9-4a32-ba3b-f08d781acba0", { exact: true })).not.toBeVisible();
  expect(await panel.locator(".data-sync-details").evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
  await expectAccessibleSyncPage(page);
  await page.screenshot({ path: info.outputPath("sync-completed-saved-run.png") });
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Users", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(fixture.starts).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("clean resync is separate from refresh and requires an informed confirmation", async ({ page }, info) => {
  const fixture = await mockSync(page, {
    ...initial, onboardingRequired: false, usageImportRequired: false,
    sources: initial.sources.map(source => ({ ...source, status: "succeeded", count: 42 })),
  });
  await page.goto("/users");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await primarySync(page).click();
  const panel = page.getByRole("region", { name: "Data sync", exact: true });
  await expect(panel.getByRole("button", { name: "Refresh saved data", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Start initial sync" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Clear saved data and resync", exact: true }).click();
  const confirm = panel.getByRole("button", { name: "Clear and start full resync" });
  await expect(confirm).toBeDisabled();
  expect(fixture.starts).toHaveLength(0);
  await expect(panel.getByText(/Accepted usage reports, report history, audit records/)).toBeVisible();
  await confirm.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("sync-clean-confirmation.png") });
  await panel.getByRole("checkbox", { name: /I understand/ }).check();
  await confirm.click();
  await expect(panel.getByText("Syncing graph packages, power platform objects", { exact: true })).toBeVisible();
  expect(await panel.locator(".data-sync-details").evaluate(element => element.scrollTop)).toBe(0);
  expect(fixture.starts).toEqual([{ mode: "full", clearSavedData: true }]);
  expect(fixture.unexpected).toEqual([]);
});

test("direct Sync navigation keeps diagnostics optional and history restricted to sync sources", async ({ page }) => {
  const fixture = await mockSync(page, initial);
  await page.goto("/sync");
  await expect(primarySync(page)).toHaveAttribute("aria-current", "page");
  await expect(primarySync(page)).toContainText("Setup needed");
  await expect(page.getByRole("heading", { name: "Data sync", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start initial sync", exact: true })).toBeEnabled();
  const inventory = page.getByRole("region", { name: "Advanced results" });
  await expect(inventory).toBeVisible();
  const disclosure = inventory.getByText("Advanced results", { exact: true });
  await expect(inventory.locator("details")).not.toHaveAttribute("open");
  await expect(inventory.getByRole("region", { name: "Source matching details" })).toBeHidden();
  await expect(inventory.getByRole("region", { name: "Saved agent inventory verification" })).toBeHidden();
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(inventory.locator("details")).toHaveAttribute("open");
  await expect(inventory.getByRole("region", { name: "Saved agent inventory verification" })).toBeVisible();
  await expect(inventory.getByText(/No manual verification or administrator approval is required after sync/)).toBeVisible();
  await expect(inventory.getByRole("region", { name: "Source matching details" })).toBeVisible();
  await expect(inventory.getByRole("region", { name: "Power Platform agent source" })).toBeVisible();
  await expect(inventory.getByRole("button", { name: "Refresh matching details" })).toBeDisabled();
  const history = page.getByRole("region", { name: "Sync history" });
  await expect(history.getByRole("heading", { name: "Sync history", level: 2 })).toBeVisible();
  await expect(history.getByText("Power Platform inventory refresh", { exact: true })).toBeVisible();
  await expect(history.getByText("Package access recovery")).toHaveCount(0);
  await expect(history.getByText("Saved Purview compliance search")).toHaveCount(0);
  await expect(history.getByText("Saved Defender agent inventory")).toHaveCount(0);
  await expect(history.getByText(/quarantine.*temporarily_unavailable/i)).toHaveCount(0);
  const filter = history.getByRole("combobox", { name: "Filter jobs by source" });
  await expect(filter.locator("option")).toHaveText([
    "All sources", "Data sync", "Package refresh", "Power Platform", "Official usage",
  ]);
  await filter.selectOption("official-usage");
  await expect(history.getByText("Power Platform inventory refresh", { exact: true })).toHaveCount(0);
  await filter.selectOption("all");
  await expect(history.getByText("Power Platform inventory refresh", { exact: true })).toBeVisible();
  await expectAccessibleSyncPage(page);
  expect(fixture.starts).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("a running sync survives back, forward, and reload without starting another run", async ({ page }) => {
  const fixture = await mockSync(page, initial);
  await page.goto("/users");
  await expect(primarySync(page)).toContainText("Setup needed");
  await expect(page).toHaveURL(/\/users$/);
  await expect(page.getByRole("region", { name: "Data sync", exact: true })).toHaveCount(0);
  await primarySync(page).click();
  const panel = page.getByRole("region", { name: "Data sync", exact: true });
  await panel.getByRole("button", { name: "Start initial sync", exact: true }).click();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "1");
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Users", exact: true }).click();
  await expect(page).toHaveURL(/\/users$/);
  await expect(panel).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/sync$/);
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "1");
  await expect(primarySync(page)).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(page).toHaveURL(/\/users$/);
  await expect(panel).toHaveCount(0);
  await page.reload();
  await expect(primarySync(page)).toContainText("Setup needed");
  await expect(page).toHaveURL(/\/users$/);
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await primarySync(page).click();
  await page.reload();
  await expect(page).toHaveURL(/\/sync$/);
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "1");
  await expect(panel.getByText("Reading the next page of Graph packages.")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  expect(fixture.starts).toEqual([{ mode: "initial" }]);
  expect(fixture.unexpected).toEqual([]);
});

test("Users Sync users navigates to Sync while starting only users", async ({ page }) => {
  const fixture = await mockSync(page, completedState());
  await page.goto("/users");
  await expect(page.getByRole("region", { name: "Data sync", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Sync users", exact: true }).click();
  await expect(page).toHaveURL(/\/sync$/);
  await expect(primarySync(page)).toHaveAttribute("aria-current", "page");
  const panel = page.getByRole("region", { name: "Data sync", exact: true });
  await expect(panel.getByText("Syncing users", { exact: true })).toBeVisible();
  await expect(panel.getByRole("article", { name: "Users", exact: true })).toBeVisible();
  await expect(panel.getByRole("article", { name: "Graph packages" })).toHaveCount(0);
  await expect(panel.getByRole("article", { name: "Power Platform objects" })).toHaveCount(0);
  await expect(panel.getByRole("progressbar")).toHaveAttribute("max", "1");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fixture.starts).toEqual([{ mode: "incremental", sources: ["users"] }]);
  expect(fixture.unexpected).toEqual([]);
});

for (const entryPath of ["/sync", "/agents"]) {
  test(`retained run links from ${entryPath} resolve to the exact Sync page across reload and history`, async ({ page }) => {
    const latest = completedState();
    const retained: DataSyncRun = {
      ...latest.run!,
      id: "22222222-2222-4222-8222-222222222222",
      status: "partial",
      completedAt: null,
      sources: latest.sources.map(source => source.source === "graph_packages"
        ? { ...source, status: "failed", canRetry: true, message: "Retained package read failed." }
        : source),
    };
    const fixture = await mockSync(page, latest, [retained]);
    await page.goto(`${entryPath}?syncRun=${retained.id}`);
    await expect(page).toHaveURL(`/sync?syncRun=${retained.id}`);
    const panel = page.getByRole("region", { name: "Data sync", exact: true });
    await expect(primarySync(page)).toHaveAttribute("aria-current", "page");
    await expect(panel.locator("code", { hasText: retained.id })).toBeVisible();
    await expect(panel.getByText("Retained package read failed.")).toBeVisible();
    await expect(panel.locator("code", { hasText: latest.run!.id })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await expect(page).toHaveURL(`/sync?syncRun=${retained.id}`);
    await expect(panel.locator("code", { hasText: retained.id })).toBeVisible();
    await panel.getByRole("button", { name: "Return to latest run" }).click();
    await expect(page).toHaveURL(/\/sync$/);
    await expect(panel.getByText("Sync complete", { exact: true })).toBeVisible();
    await expect(panel.locator("code", { hasText: latest.run!.id })).not.toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(`/sync?syncRun=${retained.id}`);
    await expect(panel.locator("code", { hasText: retained.id })).toBeVisible();
    expect(fixture.reads).toContain(`/api/data-sync/runs/${retained.id}`);
    expect(fixture.starts).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("sync history rewrites legacy sync-run links and opens retained details in place", async ({ page }) => {
  const state = completedState();
  const retained: DataSyncRun = { ...state.run!, id: "33333333-3333-4333-8333-333333333333" };
  const fixture = await mockSync(page, state, [retained]);
  await page.route("**/api/workbench/jobs", route => route.fulfill({ json: {
    value: [{
      id: retained.id, source: "data-sync", label: "Retained initial sync", target: "4 saved sources",
      status: "completed", total: 4, completed: 4, partial: false, canResume: false, canCancel: false, canReconcile: false,
      updatedAt: retained.updatedAt, href: `/agents?syncRun=${retained.id}`,
    }],
    unavailableSources: [], polledAt: retained.updatedAt, requestId: "sync-history-request",
  } }));
  await page.goto("/sync");
  const history = page.getByRole("region", { name: "Sync history" });
  const link = history.getByRole("link", { name: "Open sync details" });
  await expect(link).toHaveAttribute("href", `/sync?syncRun=${retained.id}`);
  await link.click();
  await expect(page).toHaveURL(`/sync?syncRun=${retained.id}`);
  const panel = page.getByRole("region", { name: "Data sync", exact: true });
  await expect(panel.getByText(`Requested sync run ${retained.id}`, { exact: true })).toBeVisible();
  await expect(panel.locator("code", { hasText: retained.id })).not.toBeVisible();
  await panel.locator("summary", { hasText: "View sync details" }).click();
  await expect(panel.locator("code", { hasText: retained.id })).toBeVisible();
  await expect(history.getByRole("heading", { name: "Sync history" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fixture.starts).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
