import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { adoptionSnapshotLabel } from "../src/adoptionTrends";
import { adoptionDepartmentPage, adoptionSnapshot, adoptionSummaryPage, reportPage, reportSelection } from "../src/test/reportDataFixture";
import { mockLayoutApi } from "./layoutFixtures";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("Idle dashboard keeps people and champions visible while expired selections renew without a restart", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install();
  const selection = { ...reportSelection(2), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const history = reportPage([adoptionSnapshot()], { selection });
  const summary = { ...adoptionSummaryPage(), selection };
  const departments = { ...adoptionDepartmentPage(), selection };
  let resumed = false, obsoleteFacets = 0, summaryReads = 0;
  let releaseHistory: () => void = () => {}, releaseSummary: () => void = () => {};
  const pendingHistory = new Promise<void>(resolve => { releaseHistory = resolve; });
  const pendingSummary = new Promise<void>(resolve => { releaseSummary = resolve; });
  const fresh = reportSelection(3);
  await page.route(url => url.pathname === "/api/official-usage/history/adoption", async route => {
    if (resumed) await pendingHistory;
    await route.fulfill({ json: { ...history, selection: resumed ? fresh : selection } });
  });
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/summary", async route => {
    summaryReads++;
    if (resumed) await pendingSummary;
    await route.fulfill({ json: { ...summary, selection: resumed ? fresh : selection } });
  });
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/departments", route =>
    route.fulfill({ json: { ...departments, selection: resumed ? fresh : selection } }));
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/facets", route => {
    const id = new URL(route.request().url()).searchParams.get("selectionId");
    if (resumed && id === selection.id) {
      obsoleteFacets++;
      return route.fulfill({ status: 409, json: { code: "selection_invalidated", detail: "Expired handle was collected." } });
    }
    return route.fulfill({ json: { value: [{ value: "Contoso", count: 2 }],
      counts: { total: 1, filtered: 1 }, page: summary.page, selection: resumed ? fresh : selection } });
  });
  try {
    await page.goto("/dashboard");
    const people = page.getByRole("region", { name: "People and engagement" });
    const champions = page.getByRole("region", { name: "Agents and champions" });
    await expect(people.getByText("40,000", { exact: true })).toBeVisible();
    await expect(champions.getByText("6", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveAttribute("aria-disabled", "false");
    await people.evaluate(element => { element.setAttribute("data-continuity", "original"); });
    resumed = true;
    await page.clock.fastForward(40 * 60_000);
    await expect.poll(() => summaryReads).toBe(2);
    await expect(people).toHaveAttribute("data-continuity", "original");
    await expect(people.getByText("40,000", { exact: true })).toBeVisible();
    await expect(champions.getByText("6", { exact: true })).toBeVisible();
    releaseHistory();
    releaseSummary();
    await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveAttribute("aria-disabled", "false");
    await expect(people).toHaveAttribute("data-continuity", "original");
    await expect(people.getByText("40,000", { exact: true })).toBeVisible();
    await expect(champions.getByText("6", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Restart selection" })).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(obsoleteFacets).toBe(0);
    expect(summaryReads).toBe(2);
    expect(unexpected).toEqual([]);
  } finally {
    releaseHistory();
    releaseSummary();
  }
});

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
  await expect(page.getByRole("heading", { name: "Understand adoption. Empower your people." })).toBeVisible();
  await expect(page.getByRole("link", { name: "View saved reports", exact: true })).toHaveCount(0);
  const users = page.getByRole("region", { name: "Active users", exact: true });
  await expect(users.getByText("306", { exact: true })).toBeVisible();
  await expect(users.getByText("+6 (+2%)", { exact: true })).toBeVisible();
  await expect(users.getByText("-38 (-11%)", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Active users over saved reports" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Active agents over saved reports" })).toBeVisible();
  const snapshots = page.getByRole("region", { name: "Report snapshots and comparisons", exact: true });
  await expect(snapshots.getByRole("row")).toHaveCount(4);
  await expect(snapshots.getByRole("rowheader")).toHaveText([
    adoptionSnapshotLabel(latest), adoptionSnapshotLabel(second), adoptionSnapshotLabel(first),
  ]);
  await expect(snapshots.getByText("Observed activity", { exact: true })).toHaveCount(0);
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
  await expect(departmentPanel.locator(".report-facet-control > span")).toHaveClass("sr-only");
  if (testInfo.project.name === "desktop") {
    const headingBounds = (await departmentPanel.locator(".dashboard-panel-heading").boundingBox())!;
    const companyBounds = (await company.boundingBox())!;
    expect(Math.abs(companyBounds.y + companyBounds.height / 2 - headingBounds.y - headingBounds.height / 2)).toBeLessThanOrEqual(1);
  }
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

test("Dashboard shows ten departments with direct numbered navigation and responsive page controls", async ({ page }, testInfo) => {
  const unexpected = await mockLayoutApi(page);
  const snapshot = adoptionSnapshot(), summary = adoptionSummaryPage();
  const data = adoptionDepartmentPage({ value: Array.from({ length: 571 }, (_, index) => ({
    id: `department-${index + 1}`, company: index >= 560 ? "Fabrikam" : "Contoso",
    department: `Department ${index + 1}`, people: 10, activePeople: 5,
  })) });
  const reads: URLSearchParams[] = [];
  await page.route(url => url.pathname === "/api/official-usage/history/adoption", route =>
    route.fulfill({ json: reportPage([snapshot]) }));
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/summary", route =>
    route.fulfill({ json: summary }));
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/facets", route =>
    route.fulfill({ json: { value: [{ value: "Contoso", count: 560 }, { value: "Fabrikam", count: 11 }],
      counts: { total: 2, filtered: 2 }, selection: summary.selection, page: summary.page } }));
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/departments", route => {
    const query = new URL(route.request().url()).searchParams;
    reads.push(query);
    expect(query.get("limit")).toBe("10");
    const matching = query.has("company") ? data.value.filter(row => `~string:${row.company}` === query.get("company")) : data.value;
    const ordered = query.get("order") === "asc" ? [...matching].reverse() : matching;
    const number = Math.min(Number(query.get("pageNumber") ?? 1), Math.max(1, Math.ceil(ordered.length / 10)));
    const offset = (number - 1) * 10;
    return route.fulfill({ json: { ...data, value: ordered.slice(offset, offset + 10),
      counts: { total: data.value.length, filtered: ordered.length },
      page: { limit: 10, number, offset, previousCursor: offset > 0 ? "previous" : null,
        nextCursor: offset + 10 < ordered.length ? "next" : null } } });
  });
  await page.goto("/dashboard");
  const panel = page.getByRole("region", { name: "Adoption by department" });
  const list = panel.getByRole("list", { name: "Department adoption" });
  const navigation = panel.getByRole("navigation", { name: "departments pages" });
  await expect(list.getByRole("listitem")).toHaveCount(10);
  await expect(navigation.getByRole("status")).toHaveText("571 matching departments; 10 on this page");
  await expect(navigation.getByRole("button", { name: "Page 1", exact: true })).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: testInfo.outputPath("department-first-page.png"), fullPage: true });
  const beforeJump = reads.length;
  await navigation.getByRole("button", { name: "Page 58", exact: true }).click();
  await expect(list.getByRole("link", { name: /Department 571/ })).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(navigation.getByRole("status")).toHaveText("571 matching departments; 1 on this page");
  await expect(navigation.getByRole("button", { name: "Next departments" })).toHaveAttribute("aria-disabled", "true");
  expect(reads).toHaveLength(beforeJump + 1);
  expect(reads.at(-1)!.get("pageNumber")).toBe("58");
  expect(reads.at(-1)!.get("selectionId")).toBe(data.selection.id);
  await page.screenshot({ path: testInfo.outputPath("department-last-page.png"), fullPage: true });
  await navigation.getByRole("button", { name: "Page 1", exact: true }).click();
  await expect(list.getByRole("listitem")).toHaveCount(10);
  await expect(list.getByRole("link", { name: "Department 1 Contoso", exact: true })).toBeVisible();
  await navigation.getByRole("button", { name: "Page 2", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(list.getByRole("link", { name: "Department 11 Contoso", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Sort departments by adoption percentage, highest first" }).click();
  await expect(list.getByRole("link", { name: /Department 571/ })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Page 1", exact: true })).toHaveAttribute("aria-current", "page");
  expect(reads.at(-1)!.has("pageNumber")).toBe(false);
  const company = panel.getByRole("combobox", { name: "Company", exact: true });
  await company.click();
  await page.getByRole("option", { name: "Fabrikam", exact: true }).click();
  await expect(navigation.getByRole("status")).toHaveText("11 matching departments; 10 on this page");
  await expect(navigation.getByRole("button", { name: "Page 58", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Page 2", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".dashboard-panel-teal").analyze()).violations).toEqual([]);
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
    const next = new URL(route.request().url()).searchParams.get("pageNumber") === "2";
    if (next) await pending;
    return route.fulfill({ json: { ...data, value: [data.value[next ? 1 : 0]], counts: { total: 2, filtered: 2 },
      page: { limit: 1, number: next ? 2 : 1, offset: next ? 1 : 0,
        nextCursor: next ? null : "next", previousCursor: next ? "previous" : null } } });
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
    await expect(departments.getByRole("list", { name: "Department adoption" })).toHaveAttribute("aria-busy", "true");
    await expect(departments.getByRole("link", { name: /Finance/ })).toBeVisible();
    await expect(people.getByText("40,000", { exact: true })).toBeVisible();
    await expect(champions.getByText("6", { exact: true })).toBeVisible();
    await expect(champions.getByText("Unknown", { exact: true })).toHaveCount(0);
    await expect(departments.getByRole("button", { name: "Next departments" })).toHaveAttribute("aria-disabled", "true");
    expect(summaryReads).toBe(initialSummaryReads);
    release();
    await expect(departments.getByRole("link", { name: /Engineering/ })).toBeVisible();
    await expect(departments.getByRole("list", { name: "Department adoption" })).toHaveAttribute("aria-busy", "false");
    expect(summaryReads).toBe(initialSummaryReads);
    expect(unexpected).toEqual([]);
  } finally { release(); }
});

test("Company changes preserve department height with name and bar skeletons until the new data arrives", async ({ page }, testInfo) => {
  const unexpected = await mockLayoutApi(page);
  const summary = adoptionSummaryPage();
  const data = adoptionDepartmentPage({ value: Array.from({ length: 11 }, (_, index) => ({
    id: `department-${index}`, company: index < 7 ? "Contoso" : "Fabrikam",
    department: index % 2 ? `Department ${index}` : `Department ${index} with a particularly long name that wraps over several lines`,
    people: 40, activePeople: 30,
  })) });
  let release: () => void = () => {};
  let pending = Promise.resolve();
  await page.route(url => url.pathname === "/api/official-usage/history/adoption", route =>
    route.fulfill({ json: reportPage([adoptionSnapshot()]) }));
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/summary", route =>
    route.fulfill({ json: summary }));
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/facets", route =>
    route.fulfill({ json: { value: [{ value: "Contoso", count: 7 }, { value: "Fabrikam", count: 4 }],
      counts: { total: 2, filtered: 2 }, selection: summary.selection, page: summary.page } }));
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/departments", async route => {
    const company = new URL(route.request().url()).searchParams.get("company");
    const value = company ? data.value.filter(row => `~string:${row.company}` === company) : data.value;
    await pending;
    await route.fulfill({ json: { ...data, value: value.slice(0, 10), counts: { total: 11, filtered: value.length },
      page: { limit: 10, number: 1, offset: 0, nextCursor: value.length > 10 ? "next" : null, previousCursor: null } } });
  });
  try {
    await page.goto("/dashboard");
    const panel = page.getByRole("region", { name: "Adoption by department" });
    const results = panel.locator(".dashboard-department-results");
    const list = panel.getByRole("list", { name: "Department adoption" });
    await expect(list.getByRole("listitem")).toHaveCount(10);
    for (const company of ["Fabrikam", "Contoso"]) {
      if (company === "Contoso") await page.emulateMedia({ reducedMotion: "reduce" });
      const before = await results.boundingBox();
      const panelBefore = await panel.boundingBox();
      const rows = await list.getByRole("listitem").count();
      pending = new Promise<void>(resolve => { release = resolve; });
      await panel.getByRole("combobox", { name: "Company", exact: true }).click();
      await page.getByRole("option", { name: company, exact: true }).click();
      const skeleton = panel.locator(".dashboard-department-placeholder");
      await expect(panel.getByText("Loading departments...", { exact: true })).toBeVisible();
      await expect(skeleton).toHaveAttribute("aria-hidden", "true");
      await expect(skeleton).toHaveAttribute("inert", "");
      await expect(skeleton.locator(".dashboard-department")).toHaveCount(rows);
      await expect(skeleton.locator(".dashboard-department-bar")).toHaveCount(rows);
      await expect(panel.getByRole("link")).toHaveCount(0);
      await expect(panel.getByRole("navigation", { name: "departments pages" })).toHaveCount(0);
      const during = await results.boundingBox();
      const panelDuring = await panel.boundingBox();
      expect(during!.height).toBeCloseTo(before!.height, 0);
      expect(panelDuring!.height).toBeCloseTo(panelBefore!.height, 0);
      if (company === "Contoso") await expect(skeleton.locator(".dashboard-departments")).toHaveCSS("animation-name", "none");
      expect((await new AxeBuilder({ page }).include(".dashboard-panel-teal").analyze()).violations).toEqual([]);
      if (company === "Fabrikam") await panel.screenshot({ path: testInfo.outputPath("department-company-loading.png"), animations: "disabled" });
      release();
      await expect(skeleton).toHaveCount(0);
      await expect(list.getByRole("listitem")).toHaveCount(company === "Fabrikam" ? 4 : 7);
      await expect(panel.getByRole("link").first()).toHaveAttribute("href", new RegExp(`company=%7Estring%3A${company}`));
      await expect(panel.getByRole("navigation", { name: "departments pages" })).toHaveAttribute("aria-busy", "false");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(unexpected).toEqual([]);
  } finally { release(); }
});
