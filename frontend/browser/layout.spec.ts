import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { usageOverviewFixture } from "../src/test/usageInsightsFixture";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { collectLayoutFailures } from "./layoutGeometry";

const viewports = [360, 768, 1280, 1920];
const cases = [
  { name: "agents", path: "/agents", ready: ".agent-table-stack tbody tr",
    fields: [".agent-filter-fields"] },
  { name: "users", path: "/users", ready: ".copilot-users-table tbody tr",
    fields: [".copilot-users-toolbar"] },
  { name: "report-snapshot", path: "/sync?reports=snapshot", ready: ".usage-agent-table tbody tr",
    fields: [".usage-agent-filters"] },
  { name: "audit-local", path: "/audit", ready: ".audit-table-shell tbody tr",
    fields: [".audit-controls"] },
  { name: "user-purview", path: "/users", ready: ".copilot-users-table tbody tr",
    fields: [".purview-search-primary", ".purview-structured-filters > div"] },
  { name: "agent-investigation", path: "/agents?detail=graph_packages%3Alayout-package-1&detailTab=audit-security", ready: ".hunting-history-table tbody tr",
    fields: [".hunting-primary-fields"] },
  { name: "permissions", path: "/permissions", ready: ".permission-issue-list > li",
    fields: [] },
  { name: "sync-history", path: "/sync", ready: ".sync-history-table tbody tr",
    fields: [] },
];

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

for (const scenario of cases) {
  test(`${scenario.name}: populated saved data and degraded controls fit all viewport widths`, async ({ page }, info) => {
    // The viewport matrix belongs to this test, not to Playwright's desktop/mobile projects.
    test.skip(info.project.name !== "desktop", "The desktop project runs the complete viewport matrix.");
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(`Page error: ${error.message}`));
    page.on("console", message => {
      if (message.type() === "error" || message.type() === "warning") errors.push(`${message.type()}: ${message.text()}`);
    });
    await page.clock.setFixedTime(new Date(layoutTime));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const unexpectedRequests = await mockLayoutApi(page);
    await page.goto(scenario.path);
    await expect(page.locator(scenario.ready).first()).toBeVisible();
    if (scenario.name !== "agent-investigation") {
      const permissions = page.getByRole("button", { name: "Permissions", exact: true, includeHidden: scenario.name === "report-snapshot" });
      await expect(permissions).toHaveCount(1);
      await expect(permissions).toBeVisible();
      await expect(permissions).toHaveAccessibleDescription(/^Permissions: \d+ issues?$/);
    }

    if (scenario.name === "user-purview") {
      await page.getByRole("button", { name: "Ada", exact: true }).click();
      await page.getByRole("button", { name: "Open Purview audit search", exact: true }).click();
      await expect(page.locator(".purview-history-table tbody tr")).toBeVisible();
      await expect(page.getByRole("textbox", { name: "User principal names", exact: true })).toBeVisible();
      await page.locator(".purview-history-table").getByRole("button", { name: /View/ }).click();
      await expect(page.locator(".purview-results tbody tr").first()).toBeVisible();
    }
    if (scenario.name === "agent-investigation") {
      await page.getByText("Agent scope (automatic)", { exact: true }).click();
      await expect(page.getByLabel("Agent IDs", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: /View hunt/ }).click();
      await expect(page.getByText("Saved service desk security observation", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/agents\?.*detailTab=audit-security/);
    }
    if (scenario.name === "permissions") {
      await expect(page.getByRole("region", { name: "Issues", exact: true }).getByRole("button", { name: "Details: Agent inventory", exact: true })).toBeVisible();
      const prerequisites = page.getByRole("region", { name: "App prerequisites" });
      await prerequisites.getByText("Required API permissions", { exact: true }).click();
      await prerequisites.getByText("Optional application permissions", { exact: true }).click();
      await expect(prerequisites.getByRole("region", { name: "Microsoft Graph / Application", exact: true })).toBeVisible();
      const logs = page.getByRole("region", { name: "Log setup" });
      await logs.getByText("Log collection setup", { exact: true }).click();
      await logs.getByText("Steps & permissions", { exact: true }).nth(2).click();
      await expect(logs.getByText(/Get-AdminAuditLogConfig \| Format-List UnifiedAuditLogIngestionEnabled/)).toBeVisible();
    }
    if (scenario.name === "report-snapshot") {
      await expect(page.locator(".usage-report-context")).toContainText("2026-08-30");
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(page.locator("dialog.official-usage-modal")).toBeVisible();
      await expect(page.locator("dialog.official-usage-modal").getByRole("button", { name: "Add CSV reports", exact: true })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Report agent rows" }).locator("tbody tr")).toHaveCount(2);
      await expect(page.locator(".report-chart-panel")).toHaveCount(0);
    }
    if (scenario.name === "agents") {
      await expect(page.locator(".agent-table-stack .capability-gate > button:disabled").first()).toBeVisible();
    }
    if (scenario.name === "sync-history") {
      await expect(page.getByRole("table", { name: "Sync history" })).toContainText("Power Platform inventory refresh");
      await expect(page.getByRole("table", { name: "Sync history" })).not.toContainText("Package access recovery");
      await expect(page.getByRole("button", { name: "Jobs", exact: true })).toHaveCount(0);
    }
    // Unknown provider fields are intentional fixture data, not browser failures.
    // They must not be hidden by broad console filters or by empty-state assertions.
    await expect(page.locator(".error-banner[role=alert]")).toHaveCount(0);

    for (const width of viewports) {
      await test.step(`${width}px geometry and evidence`, async () => {
        await page.setViewportSize({ width, height: width === 360 ? 900 : 1000 });
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        await page.evaluate(() => window.scrollTo(0, 0));
        if (scenario.name === "agents") {
          await page.getByRole("button", { name: "Filters", exact: true }).click();
          await expect(page.getByRole("dialog", { name: "Filter agents", exact: true })).toBeVisible();
        }
        await page.screenshot({ path: info.outputPath(`${scenario.name}-${width}.png`), fullPage: true, animations: "disabled" });
        await assertLayout(page, scenario.fields, `${scenario.name} at ${width}px`);
        if (scenario.name === "agents") {
          const selector = ".agent-filter-fields";
          const expectedColumns = width === 360 ? 1 : 2;
          const columns = await page.locator(selector).evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length);
          expect.soft(columns, `${selector} column contract at ${width}px`).toBe(expectedColumns);
          await page.keyboard.press("Escape");
          await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeFocused();
        }
        if (scenario.name === "agent-investigation") {
          await expect(page.locator(".hunting-readiness > div")).toHaveCount(5);
          await page.getByRole("combobox", { name: "Fixed template", exact: true }).selectOption("agent_activity");
          await expect(page.getByLabel("Actor object IDs", { exact: true })).toHaveCount(0);
          await page.screenshot({ path: info.outputPath(`agent-investigation-${width}-activity-filters.png`), fullPage: true, animations: "disabled" });
          await assertLayout(page, scenario.fields, `agent-scoped activity form at ${width}px`);
          await page.getByRole("combobox", { name: "Fixed template", exact: true }).selectOption("agents_inventory");
        }
        if (scenario.name === "report-snapshot") {
          const totals = page.getByRole("region", { name: "Snapshot tenant totals" });
          const metrics = totals.locator(":scope > div");
          await expect(metrics).toHaveCount(2);
          const first = (await metrics.nth(0).boundingBox())!, second = (await metrics.nth(1).boundingBox())!;
          if (width === 360) {
            expect(second.y, "Narrow snapshots wrap tenant totals without overlap").toBeGreaterThanOrEqual(first.y + first.height);
          } else {
            expect(second.y, "Wide snapshots align tenant totals").toBeCloseTo(first.y, 1);
            expect(second.x).toBeGreaterThanOrEqual(first.x + first.width);
          }
          const modal = page.locator("dialog.official-usage-modal");
          await expect(modal.getByRole("button", { name: "Close", exact: true })).toBeInViewport({ ratio: 1 });
          expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
          if (width >= 1280) {
            const bounds = await page.getByRole("region", { name: "Report agent rows" }).boundingBox();
            expect(bounds!.y, `Source rows begin in the first viewport at ${width}px`).toBeLessThan(760);
          }
        }
        if (["sync-history", "report-snapshot"].includes(scenario.name) && [360, 1920].includes(width)) {
          await test.step("Reduced-motion layout parity", async () => {
            await assertReducedMotionParity(page, `${scenario.name} at ${width}px`);
            await page.screenshot({ path: info.outputPath(`${scenario.name}-${width}-reduced-motion.png`), fullPage: true, animations: "disabled" });
            await assertLayout(page, scenario.fields, `${scenario.name} at ${width}px with reduced motion`);
            await page.emulateMedia({ reducedMotion: "no-preference" });
          });
        }
      });
    }
    expect(unexpectedRequests, "Every request must be served by an explicit synthetic fixture").toEqual([]);
    expect(errors, "No page errors, console errors, or layout warnings").toEqual([]);
  });
}

test("Agents workspace places the real saved-inventory table within 330px on desktop", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The density contract uses exact desktop viewport dimensions.");
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  await page.goto("/agents");
  const overview = page.getByRole("region", { name: "Agent inventory overview" });
  const table = page.locator(".unified-agent-table");
  await expect(table.locator("tbody tr")).toHaveCount(unifiedAgents.value.length);
  await expect(overview.getByText("Reported used agents", { exact: true }).locator("..").locator("strong")).toHaveText("2");
  await expect(overview.getByText("Loading selected report evidence...", { exact: true })).toHaveCount(0);
  await expect(overview.locator(".metric")).toHaveCount(4);
  for (const label of ["Agents in catalog", "Available to end users", "Reported used agents", "Reported active · 30 days"]) {
    await expect(overview.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(overview.getByText("Agents in catalog", { exact: true }).locator("..")).toContainText("Partial data");
  await expect(overview.getByText("Available to end users", { exact: true }).locator("..")).toContainText("Partial data");
  const measurements = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
    const actualViewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(actualViewport, "Density is measured at the exact required headless viewport").toEqual(viewport);
    const geometry = await page.evaluate(() => Object.fromEntries([
      ["header", ".top-bar"], ["heading", ".agent-catalog-heading"], ["metrics", ".agent-inventory-overview"],
      ["toolbar", ".agent-grid-toolbar"], ["table", ".unified-agent-table"], ["firstRow", ".unified-agent-table tbody tr"],
    ].map(([name, selector]) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return [name, { x: rect.x, y: rect.y + window.scrollY, width: rect.width, height: rect.height }];
    })));
    measurements.push({ viewport, actualViewport, geometry });
    await page.screenshot({ path: info.outputPath(`agents-density-${viewport.width}x${viewport.height}.png`), fullPage: true });
    expect.soft(geometry.table.y, `Real table top at ${viewport.width}×${viewport.height}: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(330);
    expect.soft(geometry.firstRow.y, "Actual saved records start immediately after the column headings").toBeLessThanOrEqual(380);
    expect.soft(geometry.header.height, "Common header remains a compact single row on desktop").toBeLessThanOrEqual(72);
    expect.soft(geometry.toolbar.height, "The default toolbar does not hide a permanent second filter row").toBeLessThanOrEqual(64);
    await expect(table.locator("tbody tr").first()).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await assertLayout(page, [], `Saved Agents density at ${viewport.width}px`);
  }
  await info.attach("agents-density-measurements", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
  expect((await new AxeBuilder({ page }).include(".top-bar").include(".agent-workspace").analyze()).violations).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("the compact metric strip distinguishes unavailable sources and missing reports from zero", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const reports = usageOverviewFixture();
  await page.route("**/api/agent-inventory?*", route => route.fulfill({ json: {
    ...unifiedAgents, value: [], count: 0,
    sources: {
      ...unifiedAgents.sources,
      graphPackages: { state: "unavailable", observation: null, error: {
        source: "graph_packages", code: "snapshot_unavailable", message: "No saved package catalog is available.",
      } },
    },
  } }));
  await page.route("**/api/official-usage/overview?*", route => route.fulfill({ json: {
    ...reports, summary: { ...reports.summary, retainedSets: 0, usedAgents: 0, activeAgents30Days: 0 },
  } }));
  await page.route("**/api/official-usage/admin", route => route.fulfill({ json: {
    activeSetId: null, activeRevision: 0, sets: [], staging: [],
  } }));
  await page.goto("/agents");
  const overview = page.getByRole("region", { name: "Agent inventory overview" });
  await expect(overview.locator(".metric")).toHaveCount(4);
  for (const label of ["Agents in catalog", "Available to end users", "Reported used agents", "Reported active · 30 days"]) {
    const metric = overview.getByText(label, { exact: true }).locator("..");
    await expect(metric.locator("strong")).toHaveText("Unknown");
  }
  await expect(overview.getByRole("button", { name: "Show agents in catalog", exact: true })).toBeDisabled();
  await expect(overview.getByRole("button", { name: "Show available to end users", exact: true })).toBeDisabled();
  await expect(overview.getByText("Agents in catalog", { exact: true }).locator("..")).toContainText("Partial data");
  await expect(overview.getByText("Reported used agents", { exact: true }).locator("..")).toContainText("No selected report data");
  await expect(overview.getByText("Reported active · 30 days", { exact: true }).locator("..")).toContainText("No selected report data");
  await expect(overview.locator(".agent-report-context")).not.toContainText("Reported counts are independent of inventory.");
  expect((await new AxeBuilder({ page }).include(".agent-inventory-overview").analyze()).violations).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("empty agent results keep the same toolbar and reachable filter dialog without document overflow", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  await page.route("**/api/agent-inventory?*", route => route.fulfill({ json: {
    ...unifiedAgents, value: [], count: 0,
    filteredSummary: { total: 0, linked: 0, graphOnly: 0, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 },
  } }));
  await page.goto("/agents?q=no-matching-agent");
  const empty = page.getByRole("heading", { name: "No matching agents", exact: true });
  const toolbar = page.getByRole("region", { name: "Unified agents" }).locator(".agent-grid-toolbar");
  await expect(empty).toBeVisible();
  await expect(page.locator(".unified-agent-table")).toHaveCount(0);
  await expect(toolbar.getByRole("searchbox", { name: "Search", exact: true })).toHaveValue("no-matching-agent");
  await expect(toolbar.getByRole("button", { name: "Columns", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Clear filters", exact: true })).toBeVisible();
  for (const width of info.project.name === "desktop" ? [1440, 1280, 768] : [360]) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 900 });
    const trigger = toolbar.getByRole("button", { name: "Filters", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Filter agents", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Built with", exact: true })).toBeFocused();
    await dialog.getByRole("combobox", { name: "Sort", exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("combobox", { name: "Sort", exact: true })).toBeInViewport({ ratio: 1 });
    await dialog.getByRole("button", { name: "Close filters", exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "Close filters", exact: true })).toBeInViewport({ ratio: 1 });
    await assertLayout(page, [".agent-filter-fields"], `Empty Agents at ${width}px`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`agents-empty-${width}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(empty).toBeVisible();
  }
  expect((await new AxeBuilder({ page }).include(".agent-workspace").analyze()).violations).toEqual([]);
  expect(unexpected).toEqual([]);
});

async function assertReducedMotionParity(page: Page, description: string) {
  const surfaces = [
    ".sync-history", ".sync-history-table", ".sync-history-table tbody tr", ".inline-actions",
    ".official-usage-modal", ".official-usage-import", ".official-usage-fields", ".official-usage-fields > label",
    ".reporting-view", ".usage-comparison-header", ".usage-agent-table", ".usage-agent-filters",
  ].join(", ");
  const geometry = () => page.locator(surfaces).evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { name: `${element.tagName.toLowerCase()}.${Array.from(element.classList).join(".")}`,
      x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
  }));
  const normal = await geometry();
  expect(normal.length, "Parity must exercise populated tables, fields, or report panels").toBeGreaterThan(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const reduced = await geometry();
  expect.soft(reduced.length, `${description}: reduced motion preserves the same content`).toBe(normal.length);
  const failures = normal.flatMap((before, index) => {
    const after = reduced[index];
    if (!after || before.name !== after.name) return [`${before.name} missing or replaced`];
    return (["x", "y", "width", "height"] as const).flatMap(dimension => Math.abs(before[dimension] - after[dimension]) > 1.5
      ? [`${before.name} ${dimension} changed: ${before[dimension].toFixed(1)} → ${after[dimension].toFixed(1)}`] : []);
  });
  expect.soft(failures, `${description}: reduced motion changes animation, not layout`).toEqual([]);
}

async function assertLayout(page: Page, fields: string[], description: string) {
  const failures = await page.evaluate(collectLayoutFailures, { fields });
  expect.soft(failures, description).toEqual([]);
}
