import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { buildOfficialUsageUserView } from "../../backend/src/services/officialUsageViews";
import { mockLayoutApi } from "./layoutFixtures";
import { downloadedCsvRows, usageCsvFixture } from "./usageCsvFixture";
import { copilotUsageFixture, licensedUser } from "../src/test/copilotUsageFixture";
import { usageFixtureNow, usageFixtureSetId, usageInsightsPublished, usageUsersFixture } from "../src/test/usageInsightsFixture";

async function mockReportedUsers(page: Page, published = usageInsightsPublished) {
  const measurements: Array<{ offset: number; users: number; relationships: number; bytes: number; projectionMs: number }> = [];
  await page.route(url => url.pathname === "/api/official-usage/users", route => {
    expect(route.request().method()).toBe("GET");
    const params = new URL(route.request().url()).searchParams;
    if (params.has("setId") && params.get("setId") !== published.activeSet?.id) {
      return route.fulfill({ status: 404, json: { code: "official_usage_set_not_found", detail: "The exact synthetic report set is unavailable." } });
    }
    const sort = params.get("sortBy");
    const cohort = params.get("cohort");
    const activity = params.get("activity");
    const started = performance.now();
    const view = buildOfficialUsageUserView(published, {
      staleAfterDays: 35, now: usageFixtureNow,
      search: params.get("search") ?? undefined, agentId: params.get("agentId") ?? undefined,
      creatorType: params.get("creatorType") ?? undefined, responsesOnly: params.get("responsesOnly") === "true",
      startDate: params.get("startDate") ?? undefined, endDate: params.get("endDate") ?? undefined,
      lowResponseThreshold: Number(params.get("lowResponseThreshold") ?? 5),
      cohort: cohort === "zero" || cohort === "low" || cohort === "review" ? cohort : "all",
      activity: activity === "recent" || activity === "inactive" || activity === "no-activity" ? activity : "all",
      userSortBy: sort === "responses" || sort === "agentsUsed" || sort === "lastActivity" || sort === "displayName" ? sort : "responses",
      sortDirection: params.get("sortDirection") === "asc" ? "asc" : "desc",
      limit: Number(params.get("limit") ?? 50), offset: Number(params.get("offset") ?? 0),
    });
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

test("all paid license assignments remain searchable beyond four thousand while the table is paged", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const fixture = structuredClone(copilotUsageFixture);
  fixture.users = Array.from({ length: 4_053 }, (_, index) =>
    licensedUser(index + 1, `Person${String(index).padStart(4, "0")}`, index < 10 ? 100 - index : null));
  fixture.counts.licensedUsers = fixture.users.length;
  let snapshots = 0;
  await page.route("**/api/copilot-usage/users", route => {
    snapshots += 1;
    return route.fulfill({ json: fixture });
  });
  await page.goto("/users");
  const table = page.getByRole("region", { name: "Paid M365 Copilot license assignments", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(50);
  await expect(page.getByLabel("M365 Copilot license summary")).toContainText("4,053");
  await expect(page.getByText(/Basic Copilot Chat access and usage are not counted/)).toBeVisible();
  const scope = page.getByRole("region", { name: "Paid license scope and coverage" });
  await expect(scope).toContainText("4,053 paid-license users in the saved roster");
  await expect(scope).toContainText("Not all tenant accounts");
  await expect(scope).toContainText("all matching Graph pages and count checks completed");
  const initialSnapshots = snapshots;
  expect(initialSnapshots).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByLabel("Paid license assignment pages")).toContainText("51-100 of 4,053");
  const responsesHeading = table.getByRole("button", { name: "Sort by Agent responses", exact: true });
  await responsesHeading.click();
  await expect(page.getByLabel("Paid license assignment pages")).toContainText("1-50 of 4,053");
  await expect(table.getByRole("columnheader", { name: "Agent responses", exact: true })).toHaveAttribute("aria-sort", "ascending");
  await expect(table.locator("tbody tr").first()).toContainText("Person0009");
  await expect(table.locator("tbody tr").nth(10)).toContainText("Unknown");
  await expect(page.getByLabel("Order by")).toHaveValue("responses-asc");
  await expect(responsesHeading).toBeFocused();
  await responsesHeading.press("Enter");
  await expect(table.locator("tbody tr").first()).toContainText("Person0000");
  await expect(table.getByRole("columnheader", { name: "Agent responses", exact: true })).toHaveAttribute("aria-sort", "descending");
  await expect(page.getByLabel("Order by")).toHaveValue("responses-desc");
  await page.getByRole("searchbox", { name: "Search users or agents" }).fill("person4052");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr")).toContainText("Person4052");
  await expect(table.locator("tbody tr")).toContainText("Unknown");
  await expect(page.getByLabel("M365 Copilot license summary")).toContainText("4,053");
  expect(snapshots).toBe(initialSnapshots);
  expect(unexpected).toEqual([]);
});

test("paid license assignments lead with useful data and support ranked employee drilldown", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.goto("/users");
  await expect(page.getByRole("button", { name: "Drew", exact: true })).toBeVisible();
  const table = page.getByRole("region", { name: "Paid M365 Copilot license assignments", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(page.getByText("Microsoft 365 admin center Copilot Agents usage exports")).not.toBeVisible();
  await expect(page.locator(".capability-health")).toContainText("Permissions:");
  await expect(page.locator(".capability-health")).not.toContainText("provider-verified");
  if (info.project.name === "desktop") {
    const bounds = await table.boundingBox();
    expect(bounds!.y, "Useful employee rows should start within the first desktop viewport").toBeLessThan(700);
  }
  await page.getByLabel("Order by").selectOption("responses-asc");
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(table.locator("tbody tr").first()).toContainText("Cleo");
  await expect(table.locator("tbody tr").last()).toContainText("Drew");
  await page.getByLabel("Order by").selectOption("responses-desc");
  await expect(table.locator("tbody tr").first()).toContainText("Ada");
  const results = await new AxeBuilder({ page }).include(".copilot-users").analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("copilot-paid-license-users.png"), fullPage: true });

  await page.getByRole("button", { name: "Ada", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Ada", exact: true });
  await expect(detail.getByRole("cell", { name: "Researcher synthetic-researcher", exact: true })).toBeVisible();
  await expect(detail.getByText("Microsoft", { exact: true })).toBeVisible();
  await expect(detail.getByText("Outlook", { exact: true })).toBeVisible();
  await expect(detail.getByRole("link")).toHaveCount(0);
  await expect(detail.getByText("Anyone, not this user", { exact: true })).toBeVisible();
  await expect(page.locator(".copilot-users").getByRole("link")).toHaveCount(0);
  await expect(page.locator(".copilot-users").getByRole("button", { name: "Sync users" })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include(".copilot-user-dialog").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("employee-detail.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(detail).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("paid assignments remain visible when paid features are inactive and active cohorts are explicit", async ({ page }) => {
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
  const table = page.getByRole("region", { name: "Paid M365 Copilot license assignments", exact: true });
  await expect(page.getByRole("button", { name: "All paid licenses", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(table.getByText("Paid license assigned", { exact: true })).toHaveCount(4);
  await expect(table.getByRole("row", { name: /Ben/ })).toContainText("Paid features: Not enabled");
  await expect(table.getByText(/^(Basic|Disabled|Copilot Disabled)$/)).toHaveCount(0);
  await expect(page.getByText("Active M365 Copilot licensed users", { exact: true }).locator("..")).toContainText("3");
  await page.getByRole("button", { name: "Active paid licenses", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.getByRole("row", { name: /Ben/ })).toHaveCount(0);
  await expect(table.getByRole("row", { name: /Cleo/ })).toContainText("Active (grace period)");
  await expect(table.getByRole("row", { name: /Drew/ })).toContainText("Partially active");
  await page.getByRole("button", { name: "All paid licenses", exact: true }).click();
  await page.getByRole("button", { name: "Ben", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Ben", exact: true });
  await expect(detail.getByText("Paid license assigned", { exact: true })).toBeVisible();
  await expect(detail.getByRole("region", { name: "Microsoft 365 Copilot paid features" })).toContainText("Not enabled");
  await expect(detail.getByText(/Raw capability status:/)).not.toBeVisible();
  await expect(detail.getByText(/Basic Copilot Chat access is not assessed here/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Ben", exact: true })).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("retained paid-license data never claims current verified coverage or active assignments", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const fixture = structuredClone(copilotUsageFixture);
  fixture.sources.directory.state = "partial";
  await page.route("**/api/copilot-usage/users", route => route.fulfill({ json: fixture }));
  await page.goto("/users");
  const scope = page.getByRole("region", { name: "Paid license scope and coverage" });
  await expect(scope).toContainText("Last saved roster: 4 paid-license users");
  await expect(scope).toContainText("Current paid-license coverage is unverified");
  await expect(scope).not.toContainText("all matching Graph pages and count checks completed");
  await expect(page.getByText("Active M365 Copilot licensed users", { exact: true }).locator("..")).toContainText("Unknown");
  const table = page.getByRole("region", { name: "Paid M365 Copilot license assignments", exact: true });
  await expect(table.getByText("Last saved: Paid license assigned", { exact: true })).toHaveCount(4);
  await page.getByRole("button", { name: "Active paid licenses", exact: true }).click();
  await expect(table).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Verify the directory to see current paid licenses" })).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("service details focus reported agent activity on the same Users page", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await mockReportedUsers(page);
  const directory = structuredClone(copilotUsageFixture);
  directory.users = directory.users.map(user => ({
    ...user, importedUsage: usageUsersFixture().users.value.find(row => row.username === user.directory.userPrincipalName) ?? null,
  }));
  await page.route("**/api/copilot-usage/users", route => route.fulfill({ json: directory }));
  await page.goto("/users");
  await page.getByRole("button", { name: "Ada", exact: true }).click();
  await page.getByRole("dialog", { name: "Ada", exact: true }).getByRole("button", { name: "Researcher", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/users\\?view=activity&agent=synthetic-researcher&snapshot=${usageFixtureSetId}$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reported activity", exact: true })).toBeFocused();
  const table = page.getByRole("region", { name: "Reported users", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.getByRole("row", { name: /Concealed report user/ })).toContainText("License not verified");
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
  const table = page.getByRole("region", { name: "Paid M365 Copilot license assignments", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(4);
  const notice = page.getByText(/Office app activity unavailable/);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Reports.Read.All");
  await expect(notice).toContainText("Reports Reader");
  await expect(page.locator(".copilot-users").getByRole("link")).toHaveCount(0);
  await expect(page.getByText("Use Permissions in the top navigation to review the connection.")).toBeVisible();
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("reported activity stays bounded with 2,053 users and 1,005 agents for one user", async ({ page }, info) => {
  test.setTimeout(60_000);
  const unexpected = await mockLayoutApi(page);
  const published = structuredClone(usageInsightsPublished);
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
  const table = page.getByRole("region", { name: "Reported users", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(50);
  await expect(table.getByRole("columnheader")).toHaveCount(6);
  await expect(page.getByLabel("Reported user pages")).toContainText("1-50 of 2,053");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(table.getByRole("row", { name: /Person0000/ })).toContainText("License not verified");
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
  const agents = dialog.getByRole("region", { name: "User agent breakdown" });
  await expect(agents.locator("tbody tr")).toHaveCount(50);
  const readsBeforeAgentPaging = measurements.length;
  await expect(dialog.getByLabel("User agent pages")).toContainText("1-50 of 1,005");
  await dialog.getByRole("button", { name: "Next agents" }).click();
  await expect(dialog.getByLabel("User agent pages")).toContainText("51-100 of 1,005");
  await dialog.getByRole("searchbox", { name: "Search this user's agents" }).fill("agent-1004");
  await expect(agents.locator("tbody tr")).toHaveCount(1);
  await expect(agents.getByRole("button", { name: largeAgentName, exact: true })).toBeVisible();
  expect(measurements).toHaveLength(readsBeforeAgentPaging);
  expect(measurements.every(read => read.users <= 50)).toBe(true);
  expect(measurements.some(read => read.relationships >= 1_005)).toBe(true);
  await info.attach("reported-users-scale.json", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
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

test("legacy matrix links open activity and filtered CSV exports pin the displayed report", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await mockReportedUsers(page);
  let exported: URLSearchParams | undefined;
  await page.route("**/api/official-usage/users.csv?*", route => {
    exported = new URL(route.request().url()).searchParams;
    expect(route.request().method()).toBe("GET");
    expect(exported.get("setId")).toBe(usageFixtureSetId);
    const users = buildOfficialUsageUserView(usageInsightsPublished, {
      staleAfterDays: 35, now: usageFixtureNow,
      search: exported.get("search") ?? undefined, agentId: exported.get("agentId") ?? undefined,
      creatorType: exported.get("creatorType") ?? undefined, responsesOnly: exported.get("responsesOnly") === "true",
      lowResponseThreshold: Number(exported.get("lowResponseThreshold") ?? 5),
      cohort: exported.get("cohort") === "low" ? "low" : "all", limit: 100_000, offset: 0,
    }).users.value;
    const rows = users.flatMap(user => (user.rows.length ? user.rows : [undefined]).map(row => ({
      username: user.username, displayName: user.displayName, reportedResponsesReceived: user.reportedResponsesReceived,
      agentId: row?.agentId, responsesSentToUsers: row?.responsesSentToUsers, reportSetId: user.datasetScope.reportSetId,
    })));
    return route.fulfill({ contentType: "text/csv", body: usageCsvFixture(
      ["username", "displayName", "reportedResponsesReceived", "agentId", "responsesSentToUsers", "reportSetId"], rows,
    ) });
  });
  await page.goto(`/users?view=matrix&agent=helpdesk%2Freport%3A2&snapshot=${usageFixtureSetId}&q=Ada`);
  const table = page.getByRole("region", { name: "Reported users", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Reported activity", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(table.locator("tbody tr")).toContainText("215");
  await expect(page.getByRole("button", { name: "Export users CSV" })).toHaveAccessibleDescription(/all agent details for matching users/);
  await expect(page.getByText(/All-agent user totals repeat per relationship; do not sum them/)).toBeVisible();
  await page.getByText("Advanced user filters", { exact: true }).click();
  await page.getByLabel("Relationship creator").selectOption("Your org");
  await page.getByLabel("Users-report response cohort").selectOption("low");
  await page.getByLabel("Low-response threshold").fill("250");
  await page.getByLabel("Require a response-producing relationship").check();
  await expect(page.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
  await page.getByRole("button", { name: "Apply user filters" }).click();
  await expect(page).toHaveURL(/\/users\?view=activity/);
  await expect(page.getByRole("button", { name: "Export users CSV" })).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export users CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("reported-user-activity.csv");
  const rows = await downloadedCsvRows(file);
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.username === "ada@example.invalid" && row.reportedResponsesReceived === "215" && row.reportSetId === usageFixtureSetId)).toBe(true);
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ agentId: "synthetic-researcher", responsesSentToUsers: "200" }),
    expect.objectContaining({ agentId: "helpdesk/report:2", responsesSentToUsers: "15" }),
  ]));
  expect(exported?.get("setId")).toBe(usageFixtureSetId);
  expect(exported?.get("agentId")).toBe("helpdesk/report:2");
  expect(exported?.get("creatorType")).toBe("Your org");
  expect(exported?.get("lowResponseThreshold")).toBe("250");
  expect(exported?.get("responsesOnly")).toBe("true");
  expect(exported?.get("cohort")).toBe("low");
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
  await expect(page.getByRole("region", { name: "Reported users", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(query => query.get("setId") === unavailable)).toBe(true);
  await page.getByRole("button", { name: "Use current reports", exact: true }).click();
  await expect(page.getByRole("region", { name: "Reported users", exact: true }).locator("tbody tr")).toHaveCount(4);
  expect(requests.at(-1)?.has("setId")).toBe(false);
  expect(unexpected).toEqual([]);
});
