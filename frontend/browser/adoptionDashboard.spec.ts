import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { adoptionSnapshotLabel } from "../src/adoptionTrends";
import { adoptionDepartmentPage, adoptionSnapshot, adoptionSummaryPage, reportPage, reportSelection } from "../src/test/reportDataFixture";
import { mockLayoutApi } from "./layoutFixtures";
import { fixtureLoginUrl } from "./permissionFixtures";
import { officeFixtureContext, officeGroup, officeHistory, officePage, officePerson, officeSummary } from "../src/test/officeAdoptionFixture";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

async function continueWithSavedUsers(page: Page) {
  const notice = page.getByRole("dialog", { name: "Set up your workspace", exact: true });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("status")).toHaveText("1 of 3 sources saved");
  await notice.getByRole("button", { name: "Continue to workspace", exact: true }).click();
  await expect(notice).toHaveCount(0);
}

async function expectDashboardHeaderLayout(page: Page) {
  const row = page.locator(".dashboard-title-row");
  await expect(row.getByRole("heading", { name: "Understand adoption. Empower your people." })).toBeVisible();
  const domain = row.getByRole("group", { name: "Dashboard adoption domain", exact: true });
  await expect(domain).toBeVisible();
  const rowBounds = (await row.boundingBox())!, domainBounds = (await domain.boundingBox())!;
  expect(Math.abs(domainBounds.x + domainBounds.width - rowBounds.x - rowBounds.width)).toBeLessThanOrEqual(1);
  const agents = (await domain.getByRole("button", { name: "Agent adoption", exact: true }).boundingBox())!;
  const office = (await domain.getByRole("button", { name: "Copilot in Office apps", exact: true }).boundingBox())!;
  expect(Math.abs(agents.y - office.y)).toBeLessThanOrEqual(1);
  if (page.viewportSize()!.width >= 1200) {
    const titleBounds = (await row.getByRole("heading").boundingBox())!;
    expect(domainBounds.x).toBeGreaterThanOrEqual(titleBounds.x + titleBounds.width + 18);
    expect(Math.abs(domainBounds.y + domainBounds.height / 2 - titleBounds.y - titleBounds.height / 2)).toBeLessThanOrEqual(1);
  }
}

async function expectAgentDashboardPanelOrder(page: Page) {
  const titles = ["People and engagement", "Agents and Agent Champs", "Adoption over time", "Adoption by department"];
  await expect(page.locator(".dashboard-panel-heading h3")).toHaveText(titles);
  const [people, champions, trends, departments] = await Promise.all(titles.map(async name =>
    (await page.getByRole("region", { name, exact: true }).boundingBox())!));
  expect(Math.max(people.y + people.height, champions.y + champions.height))
    .toBeLessThan(Math.min(departments.y, trends.y));
  expect(people.width).toBeCloseTo(champions.width, 0);
  if (page.viewportSize()!.width > 1150) {
    expect(people.y).toBeCloseTo(champions.y, 0);
    expect(people.x + people.width).toBeLessThan(champions.x);
    expect(departments.y).toBeCloseTo(trends.y, 0);
    expect(trends.x + trends.width).toBeLessThan(departments.x);
  } else {
    expect(people.y + people.height).toBeLessThan(champions.y);
    expect(trends.y + trends.height).toBeLessThan(departments.y);
  }
}

async function expectOfficeDashboardVisuals(page: Page, info: TestInfo) {
  for (const width of [1440, 760, 360]) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 1000 });
    await page.mouse.move(0, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectDashboardHeaderLayout(page);
    const domain = page.getByRole("group", { name: "Dashboard adoption domain", exact: true });
    expect(await domain.evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(234, 237, 244)");
    expect(await domain.getByRole("button", { name: "Copilot in Office apps", exact: true }).evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
    expect(await domain.getByRole("button", { name: "Agent adoption", exact: true }).evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    expect((await new AxeBuilder({ page }).include(".adoption-dashboard").analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`office-dashboard-${width}.png`), fullPage: true });
    expect(await page.getByRole("region", { name: "App adoption over time" }).evaluate(element =>
      ({ radius: getComputedStyle(element).borderRadius, background: getComputedStyle(element).backgroundImage })))
      .toMatchObject({ radius: "18px", background: expect.stringContaining("linear-gradient") });
    expect(await page.getByRole("region", { name: "Office participation" }).evaluate(element => getComputedStyle(element).backgroundImage))
      .toContain("linear-gradient");
  }
}

test("Office dashboard real SQL panels and selected controls fit all three widths with accessible measured evidence", async ({ page }, info) => {
  await page.goto(fixtureLoginUrl("role-Viewer", `fixture@office-${info.project.name}.example.invalid`));
  await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
  await page.goto("/dashboard?adoption=office");
  await continueWithSavedUsers(page);
  await expect(page.getByRole("region", { name: "Office participation", exact: true }).getByText("40", { exact: true })).toBeVisible();
  await page.getByText("Weekly Office history", { exact: true }).click();
  await expect(page.getByRole("region", { name: "Office observations and comparisons", exact: true }).getByRole("rowheader")).toHaveCount(3);
  await expectOfficeDashboardVisuals(page, info);
});

test("Office dashboard shows weekly SQL direction and aggregate-only history while preserving current person drill-downs", async ({ page }, info) => {
  const project = info.project.name;
  await page.goto(fixtureLoginUrl("role-Viewer", `fixture@office-${project}.example.invalid`));
  await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
  await page.goto("/dashboard?adoption=office");
  await continueWithSavedUsers(page);
  await expect(page.getByRole("button", { name: "Copilot in Office apps", exact: true })).toHaveAttribute("aria-pressed", "true");
  const active = page.getByRole("region", { name: "Office participation", exact: true })
    .locator(".dashboard-insight-card").filter({ has: page.getByRole("heading", { name: "Active Office users", exact: true }) });
  await expect(active.getByText("40", { exact: true })).toBeVisible();
  const direction = page.getByRole("region", { name: "App adoption over time", exact: true });
  const outlook = direction.getByRole("article", { name: "Outlook adoption trend", exact: true });
  await expect(direction.getByRole("article")).toHaveCount(7);
  await expect(direction.getByRole("img", { name: /participation over weekly snapshots/ })).toHaveCount(7);
  await expect(page.getByRole("combobox", { name: "Trend Office app", exact: true })).toHaveCount(0);
  await expect(outlook.getByText("66.7%", { exact: true })).toBeVisible();
  await expect(outlook.getByText("+33.3 percentage points", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "App trend measure" }).selectOption("count");
  await expect(outlook.getByText("+20 (+100%)", { exact: true })).toBeVisible();
  await expect(direction.getByRole("img", { name: /active users over weekly snapshots/ })).toHaveCount(7);
  await page.getByText("Weekly Office history", { exact: true }).click();
  const table = page.getByRole("region", { name: "Office observations and comparisons", exact: true });
  await expect(table.getByRole("rowheader")).toHaveCount(3);
  const options = await page.getByRole("combobox", { name: "Office observation" }).locator("option").evaluateAll(options =>
    options.map(option => ({ value: (option as HTMLOptionElement).value, label: option.textContent })));
  const historical = options.at(-1)!.value;
  const latest = options[1].value;
  expect(historical).not.toBe(latest);
  const contextResponse = await page.request.get("/api/office-app-adoption/context");
  expect(contextResponse.ok()).toBe(true);
  const context = await contextResponse.json();
  const groupsResponse = await page.request.get(`/api/office-app-adoption/groups?selectionId=${context.selection.id}&limit=5`);
  expect(groupsResponse.ok()).toBe(true);
  const groups = await groupsResponse.json();
  expect(groups.counts).toEqual({ total: 7, filtered: 7 });
  expect(groups.value).toHaveLength(5);
  const remainingGroups = await page.request.get(`/api/office-app-adoption/groups?selectionId=${context.selection.id}&limit=5&pageNumber=2`);
  expect(remainingGroups.ok()).toBe(true);
  const engineering = [...groups.value, ...(await remainingGroups.json()).value].find(group => group.department === "Engineering");
  expect(engineering.metrics.savedLicensedPeople).toBe(54);
  expect(engineering.champions.map((person: { recentApps: string[] }) => person.recentApps.length)).toEqual([7, 6, 5]);
  const historyResponse = await page.request.get(`/api/office-app-adoption/history?selectionId=${context.selection.id}&limit=100`);
  expect(historyResponse.ok()).toBe(true);
  expect((await historyResponse.json()).value).toHaveLength(3);
  await page.getByRole("combobox", { name: "Office observation" }).selectOption(historical);
  await expect(active.getByText("20", { exact: true })).toBeVisible();
  await page.getByText("Weekly Office history", { exact: true }).click();
  await expect(table.getByRole("rowheader")).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "Office baseline" })).toHaveCount(0);
  const department = page.getByRole("region", { name: "Adoption by department" }).getByRole("link", { name: /Historical Engineering/ });
  await department.click();
  await continueWithSavedUsers(page);
  await expect(page).toHaveURL(new RegExp(`adoption=office.*officeSnapshot=${historical}`));
  await expect(page.getByRole("group", { name: "Adoption domain" }).getByRole("button", { name: "Office apps", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  const group = page.getByRole("region", { name: "Office Fixture / Historical Engineering", exact: true });
  await expect(group.getByText("20 reported active / 54 saved licensed", { exact: true })).toBeVisible();
  await expect(group.getByText(/Weekly history retains group and app totals only/)).toBeVisible();
  await expect(group.getByRole("button", { name: "Next people" })).toHaveCount(0);
  await expect(group.getByRole("button", { name: /Office Person/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`officeSnapshot=${historical}`));
  await expect(active.getByText("20", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Agent adoption", exact: true }).click();
  await expect(page.getByText("No saved usage reports yet", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copilot in Office apps", exact: true }).click();
  await expect(active.getByText("20", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Explore current people", exact: true }).click();
  await expect(active.getByText("40", { exact: true })).toBeVisible();
  await page.getByRole("region", { name: "Adoption by department" }).getByRole("link", { name: /^Engineering/ }).click();
  await continueWithSavedUsers(page);
  const currentGroup = page.getByRole("region", { name: "Office Fixture / Engineering", exact: true });
  await expect(currentGroup.getByText("40 reported active / 54 saved licensed", { exact: true })).toBeVisible();
  await currentGroup.getByRole("button", { name: "Next people" }).click();
  await expect(currentGroup.getByRole("navigation", { name: "people page shortcuts", exact: true }).getByRole("status")).toHaveText("2 / 2");
  await expect(currentGroup.getByRole("button", { name: "1. Current Office Person 1", exact: true })).toHaveCount(0);
  await expect(currentGroup.getByRole("heading", { name: /Potential Office champions/ })).toHaveCount(0);
  await currentGroup.getByRole("button", { name: "Current Office Person 6", exact: true }).click();
  const frozen = page.getByRole("region", { name: "Frozen Office person evidence" });
  await expect(frozen.getByRole("list", { name: "Frozen seven-app dates" })).toBeVisible();
  await expect(frozen.getByText(/Office Fixture \/ Engineering/)).toBeVisible();
  await expect(frozen.getByText(/not recalculated from today's profile/)).toBeVisible();
  const detailUrl = page.url();
  await page.reload();
  await continueWithSavedUsers(page);
  await expect(frozen).toBeVisible();
  await expect(page).toHaveURL(detailUrl);
  await frozen.getByRole("button", { name: "Open separate current profile, licenses and agent evidence" }).click();
  await expect(page.getByRole("button", { name: "Close current profile", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close current profile", exact: true }).click();
  await expect(frozen).toBeVisible();
  await page.getByRole("dialog", { name: "Current Office Person 6", exact: true }).getByRole("button", { name: "Close current office person 6" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).not.toHaveURL(/officeSnapshot=|officeBaseline=|officeGroup=/);
});

test("Office current group rows show one champion badge and keep unknown evidence readable at every width", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const championName = "Office champion with a particularly long display name for responsive layout checks";
  const unknownName = "OfficeUnknownEvidencePersonWithAnUnbrokenDisplayNameForNarrowWidthChecks";
  const champion = officePerson(1, { displayName: championName });
  const unknown = officePerson(4, {
    displayName: unknownName,
    recentApps: [], latestRecentDate: null, unknownReasons: ["no_app_dates"],
    dates: { word: null, excel: null, powerpoint: null, outlook: null, onenote: null, loop: null, teams: null },
  });
  const older = officePerson(5, {
    recentApps: [], latestRecentDate: null, unknownReasons: [],
    dates: { word: "2026-09-01", excel: null, powerpoint: null, outlook: null, onenote: null, loop: null, teams: null },
  });
  const single = officePerson(6, {
    recentApps: ["word"],
    dates: { word: "2026-10-20", excel: null, powerpoint: null, outlook: null, onenote: null, loop: null, teams: null },
  });
  const group = officeGroup(1, { champions: [champion] });
  await page.route(url => url.pathname.startsWith("/api/office-app-adoption/"), async route => {
    const url = new URL(route.request().url());
    const input = Object.fromEntries(url.searchParams);
    const context = officeFixtureContext(input);
    if (url.pathname.endsWith("/context")) return route.fulfill({ json: context });
    expect(input.selectionId).toBe(context.selection.id);
    if (url.pathname.endsWith("/summary")) return route.fulfill({ json: officeSummary(context) });
    if (url.pathname.endsWith("/history")) return route.fulfill({ json: officePage(officeHistory(context), context) });
    if (url.pathname.endsWith("/groups")) return route.fulfill({ json: officePage([group], context) });
    if (url.pathname.endsWith("/people")) return route.fulfill({ json: officePage([champion, unknown, older, single], context) });
    if (url.pathname.endsWith("/facets")) return route.fulfill({ json: officePage([], context) });
    return route.fulfill({ status: 400, json: { code: "invalid_office_query", detail: "Unexpected Office group fixture route." } });
  });
  await page.goto("/users?section=adoption&adoption=office");
  const card = page.getByRole("region", { name: "Contoso / Engineering", exact: true });
  const championButton = card.getByRole("button", { name: championName, exact: true });
  await expect(championButton).toBeVisible();
  await expect(card.getByText("Office Champ", { exact: true })).toHaveCount(1);
  await expect(card.locator(".copilot-user-badge")).toHaveText("Office Champ");
  await expect(card.getByRole("heading", { name: /Potential Office champions/ })).toHaveCount(0);
  await expect(card.locator(".adoption-agents").getByRole("button", { name: /Office/ })).toHaveCount(0);
  await expect(card.getByText("1 app", { exact: true })).toBeVisible();
  const unknownRow = card.locator(".adoption-people li").filter({ has: page.getByRole("button", { name: unknownName, exact: true }) });
  await expect(unknownRow.getByText("Unknown evidence", { exact: true })).toBeVisible();
  await expect(card.getByText("No recent evidence", { exact: true })).toBeVisible();
  await expect(card.locator(".adoption-agents p")).toHaveCount(0);
  const controls = page.locator(".copilot-users-view-controls");
  const usersToggle = controls.getByRole("group", { name: "Users view", exact: true });
  const domainToggle = controls.getByRole("group", { name: "Adoption domain", exact: true });
  await expect(domainToggle.getByRole("button", { name: "Office apps", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(domainToggle.getByRole("button", { name: "Agents", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("combobox", { name: "Adoption domain" })).toHaveCount(0);
  const summary = page.getByRole("group", { name: "Office adoption summary", exact: true });
  await expect(summary.locator(":scope > div")).toHaveCount(5);
  const observation = summary.locator(":scope > div").nth(4);
  await expect(observation).toHaveClass(/office-observation-card/);
  await expect(observation.getByRole("combobox", { name: "Office observation" })).toBeVisible();
  await expect(observation.getByText("Refreshed Oct 21, 2026", { exact: true })).toBeVisible();
  await expect(observation.getByText(/Recent window:|Cohort captured/)).toHaveCount(0);
  await expect(observation.getByRole("combobox", { name: "Office observation" }).locator("..")).toHaveText(/^Observation/);
  for (const width of [1440, 760, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
      controls: [...document.querySelectorAll(".copilot-users-view-controls, .copilot-users-view-controls .agent-inventory-scopes, .office-observation-card")]
        .map(element => ({ className: element.className, x: element.getBoundingClientRect().x,
          width: element.getBoundingClientRect().width, scroll: element.scrollWidth })),
    }));
    expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport);
    const rowBounds = (await controls.boundingBox())!;
    const usersBounds = (await usersToggle.boundingBox())!, domainBounds = (await domainToggle.boundingBox())!;
    expect(Math.abs(usersBounds.y - domainBounds.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(usersBounds.x - rowBounds.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(domainBounds.x + domainBounds.width - rowBounds.x - rowBounds.width)).toBeLessThanOrEqual(1);
    expect(domainBounds.x).toBeGreaterThanOrEqual(usersBounds.x + usersBounds.width + 7);
    expect(await observation.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    if (width === 1440) {
      const first = (await summary.locator(".metric").first().boundingBox())!;
      const fourth = (await summary.locator(".metric").nth(3).boundingBox())!;
      const fifth = (await observation.boundingBox())!;
      expect(Math.abs(fifth.y - first.y)).toBeLessThanOrEqual(1);
      expect(fifth.x).toBeGreaterThanOrEqual(fourth.x + fourth.width - 1);
    }
    expect(await card.locator(".adoption-group-columns").evaluate(element =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(width <= 760 ? 1 : 2);
    for (const row of await card.locator(".adoption-people li").all()) {
      expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const identity = (await row.locator(".office-person-identity").boundingBox())!;
      const count = (await row.locator(".adoption-count").boundingBox())!;
      expect(count.x).toBeGreaterThanOrEqual(identity.x + identity.width + 11);
      const heading = (await row.locator(".office-person-heading").boundingBox())!;
      const evidence = (await row.locator(".office-person-date").boundingBox())!;
      expect(evidence.y).toBeGreaterThanOrEqual(heading.y + heading.height + 3);
      expect(await row.getByRole("button").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await expect(card.getByText("Office Champ", { exact: true })).toHaveCSS("font-size", "12px");
    await expect(card.getByText("Office Champ", { exact: true })).toHaveCSS("background-color", "rgb(228, 243, 235)");
    expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
    await page.locator(".copilot-users-header").screenshot({ path: info.outputPath(`office-controls-${width}.png`) });
    await summary.screenshot({ path: info.outputPath(`office-summary-${width}.png`) });
    await card.screenshot({ path: info.outputPath(`office-group-${width}.png`) });
  }
  await championButton.click();
  await expect(page.getByRole("region", { name: "Frozen Office person evidence", exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: /^Close / }).click();
  await expect(championButton).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("Office partial, one-observation and first-use states retain the shared visual language and never invent zero population evidence", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const company = "Office organization with a particularly long name covering technology operations and international services";
  let reads = 0, observations = 3;
  await page.route(url => url.pathname.startsWith("/api/office-app-adoption/"), async route => {
    const url = new URL(route.request().url());
    const input = Object.fromEntries(url.searchParams);
    if (input.company?.startsWith("~string:")) input.company = input.company.slice(8);
    const context = officeFixtureContext(input);
    if (!observations) context.observation = null;
    context.status = { state: "failed", errorCode: "office_derivation_failed", message: "Saved source refresh did not complete; automatic recovery will retry." };
    if (!observations) context.status = { state: "waiting_sources", errorCode: null, message: null };
    reads++;
    if (url.pathname.endsWith("/context")) return route.fulfill({ json: context });
    expect(input.selectionId).toBe(context.selection.id);
    if (url.pathname.endsWith("/summary")) return route.fulfill({ json: officeSummary(context) });
    if (url.pathname.endsWith("/history")) return route.fulfill({ json: officePage(observations === 1 ? officeHistory(context).slice(-1) : officeHistory(context), context) });
    if (!observations) return route.fulfill({ json: officePage([], context) });
    if (url.pathname.endsWith("/facets")) return route.fulfill({ json: officePage([{ value: company, groups: 1, people: 54 }], context) });
    if (url.pathname.endsWith("/departments")) return route.fulfill({ json: officePage([
      officeGroup(1, { company, department: `${company} department` }),
    ], context) });
    return route.fulfill({ status: 400, json: { code: "invalid_office_query", detail: "Unexpected Office fixture route." } });
  });
  await page.goto("/dashboard?adoption=office");
  const trends = page.getByRole("region", { name: "App adoption over time", exact: true });
  await expect(trends.getByRole("article")).toHaveCount(7);
  await expect(trends.getByRole("img", { name: /participation over weekly snapshots/ })).toHaveCount(7);
  await expect(page.getByRole("combobox", { name: "Trend Office app", exact: true })).toHaveCount(0);
  for (const chart of await trends.getByRole("img").all()) {
    await expect(chart.locator("circle")).toHaveCount(3);
    await expect(chart.locator(".dashboard-trend-line")).toHaveCount(2);
  }
  await trends.getByRole("combobox", { name: "App trend measure", exact: true }).selectOption("count");
  await expect(trends.getByRole("img", { name: /active users over weekly snapshots/ })).toHaveCount(7);
  await trends.getByRole("combobox", { name: "App trend measure", exact: true }).selectOption("percent");
  await page.getByText("Activity report coverage", { exact: true }).click();
  await expect(page.getByText(/9 of the 14 people without recent activity have unknown activity evidence/)).toBeVisible();
  await expect(page.getByText(/Current Office source status: failed/)).toBeVisible();
  await expect(page.getByText(/current source status is not historical usage/)).toBeVisible();
  const companyControl = page.getByRole("combobox", { name: "Company", exact: true });
  await expect(companyControl).toHaveAttribute("aria-disabled", "false");
  await companyControl.focus();
  await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/company=/);
  for (const width of [360, 760, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await trends.locator(".office-trend-grid").evaluate(element =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(width <= 760 ? 1 : 3);
    for (const card of await trends.getByRole("article").all()) {
      expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectDashboardHeaderLayout(page);
    expect((await new AxeBuilder({ page }).include(".adoption-dashboard").analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`office-partial-long-${width}.png`), fullPage: true });
  }
  observations = 1;
  await page.reload();
  await expect(page.getByText("App adoption history is building.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "App adoption over time" }).getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("img", { name: /over weekly snapshots/ })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Office baseline", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Office participation" }).getByText("40", { exact: true })).toBeVisible();
  observations = 0;
  await page.reload();
  await expect(page.getByRole("region", { name: "Office participation", exact: true }).getByText("Unknown", { exact: true })).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Copilot adoption by app" })).toBeVisible();
  await expect(page.getByRole("img", { name: /over weekly snapshots/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await page.getByRole("button", { name: "Adoption", exact: true }).click();
  await expect(page.getByRole("group", { name: "Office adoption summary" }).getByText("Unknown", { exact: true })).toHaveCount(4);
  await expect(page.getByText(/No measured Office observation yet/)).toBeVisible();
  await expect(page.getByRole("group", { name: "Adoption domain" }).getByRole("button", { name: "Office apps", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: info.outputPath("office-first-use.png"), fullPage: true });
  expect(reads).toBeGreaterThan(5);
  expect(unexpected).toEqual([]);
});

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
    const champions = page.getByRole("region", { name: "Agents and Agent Champs" });
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
  await expectDashboardHeaderLayout(page);
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
  await expect(page.getByRole("region", { name: "Agents and Agent Champs" }).getByText("6", { exact: true })).toBeVisible();
  const viewport = page.viewportSize()!;
  for (const width of [1440, 760, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    await expectAgentDashboardPanelOrder(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.setViewportSize(viewport);
  await expect(page.getByRole("heading", { name: "Agent Champs", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Explore groups and Agent Champs", exact: true })).toBeVisible();
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
    const champions = page.getByRole("region", { name: "Agents and Agent Champs" });
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
