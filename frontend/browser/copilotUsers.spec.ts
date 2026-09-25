import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockLayoutApi } from "./layoutFixtures";
import { downloadedCsvRows, usageCsvFixture } from "./usageCsvFixture";
import { copilotUsageFixture, licensedUser } from "../src/test/copilotUsageFixture";
import { usageFixtureSetId, usageUsersFixture } from "../src/test/usageInsightsFixture";
import { activeWithoutPaidPublished, activeWithoutPaidUsersFixture, reportLicenseDirectory } from "./userCohortFixtures";

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
  await expect(table.locator("tbody tr")).toContainText("M365 Copilot licensed");
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
  await expect(table.getByText("M365 Copilot licensed", { exact: true })).toHaveCount(3);
  await expect(page.getByText("Active M365 Copilot licensed users", { exact: true }).locator("..")).toContainText("3");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.getByRole("row", { name: /Ben/ })).toHaveCount(0);
  await expect(table.getByRole("row", { name: /Cleo/ })).toContainText("Active (grace period)");
  await expect(table.getByRole("row", { name: /Drew/ })).toContainText("Partially active");
  const metrics = page.getByLabel("M365 Copilot license summary");
  await expect(metrics.getByText("Using agents", { exact: true }).locator("..").locator("strong")).toHaveText("1");
  await page.getByRole("button", { name: "Needs attention", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.getByRole("row", { name: /Ben/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Usage unknown", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.getByRole("row", { name: /Drew/ })).toBeVisible();
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
  await expect(table.getByText("Last saved: M365 Copilot licensed", { exact: true })).toHaveCount(3);
  await expect(table.getByText("M365 Copilot licensed", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Last saved: 3 previously licensed users shown; current licensing unverified/)).toBeVisible();
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
  await expect(notice).toContainText("Reports.Read.All");
  await expect(notice).toContainText("Reports Reader");
  await expect(page.locator(".copilot-users").getByRole("link")).toHaveCount(0);
  await expect(page.getByText("Use Permissions in the top navigation to review the connection.")).toBeVisible();
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
  await expect(page.getByText(/License status could not be verified for 1 active report users\. Run Users sync/)).toBeVisible();
  await expect(table.getByText("License not verified", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export users CSV" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Reported activity", exact: true })).toHaveCount(0);
  await table.getByRole("button", { name: "View reported details for Emery" }).click();
  const details = page.getByRole("dialog", { name: "Emery" });
  await expect(details.getByText("No active M365 Copilot license", { exact: true })).toBeVisible();
  await expect(details.getByText("License not verified", { exact: true })).toHaveCount(0);
  await expect(details.getByRole("region", { name: "Microsoft 365 Copilot paid features" })).toHaveCount(0);
  await expect(details.getByText(/Responsibility unavailable: no exact verified directory object ID/)).toBeVisible();
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
  await expect(table.getByRole("row", { name: /Person0000/ })).toContainText("No active M365 Copilot license");
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

test("legacy matrix links open activity and filtered CSV exports pin the displayed report", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await mockReportedUsers(page);
  let exported: URLSearchParams | undefined;
  await page.route("**/api/official-usage/users.csv?*", route => {
    exported = new URL(route.request().url()).searchParams;
    expect(route.request().method()).toBe("GET");
    expect(exported.get("setId")).toBe(usageFixtureSetId);
    expect(exported.get("licenseCohort")).toBe("active_without_paid");
    const users = activeWithoutPaidUsersFixture({
      staleAfterDays: 35,
      search: exported.get("search") ?? undefined, agentId: exported.get("agentId") ?? undefined,
      creatorType: exported.get("creatorType") ?? undefined, responsesOnly: exported.get("responsesOnly") === "true",
      activity: exported.get("activity") === "recent" ? "recent" : "all",
      startDate: exported.get("startDate") ?? undefined, endDate: exported.get("endDate") ?? undefined,
      userSortBy: exported.get("sortBy") === "agentsUsed" ? "agentsUsed" : "responses",
      sortDirection: exported.get("sortDirection") === "asc" ? "asc" : "desc",
      lowResponseThreshold: Number(exported.get("lowResponseThreshold") ?? 5),
      cohort: exported.get("cohort") === "low" ? "low" : "all", limit: 100_000, offset: 0,
    }).users.value;
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
  await expect(page.getByRole("button", { name: "Export users CSV" })).toHaveAccessibleDescription(/all agent details for matching users/);
  await expect(page.getByText(/All-agent user totals repeat per relationship; do not sum them/)).toBeVisible();
  await page.getByText("Advanced user filters", { exact: true }).click();
  await page.getByLabel("Relationship creator").selectOption("Your org");
  await page.getByLabel("Users-report response cohort").selectOption("low");
  await page.getByLabel("User recency").selectOption("recent");
  await page.getByLabel("User activity start (UTC)").fill("2026-09-01");
  await page.getByLabel("User activity end (UTC)").fill("2026-09-12");
  await page.getByLabel("Low-response threshold").fill("250");
  await page.getByLabel("Require a response-producing relationship").check();
  await expect(page.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
  await page.getByRole("button", { name: "Apply user filters" }).click();
  await page.getByLabel("Order reported users by").selectOption("agents-asc");
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
  expect(exported?.get("creatorType")).toBe("Your org");
  expect(exported?.get("lowResponseThreshold")).toBe("250");
  expect(exported?.get("responsesOnly")).toBe("true");
  expect(exported?.get("cohort")).toBe("low");
  expect(exported?.get("activity")).toBe("recent");
  expect(exported?.get("startDate")).toBe("2026-09-01");
  expect(exported?.get("endDate")).toBe("2026-09-12");
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
