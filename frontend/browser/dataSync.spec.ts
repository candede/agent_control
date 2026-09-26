import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { DataSyncRun, DataSyncSourceId } from "../src/api/client";
import { completedState, initial, mockSync } from "./dataSyncFixtures";

function primarySync(page: Page) {
  return page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: /^Sync/ });
}

async function expectAccessibleSyncPage(page: Page) {
  const panel = page.getByRole("region", { name: "Data sync", exact: true });
  const reports = page.getByRole("region", { name: "CSV usage reports", exact: true });
  const history = page.getByRole("region", { name: "Sync history", exact: true });
  await expect(reports.getByRole("heading", { name: "CSV usage reports", level: 2 })).toBeVisible();
  await expect(panel.getByRole("region", { name: "CSV usage reports" })).toHaveCount(0);
  expect(await reports.evaluate((element, next) => Boolean(next && element.parentElement === next.parentElement
    && (element.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING)), await panel.elementHandle())).toBe(true);
  expect(await panel.evaluate((element, next) => Boolean(next
    && (element.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING)), await history.elementHandle())).toBe(true);
  await expect(panel.getByRole("heading", { name: "Data sync", level: 2 })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await reports.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
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
    .include(".data-sync-reports").include(".data-sync-panel").include(".sync-inventory-tools").include(".jobs-view").analyze();
  expect(accessibility.violations).toEqual([]);
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("Sync status, run details and history remain live beyond thirty minutes without resume controls", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-23T10:00:00.000Z") });
  const running: DataSyncRun = {
    id: "44444444-4444-4444-8444-444444444444", mode: "initial", status: "running",
    startedAt: "2026-09-23T10:00:00.000Z", updatedAt: "2026-09-23T10:00:00.000Z", completedAt: null,
    sources: initial.sources.filter(source => source.source !== "usage_reports").map(source => ({
      ...source, status: "running", count: 100,
    })),
  };
  const fixture = await mockSync(page, { ...initial, run: running });
  let historyRun = running;
  let historyReads = 0;
  await page.route("**/api/workbench/jobs", route => {
    if (route.request().method() !== "GET") return route.fallback();
    historyReads += 1;
    return route.fulfill({ json: {
      value: [{
        id: historyRun.id, source: "data-sync", label: "Initial sync", target: "3 sources",
        status: historyRun.status, total: 3, completed: historyRun.sources.filter(source => source.status === "succeeded").length,
        partial: false,
        startedAt: historyRun.startedAt, completedAt: historyRun.completedAt, syncSources: historyRun.sources.map(source => source.source),
        updatedAt: historyRun.updatedAt, href: `/sync?syncRun=${historyRun.id}`,
      }],
      unavailableSources: [], polledAt: historyRun.updatedAt, requestId: "long-running-history",
    } });
  });
  const stateReads = () => fixture.reads.filter(path => path === "/api/data-sync/state").length;
  const runReads = () => fixture.reads.filter(path => path === `/api/data-sync/runs/${running.id}`).length;
  await page.goto(`/sync?syncRun=${running.id}`);
  const dialog = page.getByRole("dialog", { name: "Sync run details" });
  await expect(dialog.getByText(running.id, { exact: true })).toBeVisible();
  await expect.poll(stateReads).toBeGreaterThan(0);
  await expect.poll(() => historyReads).toBeGreaterThan(0);
  await page.clock.fastForward(30 * 60_000);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const before = { state: stateReads(), run: runReads(), history: historyReads };
    await page.clock.runFor(2_100);
    await expect.poll(stateReads).toBeGreaterThan(before.state);
    await expect.poll(runReads).toBeGreaterThan(before.run);
    await expect.poll(() => historyReads).toBeGreaterThan(before.history);
  }
  await expect(page.getByRole("button", { name: "Resume updates", includeHidden: true })).toHaveCount(0);
  await expect(page.getByText(/updates (are )?paused/)).toHaveCount(0);
  historyRun = fixture.finish(await page.evaluate(() => new Date().toISOString()));
  await page.clock.runFor(2_100);
  await expect(dialog.getByText("Sync complete", { exact: true })).toBeVisible();
  await expect(page.locator(".data-sync-last-run")).toContainText("Sync complete");
  await expect(page.getByRole("table", { name: "Sync history", includeHidden: true })).toContainText("Complete");
  await expect(page.locator(".data-sync-panel")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".sync-history")).toHaveAttribute("aria-busy", "false");
  const finalReads = { state: stateReads(), run: runReads(), history: historyReads };
  await page.clock.runFor(4_100);
  await expect(dialog).toBeVisible();
  expect({ state: stateReads(), run: runReads(), history: historyReads }).toEqual(finalReads);
  await dialog.getByRole("button", { name: "Back to workspace" }).click();
  expect(fixture.starts).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
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
  await expect(page.getByText("View diagnostics", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent inventory sources" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Sync history" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("sync-setup.png") });
  await panel.getByRole("button", { name: "Start initial sync", exact: true }).click();
  await expect(panel.getByText("Syncing graph packages, power platform", { exact: true })).toBeVisible();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "1");
  await expect(panel.getByRole("progressbar")).toHaveAttribute("max", "3");
  await expect(panel.getByText("650", { exact: true })).toBeVisible();
  await expect(panel.getByText("2,451", { exact: true })).toBeVisible();
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
  await expect(panel.getByText("Sync all sources", { exact: true })).toHaveCount(1);
  const reports = page.getByRole("region", { name: "CSV usage reports", exact: true });
  await expect(reports.getByRole("button", { name: "Add CSV reports" })).toBeVisible();
  await expect(reports.getByRole("button", { name: "Manage reports", exact: true })).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Add CSV reports" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "View report history", exact: true })).toHaveCount(0);
  await expect(panel.getByText("3 of 3 sources synced", { exact: true })).toBeVisible();
  await expect(reports.getByText("Reports available", { exact: true })).toBeVisible();
  await expect(reports.locator("time[datetime='2026-08-01']")).toHaveCount(2);
  await expect(reports.locator("time[datetime='2026-08-30']")).toHaveCount(2);
  await expectAccessibleSyncPage(page);
  await page.screenshot({ path: info.outputPath("sync-complete.png") });
  await expect(panel.locator("details")).toHaveCount(0);
  await reports.getByRole("button", { name: "Add CSV reports" }).click();
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/\/sync\?reports=import$/);
  const importer = page.getByRole("dialog", { name: "Import CSV reports" });
  await expect(importer).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(importer.getByRole("region", { name: "Files", exact: true })).toBeVisible();
  await expect(importer.getByRole("button", { name: "Validate and stage", exact: true })).toBeDisabled();
  await importer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/\/sync$/);
  await expect(reports.getByRole("button", { name: "Add CSV reports", exact: true })).toBeFocused();
  await reports.getByRole("button", { name: "Manage reports", exact: true }).click();
  await expect(page).toHaveURL(/\/sync\?reports=manage$/);
  const manager = page.getByRole("dialog", { name: "Manage reports", exact: true });
  await expect(manager).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(manager.getByRole("list", { name: "Import progress" })).toHaveCount(0);
  await manager.getByRole("button", { name: "Close reports" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(reports.getByRole("button", { name: "Manage reports", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  expect(fixture.starts).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test("current sync has an aligned, keyboard-accessible cancellation footer with pending feedback", async ({ page }, info) => {
  const state = completedState();
  const users = state.sources.find(source => source.source === "users");
  if (!state.run || !users) throw new Error("Expected a saved Users source and run.");
  state.run = {
    ...state.run, mode: "incremental", status: "running", completedAt: null,
    sources: [{ ...users, status: "running", count: 1_500, message: "Checking Copilot candidates from the filtered directory." }],
  };
  const fixture = await mockSync(page, state);
  let finishCancellation!: () => void;
  const cancellation = new Promise<void>(resolve => { finishCancellation = resolve; });
  let requests = 0;
  await page.route(`**/api/data-sync/runs/${state.run.id}/cancel`, async route => {
    expect(route.request().method()).toBe("POST");
    requests += 1;
    await cancellation;
    await route.fulfill({ json: fixture.cancel() });
  });
  await page.goto("/sync");
  const panel = page.getByRole("region", { name: "Data sync", exact: true });
  const footer = panel.getByRole("group", { name: "Current sync actions" });
  const details = footer.getByRole("button", { name: "View run details" });
  const cancel = footer.getByRole("button", { name: "Cancel run" });
  await expect(cancel).toBeVisible();
  await expect(cancel.locator(".lucide-circle-stop")).toHaveCount(1);
  const bounds = await cancel.boundingBox();
  const footerBounds = await footer.boundingBox();
  expect(bounds!.height).toBeGreaterThanOrEqual(40);
  expect(bounds!.x).toBeGreaterThanOrEqual(footerBounds!.x);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(footerBounds!.x + footerBounds!.width + 1);
  expect(await cancel.evaluate(element => getComputedStyle(element).borderRadius))
    .toBe(await panel.getByRole("button", { name: "Check status" }).evaluate(element => getComputedStyle(element).borderRadius));
  if (info.project.name === "desktop") {
    const detailsBounds = await details.boundingBox();
    expect(Math.abs(bounds!.y + bounds!.height / 2 - detailsBounds!.y - detailsBounds!.height / 2)).toBeLessThan(2);
    expect(bounds!.x).toBeGreaterThan(detailsBounds!.x + detailsBounds!.width);
    expect(footerBounds!.height).toBeLessThan(70);
  }
  await expectAccessibleSyncPage(page);
  await cancel.hover();
  await page.screenshot({ path: info.outputPath("sync-cancel-footer.png") });
  await details.focus();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.screenshot({ path: info.outputPath("sync-cancel-focus.png") });
  try {
    await cancel.click();
    const pending = footer.getByRole("button", { name: "Cancelling..." });
    await expect(pending).toBeDisabled();
    await expect(pending).toHaveAttribute("aria-busy", "true");
    await expect(pending.locator(".data-sync-spinning")).toHaveCount(1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(pending.locator(".data-sync-spinning")).toHaveCSS("animation-name", "none");
    await page.screenshot({ path: info.outputPath("sync-cancel-pending.png") });
  } finally {
    finishCancellation();
  }
  await expect(panel.getByText("Sync cancelled", { exact: true })).toBeVisible();
  await expect(panel.getByText("3 of 3 sources synced", { exact: true })).toBeVisible();
  await expect(footer).toHaveCount(0);
  expect(requests).toBe(1);
  expect(fixture.unexpected).toEqual([]);
});

test("a completed saved run opens without setup and progress clutter", async ({ page }, info) => {
  const fixture = await mockSync(page, completedState());
  await page.goto("/users");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await primarySync(page).click();
  const panel = page.getByRole("region", { name: "Data sync", exact: true });
  await expect(primarySync(page)).not.toContainText("Setup needed");
  await expect(panel.getByText("Sync complete", { exact: true })).toBeVisible();
  await expect(panel.getByText("3 of 3 sources synced", { exact: true })).toBeVisible();
  await expect(panel.getByRole("article", { name: "Graph packages" })).toBeVisible();
  await expect(panel.getByText(/Verify saved inventory below/)).toHaveCount(0);
  await expect(panel.getByRole("progressbar")).toHaveCount(0);
  await expect(panel.getByText("Keep your saved data up to date")).toHaveCount(0);
  await expect(panel.getByText("Sync all sources", { exact: true })).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Check progress" })).toHaveCount(0);
  await expect(panel.locator("details")).toHaveCount(0);
  await expect(panel.getByText("be5ba369-4cc9-4a32-ba3b-f08d781acba0", { exact: true })).not.toBeVisible();
  expect(await panel.locator(".data-sync-details").evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
  await expectAccessibleSyncPage(page);
  await page.screenshot({ path: info.outputPath("sync-completed-saved-run.png") });
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Users", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(fixture.starts).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const attempts of ["completed", "mixed"] as const) {
  test(`workspace columns align with ${attempts} source attempts`, async ({ page }, info) => {
    const state = completedState();
    const counts: Record<DataSyncSourceId, number> = {
      users: 3973, graph_packages: 1039, power_platform: 4219, usage_reports: 1111,
    };
    state.sources = state.sources.map(source => ({ ...source, count: counts[source.source] }));
    if (attempts === "mixed") {
      if (!state.run) throw new Error("Expected a completed run in the alignment fixture.");
      state.run = {
        ...state.run, status: "partial",
        sources: state.run.sources.map(source => source.source === "graph_packages"
          ? { ...source, status: "permission_required", canRetry: true }
          : source.source === "power_platform" ? { ...source, status: "failed", canRetry: true } : source),
      };
    }
    const fixture = await mockSync(page, state);
    await page.goto("/sync");
    const workspace = page.getByRole("region", { name: "Workspace data", exact: true });
    await expect(workspace.getByText("3,973", { exact: true })).toBeVisible();
    const users = workspace.getByRole("article", { name: "Users", exact: true });
    await expect(users.getByText("directory users checked", { exact: true })).toBeVisible();
    await expect(users).toContainText("count is directory users checked, not licensed users or tenant headcount");
    if (attempts === "mixed") await expect(workspace.getByText("Permission required", { exact: true })).toBeVisible();

    const widths = info.project.name === "desktop" ? [1440, 1280, 1001, 1000, 768, 601] : [360, 390, 600];
    for (const width of widths) {
      await page.setViewportSize({ width, height: info.project.name === "desktop" ? 1000 : 780 });
      const columns = [
        ".data-sync-source-name",
        "dl > div:first-child > dt",
        "dl > div:first-child > dd:first-of-type",
        "dl > div:nth-child(2) > dt",
        "dl > div:nth-child(2) > dd",
        ".data-sync-source-attempt > span:first-child",
        ".data-sync-source-attempt > .status-badge",
        ...(width > 1000 ? [".data-sync-source-actions button"] : []),
      ];
      for (const column of columns) {
        const cells = workspace.locator(`.data-sync-source ${column}`);
        await expect(cells).toHaveCount(3);
        const starts = await cells.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left));
        expect(Math.max(...starts) - Math.min(...starts), `${column} at ${width}px`).toBeLessThanOrEqual(1);
      }
      const fitsViewport = await workspace.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth
          && element.scrollWidth <= element.clientWidth;
      });
      expect(fitsViewport, `Workspace fits at ${width}px`).toBe(true);
      if (width === widths[0]) await workspace.screenshot({ path: info.outputPath("aligned-workspace-columns.png") });
    }
    expect(fixture.starts).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("clean resync is separate from refresh and requires an informed confirmation", async ({ page }, info) => {
  const fixture = await mockSync(page, {
    ...initial, onboardingRequired: false, usageImportRequired: false,
    sources: initial.sources.map(source => ({ ...source, status: "succeeded", count: 42 })),
  });
  await page.goto("/users");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await primarySync(page).click();
  const panel = page.getByRole("region", { name: "Data sync", exact: true });
  await expect(panel.getByRole("button", { name: "Sync all sources", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Start initial sync" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Reset saved data...", exact: true }).click();
  const confirm = panel.getByRole("button", { name: "Clear and start full resync" });
  await expect(confirm).toBeDisabled();
  expect(fixture.starts).toHaveLength(0);
  await expect(panel.getByText(/Accepted usage reports, report history, audit records/)).toBeVisible();
  await confirm.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("sync-clean-confirmation.png") });
  await panel.getByRole("checkbox", { name: /I understand/ }).check();
  await confirm.click();
  await expect(panel.getByText("Syncing graph packages, power platform", { exact: true })).toBeVisible();
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
  const inventory = page.getByRole("region", { name: "Inventory health", exact: true });
  await expect(inventory).toBeVisible();
  const disclosure = inventory.getByText("View diagnostics", { exact: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(inventory.getByRole("region", { name: "Source matching details" })).toHaveCount(0);
  await expect(inventory.getByRole("region", { name: "Saved agent inventory verification" })).toHaveCount(0);
  await disclosure.focus();
  await page.keyboard.press("Enter");
  const diagnostics = page.getByRole("dialog", { name: "Inventory diagnostics" });
  await expect(diagnostics).toBeVisible();
  await expect(inventory.getByRole("region", { name: "Saved agent inventory verification" })).toBeVisible();
  await expect(inventory.getByText(/No manual verification or administrator approval is required after sync/)).toBeVisible();
  await expect(inventory.getByRole("region", { name: "Source matching details" })).toBeVisible();
  await expect(inventory.getByRole("region", { name: "Power Platform agent source" })).toBeVisible();
  await expect(inventory.getByRole("button", { name: "Refresh matching details" })).toBeDisabled();
  expect((await new AxeBuilder({ page }).include(".sync-dialog[open]").analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(diagnostics).not.toBeVisible();
  await expect(disclosure).toBeFocused();
  const history = page.getByRole("region", { name: "Sync history", exact: true });
  await expect(history.getByRole("heading", { name: "Sync history", level: 2 })).toBeVisible();
  await expect(history.getByText(/CSV imports are retained in Manage reports above/)).toBeVisible();
  await expect(history.getByRole("link", { name: /reports|report history/i })).toHaveCount(0);
  await expect(history.getByRole("button", { name: /reports|report history/i })).toHaveCount(0);
  await expect(history.getByRole("button", { name: /Sync runs|Source jobs/ })).toHaveCount(0);
  await expect(history.getByRole("table", { name: "Sync history" })).toBeVisible();
  await expect(history.getByText("Power Platform inventory refresh", { exact: true })).toBeVisible();
  await expect(history.getByText("Package access recovery")).toHaveCount(0);
  await expect(history.getByText("Saved Purview compliance search")).toHaveCount(0);
  await expect(history.getByText("Saved Defender agent inventory")).toHaveCount(0);
  await expect(history.getByText(/quarantine.*temporarily_unavailable/i)).toHaveCount(0);
  const filter = history.getByRole("combobox", { name: "Outcome" });
  await expect(filter.locator("option")).toHaveText([
    "All outcomes", "Complete", "In progress", "Incomplete or stopped",
  ]);
  await filter.selectOption("active");
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

test("Users navigation stays read-only and Sync retains the explicit users-only action", async ({ page }) => {
  const fixture = await mockSync(page, completedState());
  await page.goto("/users");
  await expect(page.getByRole("region", { name: "Data sync", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sync users", exact: true })).toHaveCount(0);
  await primarySync(page).click();
  await expect(page).toHaveURL(/\/sync$/);
  await expect(primarySync(page)).toHaveAttribute("aria-current", "page");
  const panel = page.getByRole("region", { name: "Data sync", exact: true });
  expect(fixture.starts).toEqual([]);
  await panel.getByRole("article", { name: "Users", exact: true }).getByRole("button", { name: "Sync users", exact: true }).click();
  await expect(panel.getByText("Syncing users", { exact: true })).toBeVisible();
  await expect(panel.getByRole("article", { name: "Users", exact: true })).toBeVisible();
  await expect(panel.getByRole("article", { name: "Graph packages" })).toBeVisible();
  await expect(panel.getByRole("article", { name: "Graph packages" }).getByText("42", { exact: true })).toBeVisible();
  await expect(panel.getByRole("article", { name: "Power Platform" })).toBeVisible();
  await expect(panel.getByText("3 of 3 sources synced")).toBeVisible();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("max", "1");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fixture.starts).toEqual([{ mode: "incremental", sources: ["users"] }]);
  fixture.finish();
  await expect(panel.getByText("Sync complete", { exact: true })).toBeVisible();
  await expect(panel.getByText("3 of 3 sources synced")).toBeVisible();
  await expect(panel.getByText(/1 of 1/)).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

for (const status of ["partial", "cancelled"] as const) {
  test(`${status} sync runs stay read-only while the normal Sync action starts a fresh run`, async ({ page }) => {
    const state = completedState();
    const previous: DataSyncRun = {
      ...state.run!,
      status,
      sources: state.run!.sources.filter(source => source.source !== "usage_reports").map(source =>
        source.source === "users" ? source : {
          ...source,
          status: status === "cancelled" ? "cancelled" : source.source === "graph_packages" ? "failed" : "partial",
          canRetry: true,
          message: "The previous collection stopped; its saved data was kept.",
        }),
    };
    const fixture = await mockSync(page, { ...state, run: previous }, [previous]);
    await page.goto("/sync");
    const panel = page.getByRole("region", { name: "Data sync", exact: true });
    const workspace = panel.getByRole("region", { name: "Workspace data", exact: true });
    await expect(workspace.getByText("3 of 3 sources synced")).toBeVisible();
    await expect(panel.getByRole("button", { name: /retry|resume/i })).toHaveCount(0);
    await panel.getByRole("button", { name: "View run details" }).click();
    const details = page.getByRole("dialog", { name: "Sync run details" });
    await expect(details.getByText(previous.id, { exact: true })).toBeVisible();
    await expect(details.getByText("The previous collection stopped; its saved data was kept.")).toHaveCount(2);
    await expect(details.getByRole("button", { name: /retry|resume|cancel|^sync |^start /i })).toHaveCount(0);
    await expect(details.getByText(/Start a new sync when you're ready/)).toBeVisible();
    expect(fixture.starts).toEqual([]);

    await details.getByRole("button", { name: "Back to workspace" }).click();
    await panel.getByRole("button", { name: "Sync all sources", exact: true }).click();
    await expect(panel.getByText("Syncing graph packages, power platform", { exact: true })).toBeVisible();
    await expect(workspace.getByRole("article", { name: "Graph packages" }).getByText("42", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Sync all sources", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Cancel run", exact: true })).toBeEnabled();
    expect(fixture.starts).toEqual([{ mode: "incremental" }]);
    await panel.getByRole("button", { name: "View run details" }).click();
    await expect(details.getByText("11111111-1111-4111-8111-111111111111", { exact: true })).toBeVisible();
    await expect(details.getByText(previous.id, { exact: true })).toHaveCount(0);

    await page.goto(`/sync?syncRun=${previous.id}`);
    await expect(details.getByText(previous.id, { exact: true })).toBeVisible();
    await expect(details.getByText("The previous collection stopped; its saved data was kept.")).toHaveCount(2);
    await expect(details.getByRole("button", { name: /retry|resume|cancel|^sync |^start /i })).toHaveCount(0);
    expect(fixture.starts).toEqual([{ mode: "incremental" }]);
    expect(fixture.unexpected).toEqual([]);
  });
}

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
    await expect(page.getByRole("dialog", { name: "Sync run details" })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(`/sync?syncRun=${retained.id}`);
    await expect(panel.locator("code", { hasText: retained.id })).toBeVisible();
    await panel.getByRole("button", { name: "Back to workspace" }).click();
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

test("one chronological sync history combines runs and refreshes, filters outcomes and preserves exact detail links", async ({ page }, info) => {
  const state = completedState();
  const retained: DataSyncRun = { ...state.run!, id: "33333333-3333-4333-8333-333333333333" };
  const fixture = await mockSync(page, state, [retained]);
  await page.route("**/api/workbench/jobs", route => route.request().method() !== "GET" ? route.fallback() : route.fulfill({ json: {
    value: [{
      id: retained.id, source: "data-sync", label: "Retained initial sync", target: "4 saved sources",
      status: "completed", total: 4, completed: 4, partial: false,
      startedAt: retained.startedAt, completedAt: retained.completedAt, syncSources: retained.sources.map(source => source.source),
      updatedAt: retained.updatedAt, href: `/agents?syncRun=${retained.id}`,
    }, {
      id: "history-package", source: "package-refresh", label: "Graph package refresh", target: "Current principal Graph package catalog",
      status: "succeeded", total: 120, completed: 120, partial: false,
      startedAt: "2026-09-15T10:00:20.000Z", completedAt: "2026-09-15T10:01:00.000Z",
      updatedAt: retained.updatedAt, href: "/sync?refreshJob=history-package",
    }, {
      id: "history-platform", source: "power-platform", label: "Power Platform refresh", target: "Agents and environments",
      status: "failed", total: 10, completed: 4, partial: false,
      startedAt: "2026-09-15T10:00:30.000Z", completedAt: "2026-09-15T10:01:00.000Z",
      updatedAt: retained.updatedAt, href: "/sync?powerPlatformJob=history-platform",
    }],
    unavailableSources: [], polledAt: retained.updatedAt, requestId: "sync-history-request",
  } }));
  await page.goto("/sync");
  const history = page.getByRole("region", { name: "Sync history", exact: true });
  const table = history.getByRole("table", { name: "Sync history" });
  await expect(table).toBeVisible();
  await expect(history.getByRole("group", { name: "History type" })).toHaveCount(0);
  await expect(history.getByRole("button", { name: /Sync runs|Source jobs/ })).toHaveCount(0);
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(table.getByRole("row").nth(1)).toContainText("Power Platform refresh");
  await expect(table.getByRole("row").nth(2)).toContainText("Graph package refresh");
  await expect(table.getByRole("row").nth(3)).toContainText("Retained initial sync");
  await expect(table.getByText("120 records saved")).toBeVisible();
  await expect(table.getByText("4 reported so far")).toBeVisible();
  await expect(table.getByText("4 of 4 sources complete")).toBeVisible();
  await expect(table.getByRole("link", { name: /View details for Graph package refresh/ })).toHaveAttribute("href", "/sync?refreshJob=history-package");
  await expect(table.getByRole("link", { name: /View details for Power Platform refresh/ })).toHaveAttribute("href", "/sync?powerPlatformJob=history-platform");
  const outcome = history.getByRole("combobox", { name: "Outcome" });
  await outcome.selectOption("complete");
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table).not.toContainText("Power Platform refresh");
  await outcome.selectOption("incomplete");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table).toContainText("Power Platform refresh");
  await outcome.selectOption("active");
  await expect(history.getByText("No recent records match this outcome.")).toBeVisible();
  await outcome.selectOption("all");
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(table.getByRole("button", { name: /Retry|Cancel|Resume/ })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include(".sync-history").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await history.scrollIntoViewIfNeeded();
  await history.screenshot({ path: info.outputPath("sync-history-table.png") });
  const link = history.getByRole("link", { name: /View details for Retained initial sync/ });
  await expect(link).toHaveAttribute("href", `/sync?syncRun=${retained.id}`);
  await link.click();
  await expect(page).toHaveURL(`/sync?syncRun=${retained.id}`);
  const panel = page.getByRole("region", { name: "Data sync", exact: true });
  await expect(page.getByRole("dialog", { name: "Sync run details" })).toBeVisible();
  await expect(panel.locator("code", { hasText: retained.id })).toBeVisible();
  await expect(history.getByRole("heading", { name: "Sync history" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  expect(fixture.starts).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("run details contain keyboard focus, restore the opener, and respect reduced motion", async ({ page }, info) => {
  const state = completedState();
  state.run = {
    ...state.run!, status: "running", completedAt: null,
    sources: state.sources.filter(source => source.source === "users" || source.source === "graph_packages").map(source => ({
      ...source, status: source.source === "users" ? "running" : "queued",
      count: source.source === "users" ? 17 : 999,
      message: source.source === "users" ? "Checking distinct Copilot candidates." : "Waiting for collection.",
    })),
  };
  const fixture = await mockSync(page, state);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/sync");
  const opener = page.getByRole("button", { name: "View run details" });
  await expect(page.locator(".data-sync-spinning").first()).toHaveCSS("animation-name", "none");
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Sync run details" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("17", { exact: true })).toBeVisible();
  await expect(dialog.getByText("999", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("value", "0");
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("max", "2");
  const closeBounds = await dialog.getByRole("button", { name: "Close sync run details" }).boundingBox();
  expect(closeBounds?.width).toBe(44);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
  }
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
  }
  expect((await new AxeBuilder({ page }).include(".sync-dialog[open]").analyze()).violations).toEqual([]);
  await dialog.screenshot({ path: info.outputPath("sync-run-details.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  expect(fixture.starts).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
