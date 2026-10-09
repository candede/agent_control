import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { layoutTime, mockLayoutApi, unifiedAgents, mockInventoryFacets } from "./layoutFixtures";
import { encodeInventoryFacet } from "../../backend/src/types/inventoryFacets";
import { fulfillInventoryPage, inventoryFixtureFacet, inventoryFixtureQuery } from "./selectedInventoryFixture";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

const environments = [
    { value: "environment-a", label: "Finance production" },
    { value: "environment-b", label: "Development" },
  ];
const inventoryWithEnvironments = { ...unifiedAgents };

test("clear search remains visible when unfocused and preserves filters, URL state and keyboard focus", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.route("**/api/agent-inventory?*", route => {
    const query = inventoryFixtureQuery(route);
    const candidates = query.get("reportedUsage") === "used" ? unifiedAgents.value.slice(0, 2) : unifiedAgents.value;
    const value = candidates.filter(record => !query.get("search") || record.displayName.includes(query.get("search")!));
    return fulfillInventoryPage(route, { ...unifiedAgents, value, counts: { ...unifiedAgents.counts, filtered: value.length } });
  });
  await page.goto("/agents?usage=used&q=Service");
  const toolbar = page.locator(".agent-grid-toolbar");
  const search = toolbar.getByRole("searchbox", { name: "Search", exact: true });
  const clear = toolbar.getByRole("button", { name: "Clear search", exact: true });
  const count = toolbar.getByRole("status", { name: "Matching agents", exact: true });
  const usage = toolbar.getByRole("button", { name: "Remove reported usage filter" });
  await expect(count).toHaveText("1 matching agent");
  await page.getByRole("heading", { name: /^Agents/ }).click();
  await expect(search).not.toBeFocused();
  await expect(clear).toBeVisible();
  await expect(clear).toHaveAttribute("title", "Clear search");
  const size = info.project.name === "mobile" ? 44 : 36;
  const target = (await clear.boundingBox())!;
  expect(target.width).toBeGreaterThanOrEqual(size);
  expect(target.height).toBeGreaterThanOrEqual(size);
  const field = (await toolbar.locator(".agent-search-field").boundingBox())!;
  expect(Math.abs(field.x + field.width - target.x - target.width)).toBeLessThanOrEqual(2);
  const height = (await toolbar.boundingBox())!.height;
  await page.screenshot({ path: info.outputPath("clear-search.png"), fullPage: true });
  expect((await new AxeBuilder({ page }).include(".agent-grid-toolbar").analyze()).violations).toEqual([]);
  await clear.click({ position: { x: 3, y: 3 } });
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(clear).toHaveCount(0);
  await expect(usage).toBeVisible();
  await expect(count).toHaveText("2 matching agents");
  await expect(page.locator(".unified-agent-table tbody tr")).toHaveCount(2);
  await expect(page).toHaveURL(/usage=used/);
  expect(new URL(page.url()).searchParams.has("q")).toBe(false);
  expect((await toolbar.boundingBox())!.height).toBeCloseTo(height, 1);
  await search.fill("Finance");
  await expect(count).toHaveText("1 matching agent");
  await search.fill("Finance".repeat(50));
  await expect(count).toHaveText("0 matching agents");
  const longTextTarget = (await clear.boundingBox())!;
  const longTextField = (await toolbar.locator(".agent-search-field").boundingBox())!;
  expect(longTextTarget.width).toBeGreaterThanOrEqual(size);
  expect(Math.abs(longTextField.x + longTextField.width - longTextTarget.x - longTextTarget.width)).toBeLessThanOrEqual(2);
  await page.keyboard.press("Tab");
  await expect(clear).toBeFocused();
  expect(await clear.evaluate(button => getComputedStyle(button).outlineStyle)).toBe("solid");
  await page.keyboard.press("Enter");
  await expect(search).toBeFocused();
  await expect(count).toHaveText("2 matching agents");
  await expect(usage).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(unexpected).toEqual([]);
});

test("clearing a pending search ignores its late result and keeps the reported usage filter", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  let finishRead!: () => void;
  let markStarted!: () => void;
  let markFinished!: () => void;
  const pendingRead = new Promise<void>(resolve => { finishRead = resolve; });
  const readStarted = new Promise<void>(resolve => { markStarted = resolve; });
  const readFinished = new Promise<void>(resolve => { markFinished = resolve; });
  await page.route("**/api/agent-inventory?*", async route => {
    const query = inventoryFixtureQuery(route);
    if (query.get("search") === "pending") {
      markStarted();
      await pendingRead;
      await fulfillInventoryPage(route, { ...unifiedAgents, value: [], counts: { ...unifiedAgents.counts, filtered: 0 } });
      markFinished();
      return;
    }
    expect(query.get("reportedUsage")).toBe("used");
    return fulfillInventoryPage(route, unifiedAgents);
  });
  await page.goto("/agents?usage=used");
  const toolbar = page.locator(".agent-grid-toolbar");
  const search = toolbar.getByRole("searchbox", { name: "Search", exact: true });
  const count = toolbar.getByRole("status", { name: "Matching agents", exact: true });
  await expect(count).toHaveText("3 matching agents");
  try {
    await search.fill("pending");
    await readStarted;
    await expect(count).toHaveText("Updating... matching agents");
    await toolbar.getByRole("button", { name: "Clear search", exact: true }).click();
    await expect(search).toHaveValue("");
    await expect(count).toHaveText("3 matching agents");
  } finally {
    finishRead();
  }
  await readFinished;
  await expect(count).toHaveText("3 matching agents");
  await expect(toolbar.getByRole("button", { name: "Remove reported usage filter" })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("q")).toBe(false);
  expect(unexpected).toEqual([]);
});

test.describe("touch search clearing", () => {
  test.use({ hasTouch: true });

  test("provides a 44px clear target on touch devices at every viewport", async ({ page }) => {
    const unexpected = await mockLayoutApi(page);
    await page.goto("/agents?q=Service");
    const clear = page.getByRole("button", { name: "Clear search", exact: true });
    await expect(clear).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const target = (await clear.boundingBox())!;
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    await clear.tap();
    await expect(page.getByRole("searchbox", { name: "Search", exact: true })).toHaveValue("");
    await expect(page.getByRole("searchbox", { name: "Search", exact: true })).toBeFocused();
    await expect(clear).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });
});

test("filtered results keep Clear filters inline and show the matching total without a duplicate report row", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.route("**/api/agent-inventory?*", route => {
    const query = inventoryFixtureQuery(route);
    const type = inventoryFixtureFacet(query, "type");
    const value = unifiedAgents.value.filter(record =>
      (type === undefined || record.packages.some(item => item.type === type))
      && (!query.has("publisher") || record.packages.some(item => item.publisher === inventoryFixtureFacet(query, "publisher")))
      && (!query.get("search") || record.displayName.includes(query.get("search")!)));
    return fulfillInventoryPage(route, { ...unifiedAgents, value, counts: { ...unifiedAgents.counts, filtered: value.length } });
  });
  await page.goto("/agents");
  const toolbar = page.locator(".agent-grid-toolbar");
  const search = toolbar.getByRole("searchbox", { name: "Search", exact: true });
  const category = toolbar.getByRole("combobox", { name: "Show agents", exact: true });
  const clear = toolbar.getByRole("button", { name: "Clear filters", exact: true });
  const count = toolbar.getByRole("status", { name: "Matching agents", exact: true });
  const viewports = info.project.name === "desktop"
    ? [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 768, height: 900 }]
    : [{ width: 360, height: 780 }];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(async () => { await document.fonts.ready; });
    await expect(category).toHaveValue("");
    await expect(category.getByRole("option", { name: "1st party agents", exact: true })).toHaveCount(1);
    await expect(category.getByRole("option", { name: "3rd party agents", exact: true })).toHaveCount(1);
    await expect(toolbar.locator(".inventory-facet-compact details")).toHaveCount(0);
    await expect(toolbar.getByLabel("Search and page show agents options")).toHaveCount(0);
    const initialHeight = (await toolbar.boundingBox())!.height;
    for (const type of ["firstParty", "thirdParty", "shared"]) {
      await category.selectOption(encodeInventoryFacet(type));
      await expect(toolbar.locator(".agent-query-bar").getByRole("button", { name: "Clear filters", exact: true })).toBeVisible();
      await expect(count).toHaveText("1 matching agent");
      await expect(toolbar.locator(".agent-filter-chips")).toHaveCount(0);
      await expect(toolbar.locator(".agent-report-note")).toHaveCount(0);
      expect((await toolbar.boundingBox())!.height, "Selecting a category adds no toolbar row").toBeCloseTo(initialHeight, 1);
      if (viewport.width >= 768) {
        const controls = await Promise.all([search, category, clear, toolbar.getByRole("button", { name: "Filters", exact: true }),
          toolbar.getByRole("button", { name: "Columns", exact: true })].map(control => control.boundingBox()));
        expect(Math.max(...controls.map(box => box!.y)) - Math.min(...controls.map(box => box!.y)),
          "Clear filters shares the main control row").toBeLessThanOrEqual(1);
        expect((await toolbar.boundingBox())!.height).toBeLessThanOrEqual(64);
      }
    }
    await expect(page.getByRole("combobox", { name: "Report set", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`filtered-toolbar-${viewport.width}.png`), fullPage: true });
    expect((await new AxeBuilder({ page }).include(".agent-grid-toolbar").analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await search.fill("No matching fixture");
    await expect(count).toHaveText("0 matching agents");
    await clear.click();
    await expect(count).toHaveText("3 matching agents");
    await expect(clear).toHaveCount(0);
    await expect(category).toHaveValue("");
    await expect(search).toHaveValue("");
    await toolbar.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("dialog", { name: "Filter agents" }).getByRole("combobox", { name: "Publisher", exact: true })
      .selectOption(encodeInventoryFacet("Synthetic Finance"));
    await page.keyboard.press("Escape");
    await expect(count).toHaveText("1 matching agent");
    await expect(toolbar.getByRole("button", { name: "Remove publisher filter" })).toBeVisible();
    await expect(toolbar.locator(".agent-query-bar").getByRole("button", { name: "Clear filters", exact: true })).toBeVisible();
    await clear.click();
    await expect(count).toHaveText("3 matching agents");
    await expect(toolbar.locator(".agent-filter-chips")).toHaveCount(0);
  }
  expect(unexpected).toEqual([]);
});

test("matching count uses the full server total and distinguishes loading and failed reads from zero", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  let finishRead!: () => void;
  const pendingRead = new Promise<void>(resolve => { finishRead = resolve; });
  await page.route("**/api/agent-inventory?*", async route => {
    const search = inventoryFixtureQuery(route).get("search");
    if (search === "pending") {
      await pendingRead;
      return fulfillInventoryPage(route, { ...unifiedAgents, counts: { total: 1093, scoped: 1093, filtered: 1093, packageTargets: 1093 } });
    }
    if (search === "failed") return route.fulfill({
      status: 503, json: { code: "snapshot_unavailable", detail: "Synthetic inventory read failed." },
    });
    return fulfillInventoryPage(route, unifiedAgents);
  });
  await page.goto("/agents");
  const toolbar = page.locator(".agent-grid-toolbar");
  const count = toolbar.getByRole("status", { name: "Matching agents", exact: true });
  const search = toolbar.getByRole("searchbox", { name: "Search", exact: true });
  await expect(count).toHaveText("3 matching agents");
  await search.fill("pending");
  try {
    await expect(count).toHaveText("Updating... matching agents");
    await expect(count).not.toContainText("3");
  } finally {
    finishRead();
  }
  await expect(count).toHaveText("1,093 matching agents");
  await expect(page.locator(".unified-agent-table tbody tr")).toHaveCount(3);
  await search.fill("failed");
  await expect(count).toHaveText("Unavailable matching agents");
  await expect(count).not.toContainText("1,093");
  await expect(page.getByText(/^Synthetic inventory read failed\./)).toBeVisible();
  await toolbar.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(count).toHaveText("3 matching agents");
  expect(unexpected).toEqual([]);
});

test("one compact toolbar opens accessible detailed filters without moving the table at every viewport", async ({ page }, info) => {
  test.setTimeout(60_000);
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  await page.goto("/agents");
  const agents = page.getByRole("region", { name: "Unified agents" });
  const table = agents.locator(".unified-agent-table");
  const toolbar = agents.locator(".agent-grid-toolbar");
  const filters = toolbar.getByRole("region", { name: "Filters", exact: true });
  const trigger = filters.getByRole("button", { name: "Filters", exact: true });
  const dialog = page.getByRole("dialog", { name: "Filter agents", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(unifiedAgents.value.length);
  await expect(toolbar).toHaveCount(1);
  await expect(filters.getByRole("searchbox", { name: "Search", exact: true })).toBeVisible();
  await expect(filters.getByRole("combobox", { name: "Show agents", exact: true })).toBeVisible();
  await expect(filters.getByRole("combobox")).toHaveCount(1);
  await expect(toolbar.getByRole("button", { name: "Columns", exact: true })).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Advanced filters" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Advanced agent filters" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toHaveCount(0);
  await expect(filters.getByRole("button", { name: "Export agent inventory CSV" })).toHaveCount(0);
  await expect(page.locator(".agent-catalog-heading").getByRole("button", { name: "Export agent inventory CSV" })).toBeVisible();

  const viewports = info.project.name === "desktop"
    ? [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 768, height: 900 }]
    : [{ width: 360, height: 780 }];
  for (const viewport of viewports) {
    await test.step(`${viewport.width}px closed toolbar and nonmodal filter geometry`, async () => {
      await page.setViewportSize(viewport);
      await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
      await expect(page.getByRole("status").filter({ hasText: "Loading selected report evidence..." })).toHaveCount(0);
      const actualViewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      expect(actualViewport, "Headless layout viewport matches the requested dimensions").toEqual(viewport);
      const initialTableTop = await table.evaluate(element => element.getBoundingClientRect().top + window.scrollY);
      const toolbarGeometry = await toolbar.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const tools = element.querySelector(".agent-grid-tools")!.getBoundingClientRect();
        return {
          contentLeft: rect.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth),
          contentRight: rect.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth),
          toolsLeft: tools.left, toolsRight: tools.right, toolsWidth: tools.width,
        };
      });
      expect.soft(toolbarGeometry.toolsLeft, "Query tools start at the toolbar's padded left edge").toBeCloseTo(toolbarGeometry.contentLeft, 1);
      expect.soft(toolbarGeometry.toolsRight, "Query tools fill the entire available toolbar width").toBeCloseTo(toolbarGeometry.contentRight, 1);
      if (viewport.width >= 768) {
        const controls = await Promise.all([
          filters.getByRole("searchbox", { name: "Search", exact: true }),
          filters.getByRole("combobox", { name: "Show agents", exact: true }),
          trigger, toolbar.getByRole("button", { name: "Columns", exact: true }),
        ].map(control => control.boundingBox()));
        expect(Math.max(...controls.map(box => box!.y)) - Math.min(...controls.map(box => box!.y))).toBeLessThanOrEqual(1);
        expect((await toolbar.boundingBox())!.height, "The whole toolbar remains one compact row").toBeLessThanOrEqual(64);
      }
      await page.screenshot({ path: info.outputPath(`agents-toolbar-${viewport.width}.png`), fullPage: true });
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(dialog).toBeVisible();
      await expect(dialog).not.toHaveAttribute("aria-modal", "true");
      await expect(trigger).toHaveAttribute("aria-controls", await dialog.getAttribute("id") as string);
      await expect(dialog.getByRole("combobox", { name: "Built with", exact: true })).toBeFocused();
      for (const name of ["Built with", "Assigned access", "Host", "Publisher", "Package status", "Environment", "Sort"]) {
        await expect(dialog.getByRole("combobox", { name, exact: true })).toBeVisible();
      }
      await expect(dialog.getByRole("spinbutton", { name: "Created within days" })).toBeVisible();
      await expect(dialog.getByRole("searchbox", { name: "Search environments" })).toBeVisible();
      await expect(dialog.getByRole("combobox", { name: "Source", exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("combobox", { name: "Source link", exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Reset filters", exact: true })).toBeDisabled();
      expect(await dialog.locator(".agent-filter-fields").evaluate(element =>
        getComputedStyle(element).gridTemplateColumns.split(/\s+/).length)).toBe(viewport.width === 360 ? 1 : 2);
      const geometry = await dialog.boundingBox();
      await info.attach(`agents-filter-bounds-${viewport.width}`, {
        body: JSON.stringify({ viewport, actualViewport, dialog: geometry, toolbar: toolbarGeometry, tableTop: initialTableTop }, null, 2),
        contentType: "application/json",
      });
      expect.soft(geometry!.x, "Filter dialog stays inside the left viewport edge").toBeGreaterThanOrEqual(0);
      expect.soft(geometry!.x + geometry!.width, "Filter dialog stays inside the right viewport edge").toBeLessThanOrEqual(viewport.width);
      expect.soft(geometry!.y, "Filter dialog stays below the top viewport edge").toBeGreaterThanOrEqual(0);
      expect.soft(geometry!.y + geometry!.height, "Filter dialog fits vertically without scrolling the page").toBeLessThanOrEqual(viewport.height);
      expect(await table.evaluate(element => element.getBoundingClientRect().top + window.scrollY),
        "Opening detailed filters overlays results instead of pushing them down").toBeCloseTo(initialTableTop, 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      for (const control of await dialog.locator("input, select, button").all()) {
        await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
        if (viewport.width === 768 && await control.textContent() === "Reset filters") {
          await info.attach("filter-reset-geometry", { contentType: "application/json", body: JSON.stringify(await control.evaluate(element => {
            const ancestors = [];
            for (let node: Element | null = element; node; node = node.parentElement) {
              const style = getComputedStyle(node);
              ancestors.push({ tag: node.tagName, className: node.className, rect: node.getBoundingClientRect().toJSON(),
                overflowX: style.overflowX, overflowY: style.overflowY, scrollTop: node.scrollTop,
                scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth });
            }
            return { width: innerWidth, height: innerHeight, ancestors };
          }), null, 2) });
        }
        await expect.soft(control).toBeInViewport({ ratio: 1, timeout: 1_000 });
      }
      await dialog.getByRole("button", { name: "Close filters" }).scrollIntoViewIfNeeded();
      expect((await new AxeBuilder({ page }).include(".agent-grid-toolbar").analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`agents-filter-dialog-${viewport.width}.png`), fullPage: true });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(trigger).toBeFocused();
    });
  }
  expect(unexpected).toEqual([]);
});

test("filter dialog flips near the viewport bottom and stays contained and focused through scroll and resize", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  // Stay above the short-height fixed-layout breakpoint to exercise anchor placement.
  await page.setViewportSize({ width: 768, height: 660 });
  await page.goto("/agents");
  const table = page.locator(".unified-agent-table");
  await expect(table.locator("tbody tr")).toHaveCount(unifiedAgents.value.length);
  await expect(page.getByRole("region", { name: "Agent inventory overview" })
    .getByText("Reported used agents", { exact: true }).locator("..").locator("strong")).toHaveText("2");
  await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
  const tableTop = await table.evaluate(element => element.getBoundingClientRect().top + window.scrollY);
  const trigger = page.getByRole("button", { name: "Filters", exact: true });
  const dialog = page.getByRole("dialog", { name: "Filter agents", exact: true });
  const firstField = dialog.getByRole("combobox", { name: "Built with", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(firstField).toBeFocused();

  async function assertPlacement(name: string, placement: "above" | "below" | "fixed") {
    await expect.poll(() => dialog.evaluate((panel, desiredPlacement) => {
      const box = panel.getBoundingClientRect();
      return box.top >= 16 && box.bottom <= window.innerHeight - 16
        && box.left >= 0 && box.right <= window.innerWidth
        && panel.getAttribute("data-side") === (desiredPlacement === "above" ? "above" : "below")
        && getComputedStyle(panel).position === (desiredPlacement === "fixed" ? "fixed" : "absolute");
    }, placement)).toBe(true);
    const geometry = await dialog.evaluate(panel => {
      const box = panel.getBoundingClientRect();
      const anchor = panel.closest(".agent-filter-picker")!.getBoundingClientRect();
      const table = document.querySelector(".unified-agent-table")!.getBoundingClientRect();
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        anchor: { top: anchor.top, bottom: anchor.bottom },
        panel: { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height },
        side: panel.getAttribute("data-side"), position: getComputedStyle(panel).position,
        scrollY: window.scrollY, tableTop: table.top + window.scrollY,
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    await info.attach(`filter-anchor-${name}`, { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
    expect(geometry.viewport).toEqual(page.viewportSize());
    expect(geometry.panel.left).toBeGreaterThanOrEqual(0);
    expect(geometry.panel.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(geometry.panel.top).toBeGreaterThanOrEqual(16);
    expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.viewport.height - 16);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport.width);
    expect(geometry.position).toBe(placement === "fixed" ? "fixed" : "absolute");
    expect(geometry.side).toBe(placement === "above" ? "above" : "below");
    if (placement === "above") expect(geometry.panel.bottom).toBeCloseTo(geometry.anchor.top - 10, 1);
    if (placement === "below") expect(geometry.panel.top).toBeCloseTo(geometry.anchor.bottom + 10, 1);
    await expect(firstField).toBeFocused();
    await expect(firstField).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole("button", { name: "Close filters", exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`filter-anchor-${name}.png`) });
    return geometry;
  }

  const initial = await assertPlacement("near-bottom", "above");
  expect(initial.tableTop).toBeCloseTo(tableTop, 1);
  await page.evaluate(() => window.scrollBy(0, 80));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const scrolled = await assertPlacement("scrolled", "above");
  expect(scrolled.anchor.top).toBeLessThan(initial.anchor.top);
  expect(scrolled.panel.height).toBeLessThan(initial.panel.height);
  expect(scrolled.tableTop).toBeCloseTo(tableTop, 1);

  await page.setViewportSize({ width: 768, height: 1100 });
  await assertPlacement("resized-below", "below");
  await page.setViewportSize({ width: 360, height: 780 });
  await assertPlacement("mobile-fixed", "fixed");
  await page.setViewportSize({ width: 1280, height: 600 });
  await assertPlacement("short-fixed", "fixed");
  await page.setViewportSize({ width: 768, height: 1100 });
  await assertPlacement("restored-anchor", "below");
  const sort = dialog.getByRole("combobox", { name: "Sort", exact: true });
  await sort.focus();
  await sort.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await expect(sort).toBeFocused();
  await expect(sort).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("filter dismissal supports the close button, Escape, outside click and nonmodal keyboard navigation", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.goto("/agents");
  const trigger = page.getByRole("button", { name: /^Filters(?:, \d+ active)?$/ });
  const dialog = page.getByRole("dialog", { name: "Filter agents", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("combobox", { name: "Built with", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Close filters" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("combobox", { name: "Built with", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.getByRole("button", { name: "Close filters" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByRole("region", { name: "Agent inventory overview" }).getByText("Reported used agents", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName("Filters, 1 active");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("combobox", { name: "Built with", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(trigger).toBeFocused();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toBeFocused();
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("combobox", { name: "Show agents", exact: true })).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("environment selection retains keyboard focus during and after the saved-results refresh", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await mockInventoryFacets(page, { environmentId: environments });
  let finishRefresh: (() => Promise<void>) | undefined;
  await page.route("**/api/agent-inventory?*", route => {
    if (inventoryFixtureFacet(inventoryFixtureQuery(route), "environmentId") === "environment-a") {
      finishRefresh = () => fulfillInventoryPage(route, inventoryWithEnvironments);
      return;
    }
    return fulfillInventoryPage(route, inventoryWithEnvironments);
  });
  await page.goto("/agents");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Filter agents", exact: true });
  const environment = dialog.getByRole("combobox", { name: "Environment", exact: true });
  try {
    await environment.focus();
    await environment.selectOption(encodeInventoryFacet("environment-a"));
    await expect.poll(() => Boolean(finishRefresh)).toBe(true);
    await expect(environment).toHaveAttribute("aria-busy", "true");
    await expect(environment).toBeFocused();
    await expect(dialog).toBeVisible();
  } finally {
    if (finishRefresh) await finishRefresh();
  }
  await expect(environment).toHaveAttribute("aria-busy", "false");
  await expect(environment).toHaveValue(encodeInventoryFacet("environment-a"));
  await expect(environment).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Filters, 1 active", exact: true })).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("closed filters preserve request parameters and history while Clear and Reset preserve sorting", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await mockInventoryFacets(page, { environmentId: environments });
  const queries: URLSearchParams[] = [];
  await page.route("**/api/agent-inventory?*", route => {
    queries.push(inventoryFixtureQuery(route));
    return fulfillInventoryPage(route, inventoryWithEnvironments);
  });
  await page.goto("/agents?source=power_platform&linkState=matched");
  const trigger = page.getByRole("button", { name: /^Filters(?:, \d+ active)?$/ });
  const dialog = page.getByRole("dialog", { name: "Filter agents", exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL(/\/agents$/);
  await page.getByRole("searchbox", { name: "Search", exact: true }).fill("policy");
  await trigger.click();
  await dialog.getByRole("combobox", { name: "Assigned access", exact: true }).selectOption(encodeInventoryFacet("some"));
  await dialog.getByRole("combobox", { name: "Host", exact: true }).selectOption(encodeInventoryFacet("Teams"));
  await dialog.getByRole("combobox", { name: "Built with", exact: true }).selectOption(encodeInventoryFacet("Copilot Studio"));
  await dialog.getByRole("spinbutton", { name: "Created within days" }).fill("60");
  await dialog.getByRole("combobox", { name: "Package status", exact: true }).selectOption("blocked");
  await dialog.getByRole("combobox", { name: "Publisher", exact: true }).selectOption(encodeInventoryFacet("Synthetic Finance"));
  const beforeEnvironmentSearch = page.url();
  await dialog.getByRole("searchbox", { name: "Search environments" }).fill("fin");
  const environment = dialog.getByRole("combobox", { name: "Environment", exact: true });
  await expect(environment.getByRole("option")).toHaveCount(2);
  expect(page.url()).toBe(beforeEnvironmentSearch);
  await environment.focus();
  await environment.selectOption(encodeInventoryFacet("environment-a"));
  await expect(environment).toBeFocused();
  await expect(trigger).toHaveAccessibleName("Filters, 7 active");
  await dialog.getByRole("combobox", { name: "Sort", exact: true }).selectOption("lastModifiedAt:desc");
  await expect.poll(() => queries.at(-1)?.get("sortDirection")).toBe("desc");
  const latest = queries.at(-1)!;
  expect(Object.fromEntries(["environmentId", "publisher", "availableTo", "host", "platform", "createdWithinDays", "sortBy", "search", "blocked"].map(key => [key, latest.get(key)]))).toEqual({
    environmentId: encodeInventoryFacet("environment-a"), publisher: encodeInventoryFacet("Synthetic Finance"),
    availableTo: encodeInventoryFacet("some"), host: encodeInventoryFacet("Teams"), platform: encodeInventoryFacet("Copilot Studio"), createdWithinDays: "60", sortBy: "lastModifiedAt",
    search: "policy", blocked: "true",
  });
  expect(queries.every(query => !query.has("source") && !query.has("linkState"))).toBe(true);
  const filteredUrl = page.url();
  await dialog.getByRole("button", { name: "Close filters" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(page.url()).toBe(filteredUrl);
  for (const name of ["built with", "assigned access", "host", "publisher", "package status", "created within", "environment"]) {
    await expect(page.getByRole("button", { name: `Remove ${name} filter`, exact: true })).toBeVisible();
  }
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: /^Sync/ }).click();
  await page.goBack();
  await expect(page).toHaveURL(filteredUrl);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Remove environment filter" })).toContainText("Finance production");
  await page.reload();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toHaveAccessibleName("Filters, 7 active");
  await expect(dialog).toHaveCount(0);
  await trigger.click();
  await expect(environment).toHaveValue(encodeInventoryFacet("environment-a"));
  await expect(dialog.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue("lastModifiedAt:desc");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(trigger).toHaveAccessibleName("Filters");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(/\/agents\?sort=lastModifiedAt&direction=desc$/);
  await expect(page.getByRole("searchbox", { name: "Search", exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: /^Remove .* filter$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toHaveCount(0);
  await trigger.click();
  await expect(dialog.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue("lastModifiedAt:desc");
  await expect(dialog.getByRole("button", { name: "Reset filters" })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Host", exact: true }).selectOption(encodeInventoryFacet("Teams"));
  await dialog.getByRole("button", { name: "Reset filters" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Built with", exact: true })).toBeFocused();
  await expect(dialog.getByRole("combobox", { name: "Host", exact: true })).toHaveValue("");
  await expect(dialog.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue("lastModifiedAt:desc");
  await expect(page).toHaveURL(/\/agents\?sort=lastModifiedAt&direction=desc$/);
  await expect(dialog.getByRole("button", { name: "Reset filters" })).toBeDisabled();
  expect(unexpected).toEqual([]);
});

test("bookmarks expose active restrictions as chips without automatically opening detailed filters", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.goto(`/agents?${new URLSearchParams({ platform: encodeInventoryFacet("Copilot Studio"),
    createdWithinDays: "30", availability: encodeInventoryFacet("some"), host: encodeInventoryFacet("Teams") })}`);
  const trigger = page.getByRole("button", { name: "Filters, 4 active", exact: true });
  const dialog = page.getByRole("dialog", { name: "Filter agents", exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove built with filter" })).toContainText("Copilot Studio");
  await expect(page.getByRole("button", { name: "Remove created within filter" })).toContainText("30 days");
  await expect(page.getByRole("button", { name: "Remove assigned access filter" })).toContainText("some");
  await expect(page.getByRole("button", { name: "Remove host filter" })).toContainText("Teams");
  await page.reload();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toHaveCount(0);
  await trigger.click();
  await expect(dialog.getByRole("combobox", { name: "Built with", exact: true })).toHaveValue(encodeInventoryFacet("Copilot Studio"));
  await expect(dialog.getByRole("spinbutton", { name: "Created within days" })).toHaveValue("30");
  await expect(dialog.getByRole("combobox", { name: "Host", exact: true })).toHaveValue(encodeInventoryFacet("Teams"));
  await expect(dialog.getByRole("combobox", { name: "Assigned access", exact: true })).toHaveValue(encodeInventoryFacet("some"));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Remove host filter", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Remove host filter", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filters, 3 active", exact: true })).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("each chip removes only its own restriction and Clear also resets search and view but not sorting", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await mockInventoryFacets(page, { environmentId: environments });
  const queries: URLSearchParams[] = [];
  await page.route("**/api/agent-inventory?*", route => {
    queries.push(inventoryFixtureQuery(route));
    return fulfillInventoryPage(route, inventoryWithEnvironments);
  });
  await page.goto("/agents");
  await page.getByRole("searchbox", { name: "Search", exact: true }).fill("policy");
  await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Show agents", exact: true }).selectOption(encodeInventoryFacet("firstParty"));
  const trigger = page.getByRole("button", { name: /^Filters(?:, \d+ active)?$/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Filter agents", exact: true });
  for (const [name, value] of [
    ["Built with", encodeInventoryFacet("Copilot Studio")], ["Assigned access", encodeInventoryFacet("some")], ["Host", encodeInventoryFacet("Teams")],
    ["Publisher", encodeInventoryFacet("Synthetic Finance")], ["Package status", "blocked"], ["Environment", encodeInventoryFacet("environment-a")],
    ["Sort", "lastModifiedAt:desc"],
  ]) {
    await dialog.getByRole("combobox", { name, exact: true }).selectOption(value);
  }
  await dialog.getByRole("spinbutton", { name: "Created within days" }).fill("60");
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAccessibleName("Filters, 7 active");
  const remaining: Record<string, string> = {
    platform: encodeInventoryFacet("Copilot Studio"), availableTo: encodeInventoryFacet("some"), host: encodeInventoryFacet("Teams"), publisher: encodeInventoryFacet("Synthetic Finance"),
    blocked: "true", environmentId: encodeInventoryFacet("environment-a"), createdWithinDays: "60",
  };
  for (const [name, key] of [
    ["built with", "platform"], ["assigned access", "availableTo"], ["host", "host"],
    ["publisher", "publisher"], ["package status", "blocked"], ["environment", "environmentId"],
    ["created within", "createdWithinDays"],
  ]) {
    await page.getByRole("button", { name: `Remove ${name} filter`, exact: true }).click();
    await expect(trigger).toBeFocused();
    delete remaining[key];
    await expect.poll(() => queries.at(-1)?.get(key)).toBeNull();
    const latest = queries.at(-1)!;
    expect(Object.fromEntries(Object.keys(remaining).map(field => [field, latest.get(field)]))).toEqual(remaining);
    expect(Object.fromEntries(["search", "type", "sortBy", "sortDirection"].map(field => [field, latest.get(field)]))).toEqual({
      search: "policy", type: encodeInventoryFacet("firstParty"), sortBy: "lastModifiedAt", sortDirection: "desc",
    });
    await expect(page.getByRole("button", { name: `Remove ${name} filter`, exact: true })).toHaveCount(0);
    await expect(trigger).toHaveAccessibleName(Object.keys(remaining).length ? `Filters, ${Object.keys(remaining).length} active` : "Filters");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  }
  await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("searchbox", { name: "Search", exact: true })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Show agents", exact: true })).toHaveValue("");
  await expect(page).toHaveURL(/\/agents\?sort=lastModifiedAt&direction=desc$/);
  await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Show agents", exact: true }).selectOption(encodeInventoryFacet("firstParty"));
  await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toBeVisible();
  expect(unexpected).toEqual([]);
});
