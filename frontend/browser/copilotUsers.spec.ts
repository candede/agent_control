import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockLayoutApi } from "./layoutFixtures";
import { downloadedCsvRows, usageCsvFixture } from "./usageCsvFixture";
import { copilotUsageFixture, licensedUser } from "../src/test/copilotUsageFixture";
import { usageFixtureSetId, usageUsersFixture } from "../src/test/usageInsightsFixture";
import { activeWithoutPaidPublished, activeWithoutPaidUsersFixture, reportLicenseDirectory } from "./userCohortFixtures";

async function paidFilters(page: Page) {
  const filters = page.getByRole("dialog", { name: "Filter users", exact: true });
  if (!await filters.count()) await page.getByRole("button", { name: /^Filters(?:, \d+ active)?$/ }).click();
  return filters;
}

async function sortPaidUsers(page: Page, value: string) {
  const filters = await paidFilters(page);
  await filters.getByRole("combobox", { name: "Sort", exact: true }).selectOption(value);
  await filters.getByRole("button", { name: "Close filters" }).click();
}

async function expectPaidSort(page: Page, value: string) {
  const filters = await paidFilters(page);
  await expect(filters.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue(value);
  await filters.getByRole("button", { name: "Close filters" }).click();
}

async function mockReportedUsers(page: Page, published = activeWithoutPaidPublished, directory = reportLicenseDirectory(published)) {
  const measurements: Array<{ offset: number; users: number; relationships: number; bytes: number; projectionMs: number }> = [];
  await page.route(url => url.pathname === "/api/official-usage/users", route => {
    expect(route.request().method()).toBe("GET");
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("licenseCohort")).toBe("active_without_paid");
    if (params.has("setId") && params.get("setId") !== published.activeSet?.id) {
      return route.fulfill({ status: 404, json: { code: "official_usage_set_not_found", detail: "The exact synthetic report set is unavailable." } });
    }
    const sort = params.get("sortBy");
    const cohort = params.get("cohort");
    const activity = params.get("activity");
    const started = performance.now();
    const view = activeWithoutPaidUsersFixture({
      staleAfterDays: 35,
      search: params.get("search") ?? undefined, agentId: params.get("agentId") ?? undefined,
      company: params.get("company") ?? undefined, department: params.get("department") ?? undefined,
      creatorType: params.get("creatorType") ?? undefined, responsesOnly: params.get("responsesOnly") === "true",
      startDate: params.get("startDate") ?? undefined, endDate: params.get("endDate") ?? undefined,
      lowResponseThreshold: Number(params.get("lowResponseThreshold") ?? 5),
      cohort: cohort === "zero" || cohort === "low" || cohort === "review" ? cohort : "all",
      activity: activity === "recent" || activity === "inactive" || activity === "no-activity" ? activity : "all",
      userSortBy: sort === "responses" || sort === "agentsUsed" || sort === "lastActivity" || sort === "displayName" ? sort : "responses",
      sortDirection: params.get("sortDirection") === "asc" ? "asc" : "desc",
      limit: Number(params.get("limit") ?? 50), offset: Number(params.get("offset") ?? 0),
    }, published, directory);
    const body = JSON.stringify(view);
    measurements.push({
      offset: view.users.offset, users: view.users.value.length,
      relationships: view.users.value.reduce((count, user) => count + user.rows.length, 0),
      bytes: Buffer.byteLength(body), projectionMs: performance.now() - started,
    });
    return route.fulfill({ contentType: "application/json", body });
  });
  return measurements;
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("expanded data sources and coverage stays concise without disclaimer paragraphs", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const fixture = structuredClone(copilotUsageFixture);
  fixture.sources.directory.message = "Checked 4 directory users.";
  fixture.sources.appActivity.state = "partial";
  fixture.sources.appActivity.message = "Loaded 4 app activity rows; 1 unmatched identity was not joined.";
  fixture.notices = ["This dashboard is read-only and never changes license assignments."];
  await page.route("**/api/copilot-usage/users", route => route.fulfill({ json: fixture }));
  await page.goto("/users");
  const coverage = page.locator(".copilot-users-provenance");
  const summary = coverage.getByText("Data sources and coverage", { exact: true });
  await expect(coverage).not.toHaveAttribute("open", "");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(coverage).toHaveAttribute("open", "");
  await expect(coverage.getByText("Checked 4 directory users.", { exact: true })).toBeVisible();
  await expect(coverage.getByText("Office app activity: Incomplete", { exact: true })).toBeVisible();
  await expect(coverage.getByText(fixture.sources.appActivity.message, { exact: true })).toBeVisible();
  await expect(coverage.getByText(/Directory observed:.*App activity observed:/)).toBeVisible();
  await expect(coverage.getByText(/^Checked:/)).toHaveCount(3);
  await expect(coverage.locator(":scope > p")).toHaveCount(1);
  await expect(coverage).not.toContainText(/read-only|license assignments|Identities are matched|Only verified active paid|reports can lag|coaching signal/);
  expect((await coverage.innerText()).trim().split(/\s+/).length).toBeLessThanOrEqual(110);
  expect(await coverage.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".copilot-users-provenance").analyze()).violations).toEqual([]);
  await coverage.screenshot({ path: info.outputPath("concise-source-coverage.png") });
  expect(unexpected).toEqual([]);
});

test("all user summary cards filter directly with readable selected, hover and keyboard states", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.goto("/users");
  const summary = page.getByRole("group", { name: "M365 Copilot license summary", exact: true });
  const cards = summary.getByRole("button");
  const table = page.getByRole("region", { name: "M365 Copilot license status", exact: true });
  const all = summary.getByRole("button", { name: "Active M365 Copilot licensed users", exact: true });
  const using = summary.getByRole("button", { name: "Using agents", exact: true });
  const attention = summary.getByRole("button", { name: "Needs attention", exact: true });
  const noActivity = summary.getByRole("button", { name: "No reported agent activity", exact: true });
  await expect(cards).toHaveCount(4);
  await expect(page.locator(".copilot-users-tabs")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Licensed users", exact: true })).toHaveCount(0);
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(cards.locator("strong")).toHaveText(["4", "2", "2", "1"]);
  for (const card of await cards.all()) {
    const contentInsets = await card.evaluate(element => {
      const style = getComputedStyle(element);
      const left = element.getBoundingClientRect().left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
      return Array.from(element.children).map(child => child.getBoundingClientRect().left - left);
    });
    for (const inset of contentInsets) expect(Math.abs(inset)).toBeLessThanOrEqual(1);
    const colors = await card.locator("span, strong, small").evaluateAll(elements => elements.map(element => getComputedStyle(element).color));
    await card.hover();
    expect(await card.locator("span, strong, small").evaluateAll(elements => elements.map(element => getComputedStyle(element).color))).toEqual(colors);
    await expect(card).toHaveCSS("background-color", "rgb(240, 239, 255)");
  }
  await all.focus();
  await page.keyboard.press("Tab");
  await expect(using).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator("tbody tr").first()).toContainText("Ada");
  await expect(table.locator("tbody tr").last()).toContainText("Ben");
  await page.keyboard.press("Tab");
  await expect(attention).toBeFocused();
  await page.keyboard.press("Space");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(page.getByLabel("Low-response threshold")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(noActivity).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr")).toContainText("Cleo");
  await expect(summary.getByRole("button", { pressed: true })).toHaveCount(1);
  await using.click();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await using.click();
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await page.mouse.move(0, 0);
  await expect(all).toHaveCSS("background-color", "rgb(248, 247, 255)");
  expect(await summary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("clickable-user-summary-cards.png") });
  expect(unexpected).toEqual([]);
});

test("no reported activity includes identifiable absence and follows the selected reports", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const fixture = structuredClone(copilotUsageFixture);
  fixture.unresolvedImportedIdentities = [];
  fixture.counts.unresolvedImportedIdentities = 0;
  const bridge = licensedUser(5, "Bridge", 100);
  bridge.importedUsage!.missingUserReport = true;
  const conflict = licensedUser(6, "Conflict", 100);
  conflict.importedUsage!.reportedResponsesReceived = 0;
  conflict.importedUsage!.reviewCohort = "zero_responses";
  fixture.users.push(bridge, conflict);
  fixture.counts.licensedUsers = 6;
  await page.route("**/api/copilot-usage/users", route => route.fulfill({ json: fixture }));
  await page.goto("/users");
  const summary = page.getByRole("group", { name: "M365 Copilot license summary", exact: true });
  const table = page.getByRole("region", { name: "M365 Copilot license status", exact: true });
  const noActivity = summary.getByRole("button", { name: "No reported agent activity", exact: true });
  await expect(noActivity).toHaveAccessibleDescription("2. Licensed users with no agent activity in the selected reports");
  await expect(page.getByText(/not proof of inactivity/)).toHaveCount(0);
  await summary.getByRole("button", { name: "Using agents", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(table.getByRole("row", { name: /Bridge|Conflict/ })).toHaveCount(2);
  await noActivity.click();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.getByRole("row", { name: /Cleo|Drew/ })).toHaveCount(2);
  await expect(table.getByText("Usage unknown", { exact: true })).toHaveCount(0);
  expect(await summary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("no-reported-agent-activity.png") });
  await table.getByRole("button", { name: "Drew", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Drew", exact: true });
  await expect(detail.getByText("No reported agent activity", { exact: true })).toBeVisible();
  await detail.getByRole("tab", { name: "Usage & agents", exact: true }).click();
  await expect(detail.getByText("No agent activity in the selected reports.", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  fixture.users[3] = licensedUser(4, "Drew", 20);
  for (const user of fixture.users) {
    if (user.importedUsage) user.importedUsage.datasetScope.reportSetId = "new-selection";
  }
  await page.reload();
  await expect(noActivity.locator("strong")).toHaveText("1");
  await noActivity.click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.getByRole("row", { name: /Cleo/ })).toBeVisible();
  fixture.sources.importedAgentUsage.state = "stale";
  await page.reload();
  await expect(noActivity.locator("strong")).toHaveText("Unknown");
  await noActivity.click();
  await expect(table).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Agent usage unavailable", exact: true })).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("paid users remain searchable beyond four thousand without exposing checked nonpaid candidates", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const fixture = structuredClone(copilotUsageFixture);
  fixture.users = Array.from({ length: 4_053 }, (_, index) => {
    return licensedUser(index + 1, `Person${String(index).padStart(4, "0")}`, index < 10 ? 100 - index : index === 10 ? 0 : null);
  });
  const excluded = licensedUser(5_000, "Disabled candidate", 300);
  excluded.copilotServiceState = excluded.servicePlans[0].state = "disabled";
  const unknown = licensedUser(5_001, "Unverified candidate", 400);
  unknown.copilotServiceState = unknown.servicePlans[0].state = "unknown";
  fixture.users.push(excluded, unknown);
  fixture.counts.licensedUsers = 4_053;
  let snapshots = 0;
  await page.route("**/api/copilot-usage/users", route => {
    snapshots += 1;
    return route.fulfill({ json: fixture });
  });
  await page.goto("/users");
  const table = page.getByRole("region", { name: "M365 Copilot license status", exact: true });
  const cohort = page.getByRole("combobox", { name: "User cohort", exact: true });
  await expect(cohort).toHaveValue("licenses");
  await expect(cohort.locator("option")).toHaveText(["Paid M365 Copilot users", "Active users without paid Copilot", "Agent responsibility"]);
  const active = page.getByText("Active M365 Copilot licensed users", { exact: true }).locator("..");
  await expect(active.locator("strong")).toHaveText("4,053");
  await expect(table.locator("tbody tr")).toHaveCount(50);
  await expect(page.getByRole("region", { name: "Paid license scope and coverage" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "All checked users", exact: true })).toHaveCount(0);
  await expect(page.getByText("Unlinked report identities", { exact: true })).toHaveCount(0);
  await expect(table.getByRole("row", { name: /Disabled candidate|Unverified candidate/ })).toHaveCount(0);
  const initialSnapshots = snapshots;
  expect(initialSnapshots).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByLabel("Copilot user pages")).toContainText("51-100 of 4,053");
  const responsesHeading = table.getByRole("button", { name: "Sort by Agent responses", exact: true });
  await responsesHeading.click();
  await expect(page.getByLabel("Copilot user pages")).toContainText("1-50 of 4,053");
  await expect(table.getByRole("columnheader", { name: "Agent responses", exact: true })).toHaveAttribute("aria-sort", "ascending");
  await expect(table.locator("tbody tr").first()).toContainText("Person0010");
  await expect(table.locator("tbody tr").nth(11)).toContainText("Unknown");
  await expect(responsesHeading).toBeFocused();
  await expectPaidSort(page, "responses-asc");
  await responsesHeading.focus();
  await responsesHeading.press("Enter");
  await expect(table.locator("tbody tr").first()).toContainText("Person0000");
  await expect(table.getByRole("columnheader", { name: "Agent responses", exact: true })).toHaveAttribute("aria-sort", "descending");
  await expectPaidSort(page, "responses-desc");
  await page.getByRole("searchbox", { name: "Search users or agents" }).fill("person4052");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr")).toContainText("Person4052");
  await expect(table.locator("tbody tr")).toContainText("Unknown");
  await table.getByRole("button", { name: "Person4052", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Person4052", exact: true });
  await expect(detail.getByText("M365 Copilot licensed", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(active.locator("strong")).toHaveText("4,053");
  expect(snapshots).toBe(initialSnapshots);
  expect(unexpected).toEqual([]);
});

test("effectively licensed users lead with useful data and support ranked employee drilldown", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.goto("/users");
  await expect(page.getByRole("button", { name: "Drew", exact: true })).toBeVisible();
  const table = page.getByRole("region", { name: "M365 Copilot license status", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(table.getByRole("columnheader")).toHaveText(["User", "Agent responses", "Agents used", "Company", "Department", "Last activity"]);
  await expect(table.getByRole("rowheader")).toHaveCount(4);
  for (const header of await table.getByRole("rowheader").all()) await expect(header).toHaveAttribute("scope", "row");
  await expect(table).not.toContainText(/M365 Copilot licensed|Paid features:|Users report only|Follow-up/);
  await expect(page.getByRole("button", { name: /Export.*CSV/i })).toHaveCount(0);
  await expect(table.getByRole("row", { name: /Cleo/ })).toContainText("0");
  await expect(table.getByRole("row", { name: /Drew/ })).toContainText("Unknown");
  await expect(page.getByText("Unlinked report identities", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Concealed report user", exact: true })).toHaveCount(0);
  await expect(page.getByText("Microsoft 365 admin center Copilot Agents usage exports")).not.toBeVisible();
  await expect(page.locator(".capability-health")).toHaveAccessibleName("Permissions");
  await expect(page.locator(".capability-health")).toHaveAccessibleDescription(/^Permissions: \d+ issues?$/);
  await expect(page.locator(".capability-health")).not.toContainText("provider-verified");
  if (info.project.name === "desktop") {
    const bounds = await table.boundingBox();
    expect(bounds!.y, "Useful employee rows should start within the first desktop viewport").toBeLessThan(700);
  }
  await sortPaidUsers(page, "responses-asc");
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(table.locator("tbody tr").first()).toContainText("Cleo");
  await expect(table.locator("tbody tr").last()).toContainText("Drew");
  await sortPaidUsers(page, "responses-desc");
  await expect(table.locator("tbody tr").first()).toContainText("Ada");
  const results = await new AxeBuilder({ page }).include(".copilot-users").analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("copilot-paid-license-users.png"), fullPage: true });

  await page.getByRole("button", { name: "Ada", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Ada", exact: true });
  await detail.getByRole("tab", { name: "Usage & agents", exact: true }).click();
  await expect(detail.getByRole("cell", { name: "Researcher synthetic-researcher", exact: true })).toBeVisible();
  await expect(detail.getByText("Microsoft", { exact: true })).toBeVisible();
  await expect(detail.getByText("Outlook", { exact: true })).toBeVisible();
  await expect(detail.getByRole("link")).toHaveCount(0);
  await expect(detail.getByRole("columnheader", { name: "Agent-wide last activity", exact: true })).toBeVisible();
  await expect(page.locator(".copilot-users").getByRole("link")).toHaveCount(0);
  await expect(page.locator(".copilot-users").getByRole("button", { name: "Sync users" })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include(".copilot-user-dialog").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("employee-detail.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(detail).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("paid user filters stay concise, accessible and client-paged with exact organization matching", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const fixture = structuredClone(copilotUsageFixture);
  fixture.users = Array.from({ length: 103 }, (_, index) => {
    const user = licensedUser(index + 1, `Person${String(index).padStart(3, "0")}`, 200 - index);
    user.directory.companyName = index < 52 ? index % 2 ? "Contoso" : " Contoso " : "Fabrikam";
    user.directory.department = index < 52 ? " Engineering " : "Sales";
    return user;
  });
  const missing = licensedUser(104, "Missing", null);
  missing.directory.companyName = missing.directory.department = null;
  const excluded = licensedUser(105, "Excluded", 999);
  excluded.copilotServiceState = excluded.servicePlans[0].state = "disabled";
  excluded.directory.companyName = "Excluded company";
  excluded.directory.department = "Excluded department";
  fixture.users.push(missing, excluded);
  fixture.counts.licensedUsers = 104;
  let snapshots = 0;
  await page.route("**/api/copilot-usage/users", route => {
    snapshots += 1;
    return route.fulfill({ json: fixture });
  });
  await page.goto("/users");
  const table = page.getByRole("region", { name: "M365 Copilot license status", exact: true });
  const toolbar = page.getByRole("region", { name: "User filters", exact: true });
  const matching = page.getByRole("status", { name: "Matching users", exact: true });
  const trigger = page.getByTitle("Filter users and choose sort order", { exact: true });
  const search = toolbar.getByRole("searchbox", { name: "Search users or agents", exact: true });
  const summary = page.getByRole("group", { name: "M365 Copilot license summary", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(50);
  const initialSnapshots = snapshots;
  await expect(matching).toContainText("104 matching users");
  await expect(summary.getByRole("button", { name: "Active M365 Copilot licensed users", exact: true }))
    .toHaveAccessibleDescription("104. Licensed users with active paid features");
  await expect(page.getByRole("button", { name: /Export.*CSV/i })).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName("Filters");
  expect(await toolbar.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const tableBefore = await table.boundingBox();
  await trigger.focus();
  await trigger.press("Enter");
  const filters = page.getByRole("dialog", { name: "Filter users", exact: true });
  const company = filters.getByRole("combobox", { name: "Company", exact: true });
  const department = filters.getByRole("combobox", { name: "Department", exact: true });
  const activity = filters.getByRole("combobox", { name: "Activity", exact: true });
  const threshold = filters.getByRole("spinbutton", { name: "Low-response threshold", exact: true });
  const sort = filters.getByRole("combobox", { name: "Sort", exact: true });
  await expect(company).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(await table.boundingBox()).toEqual(tableBefore);
  const bounds = await filters.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await expect(company.locator("option")).toHaveText(["All companies", "Contoso", "Fabrikam"]);
  await expect(department.locator("option")).toHaveText(["All departments", "Engineering", "Sales"]);
  await expect(activity.locator("option")).toHaveText(["All paid users", "Using agents", "Needs attention", "No reported agent activity"]);
  await expect(threshold).toHaveValue("5");
  await expect(threshold).toHaveAttribute("min", "1");
  await expect(threshold).toHaveAttribute("max", "100000000");
  await expect(sort.locator("option")).toHaveCount(8);
  await expect(sort.getByRole("option", { name: /license|follow-up/i })).toHaveCount(0);
  await expect(filters.getByRole("combobox", { name: "Agent responses", exact: true })).toHaveCount(0);
  await company.selectOption("Contoso");
  await department.selectOption("Engineering");
  await threshold.fill("200");
  await activity.selectOption("attention");
  await sort.selectOption("name-desc");
  await expect(company).toHaveCSS("box-shadow", "none");
  await expect(summary.getByRole("button", { name: "Needs attention", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(matching).toContainText("52 matching users");
  await expect(table.locator("tbody tr")).toHaveCount(50);
  await expect(table.getByRole("rowheader").first()).toContainText("Person051");
  await threshold.fill("0");
  await expect(threshold).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText("Enter a whole-number threshold between 1 and 100,000,000.");
  await expect(matching).toContainText("52 matching users");
  await threshold.fill("200");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  await filters.screenshot({ path: info.outputPath("paid-user-filter-popup.png") });
  await page.keyboard.press("Escape");
  await expect(filters).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("Active filters").getByRole("button")).toHaveCount(4);
  await expect(trigger).toHaveAccessibleName("Filters, 4 active");
  await page.screenshot({ path: info.outputPath("paid-user-organization-filters.png") });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByLabel("Copilot user pages")).toContainText("51-52 of 52");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await search.fill("Person050");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.getByRole("rowheader")).toContainText("Person050");
  await expect(matching).toContainText("1 matching user");
  await paidFilters(page);
  await expect(company.locator("option")).toHaveText(["All companies", "Contoso", "Fabrikam"]);
  await expect(department.locator("option")).toHaveText(["All departments", "Engineering", "Sales"]);
  await department.selectOption("Sales");
  await expect(page.getByRole("heading", { name: "No users match", exact: true })).toBeVisible();
  await expect(matching).toContainText("0 matching users");
  await filters.getByRole("button", { name: "Reset filters", exact: true }).click();
  await expect(company).toHaveValue("");
  await expect(department).toHaveValue("");
  await expect(activity).toHaveValue("licensed");
  await expect(threshold).toHaveValue("5");
  await expect(sort).toHaveValue("name-desc");
  await expect(search).toHaveValue("");
  await expect(matching).toContainText("104 matching users");
  await expect(page.getByLabel("Copilot user pages")).toContainText("1-50 of 104");
  await expect(summary.getByRole("button", { name: "Active M365 Copilot licensed users", exact: true })).toHaveAttribute("aria-pressed", "true");
  await filters.getByRole("button", { name: "Close filters" }).click();
  await summary.getByRole("button", { name: "Using agents", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await paidFilters(page);
  await expect(activity).toHaveValue("using");
  await filters.getByRole("button", { name: "Close filters" }).click();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.getByLabel("Copilot user pages")).toContainText("1-50 of 104");
  await expect(table.getByRole("rowheader").first()).toContainText("Person102");
  await expectPaidSort(page, "name-desc");
  await search.fill("Missing");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.getByRole("cell")).toHaveText(["Unknown", "Unknown", "Not set", "Not set", "Not reported"]);
  await search.fill("Person102");
  await table.getByRole("button", { name: "Person102", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Person102", exact: true });
  await expect(detail.getByText("M365 Copilot licensed", { exact: true })).toBeVisible();
  await detail.getByRole("tab", { name: "Licenses", exact: true }).click();
  await expect(detail.getByRole("list", { name: "Paid feature states", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(table.getByRole("button", { name: "Person102", exact: true })).toBeFocused();
  expect(await page.locator("body").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  await expect(trigger).toHaveAccessibleName("Filters");
  expect(snapshots).toBe(initialSnapshots);
  expect(unexpected).toEqual([]);
});

test("disabled bundle candidates stay excluded from paid cohorts and licensed adoption", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const fixture = structuredClone(copilotUsageFixture);
  fixture.users[1].copilotServiceState = fixture.users[1].servicePlans[0].state = "disabled";
  fixture.users[2].copilotServiceState = fixture.users[2].servicePlans[0].state = "warning";
  fixture.users[3].copilotServiceState = "partially_enabled";
  fixture.users[3].servicePlans.push({
    servicePlanId: "b95945de-b3bd-46db-8437-f2beb6ea2347", service: "M365_COPILOT_TEAMS",
    displayName: "Microsoft 365 Copilot in Microsoft Teams", state: "unknown",
    assignedDateTime: null, capabilityStatus: null,
  });
  fixture.counts.licensedUsers = 3;
  await page.route("**/api/copilot-usage/users", route => route.fulfill({ json: fixture }));
  await page.goto("/users");
  const table = page.getByRole("region", { name: "M365 Copilot license status", exact: true });
  await expect(page.getByRole("combobox", { name: "User cohort", exact: true })).toHaveValue("licenses");
  await expect(table.getByRole("rowheader")).toHaveCount(3);
  await expect(page.getByText("Active M365 Copilot licensed users", { exact: true }).locator("..")).toContainText("3");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.getByRole("row", { name: /Ben/ })).toHaveCount(0);
  for (const [name, state] of [["Cleo", "Active (grace period)"], ["Drew", "Partially active"]]) {
    await table.getByRole("button", { name, exact: true }).click();
    const detail = page.getByRole("dialog", { name, exact: true });
    await expect(detail.getByText("M365 Copilot licensed", { exact: true })).toBeVisible();
    await expect(detail.getByText(`Paid features: ${state}`, { exact: true })).toBeVisible();
    await expect(detail.getByText("Review paid features", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
  }
  const metrics = page.getByLabel("M365 Copilot license summary");
  await expect(metrics.getByText("Using agents", { exact: true }).locator("..").locator("strong")).toHaveText("1");
  await page.getByRole("button", { name: "Needs attention", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.getByRole("row", { name: /Ben/ })).toHaveCount(0);
  await page.getByRole("button", { name: "No reported agent activity", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.getByRole("row", { name: /Cleo/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "All checked users", exact: true })).toHaveCount(0);
  await expect(table.getByRole("row", { name: /Ben/ })).toHaveCount(0);
  await expect(table.getByText(/^(Basic|Disabled|Copilot Disabled|Paid license assigned)$/)).toHaveCount(0);
  await expect(metrics.getByText("Using agents", { exact: true }).locator("..").locator("strong")).toHaveText("1");
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("copilot-verified-paid-users.png"), fullPage: true });
  expect(unexpected).toEqual([]);
});

test("retained licensing evidence preserves last-known context without claiming current entitlement", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const fixture = structuredClone(copilotUsageFixture);
  fixture.sources.directory.state = "partial";
  fixture.users[1].copilotServiceState = fixture.users[1].servicePlans[0].state = "disabled";
  await page.route("**/api/copilot-usage/users", route => route.fulfill({ json: fixture }));
  await page.goto("/users");
  await expect(page.getByRole("region", { name: "Paid license scope and coverage" })).toHaveCount(0);
  await expect(page.getByText("Active M365 Copilot licensed users", { exact: true }).locator("..")).toContainText("Unknown");
  const table = page.getByRole("region", { name: "M365 Copilot license status", exact: true });
  await table.getByRole("button", { name: "Ada", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Ada", exact: true });
  await expect(detail.getByText("Last saved: M365 Copilot licensed", { exact: true })).toBeVisible();
  await expect(detail.getByText("Verify paid license inventory", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(table.getByText("M365 Copilot licensed", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Matching users", exact: true })).toContainText("3 matching users");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.getByRole("row", { name: /Ben/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Needs attention", exact: true }).click();
  await expect(table).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No last-saved users in this cohort" })).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("paid user details retain their agent breakdown without navigating to the nonpaid cohort", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await mockReportedUsers(page);
  const directory = structuredClone(copilotUsageFixture);
  directory.users = directory.users.map(user => ({
    ...user, importedUsage: usageUsersFixture().users.value.find(row => row.username === user.directory.userPrincipalName) ?? null,
  }));
  await page.route("**/api/copilot-usage/users", route => route.fulfill({ json: directory }));
  await page.goto("/users");
  await page.getByRole("button", { name: "Ada", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Ada", exact: true });
  await detail.getByRole("tab", { name: "Usage & agents", exact: true }).click();
  await expect(detail.getByRole("region", { name: "User agent breakdown" }).locator("tbody tr")).toHaveCount(2);
  await expect(detail.getByRole("row", { name: /Researcher/ })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Researcher", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("link", { name: /Researcher|Helpdesk/ })).toHaveCount(0);
  await expect(page).toHaveURL(/\/users$/);
  await expect(page.getByRole("combobox", { name: "User cohort", exact: true })).toHaveValue("licenses");
  await page.keyboard.press("Escape");
  await expect(page.locator(".copilot-users").getByRole("link")).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test("report permission recovery is visible without hiding service assignments", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const fixture = structuredClone(copilotUsageFixture);
  fixture.sources.appActivity = {
    ...fixture.sources.appActivity, state: "unavailable",
    message: "Check Reports.Read.All admin consent on the existing Entra app and the signed-in user's Reports Reader role.",
  };
  await page.route("**/api/copilot-usage/users", route => route.fulfill({ json: fixture }));
  await page.goto("/users");
  const table = page.getByRole("region", { name: "M365 Copilot license status", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(4);
  const notice = page.getByText(/Office app activity unavailable/);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Permissions");
  await expect(page.locator(".copilot-users").getByRole("link")).toHaveCount(0);
  await page.getByText("Data sources and coverage", { exact: true }).click();
  await expect(page.locator(".copilot-users-provenance").getByText(fixture.sources.appActivity.message, { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("the active nonpaid cohort excludes paid and unknown identities and explains incomplete coverage", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const responsibilityReads: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/agent-responsibility") responsibilityReads.push(request.url()); });
  await mockReportedUsers(page);
  await page.goto("/users?view=activity");
  const table = page.getByRole("region", { name: "Active users without paid Copilot", exact: true }).and(page.locator(".copilot-users-table-shell"));
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.getByRole("row", { name: /Emery|Finley/ })).toHaveCount(2);
  await expect(table.getByRole("row", { name: /Ada|Ben|Cleo|Concealed report user/ })).toHaveCount(0);
  await expect(page.getByText(/1 user needs a license check\. Run Users sync/)).toBeVisible();
  await expect(table.getByText("License not verified", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export users CSV" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Reported activity", exact: true })).toHaveCount(0);
  await table.getByRole("button", { name: "View reported details for Emery" }).click();
  const details = page.getByRole("dialog", { name: "Emery" });
  await expect(details.getByText("No active M365 Copilot license", { exact: true })).toBeVisible();
  await expect(details.getByText("License not verified", { exact: true })).toHaveCount(0);
  await expect(details.getByRole("region", { name: "Microsoft 365 Copilot paid features" })).toHaveCount(0);
  await details.getByRole("tab", { name: "Responsibility", exact: true }).click();
  await expect(details.getByText(/Link this user to a directory identity/)).toBeVisible();
  expect(responsibilityReads).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("unavailable license coverage hides retained candidates and disables CSV until Users sync recovers", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const directory = reportLicenseDirectory();
  directory.attemptStatus = "failed";
  directory.message = "Current license status is unavailable. Run Users sync.";
  await mockReportedUsers(page, activeWithoutPaidPublished, directory);
  await page.goto("/users?view=activity");
  await expect(page.getByText(/Run Users sync/).first()).toBeVisible();
  await expect(page.getByText(/license.*unavailable/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^View reported details for/ })).toHaveCount(0);
  await expect(page.getByText("Emery", { exact: true })).toHaveCount(0);
  directory.attemptStatus = "available";
  directory.message = null;
  await page.reload();
  const table = page.getByRole("region", { name: "Active users without paid Copilot", exact: true }).and(page.locator(".copilot-users-table-shell"));
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Export users CSV" })).toBeEnabled();
  expect(unexpected).toEqual([]);
});

test("reloading a newly saved license snapshot transfers users between cohorts without changing report history", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const licenses = reportLicenseDirectory();
  await mockReportedUsers(page, activeWithoutPaidPublished, licenses);
  const directory = structuredClone(copilotUsageFixture);
  await page.route("**/api/copilot-usage/users", route => route.fulfill({ json: directory }));
  await page.goto("/users");
  const cohort = page.getByRole("combobox", { name: "User cohort", exact: true });
  await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Emery", exact: true })).toHaveCount(0);
  await cohort.selectOption("activity");
  const activity = page.getByRole("region", { name: "Active users without paid Copilot", exact: true }).and(page.locator(".copilot-users-table-shell"));
  await expect(activity.getByRole("row", { name: /Emery/ })).toBeVisible();
  await expect(activity.getByRole("row", { name: /Ada/ })).toHaveCount(0);

  directory.users[0].copilotServiceState = directory.users[0].servicePlans[0].state = "disabled";
  directory.users.push(licensedUser(20, "Emery", 215));
  for (const user of licenses.value!) {
    if (user.identity.userPrincipalName === "ada@example.invalid") user.copilotServiceState = "disabled";
    if (user.identity.userPrincipalName === "emery@example.invalid") user.copilotServiceState = "enabled";
  }
  await page.reload();
  await expect(activity.locator("tbody tr")).toHaveCount(2);
  await expect(activity.getByRole("row", { name: /Ada/ })).toBeVisible();
  await expect(activity.getByRole("row", { name: /Emery/ })).toHaveCount(0);
  await cohort.selectOption("licenses");
  await expect(page.getByRole("button", { name: "Ada", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Emery", exact: true })).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("reported activity stays bounded with 2,053 users and 1,005 agents for one user", async ({ page }, info) => {
  test.setTimeout(60_000);
  const unexpected = await mockLayoutApi(page);
  const published = structuredClone(activeWithoutPaidPublished);
  const largeUserName = `Person0000 ${"Long synthetic display name ".repeat(8).trim()}`;
  const largeAgentName = `Agent1004 ${"LongAgentName".repeat(20)}`;
  published.reports.users!.rows = Array.from({ length: 2_053 }, (_, index) => ({
    username: `person${index}@example.invalid`, displayName: index === 0 ? largeUserName : `Person${String(index).padStart(4, "0")}`,
    numberOfAgentsUsed: index === 0 ? 1_005 : 1, agentResponsesReceived: index === 0 ? 50_000 : 1,
  }));
  published.reports.userAgents!.rows = [
    ...Array.from({ length: 1_005 }, (_, index) => ({
      username: "person0@example.invalid", agentId: `agent-${index}`, agentName: index === 1_004 ? largeAgentName : `Agent${String(index).padStart(4, "0")}`,
      creatorType: "Your org", responsesSentToUsers: 2,
    })),
    ...published.reports.users!.rows.slice(1).map((user, index) => ({
      username: user.username, agentId: `specialist-${index + 1}`, agentName: `Specialist${index + 1}`,
      creatorType: "Microsoft", responsesSentToUsers: 1,
    })),
  ];
  const measurements = await mockReportedUsers(page, published);
  const directory = structuredClone(copilotUsageFixture);
  directory.sources.directory.state = "unavailable";
  directory.users = [];
  await page.route("**/api/copilot-usage/users", route => route.fulfill({ json: directory }));
  await page.goto("/users?view=activity");
  const table = page.getByRole("region", { name: "Active users without paid Copilot", exact: true }).and(page.locator(".copilot-users-table-shell"));
  await expect(table.locator("tbody tr")).toHaveCount(50);
  await expect(table.getByRole("columnheader")).toHaveCount(6);
  await expect(page.getByLabel("Reported user pages")).toContainText("1-50 of 2,053");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(table.getByRole("row", { name: /Person0000/ })).toBeVisible();
  await page.getByRole("button", { name: "Next users", exact: true }).click();
  await expect(page.getByLabel("Reported user pages")).toContainText("51-100 of 2,053");
  await page.getByRole("searchbox", { name: "Search reported users or agents" }).fill("Specialist2052");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr")).toContainText("Person2052");
  await page.getByRole("searchbox", { name: "Search reported users or agents" }).fill("");
  const detailButton = table.getByRole("button", { name: `View reported details for ${largeUserName}`, exact: true });
  await detailButton.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: largeUserName, exact: true });
  await dialog.getByRole("tab", { name: "Usage & agents", exact: true }).click();
  const agents = dialog.getByRole("region", { name: "User agent breakdown" });
  await expect(agents.locator("tbody tr")).toHaveCount(50);
  const readsBeforeAgentPaging = measurements.length;
  await expect(dialog.getByLabel("User agent pages")).toContainText("1-50 of 1,005");
  await dialog.getByRole("button", { name: "Next agents" }).click();
  await expect(dialog.getByLabel("User agent pages")).toContainText("51-100 of 1,005");
  await dialog.getByRole("searchbox", { name: "Search this user's agents" }).fill("agent-1004");
  await expect(agents.locator("tbody tr")).toHaveCount(1);
  await expect(agents.getByRole("button", { name: `${largeAgentName}: active users without paid Copilot`, exact: true })).toBeVisible();
  expect(measurements).toHaveLength(readsBeforeAgentPaging);
  expect(measurements.every(read => read.users <= 50)).toBe(true);
  expect(measurements.some(read => read.offset === 50)).toBe(true);
  expect(measurements.some(read => read.relationships >= 1_005)).toBe(true);
  await info.attach("reported-users-scale.json", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
  await agents.getByRole("button", { name: `${largeAgentName}: active users without paid Copilot`, exact: true }).hover();
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("reported-user-agent-detail.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(detailButton).toBeFocused();
  await expect(dialog).not.toBeVisible();
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("reported-users.png"), fullPage: true });
  expect(unexpected).toEqual([]);
});

test("legacy matrix links open activity and filtered CSV exports pin the displayed report", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const directory = reportLicenseDirectory();
  for (const user of directory.value!) {
    user.identity.companyName = user.identity.userPrincipalName === "emery@example.invalid" ? "Contoso" : "Fabrikam";
    user.identity.department = user.identity.userPrincipalName === "emery@example.invalid" ? "Engineering" : "Sales";
  }
  await mockReportedUsers(page, activeWithoutPaidPublished, directory);
  let exported: URLSearchParams | undefined;
  await page.route("**/api/official-usage/users.csv?*", route => {
    exported = new URL(route.request().url()).searchParams;
    expect(route.request().method()).toBe("GET");
    expect(exported.get("setId")).toBe(usageFixtureSetId);
    expect(exported.get("licenseCohort")).toBe("active_without_paid");
    const users = activeWithoutPaidUsersFixture({
      staleAfterDays: 35,
      search: exported.get("search") ?? undefined, agentId: exported.get("agentId") ?? undefined,
      company: exported.get("company") ?? undefined, department: exported.get("department") ?? undefined,
      userSortBy: exported.get("sortBy") === "agentsUsed" ? "agentsUsed" : "responses",
      sortDirection: exported.get("sortDirection") === "asc" ? "asc" : "desc",
      lowResponseThreshold: Number(exported.get("lowResponseThreshold") ?? 5),
      cohort: exported.get("cohort") === "low" ? "low" : "all", limit: 100_000, offset: 0,
    }, activeWithoutPaidPublished, directory).users.value;
    const rows = users.flatMap(user => (user.rows.length ? user.rows : [undefined]).map(row => ({
      username: user.username, displayName: user.displayName, reportedResponsesReceived: user.reportedResponsesReceived,
      licenseAssignmentStatus: user.licenseAssignmentStatus,
      agentId: row?.agentId, responsesSentToUsers: row?.responsesSentToUsers, reportSetId: user.datasetScope.reportSetId,
    })));
    return route.fulfill({ contentType: "text/csv", body: usageCsvFixture(
      ["username", "displayName", "reportedResponsesReceived", "licenseAssignmentStatus", "agentId", "responsesSentToUsers", "reportSetId"], rows,
    ) });
  });
  await page.goto(`/users?view=matrix&agent=helpdesk%2Freport%3A2&snapshot=${usageFixtureSetId}&q=Emery`);
  const table = page.getByRole("region", { name: "Active users without paid Copilot", exact: true }).and(page.locator(".copilot-users-table-shell"));
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "User cohort", exact: true })).toHaveValue("activity");
  await expect(table.locator("tbody tr")).toContainText("215");
  await expect(page.getByText(/All-agent user totals repeat|Advanced user filters|Membership uses current saved/)).toHaveCount(0);
  const tableBefore = await table.boundingBox();
  const toolbar = page.getByRole("region", { name: "User filters", exact: true });
  const toolbarBounds = await toolbar.boundingBox();
  const searchBounds = await toolbar.getByRole("searchbox").boundingBox();
  expect(searchBounds!.y).toBeGreaterThanOrEqual(toolbarBounds!.y);
  expect(searchBounds!.x).toBeGreaterThanOrEqual(toolbarBounds!.x);
  expect(await toolbar.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole("button", { name: /^Filters/ }).click();
  const filters = page.getByRole("dialog", { name: "Filter users" });
  await expect(filters.getByRole("combobox", { name: "Company", exact: true })).toBeFocused();
  expect(await table.boundingBox()).toEqual(tableBefore);
  const panelBounds = await filters.boundingBox();
  expect(panelBounds!.x).toBeGreaterThanOrEqual(0);
  expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(panelBounds!.y + panelBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await expect(filters.getByLabel(/Relationship creator|User recency|User activity start|User activity end/)).toHaveCount(0);
  await filters.getByRole("combobox", { name: "Company", exact: true }).selectOption("Contoso");
  await expect(filters.getByRole("combobox", { name: "Company", exact: true })).toHaveCSS("box-shadow", "none");
  await filters.getByRole("combobox", { name: "Department", exact: true }).selectOption("Engineering");
  await filters.getByRole("combobox", { name: "Agent responses", exact: true }).selectOption("low");
  await page.getByLabel("Low-response threshold").fill("250");
  await filters.getByRole("combobox", { name: "Sort", exact: true }).selectOption("agents-asc");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  expect((await new AxeBuilder({ page }).include(".reported-users").analyze()).violations).toEqual([]);
  await filters.screenshot({ path: info.outputPath("user-filter-popup.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^Filters/ })).toBeFocused();
  await expect(filters).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("nonpaid-user-filters.png") });
  await expect(page).toHaveURL(/\/users\?view=activity/);
  await expect(page.getByRole("button", { name: "Export users CSV" })).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export users CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("reported-user-activity.csv");
  const rows = await downloadedCsvRows(file);
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.licenseAssignmentStatus === "no_active_paid_license")).toBe(true);
  expect(rows.every(row => row.username === "emery@example.invalid" && row.reportedResponsesReceived === "215" && row.reportSetId === usageFixtureSetId)).toBe(true);
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ agentId: "synthetic-researcher", responsesSentToUsers: "200" }),
    expect.objectContaining({ agentId: "helpdesk/report:2", responsesSentToUsers: "15" }),
  ]));
  expect(exported?.get("setId")).toBe(usageFixtureSetId);
  expect(exported?.get("licenseCohort")).toBe("active_without_paid");
  expect(exported?.get("search")).toBe("Emery");
  expect(exported?.get("agentId")).toBe("helpdesk/report:2");
  expect(exported?.get("company")).toBe("Contoso");
  expect(exported?.get("department")).toBe("Engineering");
  expect(exported?.get("lowResponseThreshold")).toBe("250");
  expect(exported?.get("cohort")).toBe("low");
  for (const removed of ["creatorType", "activity", "startDate", "endDate", "responsesOnly"]) expect(exported?.has(removed)).toBe(false);
  expect(exported?.get("sortBy")).toBe("agentsUsed");
  expect(exported?.get("sortDirection")).toBe("asc");
  expect(exported?.has("offset")).toBe(false);
  expect(exported?.has("limit")).toBe(false);
  expect(unexpected).toEqual([]);
});

test("an unavailable exact reported snapshot does not fall back to current reports", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await mockReportedUsers(page);
  const requests: URLSearchParams[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/official-usage/users") requests.push(url.searchParams);
  });
  const unavailable = "99999999-9999-4999-8999-999999999999";
  await page.goto(`/users?view=activity&snapshot=${unavailable}`);
  await expect(page.getByRole("alert")).toContainText("The exact synthetic report set is unavailable.");
  const table = page.getByRole("region", { name: "Active users without paid Copilot", exact: true }).and(page.locator(".copilot-users-table-shell"));
  await expect(table).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(query => query.get("setId") === unavailable)).toBe(true);
  expect(requests.every(query => query.get("licenseCohort") === "active_without_paid")).toBe(true);
  await page.getByRole("button", { name: "Use current reports", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  expect(requests.at(-1)?.has("setId")).toBe(false);
  expect(unexpected).toEqual([]);
});
