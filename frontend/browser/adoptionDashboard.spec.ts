import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { adoptionDepartmentPage, adoptionSnapshot, adoptionSummaryPage, reportPage } from "../src/test/reportDataFixture";
import { mockLayoutApi } from "./layoutFixtures";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("Dashboard shows historical adoption, preserves baseline and company navigation, and fits desktop and mobile", async ({ page }, testInfo) => {
  const unexpected = await mockLayoutApi(page);
  const first = adoptionSnapshot(1, { reportingStart: "2025-08-14", reportingEnd: "2025-09-12" });
  const second = adoptionSnapshot(2, { reportingStart: "2026-09-09", reportingEnd: "2026-10-08", activeUsers: 344, activeAgents: 325 });
  const latest = adoptionSnapshot(3, { reportingStart: "2026-09-27", reportingEnd: "2026-10-26", activeUsers: 306, activeAgents: 317 });
  const reads: URLSearchParams[] = [];
  await page.route(url => url.pathname === "/api/official-usage/history/adoption", route => {
    expect(route.request().method()).toBe("GET");
    const query = new URL(route.request().url()).searchParams;
    reads.push(query);
    return route.fulfill({ json: reportPage([latest, second, first]) });
  });
  const departments = adoptionDepartmentPage();
  const companyName = "Fabrikam International Health Services and Technology with a particularly long company name";
  departments.value[2].company = companyName;
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/summary", route => {
    const data = adoptionSummaryPage();
    expect(new URL(route.request().url()).searchParams.has("cursor")).toBe(false);
    return route.fulfill({ json: { ...data, reports: { ...data.reports, setId: latest.id } } });
  });
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/departments", route => {
    expect(route.request().method()).toBe("GET");
    const query = new URL(route.request().url()).searchParams;
    expect(query.get("setId")).toBe(latest.id);
    expect(query.get("sort")).toBe("adoptionRate");
    const value = query.get("company") === `~string:${companyName}` ? departments.value.slice(2)
      : query.get("order") === "asc" ? [...departments.value].reverse() : departments.value;
    return route.fulfill({ json: { ...departments, value, counts: { total: 3, filtered: value.length },
      reports: { ...departments.reports, setId: latest.id } } });
  });
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/facets", route => route.fulfill({ json: {
    value: [{ value: "Contoso", count: 2 }, { value: companyName, count: 1 }],
    counts: { total: 2, filtered: 2 }, selection: departments.selection, page: departments.page,
  } }));
  await page.goto("/dashboard");
  await expect(page.getByRole("button", { name: "Dashboard", exact: true })).toHaveAttribute("aria-current", "page");
  const users = page.getByRole("region", { name: "Active users", exact: true });
  await expect(users.getByText("306", { exact: true })).toBeVisible();
  await expect(users.getByText("+6 (+2%)", { exact: true })).toBeVisible();
  await expect(users.getByText("-38 (-11%)", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Active users over saved reports" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Active agents over saved reports" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Report snapshots and comparisons", exact: true }).getByRole("row")).toHaveCount(4);
  const departmentPanel = page.getByRole("region", { name: "Adoption by department" });
  await expect(departmentPanel.getByText("75%", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "People and engagement" }).getByText("40,000", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Agents and champions" }).getByText("6", { exact: true })).toBeVisible();
  await expect(page.getByText(/Snapshot comparison: observed activity dates/)).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Explore adoption insights" })).toHaveCount(0);
  const sort = departmentPanel.getByRole("button", { name: "Sort departments by adoption percentage, highest first" });
  await sort.click();
  await expect(departmentPanel.getByRole("listitem").first()).toContainText("25%");
  await departmentPanel.getByRole("button", { name: "Sort departments by adoption percentage, lowest first" }).click();
  await expect(departmentPanel.getByRole("listitem").first()).toContainText("75%");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".adoption-dashboard").analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("dashboard.png"), fullPage: true });
  const readsBeforeBaseline = reads.length;
  await page.getByRole("combobox", { name: "Compare latest with baseline" }).selectOption(second.id);
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?baseline=${second.id}$`));
  await expect(users.getByText("-38 (-11%)", { exact: true })).toHaveCount(2);
  expect(reads).toHaveLength(readsBeforeBaseline);
  const company = page.getByRole("combobox", { name: "Company", exact: true });
  await company.click();
  const companyMenu = page.getByRole("listbox", { name: "Company options" });
  await expect(companyMenu).toBeVisible();
  const controlBounds = await company.boundingBox(), menuBounds = await companyMenu.boundingBox();
  expect(controlBounds).not.toBeNull();
  expect(menuBounds).not.toBeNull();
  expect(Math.abs(controlBounds!.width - menuBounds!.width)).toBeLessThan(1);
  expect(Math.abs(controlBounds!.x - menuBounds!.x)).toBeLessThan(1);
  await expect(companyMenu.getByRole("option", { name: companyName, exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include(".dashboard-panel-teal").analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("company-menu.png") });
  await companyMenu.getByRole("option", { name: companyName, exact: true }).click();
  await expect(departmentPanel.getByText("25%", { exact: true })).toBeVisible();
  await expect(departmentPanel.getByRole("link", { name: /Finance/ })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("company")).toBe(`~string:${companyName}`);
  await page.goBack();
  await expect(departmentPanel.getByText("75%", { exact: true })).toBeVisible();
  await page.goForward();
  await expect(departmentPanel.getByText("25%", { exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Users", exact: true }).click();
  await expect(page).toHaveURL(/\/users$/);
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Compare latest with baseline" })).toHaveValue(second.id);
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toContainText(companyName);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Compare latest with baseline" })).toHaveValue(second.id);
  await expect(departmentPanel.getByText("25%", { exact: true })).toBeVisible();
  await page.getByRole("region", { name: "Report snapshots and comparisons", exact: true })
    .getByRole("link", { name: "Inspect report" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/sync\\?reports=snapshot&snapshot=${latest.id}`));
  expect(reads.every(query => !query.has("setId"))).toBe(true);
  expect(unexpected).toEqual([]);
});

test("Dashboard works before any usage reports are imported without extra setup gates", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.route(url => url.pathname === "/api/official-usage/history/adoption", route =>
    route.fulfill({ json: reportPage([]) }));
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "No saved usage reports yet" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Sync", exact: true })).toHaveAttribute("href", "/sync");
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Active users over saved reports" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /enable|approve|qualify/i })).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test("Department paging keeps the current page and organization metrics visible while the next response is pending", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const data = adoptionDepartmentPage(), summary = adoptionSummaryPage();
  let summaryReads = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === "/api/official-usage/history/adoption", route =>
    route.fulfill({ json: reportPage([adoptionSnapshot()]) }));
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/summary", route => {
    summaryReads++;
    return route.fulfill({ json: summary });
  });
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/facets", route =>
    route.fulfill({ json: { value: [], counts: { total: 0, filtered: 0 }, selection: summary.selection, page: summary.page } }));
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/departments", async route => {
    const next = new URL(route.request().url()).searchParams.get("cursor") === "next";
    if (next) await pending;
    return route.fulfill({ json: { ...data, value: [data.value[next ? 1 : 0]], counts: { total: 2, filtered: 2 },
      page: { limit: 1, nextCursor: next ? null : "next", previousCursor: next ? "previous" : null } } });
  });
  try {
    await page.goto("/dashboard");
    const departments = page.getByRole("region", { name: "Adoption by department" });
    const people = page.getByRole("region", { name: "People and engagement" });
    const champions = page.getByRole("region", { name: "Agents and champions" });
    await expect(departments.getByRole("link", { name: /Finance/ })).toBeVisible();
    await expect(people.getByText("40,000", { exact: true })).toBeVisible();
    await expect(champions.getByText("6", { exact: true })).toBeVisible();
    const initialSummaryReads = summaryReads;
    expect(initialSummaryReads).toBeGreaterThan(0);
    await departments.getByRole("button", { name: "Next departments" }).click();
    await expect(departments.getByRole("list")).toHaveAttribute("aria-busy", "true");
    await expect(departments.getByRole("link", { name: /Finance/ })).toBeVisible();
    await expect(people.getByText("40,000", { exact: true })).toBeVisible();
    await expect(champions.getByText("6", { exact: true })).toBeVisible();
    await expect(champions.getByText("Unknown", { exact: true })).toHaveCount(0);
    await expect(departments.getByRole("button", { name: "Next departments" })).toHaveAttribute("aria-disabled", "true");
    expect(summaryReads).toBe(initialSummaryReads);
    release();
    await expect(departments.getByRole("link", { name: /Engineering/ })).toBeVisible();
    await expect(departments.getByRole("list")).toHaveAttribute("aria-busy", "false");
    expect(summaryReads).toBe(initialSummaryReads);
    expect(unexpected).toEqual([]);
  } finally { release(); }
});
