import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("basic filters occupy exactly two rows on desktop and tablet, with usable mobile reflow", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  await page.goto("/agents");
  await expect(page.getByRole("region", { name: "Unified agents" })).toBeVisible();
  const filters = page.getByRole("region", { name: "Filters", exact: true });
  await expect(filters.getByRole("combobox")).toHaveCount(6);
  await expect(page.getByRole("checkbox", { name: "Advanced filters" })).not.toBeChecked();
  for (const name of ["Show agents", "Built with", "Assigned access", "Host", "Package status"]) {
    await expect(filters.getByRole("combobox", { name, exact: true })).toBeVisible();
  }
  await expect(filters.getByRole("spinbutton", { name: "Created within days" })).toBeVisible();
  await expect(filters.getByRole("combobox", { name: "Source", exact: true })).toHaveCount(0);
  await expect(filters.getByRole("combobox", { name: "Source link", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Advanced agent filters" })).toHaveCount(0);
  await expect(filters.getByRole("button", { name: "Export agent inventory CSV" })).toHaveCount(0);
  await expect(page.locator(".agent-catalog-heading").getByRole("button", { name: "Export agent inventory CSV" })).toBeVisible();
  for (const width of info.project.name === "desktop" ? [768, 1024, 1480, 1920] : [360]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    if (width >= 768) {
      const geometry = await filters.evaluate(element => {
        const rows = Array.from(element.children).filter(child => getComputedStyle(child).display !== "none");
        const primary = rows[0].getBoundingClientRect();
        const toolbar = rows[1].getBoundingClientRect();
        const controls = Array.from(element.querySelectorAll("input, select, button")).filter(control => control.getClientRects().length);
        return {
          rowCount: rows.length,
          height: element.getBoundingClientRect().height,
          toolbarHeight: toolbar.height,
          contained: controls.every(control => {
            const box = control.getBoundingClientRect();
            return [primary, toolbar].some(row => box.top >= row.top - 1 && box.bottom <= row.bottom + 1);
          }),
        };
      });
      expect(geometry.rowCount).toBe(2);
      expect(geometry.height).toBeLessThanOrEqual(132);
      expect(geometry.toolbarHeight).toBeLessThanOrEqual(60);
      expect(geometry.contained).toBe(true);
    }
    await page.screenshot({ path: info.outputPath(`agents-basic-${width}.png`), fullPage: true });
  }
  const toggle = page.getByRole("checkbox", { name: "Advanced filters" });
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toBeChecked();
  await expect(page.getByRole("region", { name: "Advanced agent filters" })).toBeVisible();
  for (const name of ["Publisher", "Environment"]) {
    await expect(page.getByRole("combobox", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("searchbox", { name: "Search environments" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".catalog-controls").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("agents-advanced.png"), fullPage: true });
  expect(unexpected).toEqual([]);
});

test("advanced values stay active when hidden, preserve request parameters, and restore from history", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const queries: URLSearchParams[] = [];
  const inventory = {
    ...unifiedAgents,
    facets: { ...unifiedAgents.facets, environments: [
      { value: "environment-a", label: "Finance production" },
      { value: "environment-b", label: "Development" },
    ] },
  };
  await page.route("**/api/agent-inventory?*", route => {
    queries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: inventory });
  });
  await page.goto("/agents?source=power_platform&linkState=matched");
  const toggle = page.getByRole("checkbox", { name: /Advanced filters/ });
  await expect(toggle).not.toBeChecked();
  await expect(page).toHaveURL(/\/agents$/);
  await page.getByRole("searchbox", { name: "Search", exact: true }).fill("policy");
  await page.getByRole("combobox", { name: "Assigned access", exact: true }).selectOption("available:some");
  await page.getByRole("combobox", { name: "Host", exact: true }).selectOption("Teams");
  await page.getByRole("combobox", { name: "Built with", exact: true }).selectOption("Copilot Studio");
  await page.getByRole("spinbutton", { name: "Created within days" }).fill("60");
  await page.getByRole("combobox", { name: "Package status", exact: true }).selectOption("blocked");
  await expect(toggle).toHaveAccessibleName("Advanced filters");
  await toggle.check();
  await page.getByRole("combobox", { name: "Publisher", exact: true }).selectOption("Synthetic Finance");
  const beforeEnvironmentSearch = page.url();
  await page.getByRole("searchbox", { name: "Search environments" }).fill("fin");
  const environment = page.getByRole("combobox", { name: "Environment", exact: true });
  await expect(environment.getByRole("option")).toHaveCount(2);
  expect(page.url()).toBe(beforeEnvironmentSearch);
  await environment.selectOption("environment-a");
  await expect(toggle).toHaveAccessibleName("Advanced filters 2 active");
  await page.getByRole("combobox", { name: "Sort", exact: true }).selectOption("lastModifiedAt:desc");
  await expect.poll(() => queries.at(-1)?.get("sortDirection")).toBe("desc");
  const latest = queries.at(-1)!;
  expect(Object.fromEntries(["environmentId", "publisher", "availableTo", "host", "platform", "createdWithinDays", "sortBy", "search", "blocked"].map(key => [key, latest.get(key)]))).toEqual({
    environmentId: "environment-a", publisher: "Synthetic Finance",
    availableTo: "available:some", host: "Teams", platform: "Copilot Studio", createdWithinDays: "60", sortBy: "lastModifiedAt",
    search: "policy", blocked: "true",
  });
  expect(queries.every(query => !query.has("source") && !query.has("linkState"))).toBe(true);
  const filteredUrl = page.url();
  await toggle.uncheck();
  await expect(environment).not.toBeVisible();
  expect(page.url()).toBe(filteredUrl);
  if (info.project.name === "desktop") {
    await page.setViewportSize({ width: 768, height: 1000 });
    expect(await page.locator(".agent-filter-toolbar").evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(60);
    expect(await page.locator(".catalog-controls").evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(132);
  }
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: /^Sync/ }).click();
  await page.goBack();
  await expect(toggle).toBeChecked();
  await expect(environment).toHaveValue("environment-a");
  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(toggle).toHaveAccessibleName("Advanced filters 2 active");
  await toggle.uncheck();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(toggle).toHaveAccessibleName("Advanced filters");
  await expect(toggle).not.toBeChecked();
  await expect(page).toHaveURL(/\/agents\?sort=lastModifiedAt&direction=desc$/);
  await expect(page.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue("lastModifiedAt:desc");
  expect(unexpected).toEqual([]);
});

test("bookmarked everyday filters stay visible without opening Advanced", async ({ page }) => {
  await mockLayoutApi(page);
  await page.goto("/agents?platform=Copilot+Studio&createdWithinDays=30&availability=available%3Asome&host=Teams");
  await expect(page.getByRole("checkbox", { name: "Advanced filters" })).not.toBeChecked();
  await expect(page.getByRole("combobox", { name: "Built with", exact: true })).toHaveValue("Copilot Studio");
  await expect(page.getByRole("spinbutton", { name: "Created within days" })).toHaveValue("30");
  await expect(page.getByRole("combobox", { name: "Host", exact: true })).toHaveValue("Teams");
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Advanced filters" })).not.toBeChecked();
});
